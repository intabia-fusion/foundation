/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

const { performance } = require('perf_hooks')
const { join } = require('path')
const { spawn } = require('child_process')
const { isPhaseCached, markPhaseCompleted } = require('../libs/cache')
const { success, error, dim } = require('../libs/colors')
const { computeTypesHashes, compositeHashFromTypes } = require('../libs/composite-hash')
const { getOptimalWorkerCount } = require('../libs/utils')

/**
 * Find svelte-check binary — walk up node_modules/.bin from package dir
 */
function findSvelteCheckBin(cwd) {
  let dir = cwd
  while (dir !== '/') {
    const bin = join(dir, 'node_modules', '.bin', 'svelte-check')
    if (require('fs').existsSync(bin)) return bin
    dir = require('path').dirname(dir)
  }
  return 'svelte-check' // fallback — will fail with ENOENT if not in PATH
}

/**
 * Run svelte-check for a single package directly (no rushx overhead)
 */
function readProcessRssMB(pid) {
  try {
    const statm = require('fs').readFileSync(`/proc/${pid}/statm`, 'utf-8').split(' ')
    // field 2 is resident pages
    return Math.round(parseInt(statm[1], 10) * 4096 / 1024 / 1024)
  } catch {
    return 0
  }
}

function runSvelteCheckForPackage(cwd, heapLimitMB) {
  return new Promise((resolve) => {
    const bin = findSvelteCheckBin(cwd)
    // Sized from the memory budget; must stay above the heaviest package's real need
    // (~2.9GB measured) or tracker/github/workflow-resources OOM.
    const heapMB = process.env.FAST_BUILD_SVELTE_HEAP_MB ?? String(heapLimitMB)
    const nodeOptions = [process.env.NODE_OPTIONS, `--max-old-space-size=${heapMB}`]
      .filter(Boolean).join(' ')
    const child = spawn(bin, ['--output', 'human'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: nodeOptions }
    })

    let stdout = ''
    let stderr = ''
    let peakRssMB = 0
    const rssTimer = setInterval(() => {
      const mb = readProcessRssMB(child.pid)
      if (mb > peakRssMB) peakRssMB = mb
    }, 500)

    child.stdout?.on('data', (data) => {
      stdout += data.toString()
    })
    child.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      clearInterval(rssTimer)
      if (code === 0) {
        resolve({ success: true, output: stdout, peakRssMB })
      } else {
        resolve({ success: false, output: stdout + '\n' + stderr, peakRssMB, error: new Error(`svelte-check failed with exit code ${code}`) })
      }
    })

    child.on('error', (err) => {
      clearInterval(rssTimer)
      resolve({ success: false, error: err, peakRssMB })
    })
  })
}

/**
 * Run svelte-check for every package off a shared queue.
 * Order does not matter — it consumes the types/ validate already emitted.
 */
async function runSvelteCheckPhase(graph, packageNames, concurrency, options = {}) {
  const { force = false, packageHashes, typesHashes } = options

  // svelte-check reads dependencies through their emitted .d.ts, same as lint.
  const depTypes = typesHashes ?? computeTypesHashes(graph)

  // Each svelte-check is a separate process holding a full TS + svelte language service.
  // A hardcoded cap either wastes a big machine or OOMs a small one, so size it by memory.
  const plan = getOptimalWorkerCount(concurrency, 'svelte-check')
  const svelteCheckConcurrency = process.env.FAST_BUILD_SVELTE_WORKERS
    ? parseInt(process.env.FAST_BUILD_SVELTE_WORKERS, 10)
    : plan.workers
  const heapLimitMB = plan.heapMB

  const results = {
    successCount: 0,
    cacheHits: 0,
    total: packageNames.length,
    errors: [],
    time: 0,
    workers: 0,
    peakChildRssMB: 0
  }

  results.workers = svelteCheckConcurrency
  results.heapMB = heapLimitMB

  const startTime = performance.now()
  let completedCount = 0
  const timings = []

  async function processPackage(name) {
    const node = graph.get(name)
    const cwd = node.project.fullPath
    const hash = packageHashes
      ? compositeHashFromTypes(name, graph, packageHashes, depTypes, ['svelte.config.js', 'tsconfig.json'])
      : undefined

    if (!force && hash && isPhaseCached(cwd, hash, 'svelte-check', null, [])) {
      completedCount++
      results.successCount++
      results.cacheHits++
      const pkgTime = 0
      console.log(`    ${success('S')} ${dim(completedCount)}/${packageNames.length} ${name} ${success('svelte-checked')} (cached) ${dim(pkgTime + 'ms')}`)
      return
    }

    const taskStart = performance.now()
    const result = await runSvelteCheckForPackage(cwd, heapLimitMB)
    const pkgTime = Math.round(performance.now() - taskStart)
    completedCount++

    timings.push({ package: name, time: pkgTime, failed: !result.success })
    if (result.peakRssMB > results.peakChildRssMB) results.peakChildRssMB = result.peakRssMB

    if (result.success) {
      if (hash) {
        markPhaseCompleted(cwd, hash, 'svelte-check', null, [])
      }
      results.successCount++
      console.log(`    ${success('S')} ${dim(completedCount)}/${packageNames.length} ${name} ${success('svelte-checked')} ${dim(pkgTime + 'ms')}`)
    } else {
      results.errors.push({ package: name, error: result.error, output: result.output })
      console.error(`    ${error('S')} ${dim(completedCount)}/${packageNames.length} ${name} ${error('FAILED')} ${dim(pkgTime + 'ms')}`)
      if (result.output) process.stderr.write(result.output + '\n')
    }
  }

  // svelte-check only reads the types/ that validate already produced and emits nothing
  // other packages consume, so dependency waves bought nothing while their chunk barriers
  // made every package wait for the slowest one in its chunk. A flat queue keeps all
  // workers busy until the list is empty.
  const queue = [...packageNames]
  const runners = Array.from({ length: Math.min(svelteCheckConcurrency, queue.length) }, async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      await processPackage(name)
    }
  })
  await Promise.all(runners)

  results.time = performance.now() - startTime

  // Print timing summary
  if (results.peakChildRssMB > 0) {
    console.log(`    Peak svelte-check process: ${results.peakChildRssMB}MB (x${svelteCheckConcurrency} concurrent)`)
  }

  if (timings.length > 0) {
    const sorted = timings.sort((a, b) => b.time - a.time)
    const slowCount = Math.min(5, sorted.length)
    console.log(`\n    Top ${slowCount} slowest svelte-check packages:`)
    for (let i = 0; i < slowCount; i++) {
      const t = sorted[i]
      const failInfo = t.failed ? ' FAILED' : ''
      console.log(`      ${(t.time / 1000).toFixed(1)}s ${t.package}${failInfo}`)
    }
  }

  return results
}

module.exports = { runSvelteCheckPhase }

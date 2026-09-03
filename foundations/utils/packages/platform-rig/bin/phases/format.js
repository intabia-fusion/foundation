/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

const { performance } = require('perf_hooks')
const { join } = require('path')
const fs = require('fs')

// Parse srcDir from `_phase:format` script (e.g. "format src", "format tests").
// Returns 'src' if not parseable.
function parseSrcDir(phaseFormat) {
  if (typeof phaseFormat !== 'string') return 'src'
  const tokens = phaseFormat.trim().split(/\s+/)
  if (tokens[0] !== 'format') return 'src'
  const arg = tokens.slice(1).find((t) => !t.startsWith('-'))
  return arg || 'src'
}

// Estimate package weight by counting source files. Heavier packages first = shorter tail.
function estimatePackageWeight(cwd, srcDir = 'src') {
  let count = 0
  const stack = [join(cwd, srcDir)]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (!fs.existsSync(dir)) continue
    try {
      for (const entry of fs.readdirSync(dir)) {
        const full = join(dir, entry)
        const stat = fs.lstatSync(full)
        if (stat.isDirectory()) stack.push(full)
        else if (/\.(ts|svelte|js)$/.test(entry) && !entry.endsWith('.d.ts')) count++
      }
    } catch {}
  }
  return count
}

const { isPhaseCached, markPhaseCompleted, calculatePackageHash } = require('../libs/cache')
const { getNamedWorkerPool } = require('../libs/workers')
const { getOptimalWorkerCount } = require('../libs/utils')
const { success, error, dim } = require('../libs/colors')

/**
 * Run format phase for all packages.
 * Hash is per-package only (no deps) — formatting is local to the package.
 */
async function runFormatPhase(graph, packageNames, concurrency, options = {}) {
  const { force = false, packageHashes } = options

  // Format workers retain @typescript-eslint/parser Program per package (unavoidable leak).
  // Cap concurrency + aggressive recycle to keep total memory bounded.
  const plan = getOptimalWorkerCount(concurrency, 'format')
  const formatConcurrency = process.env.FAST_BUILD_FORMAT_WORKERS
    ? parseInt(process.env.FAST_BUILD_FORMAT_WORKERS, 10)
    : plan.workers

  const results = {
    successCount: 0,
    cacheHits: 0,
    total: packageNames.length,
    errors: [],
    time: 0,
    peakMemoryMB: 0
  }

  const startTime = performance.now()
  // Each package loads a fresh @typescript-eslint/parser Program that is retained forever
  // in the plugin's internal programCache. Recycle aggressively by memory threshold.
  const pool = await getNamedWorkerPool('format', formatConcurrency, join(__dirname, '..', 'format-worker.js'), {
    workerOptions: {
      resourceLimits: {
        maxOldGenerationSizeMb: parseInt(process.env.FAST_BUILD_FORMAT_HEAP_MB ?? String(plan.heapMB), 10),
        maxYoungGenerationSizeMb: 256
      }
    },
    // The worker clears the parser's Program cache after each package, so recycling is a
    // memory backstop rather than the primary mechanism. recycleAfter: 2 respawned a thread
    // (and re-required eslint/prettier/typescript) roughly 200 times over a full format run.
    recycleAfter: 25,
    // Must stay below maxOldGenerationSizeMb, or the worker hits the hard limit first.
    recycleMemoryMB: Math.floor(plan.heapMB * 0.8)
  })

  let completedCount = 0
  const timings = []

  // Longest-first scheduling: heavy packages go into queue early so tail isn't starved
  const sortedNames = [...packageNames].sort((a, b) => {
    const na = graph.get(a)
    const nb = graph.get(b)
    const wa = (na && na.project) ? estimatePackageWeight(na.project.fullPath, parseSrcDir(na.phaseFormat)) : 0
    const wb = (nb && nb.project) ? estimatePackageWeight(nb.project.fullPath, parseSrcDir(nb.phaseFormat)) : 0
    return wb - wa
  })

  const promises = sortedNames.map(async (name) => {
    const node = graph.get(name)

    if (!node.phaseFormat) {
      completedCount++
      results.successCount++
      results.cacheHits++
      return
    }

    const cwd = node.project.fullPath
    const hash = packageHashes ? packageHashes.get(name) : undefined

    if (!force && hash && isPhaseCached(cwd, hash, 'format', null, [])) {
      completedCount++
      results.successCount++
      results.cacheHits++
      console.log(`    [F] ${completedCount}/${packageNames.length} ${dim(name)} ${dim('(cached)')}`)
      return
    }

    const taskStart = performance.now()
    const srcDir = parseSrcDir(node.phaseFormat)
    const result = await pool.runTask('format', cwd, { srcDir })
    const waitTime = Math.round(performance.now() - taskStart)
    // Actual in-worker duration reported by worker; fallback to full wait time
    const taskTime = result.durationMs !== undefined ? result.durationMs : waitTime
    completedCount++

    timings.push({ package: name, time: taskTime, failed: !result.success })

    if (result.memoryMB !== undefined && result.memoryMB > results.peakMemoryMB) {
      results.peakMemoryMB = result.memoryMB
    }

    if (result.success) {
      // After formatting, file mtimes change → package hash changes.
      // Store the NEW hash so the next run sees the files as up-to-date.
      const finalHash = result.changed > 0 ? calculatePackageHash(cwd) : hash
      if (finalHash) {
        markPhaseCompleted(cwd, finalHash, 'format', null, [])
      }
      results.successCount++
      const changedInfo = result.changed !== undefined ? ` (${result.changed} changed)` : ''
      const memInfo = result.memoryMB !== undefined ? ` ${dim(result.memoryMB + 'MB')}` : ''
      console.log(`    [F] ${completedCount}/${packageNames.length} ${success(name)} formatted ${dim(taskTime + 'ms')}${memInfo}${changedInfo}`)
    } else {
      results.errors.push({ package: name, error: result.error })
      console.error(`    [F] ${completedCount}/${packageNames.length} ${error(name)} FAILED ${dim(taskTime + 'ms')}`)
      if (result.lintOutput) process.stderr.write(result.lintOutput + '\n')
      if (result.errors && result.errors.length > 0) {
        process.stderr.write(result.errors.join('\n') + '\n')
      }
    }
  })

  await Promise.all(promises)
  results.time = performance.now() - startTime

  if (timings.length > 0) {
    const sorted = timings.sort((a, b) => b.time - a.time)
    const slowCount = Math.min(5, sorted.length)
    console.log(`\n    Top ${slowCount} slowest format packages:`)
    for (let i = 0; i < slowCount; i++) {
      const t = sorted[i]
      const failInfo = t.failed ? ' FAILED' : ''
      console.log(`      ${(t.time / 1000).toFixed(1)}s ${t.package}${failInfo}`)
    }
  }
  if (results.peakMemoryMB > 0) {
    console.log(`    Peak worker memory: ${results.peakMemoryMB}MB`)
  }

  return results
}

module.exports = { runFormatPhase }

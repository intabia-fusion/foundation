/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

/**
 * Build phase - one native tsc pass per package, emitting JS and .d.ts together.
 * Replaces the former transpile (esbuild) + validate (ts.createProgram) pair.
 */

const { join } = require('path')
const { spawn } = require('child_process')
const { performance } = require('perf_hooks')

const { markPhaseCompleted, getPhaseMetadata, calculateOutputHashForDirs } = require('../libs/cache')
const { computeTypesHashes, compositeHashFromTypes } = require('../libs/composite-hash')
const { resolveTsc7 } = require('../compile.js')

const COLORS = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m' }
const success = (t) => `${COLORS.green}${t}${COLORS.reset}`
const error = (t) => `${COLORS.red}${t}${COLORS.reset}`
const dim = (t) => `${COLORS.dim}${t}${COLORS.reset}`

// Esbuild is still needed for the one svelte package that compiles .svelte to JS.
async function runEsbuildPackage (packagePath) {
  const { collectFiles, performESBuildWithSvelte, generateSvelteTypes } = require('../compile.js')
  const files = collectFiles(join(packagePath, 'src'))
  await performESBuildWithSvelte(files, { cwd: packagePath })
  await generateSvelteTypes({ cwd: packagePath })
}

function runTsc (packagePath, emitDeclarationOnly) {
  return new Promise((resolve) => {
    const args = ['-p', 'tsconfig.json', '--tsBuildInfoFile', join('.build', 'build.tsbuildinfo')]
    if (emitDeclarationOnly) args.push('--emitDeclarationOnly')
    let out = ''
    const child = spawn(resolveTsc7(), args, { cwd: packagePath })
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', (err) => resolve({ success: false, error: err }))
    child.on('close', (code) => {
      if (code === 0) resolve({ success: true })
      else resolve({ success: false, error: new Error(out.trim() || `tsc exited with ${code}`) })
    })
  })
}

/**
 * @param {Map<string, object>} graph
 * @param {string[]} packageNames
 * @param {number} concurrency max tsc processes in flight
 * @param {object} options
 * @param {boolean} [options.force]
 * @param {Map<string, string>} options.packageHashes
 */
async function runBuildPhase (graph, packageNames, concurrency, options = {}) {
  const { force = false, packageHashes } = options
  const startTime = performance.now()
  const results = {
    successCount: 0,
    cacheHits: 0,
    total: packageNames.length,
    errors: [],
    time: 0,
    changedPackages: new Set()
  }
  if (packageNames.length === 0) {
    results.time = 0
    return results
  }

  // Seeded from disk so packages outside this set still contribute a real hash.
  const typesHashes = computeTypesHashes(graph)
  const inSet = new Set(packageNames)
  const timings = []
  let completedCount = 0

  const state = new Map()
  for (const name of packageNames) {
    const node = graph.get(name)
    const deps = [...node.dependencies].filter((d) => inSet.has(d))
    state.set(name, { node, deps, remaining: deps.length, dependents: [] })
  }
  for (const [name, s] of state) {
    for (const d of s.deps) state.get(d).dependents.push(name)
  }

  async function buildPackage (name) {
    const s = state.get(name)
    const node = s.node
    const packagePath = node.project.fullPath
    const isUi = node.phaseBuild === 'compile build-ui'
    const isEsbuild = node.phaseBuild === 'compile ui-esbuild'
    const outputDirs = isUi ? ['types'] : ['lib', 'types']
    const pkgStart = performance.now()

    // A dependency is visible only through its .d.ts, so that is the input, not its sources.
    const packageHash = compositeHashFromTypes(name, graph, packageHashes, typesHashes, ['tsconfig.json'])

    // Must hash the same dirs as markPhaseCompleted, or the cache never hits.
    const outputHash = calculateOutputHashForDirs(packagePath, outputDirs)
    const typesHash = isUi ? outputHash : calculateOutputHashForDirs(packagePath, ['types'])
    if (typesHash) typesHashes.set(name, typesHash)

    const cached = packageHash ? getPhaseMetadata(packagePath, packageHash, 'build') : null
    const outputsMatch = cached != null && (cached.outputHash == null || cached.outputHash === outputHash)
    if (!force && packageHash && outputsMatch) {
      results.successCount++
      results.cacheHits++
      return
    }

    // tsc's own incremental state does not notice that outputs were deleted, so --force
    // has to drop it too or nothing is re-emitted.
    if (force) {
      try {
        require('fs').rmSync(join(packagePath, '.build', 'build.tsbuildinfo'), { force: true })
      } catch {}
    }

    const result = isEsbuild
      ? await runEsbuildPackage(packagePath).then(() => ({ success: true }), (err) => ({ success: false, error: err }))
      : await runTsc(packagePath, isUi)
    const pkgTime = Math.round(performance.now() - pkgStart)

    if (result.success) {
      results.successCount++
      results.changedPackages.add(name)
      const fresh = calculateOutputHashForDirs(packagePath, ['types'])
      if (fresh) typesHashes.set(name, fresh)
      if (packageHash) markPhaseCompleted(packagePath, packageHash, 'build', null, outputDirs)
      console.log(`    ${success('B')} ${dim(completedCount + 1)}/${packageNames.length} ${name} ${success('built')} ${dim(pkgTime + 'ms')}`)
      timings.push({ package: name, time: pkgTime })
    } else {
      results.errors.push({ package: name, error: result.error })
      console.error(`    ${error('B')} ${dim(completedCount + 1)}/${packageNames.length} ${name} ${error('FAILED')} ${dim(pkgTime + 'ms')}`)
      console.error(String(result.error.message ?? result.error).split('\n').slice(0, 8).map((l) => '      ' + l).join('\n'))
      timings.push({ package: name, time: pkgTime, failed: true })
    }
  }

  console.log(`\n=== Phase: Building ${packageNames.length} packages ===`)
  console.log(`    Using ${concurrency} workers`)

  // Ready-queue, not waves: a package starts as soon as its own dependencies are done.
  const ready = packageNames.filter((n) => state.get(n).remaining === 0)
  let running = 0
  let done = 0

  await new Promise((resolve, reject) => {
    const pump = () => {
      if (done === packageNames.length) { resolve(); return }
      if (running === 0 && ready.length === 0) {
        reject(new Error('Circular dependency detected in build phase'))
        return
      }
      while (running < concurrency && ready.length > 0) {
        const name = ready.shift()
        running++
        buildPackage(name).then(() => {
          running--
          done++
          completedCount++
          for (const dep of state.get(name).dependents) {
            if (--state.get(dep).remaining === 0) ready.push(dep)
          }
          pump()
        }, reject)
      }
    }
    pump()
  })

  results.time = performance.now() - startTime

  console.log(`\nBuilt: ${results.successCount}/${results.total} packages in ${Math.round(results.time)}ms`)
  if (results.cacheHits > 0) console.log(`  (${results.cacheHits} from cache)`)

  if (timings.length > 0) {
    const sorted = timings.sort((a, b) => b.time - a.time)
    const slowCount = Math.min(10, sorted.length)
    console.log(`\n    Top ${slowCount} slowest packages:`)
    for (let i = 0; i < slowCount; i++) {
      const t = sorted[i]
      console.log(`      ${(t.time / 1000).toFixed(1)}s ${t.package}${t.failed ? ' FAILED' : ''}`)
    }
  }

  return results
}

module.exports = { runBuildPhase }

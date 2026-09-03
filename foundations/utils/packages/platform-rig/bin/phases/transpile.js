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
 * Transpile phase - synchronous execution
 * Fast esbuild transpilation with change detection
 */

const { join } = require('path')
const { existsSync } = require('fs')
const { performance } = require('perf_hooks')

const {
  isPhaseCached,
  markPhaseCompleted,
  invalidatePhase
} = require('../libs/cache')

// ANSI color codes
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
}

function color(text, colorCode) {
  return `${colorCode}${text}${COLORS.reset}`
}

function success(text) { return color(text, COLORS.green) }
function error(text) { return color(text, COLORS.red) }
function dim(text) { return color(text, COLORS.dim) }

async function runTranspilePhase(graph, packageNames, concurrency, options = {}) {
  const { force = false, packageHashes } = options
  const { collectFiles, performESBuild, performESBuildWithSvelte, generateSvelteTypes } = require('../compile.js')

  const startTime = performance.now()
  const results = {
    successCount: 0,
    skippedCount: 0,
    total: packageNames.length,
    errors: [],
    time: 0,
    changedPackages: new Set()
  }

  // Group packages by waves based on dependencies
  const pending = new Set(packageNames)
  const completed = new Set()
  let completedCount = 0

  // Track which packages had upstream changes (need rebuild even if own src unchanged)
  const upstreamChanged = new Set()

  async function transpilePackage(packageName) {
    const node = graph.get(packageName)
    const srcDir = node.phaseBuild === 'compile transpile tests' ? 'tests' : 'src'
    const isUiEsbuild = node.phaseBuild === 'compile ui-esbuild'
    const packagePath = node.project.fullPath

    // Get pre-calculated package hash
    const packageHash = packageHashes?.get(packageName)
    if (!packageHash) {
      // Fallback: if no hash provided, always build
      console.log(`    Warning: No hash for ${packageName}, forcing build`)
    }

    // Check if any dependency changed
    const hasUpstreamChanges = [...node.dependencies]
      .filter(d => packageNames.includes(d))
      .some(d => upstreamChanged.has(d))

    // ui-esbuild produces both lib/ and types/, regular transpile produces only lib/
    const outputDirs = isUiEsbuild ? ['lib', 'types'] : ['lib']
    const outputsExist = outputDirs.every(d => existsSync(join(packagePath, d)))

    // Skip if cached and no upstream changes and outputs exist
    if (!force && !hasUpstreamChanges && outputsExist && packageHash) {
      if (isPhaseCached(packagePath, packageHash, 'transpile', null, outputDirs)) {
        return { success: true, filesCount: 0, skipped: true }
      }
    }

    // Only this phase is stale; other phases keep their own hashes.
    if (force || hasUpstreamChanges) {
      invalidatePhase(packagePath, 'transpile')
    }

    try {
      const filesToTranspile = collectFiles(join(packagePath, srcDir))
      if (filesToTranspile.length === 0) {
        if (packageHash) {
          markPhaseCompleted(packagePath, packageHash, 'transpile', null, outputDirs)
        }
        return { success: true, filesCount: 0 }
      }

      const relativeFiles = filesToTranspile.map(f => f.replace(packagePath + '/', ''))

      if (isUiEsbuild) {
        await performESBuildWithSvelte(filesToTranspile, { cwd: packagePath })
        await generateSvelteTypes({ cwd: packagePath })
      } else {
        await performESBuild(relativeFiles, { srcDir, cwd: packagePath, outDir: 'lib' })
      }

      // Mark phase as completed
      if (packageHash) {
        markPhaseCompleted(packagePath, packageHash, 'transpile', null, outputDirs)
      }

      // Mark this package as changed
      upstreamChanged.add(packageName)
      results.changedPackages.add(packageName)

      return { success: true, filesCount: relativeFiles.length }
    } catch (err) {
      return { success: false, error: err }
    }
  }

  // Process in dependency order waves
  while (completed.size < packageNames.length) {
    // Find packages ready to transpile (all deps completed)
    const ready = []
    for (const name of pending) {
      const node = graph.get(name)
      const depsCompleted = [...node.dependencies].filter(d => packageNames.includes(d))
        .every(d => completed.has(d))
      if (depsCompleted) {
        ready.push(name)
      }
    }

    if (ready.length === 0) {
      throw new Error('Circular dependency detected in transpile phase')
    }

    // Transpile ready packages in parallel
    const transpilePromises = ready.map(async (name) => {
      const result = await transpilePackage(name)
      completedCount++

      if (result.success) {
        if (result.skipped) {
          results.skippedCount++
          results.successCount++
        } else {
          results.successCount++
          const svelteInfo = graph.get(name).phaseBuild === 'compile ui-esbuild' ? ' (svelte)' : ''
          console.log(`    ${success('T')} ${dim(completedCount)}/${packageNames.length} ${name} ${success('transpiled')}${svelteInfo} ${dim('(' + result.filesCount + ' files)')}`)
        }
      } else {
        results.errors.push({ package: name, error: result.error })
        console.error(`    ${error('T')} ${dim(completedCount)}/${packageNames.length} ${name} ${error('FAILED')}`)
      }

      completed.add(name)
      pending.delete(name)
    })

    await Promise.all(transpilePromises)
  }

  if (results.skippedCount > 0) {
    console.log(`    (${results.skippedCount} packages unchanged, skipped)`)
  }

  results.time = performance.now() - startTime
  return results
}

module.exports = { runTranspilePhase }

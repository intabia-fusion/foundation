/**
 * Package phase with unified caching
 */
const { spawn } = require('child_process')
const { performance } = require('perf_hooks')
const { join } = require('path')
const fs = require('fs')

const {
  isPhaseCached,
  markPhaseCompleted
} = require('../libs/cache')

/**
 * Check if package output exists (dist/ directory)
 */
function hasPackageOutput(cwd) {
  const distPath = join(cwd, 'dist')
  return fs.existsSync(distPath) && fs.statSync(distPath).isDirectory()
}

async function runPackagePhase(graph, packageNames, concurrency, options = {}) {
  const { force = false, packageHash } = options

  const results = {
    successCount: 0,
    cacheHits: 0,
    total: packageNames.length,
    errors: [],
    time: 0
  }

  async function packagePackage(packageName) {
    const node = graph.get(packageName)
    const cwd = node.project.fullPath

    // Check cache using pre-calculated package hash
    if (!force && packageHash) {
      if (isPhaseCached(cwd, packageHash, 'package', hasPackageOutput, ['dist'])) {
        return { success: true, fromCache: true }
      }
    }

    return new Promise((resolve) => {
      const startTime = performance.now()
      const child = spawn('pnpm', ['run', 'package'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''
      let progressInterval = null
      let progressTimeout = null
      let isCompleted = false

      // Setup progress logging for long-running packages (>15s)
      const setupProgressLogging = () => {
        const checkProgress = () => {
          if (isCompleted) return
          const elapsed = Math.round((performance.now() - startTime) / 1000)
          if (elapsed >= 15) {
            console.log(`    [package] ${packageName} still packaging... (${elapsed}s elapsed)`)
          }
        }
        
        // First check after 15 seconds
        progressTimeout = setTimeout(() => {
          if (isCompleted) return
          checkProgress()
          // Then every 15 seconds
          if (!isCompleted) {
            progressInterval = setInterval(checkProgress, 15000)
          }
        }, 15000)
      }

      setupProgressLogging()

      child.stdout?.on('data', (data) => {
        stdout += data.toString()
      })
      child.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        isCompleted = true
        const time = performance.now() - startTime
        
        // Clear progress timers
        if (progressTimeout) {
          clearTimeout(progressTimeout)
          progressTimeout = null
        }
        if (progressInterval) {
          clearInterval(progressInterval)
          progressInterval = null
        }

        if (code === 0) {
          if (packageHash) {
            markPhaseCompleted(cwd, packageHash, 'package', null, ['dist'])
          }
          resolve({ success: true, time })
        } else {
          const error = new Error(`Package failed with exit code ${code}`)
          error.stdout = stdout
          error.stderr = stderr
          resolve({ success: false, error, time })
        }
      })

      child.on('error', (err) => {
        isCompleted = true
        // Clear progress timers on error
        if (progressTimeout) {
          clearTimeout(progressTimeout)
          progressTimeout = null
        }
        if (progressInterval) {
          clearInterval(progressInterval)
          progressInterval = null
        }
        resolve({ success: false, error: err })
      })
    })
  }

  // Process packages
  const promises = packageNames.map(async (name) => {
    const result = await packagePackage(name)
    if (result.success) {
      results.successCount++
      if (result.fromCache) results.cacheHits++
    } else {
      results.errors.push({ package: name, error: result.error })
    }
    return result
  })

  await Promise.all(promises)
  return results
}

module.exports = { runPackagePhase }

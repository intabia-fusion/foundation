/**
 * Test phase — runs `pnpm run test` for packages with `_phase:test`
 */
const { spawn } = require('child_process')
const { performance } = require('perf_hooks')
const { join } = require('path')
const { readdirSync } = require('fs')

const crypto = require('crypto')

const {
  isPhaseCached,
  markPhaseCompleted
} = require('../libs/cache')
const { success, error, dim, colorizeErrorMessage } = require('../libs/colors')

// Environment variables that affect test execution and should invalidate cache
const TEST_ENV_VARS = [
  'DB_URL',
  'ELASTIC_URL',
  'MONGO_URL'
]

/**
 * Compute a hash suffix from test-relevant environment variables.
 * When any of these change, the test cache is invalidated.
 */
function getTestEnvHash () {
  const parts = TEST_ENV_VARS
    .map(name => `${name}=${process.env[name] ?? ''}`)
    .sort()
  return crypto.createHash('md5').update(parts.join('\n')).digest('hex').substring(0, 8)
}

/**
 * Check if a directory contains any test files (*.test.ts, *.spec.ts, *.test.js, *.spec.js)
 */
function hasTestFiles (dir) {
  const testPattern = /\.(test|spec)\.(ts|js|tsx|jsx)$/
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.svelte-check') continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (hasTestFiles(fullPath)) return true
      } else if (testPattern.test(entry.name)) {
        return true
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  return false
}

async function runTestPhase (graph, packageNames, concurrency, options = {}) {
  const { force = false, packageHashes, verbose = false } = options

  const results = {
    successCount: 0,
    cacheHits: 0,
    skippedCount: 0,
    total: packageNames.length,
    errors: [],
    time: 0
  }

  const startTime = performance.now()
  let completedCount = 0
  const timings = []
  const envHash = getTestEnvHash()

  console.log(`    Using ${concurrency} test workers`)

  async function testPackage (packageName) {
    const node = graph.get(packageName)
    const cwd = node.project.fullPath
    const baseHash = packageHashes?.get(packageName)
    // Include env vars in hash so cache invalidates when test env changes
    const packageHash = baseHash ? `${baseHash}-${envHash}` : undefined

    // Check cache
    if (!force && packageHash) {
      if (isPhaseCached(cwd, packageHash, 'test', null, [])) {
        return { success: true, fromCache: true }
      }
    }

    // Skip packages without any test files — avoids ~2s jest startup overhead per package
    if (!hasTestFiles(cwd)) {
      if (packageHash) {
        markPhaseCompleted(cwd, packageHash, 'test', null, [])
      }
      return { success: true, skipped: true }
    }

    return new Promise((resolve) => {
      const pkgStart = performance.now()
      const child = spawn('pnpm', ['run', 'test'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''
      let progressInterval = null
      let progressTimeout = null
      let isCompleted = false

      const setupProgressLogging = () => {
        const checkProgress = () => {
          if (isCompleted) return
          const elapsed = Math.round((performance.now() - pkgStart) / 1000)
          if (elapsed >= 15) {
            console.log(`    [test] ${packageName} still testing... (${elapsed}s elapsed)`)
          }
        }

        progressTimeout = setTimeout(() => {
          if (isCompleted) return
          checkProgress()
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
        const time = performance.now() - pkgStart

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
            markPhaseCompleted(cwd, packageHash, 'test', null, [])
          }
          resolve({ success: true, time })
        } else {
          const err = new Error(`Test failed with exit code ${code}`)
          err.stdout = stdout
          err.stderr = stderr
          resolve({ success: false, error: err, time })
        }
      })

      child.on('error', (err) => {
        isCompleted = true
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

  // Process packages with concurrency limit
  const chunks = []
  for (let i = 0; i < packageNames.length; i += concurrency) {
    chunks.push(packageNames.slice(i, i + concurrency))
  }

  for (const chunk of chunks) {
    const promises = chunk.map(async (name) => {
      const result = await testPackage(name)
      completedCount++
      if (result.success) {
        results.successCount++
        if (result.fromCache) {
          results.cacheHits++
          if (verbose) {
            console.log(`    ${success('T')} ${dim(completedCount)}/${packageNames.length} ${dim(name)} ${dim('(cached)')}`)
          }
        } else if (result.skipped) {
          results.skippedCount++
          if (verbose) {
            console.log(`    ${success('T')} ${dim(completedCount)}/${packageNames.length} ${dim(name)} ${dim('(no tests)')}`)
          }
        } else {
          const time = result.time ? Math.round(result.time) + 'ms' : ''
          timings.push({ package: name, time: Math.round(result.time || 0), failed: false })
          console.log(`    ${success('T')} ${dim(completedCount)}/${packageNames.length} ${name} ${success('passed')} ${dim(time)}`)
        }
      } else {
        results.errors.push({ package: name, error: result.error })
        const time = result.time ? Math.round(result.time) + 'ms' : ''
        timings.push({ package: name, time: Math.round(result.time || 0), failed: true })
        console.error(`    ${error('T')} ${dim(completedCount)}/${packageNames.length} ${name} ${error('FAILED')} ${dim(time)}`)
        if (result.error?.stderr) {
          const lines = result.error.stderr.split('\n').filter(l => l.trim()).slice(-5)
          for (const line of lines) {
            const { colored } = colorizeErrorMessage(line)
            console.error(`      ${colored}`)
          }
        }
      }
      return result
    })

    await Promise.all(promises)
  }

  results.time = performance.now() - startTime

  // Print timing summary
  if (timings.length > 0) {
    const sorted = timings.sort((a, b) => b.time - a.time)
    const slowCount = Math.min(10, sorted.length)
    console.log(`\n    Top ${slowCount} slowest test packages:`)
    for (let i = 0; i < slowCount; i++) {
      const t = sorted[i]
      const failInfo = t.failed ? ' FAILED' : ''
      console.log(`      ${(t.time / 1000).toFixed(1)}s ${t.package}${failInfo}`)
    }
  }

  return results
}

module.exports = { runTestPhase }

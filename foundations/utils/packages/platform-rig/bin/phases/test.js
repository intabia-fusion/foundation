/**
 * Test phase — runs `pnpm run test` for packages with `_phase:test`
 */
const { spawn } = require('child_process')
const { performance } = require('perf_hooks')
const { join } = require('path')
const { readdirSync } = require('fs')

const crypto = require('crypto')
const PNPM_CMD = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const {
  isPhaseCached,
  markPhaseCompleted
} = require('../libs/cache')
const { planTestRun, findJestBin, hasTestFiles, buildSharedConfig } = require('../libs/test-groups')
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
 * Runs one jest over every shared package via `projects`, then maps the report back so each
 * package keeps its own pass/fail and cache entry. jest's own reporter goes straight to the
 * terminal; the machine-readable copy lands in a temp file.
 */
async function runShared (shared, jestBin) {
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('fs')
  const { tmpdir } = require('os')
  const dir = mkdtempSync(join(tmpdir(), 'jest-shared-'))
  const configPath = join(dir, 'jest.config.js')
  const jsonPath = join(dir, 'report.json')
  const { projects, testTimeout } = buildSharedConfig(shared)
  writeFileSync(configPath, `module.exports = ${JSON.stringify({ projects }, null, 2)}\n`)

  const args = ['-c', configPath, ...shared.flags, '--json', `--outputFile=${jsonPath}`]
  if (testTimeout !== undefined) args.push(`--testTimeout=${testTimeout}`)
  const started = performance.now()
  // jest prints a line per suite; captured here so a green run stays quiet, replayed on failure.
  const child = spawn(jestBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.on('data', (d) => { output += d.toString() })
  child.stderr?.on('data', (d) => { output += d.toString() })
  const heartbeat = setInterval(() => {
    console.log(`    [test] shared jest still running... (${Math.round((performance.now() - started) / 1000)}s elapsed)`)
  }, 15000)
  await new Promise((resolve) => {
    child.on('close', resolve)
    child.on('error', () => resolve(-1))
  })
  clearInterval(heartbeat)
  const wall = performance.now() - started

  // Attribute every suite to the package it lives in, longest path first so nested dirs win.
  const byPackage = new Map(shared.packages.map((p) => [p.name, { time: 0, failed: false, details: [] }]))
  const sorted = [...shared.packages].sort((a, b) => b.cwd.length - a.cwd.length)
  let parsed = false
  if (existsSync(jsonPath)) {
    try {
      const report = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      parsed = true
      for (const suite of report.testResults ?? []) {
        const owner = sorted.find((pkg) => suite.name.startsWith(pkg.cwd + '/'))
        if (owner === undefined) continue
        const acc = byPackage.get(owner.name)
        acc.time += suite.endTime - suite.startTime
        if (suite.status === 'failed') {
          acc.failed = true
          if (suite.message) acc.details.push(suite.message.trimEnd())
        }
      }
    } catch { /* handled below */ }
  }
  rmSync(dir, { recursive: true, force: true })

  // No report means we cannot tell packages apart; fail them all rather than cache a bad pass.
  if (!parsed) {
    for (const acc of byPackage.values()) acc.failed = true
  }
  return { byPackage, wall, parsed, output }
}

async function runTestPhase (graph, packageNames, concurrency, options = {}) {
  const { force = false, packageHashes, verbose = false, group: groupEnabled = true } = options

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

  const hashOf = (packageName) => {
    const baseHash = packageHashes?.get(packageName)
    // Include env vars in hash so cache invalidates when test env changes
    return baseHash ? `${baseHash}-${envHash}` : undefined
  }

  async function testPackage (packageName) {
    const node = graph.get(packageName)
    const cwd = node.project.fullPath
    const packageHash = hashOf(packageName)

    return new Promise((resolve) => {
      const pkgStart = performance.now()
      const child = spawn(PNPM_CMD, ['run', 'test'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true
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

  function report (name, result) {
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
      if (result.details) {
        for (const line of result.details.split('\n')) console.error(`      ${line}`)
      } else if (result.error?.stderr) {
        const lines = result.error.stderr.split('\n').filter(l => l.trim()).slice(-5)
        for (const line of lines) {
          const { colored } = colorizeErrorMessage(line)
          console.error(`      ${colored}`)
        }
      }
    }
    return result
  }

  // Pre-pass: cache hits and packages without tests never reach jest.
  const pending = []
  for (const name of packageNames) {
    const cwd = graph.get(name).project.fullPath
    const packageHash = hashOf(name)
    if (!force && packageHash && isPhaseCached(cwd, packageHash, 'test', null, [])) {
      report(name, { success: true, fromCache: true })
      continue
    }
    // Skip packages without any test files — avoids ~2s jest startup overhead per package
    if (!hasTestFiles(cwd)) {
      if (packageHash) markPhaseCompleted(cwd, packageHash, 'test', null, [])
      report(name, { success: true, skipped: true })
      continue
    }
    pending.push({ name, cwd })
  }

  let solo = pending.map((p) => p.name)
  let exclusive = []
  if (groupEnabled && pending.length > 0) {
    const { shared, isolated } = planTestRun(pending)
    const jestBin = shared == null ? null : findJestBin(shared.packages)
    if (shared != null && jestBin != null) {
      solo = isolated.filter((i) => !i.exclusive).map((i) => i.name)
      exclusive = isolated.filter((i) => i.exclusive).map((i) => i.name)
      console.log(`    Running ${shared.packages.length} packages as one jest, ${isolated.length} on their own`)
      if (verbose) {
        for (const i of isolated) console.log(`      ${dim(i.name)} ${dim('— ' + i.reason)}`)
      }
      const { byPackage, parsed, output } = await runShared(shared, jestBin)
      // Without a report there is nothing to attribute, so the raw tail is all we have.
      if (!parsed) console.error(output.split('\n').slice(-200).join('\n'))
      for (const pkg of shared.packages) {
        const acc = byPackage.get(pkg.name)
        if (acc.failed) {
          const err = new Error(parsed ? 'Test failed in the shared jest run' : 'Shared jest run produced no report')
          report(pkg.name, { success: false, error: err, time: acc.time, details: acc.details.join('\n\n') })
        } else {
          const packageHash = hashOf(pkg.name)
          if (packageHash) markPhaseCompleted(pkg.cwd, packageHash, 'test', null, [])
          report(pkg.name, { success: true, time: acc.time })
        }
      }
    }
  }

  // These say they need the stand to themselves, so they get it: one at a time.
  for (const name of exclusive) {
    report(name, await testPackage(name))
  }

  // Whatever could not be shared still runs package by package.
  for (let i = 0; i < solo.length; i += concurrency) {
    await Promise.all(solo.slice(i, i + concurrency).map(async (name) => {
      report(name, await testPackage(name))
    }))
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

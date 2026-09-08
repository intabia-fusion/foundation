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

// Most packages can run as projects of a single jest invocation, which pays the ~2s jest bootstrap
// once instead of once per package. A few cannot, and say so themselves.

const { existsSync, readFileSync, readdirSync } = require('fs')
const { join } = require('path')
const { listWorkspaceProjects, findWorkspaceRoot } = require('./workspace')

const TEST_FILE = /\.(test|spec)\.(ts|js|tsx|jsx)$/

/** A package with no test file at all is not worth a jest project, nor a jest process. */
function hasTestFiles (dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.svelte-check') continue
    if (e.isDirectory()) {
      if (hasTestFiles(join(dir, e.name))) return true
    } else if (TEST_FILE.test(e.name)) {
      return true
    }
  }
  return false
}

/** Every workspace package that has tests, as planTestRun wants them. */
function collectTestEntries (rootDir = findWorkspaceRoot()) {
  return listWorkspaceProjects(rootDir)
    .filter((p) => hasTestFiles(p.fullPath))
    .map((p) => ({ name: p.name, cwd: p.fullPath }))
}

// Process-wide flags that are safe to apply to everyone in the shared run.
const SHARED_FLAGS = new Set(['--passWithNoTests', '--silent', '--forceExit'])
// Coverage is per-run, not per-project. No package sets a coverageThreshold and CI does not read
// the reports, so the shared run drops it; `pnpm test --no-test-group` still collects it.
const DROPPED_FLAGS = new Set(['--coverage'])

function classify (entry) {
  const pkgJsonPath = join(entry.cwd, 'package.json')
  if (!existsSync(pkgJsonPath)) return { isolated: 'no package.json' }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))

  if (pkg.testIsolated === true) return { isolated: 'testIsolated in package.json', exclusive: true }

  const script = pkg.scripts?.test
  if (script == null) return { isolated: 'no test script' }
  const parts = script.trim().split(/\s+/)
  if (parts[0] !== 'jest') return { isolated: 'test script is not jest' }

  const flags = []
  for (const p of parts.slice(1)) {
    if (SHARED_FLAGS.has(p)) flags.push(p)
    else if (DROPPED_FLAGS.has(p)) continue
    else return { isolated: `unsupported flag ${p}` }
  }

  const configPath = join(entry.cwd, 'jest.config.js')
  if (!existsSync(configPath)) return { isolated: 'no jest.config.js' }
  // jest does not nest: a config that is itself a multi-project cannot become one of our projects.
  if (/\bprojects\s*:/.test(readFileSync(configPath, 'utf-8'))) return { isolated: 'config uses projects' }

  return { flags }
}


// jest validates a project config against the project schema, where these are not allowed: they
// belong to the run as a whole. Left in place they only produce "Unknown option" warnings and are
// ignored, so the shared run strips them and lifts what it can to the top level.
const GLOBAL_ONLY_KEYS = [
  'collectCoverage',
  'coverageDirectory',
  'coverageReporters',
  'coveragePathIgnorePatterns',
  'coverageProvider',
  'forceExit',
  'testTimeout',
  'bail',
  'verbose',
  'silent',
  'maxWorkers',
  'notify',
  'notifyMode',
  'reporters',
  'watchman'
]

/**
 * Turns the planned packages into an inline `projects` array: each package's own config with the
 * run-wide keys removed, an explicit rootDir, and its name as displayName so jest's output says
 * which package a test came from.
 * @returns {{projects: object[], testTimeout: number | undefined}}
 */
function buildSharedConfig (shared) {
  const projects = []
  let testTimeout
  for (const pkg of shared.packages) {
    const raw = require(join(pkg.cwd, 'jest.config.js'))
    const config = { ...(typeof raw === 'function' ? raw() : raw) }
    // A per-project timeout cannot survive, but the longest one can stand for the whole run.
    if (typeof config.testTimeout === 'number') {
      testTimeout = Math.max(testTimeout ?? 0, config.testTimeout)
    }
    for (const key of GLOBAL_ONLY_KEYS) delete config[key]
    // ts-jest looks for tsconfig.json on its own and silently falls back to its defaults
    // (moduleResolution node10, which TS 6 rejects) when it misses. Point it at the package's own.
    const tsconfig = join(pkg.cwd, 'tsconfig.json')
    if (config.preset === 'ts-jest' && config.transform === undefined && existsSync(tsconfig)) {
      config.transform = { '^.+\\.[cm]?[jt]sx?$': ['ts-jest', { tsconfig }] }
    }
    projects.push({ ...config, rootDir: pkg.cwd, displayName: pkg.name })
  }
  return { projects, testTimeout }
}

/**
 * @param {Array<{name: string, cwd: string}>} entries
 * @returns {{shared: {packages: Array<{name: string, cwd: string}>, flags: string[]}, isolated: Array<{name: string, reason: string}>}}
 */
function planTestRun (entries) {
  const packages = []
  const flags = new Set()
  const isolated = []
  for (const entry of entries) {
    const verdict = classify(entry)
    if (verdict.isolated !== undefined) {
      isolated.push({ name: entry.name, reason: verdict.isolated, exclusive: verdict.exclusive === true })
      continue
    }
    packages.push(entry)
    for (const f of verdict.flags) flags.add(f)
  }
  // A shared run of one buys nothing over running that package directly.
  if (packages.length < 2) {
    return { shared: null, isolated: isolated.concat(packages.map((p) => ({ name: p.name, reason: 'nothing to share with', exclusive: false }))) }
  }
  return { shared: { packages, flags: [...flags] }, isolated }
}

/** jest lives in each package's own node_modules; the shared run uses the first one that has it. */
function findJestBin (packages) {
  for (const p of packages) {
    const bin = join(p.cwd, 'node_modules', '.bin', 'jest')
    if (existsSync(bin)) return bin
  }
  return null
}

module.exports = { planTestRun, findJestBin, hasTestFiles, collectTestEntries, buildSharedConfig }

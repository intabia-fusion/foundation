/**
 * Common caching utilities for fast-build phases
 * Provides unified package hash calculation and phase-based caching
 *
 * Cache format (v2 - per-phase hashes):
 * {
 *   "version": 2,
 *   "phases": {
 *     "transpile": { "hash": "abc123", "completedAt": 1234567890 },
 *     "bundle":    { "hash": "def456", "completedAt": 1234567890 },
 *     "validate":  { "hash": "abc123", "completedAt": 1234567890 },
 *     "package":   { "hash": "def456", "completedAt": 1234567890 },
 *     "docker-build": { "hash": "def456", "completedAt": 1234567890 }
 *   }
 * }
 *
 * Previously (v1), there was a single top-level "hash" field shared by all phases.
 * This caused an infinite rebuild cycle: transpile uses a base hash while
 * bundle/package/docker use a composite hash (including dependency hashes).
 * When one phase wrote its hash, it invalidated ALL other phases because
 * the single hash didn't match. On the next run the other phase would
 * overwrite the hash again, wiping the first phase's cache — ad infinitum.
 *
 * With v2, each phase stores its own hash independently, so phases using
 * different hash strategies (base vs composite) no longer conflict.
 */

const { join } = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { xxh64 } = require('@node-rs/xxhash')

const CACHE_VERSION = 2

/**
 * Find repository root by looking for rush.json
 * Walks up from the given directory until found
 */
function findRepoRoot(startPath) {
  let current = startPath
  const root = process.platform === 'win32' ? '/' : '/'
  
  while (current !== root) {
    if (fs.existsSync(join(current, 'rush.json'))) {
      return current
    }
    const parent = join(current, '..')
    if (parent === current) break
    current = parent
  }
  
  // Fallback: try to find from common known structure
  // platform-rig/bin/libs/cache.js -> foundations/utils/packages/platform-rig/bin/libs -> foundations/utils/packages -> foundations/utils -> foundations
  return null
}

/**
 * Output directories for each phase that need to be verified
 */
const phaseOutputDirs = {
  transpile: ['lib'],
  validate: ['types'],
  bundle: ['bundle'],
  package: ['dist'],
  'docker-build': []
}

/**
 * Collect file signatures (mtime:size) recursively
 * @param {string} dir - Directory to scan
 * @param {Set<string>} [extensions] - Optional set of file extensions to include (e.g., ['.ts', '.js'])
 * @returns {Object} Map of file paths to signatures
 */
function collectFileSignatures(dir, extensions = null) {
  const signatures = {}
  if (!fs.existsSync(dir)) return signatures

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      Object.assign(signatures, collectFileSignatures(fullPath, extensions))
    } else {
      // Skip if extensions filter is provided and file doesn't match
      if (extensions) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.'))
        // Special handling for .d.ts files
        const isMatch = extensions.has(ext) || (ext === '.ts' && entry.name.endsWith('.d.ts') && extensions.has('.d.ts'))
        if (!isMatch) {
          continue
        }
      }
      try {
        const stat = fs.lstatSync(fullPath)
        if (!stat.isFile()) continue
        // Content-based hash: robust across git checkouts that bump mtime.
        // xxh64 is ~5–10x faster than md5, source files typically <100KB.
        const content = fs.readFileSync(fullPath)
        const hash = xxh64(content).toString(16)
        signatures[fullPath] = `${hash}:${stat.size}`
      } catch {
        // Ignore stat/read errors
      }
    }
  }
  return signatures
}

/**
 * Read fastBuild section from package.json
 * Supported fields:
 *   fastBuild.extraHashFiles: string[]  - extra files (relative to package dir)
 *   fastBuild.extraHashPaths: string[]  - extra files/dirs (relative to package dir)
 *                                          dirs are hashed recursively
 * @param {string} packagePath
 * @returns {{extraHashFiles: string[], extraHashPaths: string[]}}
 */
function readFastBuildConfig(packagePath) {
  const pkgJsonPath = join(packagePath, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) return { extraHashFiles: [], extraHashPaths: [] }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
    const fb = pkg.fastBuild || {}
    return {
      extraHashFiles: Array.isArray(fb.extraHashFiles) ? fb.extraHashFiles : [],
      extraHashPaths: Array.isArray(fb.extraHashPaths) ? fb.extraHashPaths : []
    }
  } catch {
    return { extraHashFiles: [], extraHashPaths: [] }
  }
}

/**
 * Calculate unified package hash based on all source inputs
 * This hash is used across all phases to detect changes
 *
 * Includes:
 * - src/ directory (source files)
 * - package.json
 * - tsconfig.json (if exists)
 * - common/scripts/version.txt (global version file)
 * - Any additional config files provided via parameter or package.json fastBuild
 *
 * @param {string} packagePath - Path to package directory
 * @param {string[]} [extraFiles] - Additional files to include in hash (relative to package dir)
 * @returns {string} MD5 hash
 */
function calculatePackageHash(packagePath, extraFiles = []) {
  const parts = []

  // Hash src/ directory
  const srcPath = join(packagePath, 'src')
  if (fs.existsSync(srcPath)) {
    const srcExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.svelte', '.json'])
    const sigs = collectFileSignatures(srcPath, srcExtensions)
    const sortedKeys = Object.keys(sigs).sort()
    for (const key of sortedKeys) {
      parts.push(`src:${key}=${sigs[key]}`)
    }
  }

  // Hash tests/ directory if exists
  const testsPath = join(packagePath, 'tests')
  if (fs.existsSync(testsPath)) {
    const testExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.json'])
    const sigs = collectFileSignatures(testsPath, testExtensions)
    const sortedKeys = Object.keys(sigs).sort()
    for (const key of sortedKeys) {
      parts.push(`tests:${key}=${sigs[key]}`)
    }
  }

  // Content-hash helper — robust to git checkout mtime bumps.
  const pushFileSig = (label, absPath) => {
    if (!fs.existsSync(absPath)) return
    try {
      const stat = fs.statSync(absPath)
      if (!stat.isFile()) return
      const content = fs.readFileSync(absPath)
      const hash = xxh64(content).toString(16)
      parts.push(`${label}:${hash}:${stat.size}`)
    } catch { /* ignore */ }
  }

  pushFileSig('package.json', join(packagePath, 'package.json'))
  pushFileSig('tsconfig.json', join(packagePath, 'tsconfig.json'))
  pushFileSig('Dockerfile', join(packagePath, 'Dockerfile'))

  // Global version file — when it changes, all packages must rebuild.
  const rootDir = findRepoRoot(packagePath)
  if (rootDir) {
    pushFileSig('common/scripts/version.txt', join(rootDir, 'common', 'scripts', 'version.txt'))
  }

  // Merge extraFiles from parameter with fastBuild config from package.json
  const fb = readFastBuildConfig(packagePath)
  const allExtraFiles = [...extraFiles, ...fb.extraHashFiles]
  for (const file of allExtraFiles) {
    pushFileSig(`extra:${file}`, join(packagePath, file))
  }

  // extraHashPaths supports both files and directories (recursive)
  // Paths are relative to package dir; can point outside (e.g. ../../dev/prod/dist)
  for (const rel of fb.extraHashPaths) {
    const absPath = join(packagePath, rel)
    if (!fs.existsSync(absPath)) continue
    try {
      const stat = fs.statSync(absPath)
      if (stat.isFile()) {
        pushFileSig(`path:${rel}`, absPath)
      } else if (stat.isDirectory()) {
        const sigs = collectFileSignatures(absPath)
        const sortedKeys = Object.keys(sigs).sort()
        for (const key of sortedKeys) {
          // Use relative key inside the directory to keep hash stable across machines
          const relKey = key.slice(absPath.length)
          parts.push(`path:${rel}:${relKey}=${sigs[key]}`)
        }
      }
    } catch { /* ignore */ }
  }

  return crypto.createHash('md5').update(parts.join('\n')).digest('hex')
}

/**
 * Calculate hash of output directory contents
 * Used to detect if output was modified/corrupted after build
 * @param {string} packagePath - Path to package directory
 * @param {string} phase - Phase name (used to determine output dirs)
 * @returns {string|null} MD5 hash of all output files, or null if any dir doesn't exist
 */
function calculateOutputHash(packagePath, phase) {
  const dirs = phaseOutputDirs[phase]
  if (!dirs || dirs.length === 0) return null
  return calculateOutputHashForDirs(packagePath, dirs)
}

/**
 * Calculate hash of specific output directories
 * @param {string} packagePath - Path to package directory
 * @param {string[]} dirs - Directory names relative to package
 * @returns {string|null} MD5 hash, or null if any dir doesn't exist
 */
function calculateOutputHashForDirs(packagePath, dirs) {
  const parts = []
  for (const dir of dirs) {
    const dirPath = join(packagePath, dir)
    if (!fs.existsSync(dirPath)) return null

    // Hash all files in output directory
    const sigs = collectFileSignatures(dirPath)
    const sortedKeys = Object.keys(sigs).sort()
    for (const key of sortedKeys) {
      parts.push(`${dir}:${key}=${sigs[key]}`)
    }
  }

  if (parts.length === 0) return null
  return crypto.createHash('md5').update(parts.join('\n')).digest('hex')
}

/**
 * Load package cache from .fast-build-cache.json
 * Handles migration from v1 format transparently.
 * @param {string} packagePath - Path to package directory
 * @returns {Object|null} Cache object (always v2 format) or null
 */
function loadPackageCache(packagePath) {
  const cachePath = join(packagePath, '.fast-build-cache.json')
  try {
    if (fs.existsSync(cachePath)) {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))

      // Already v2
      if (raw.version === CACHE_VERSION && raw.phases) {
        return raw
      }

      // Migrate v1 → v2
      // v1 format: { hash: "...", timestamp: ..., phases: { transpile: { completedAt: ... }, ... } }
      if (raw.hash && raw.phases) {
        const migrated = { version: CACHE_VERSION, phases: {} }
        for (const [phase, meta] of Object.entries(raw.phases)) {
          if (meta && typeof meta === 'object') {
            migrated.phases[phase] = {
              hash: raw.hash,
              ...meta
            }
          }
        }
        // Write back migrated format
        savePackageCache(packagePath, migrated)
        return migrated
      }

      // Unrecognised format — discard
      return null
    }
  } catch { /* ignore corrupted cache */ }
  return null
}

/**
 * Save package cache to .fast-build-cache.json
 * @param {string} packagePath - Path to package directory
 * @param {Object} cache - Cache object to save (v2 format)
 */
function savePackageCache(packagePath, cache) {
  const cachePath = join(packagePath, '.fast-build-cache.json')
  try {
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8')
  } catch { /* ignore write errors */ }
}

/**
 * Check if a phase is cached and valid
 * @param {string} packagePath - Path to package directory
 * @param {string} packageHash - Current package hash (may differ per phase)
 * @param {string} phase - Phase name (e.g., 'transpile', 'bundle', 'package', 'docker-build')
 * @param {Function} [outputCheck] - Optional function to verify output exists
 * @param {string[]} [outputDirs] - Optional override for output directories to hash
 * @returns {boolean} True if phase is cached and valid
 */
function isPhaseCached(packagePath, packageHash, phase, outputCheck = null, outputDirs = null) {
  const cache = loadPackageCache(packagePath)
  if (!cache) return false

  const phaseEntry = cache.phases && cache.phases[phase]
  if (!phaseEntry) return false

  // Each phase stores its own hash — compare only against that phase's hash
  if (phaseEntry.hash !== packageHash) return false

  // Verify output hash matches what was stored (detects deleted/corrupted outputs)
  if (phaseEntry.outputHash) {
    const currentOutputHash = outputDirs
      ? calculateOutputHashForDirs(packagePath, outputDirs)
      : calculateOutputHash(packagePath, phase)
    if (currentOutputHash !== phaseEntry.outputHash) return false
  }

  // Run optional output check
  if (outputCheck && !outputCheck(packagePath)) {
    return false
  }

  return true
}

/**
 * Mark a phase as completed in cache
 * @param {string} packagePath - Path to package directory
 * @param {string} packageHash - Current package hash (may differ per phase)
 * @param {string} phase - Phase name
 * @param {Object} [metadata] - Optional metadata to store (e.g., { errorCount: 0, warningCount: 5 })
 * @param {string[]} [outputDirs] - Optional override for output directories to hash
 */
function markPhaseCompleted(packagePath, packageHash, phase, metadata = null, outputDirs = null) {
  let cache = loadPackageCache(packagePath)

  if (!cache) {
    cache = { version: CACHE_VERSION, phases: {} }
  }

  if (!cache.phases) {
    cache.phases = {}
  }

  // Calculate output hash AFTER phase completed
  const outputHash = outputDirs
    ? calculateOutputHashForDirs(packagePath, outputDirs)
    : calculateOutputHash(packagePath, phase)

  // Store the hash *inside* the phase entry so each phase tracks its own hash
  // independently.  Other phases are left untouched.
  cache.phases[phase] = {
    hash: packageHash,
    completedAt: Date.now(),
    outputHash,
    ...metadata
  }

  savePackageCache(packagePath, cache)
}

/**
 * Get phase metadata from cache
 * @param {string} packagePath - Path to package directory
 * @param {string} packageHash - Current package hash
 * @param {string} phase - Phase name
 * @returns {Object|null} Phase metadata or null if not cached
 */
function getPhaseMetadata(packagePath, packageHash, phase) {
  const cache = loadPackageCache(packagePath)
  if (!cache) return null

  const phaseEntry = cache.phases && cache.phases[phase]
  if (!phaseEntry) return null
  if (phaseEntry.hash !== packageHash) return null

  return phaseEntry
}

/**
 * Get list of completed phases for a package whose hash still matches.
 * Because each phase may use a different hash, the caller must provide
 * a map of phase→hash or a single hash (applied to all phases).
 *
 * When a single string is provided the behaviour matches the old API:
 * only phases whose stored hash equals that string are returned.
 *
 * @param {string} packagePath - Path to package directory
 * @param {string|Object} packageHash - Hash string or { phase: hash } map
 * @returns {string[]} Array of completed phase names
 */
function getCompletedPhases(packagePath, packageHash) {
  const cache = loadPackageCache(packagePath)
  if (!cache || !cache.phases) return []

  const result = []
  for (const [phase, entry] of Object.entries(cache.phases)) {
    if (!entry) continue
    const expectedHash = typeof packageHash === 'string' ? packageHash : packageHash[phase]
    if (expectedHash && entry.hash === expectedHash) {
      result.push(phase)
    }
  }
  return result
}

/**
 * Drop a single phase from the cache, leaving the other phases untouched.
 * Transpile used to call invalidateCache() on any upstream change, which wiped
 * validate/lint/svelte-check/bundle/package/docker-build for the whole downstream closure.
 * @param {string} packagePath - Path to package directory
 * @param {string} phase - Phase name
 */
function invalidatePhase(packagePath, phase) {
  const cache = loadPackageCache(packagePath)
  if (!cache || !cache.phases || !cache.phases[phase]) return

  delete cache.phases[phase]
  savePackageCache(packagePath, cache)
}

/**
 * Invalidate all caches for a package (when force rebuilding)
 * @param {string} packagePath - Path to package directory
 */
function invalidateCache(packagePath) {
  const cachePath = join(packagePath, '.fast-build-cache.json')
  try {
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath)
    }
  } catch { /* ignore */ }
}

module.exports = {
  collectFileSignatures,
  calculatePackageHash,
  calculateOutputHash,
  calculateOutputHashForDirs,
  loadPackageCache,
  savePackageCache,
  isPhaseCached,
  markPhaseCompleted,
  getPhaseMetadata,
  getCompletedPhases,
  invalidatePhase,
  invalidateCache
}

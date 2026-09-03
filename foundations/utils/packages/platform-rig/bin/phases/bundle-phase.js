/**
 * Optimized bundle phase with unified caching
 * For packages using common/scripts/esbuild.js, runs esbuild directly in-process
 * For others, falls back to rushx bundle
 */

const { createHash } = require('crypto')
const { spawn } = require('child_process')
const { performance } = require('perf_hooks')
const { join, resolve } = require('path')
const fs = require('fs')

const {
  isPhaseCached,
  markPhaseCompleted,
  calculatePackageHash
} = require('../libs/cache')

// Cache for get-model to avoid running it multiple times for the same package
// Key: packageName, value: { modelHash, depsHash }
const getModelCache = new Map()

// Pre-compute common values once
const commonScriptsPath = resolve(__dirname, '../../../../../../common/scripts')
let cachedVersion = null
let cachedGitRevision = null

const versionFilePath = join(commonScriptsPath, 'version.txt')
let cachedModelVersion = null

try {
  cachedModelVersion = fs.readFileSync(versionFilePath, 'utf8').trim()
} catch (error) {
  console.error(`[bundle-phase] Error: version.txt not found at ${versionFilePath}`)
  console.error('[bundle-phase] Please ensure version.txt exists in common/scripts/')
  process.exit(1)
}

// Path to models-all
const modelsAllPath = resolve(__dirname, '../../../../../../models/all')
const modelsAllBundlePath = join(modelsAllPath, 'bundle', 'model.json')
const modelsAllCachePath = join(modelsAllPath, '.fast-build-cache.json')

// Get hash of models-all model.json or cache file
function getModelHash() {
  try {
    // Try cache file first (more reliable, updated after successful build)
    if (fs.existsSync(modelsAllCachePath)) {
      const cache = JSON.parse(fs.readFileSync(modelsAllCachePath, 'utf8'))
      if (cache.phases?.bundle?.hash) {
        return cache.phases.bundle.hash
      }
    }
    // Fallback to model.json content hash
    if (fs.existsSync(modelsAllBundlePath)) {
      const content = fs.readFileSync(modelsAllBundlePath, 'utf8')
      return createHash('sha256').update(content).digest('hex')
    }
    return null
  } catch {
    return null
  }
}

function getVersion() {
  if (cachedVersion !== null) return cachedVersion
  try {
    const { execSync } = require('child_process')
    const stdout = execSync('git describe --tags --abbrev=0').toString().trim()
    const rawVersion = stdout.replace('v', '').replace('s', '').split('.')
    if (rawVersion.length === 3) {
      const version = {
        major: parseInt(rawVersion[0]),
        minor: parseInt(rawVersion[1]),
        patch: parseInt(rawVersion[2])
      }
      cachedVersion = `${version.major}.${version.minor}.${version.patch}`
    } else {
      cachedVersion = '0.7.0'
    }
  } catch {
    cachedVersion = '0.7.0'
  }
  return cachedVersion
}

function getGitRevisionCached() {
  if (cachedGitRevision !== null) return cachedGitRevision
  try {
    const { execSync } = require('child_process')
    cachedGitRevision = execSync('git describe --all --long').toString().trim()
  } catch {
    cachedGitRevision = ''
  }
  return cachedGitRevision
}

// Check if bundle script uses standard esbuild (common/scripts/esbuild.js or local esbuild.js)
function isStandardEsbuild(bundleScript) {
  if (!bundleScript) return false
  const hasCommonEsbuild = bundleScript.includes('common/scripts/esbuild.js')
  const hasRushxBundle = /\brushx\s+bundle\b/.test(bundleScript) && !bundleScript.includes('get-model')
  return hasCommonEsbuild && !hasRushxBundle
}

// Check if script needs get-model step (rushx get-model && node ...esbuild.js)
function needsGetModel(bundleScript) {
  if (!bundleScript) return false
  return bundleScript.includes('rushx get-model') || bundleScript.includes('get-model &&')
}

// Check if script has post-processing (&& node ... after esbuild)
function hasPostProcessing(bundleScript) {
  if (!bundleScript) return false
  const esbuildIndex = bundleScript.indexOf('esbuild.js')
  if (esbuildIndex === -1) return false
  const afterEsbuild = bundleScript.slice(esbuildIndex + 10)
  return /\s*&&\s*node\s/.test(afterEsbuild)
}

// Parse esbuild arguments from bundle script
function parseEsbuildArgs(bundleScript, packagePath) {
  const args = {
    entryPoint: 'src/index.ts',
    outdir: 'bundle',
    platform: 'node',
    minify: false,
    keepNames: true,
    sourcemap: false,
    logLevel: 'error',
    external: ['snappy'],
    define: {}
  }

  const argMatches = bundleScript.match(/--([\w-]+)(?:[:=]([^\s]+))?/g)
  if (argMatches) {
    for (const match of argMatches) {
      const fullMatch = match.slice(2)
      const eqIndex = fullMatch.search(/[:=]/)
      let key, value
      if (eqIndex === -1) {
        key = fullMatch
        value = ''
      } else {
        key = fullMatch.slice(0, eqIndex)
        value = fullMatch.slice(eqIndex + 1)
      }
      switch (key) {
        case 'entry':
        case 'entryPoint':
          args.entryPoint = value
          break
        case 'minify':
          args.minify = value !== 'false'
          break
        case 'keep-names':
          args.keepNames = value !== 'false'
          break
        case 'sourcemap':
          args.sourcemap = value
          break
        case 'external':
          if (value && !args.external.includes(value)) {
            args.external.push(value)
          }
          break
        case 'define':
          if (value) {
            args.define[value] = true
          }
          break
      }
    }
  }

  return args
}

// Run get-model script if it exists
async function runGetModel(cwd, bundleScript, packageName) {
  // Check cache first based on model hash and package hash
  const currentModelHash = getModelHash()
  const currentPkgHash = calculatePackageHash(cwd)
  const cacheKey = packageName || cwd

  const cached = getModelCache.get(cacheKey)
  if (cached &&
      cached.modelHash === currentModelHash &&
      cached.pkgHash === currentPkgHash) {
    // Model and package haven't changed, skip get-model
    return { success: true, fromCache: true }
  }

  // Check if bundle script explicitly calls rushx get-model
  if (bundleScript && bundleScript.includes('rushx get-model')) {
    console.log(`    [get-model] Running rushx get-model for ${cwd}`)
    try {
      const { execSync } = require('child_process')
      execSync('rushx get-model', { cwd, stdio: 'pipe' })
      console.log(`    [get-model] Completed`)
      getModelCache.set(cacheKey, { modelHash: currentModelHash, pkgHash: currentPkgHash })
      return { success: true }
    } catch (error) {
      console.error(`    [get-model] Error:`, error.message)
      return { success: false, error }
    }
  }

  // Check if package has get-model script in package.json
  const packageJsonPath = join(cwd, 'package.json')
  if (!fs.existsSync(packageJsonPath)) {
    return { success: true }
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    const scripts = packageJson.scripts || {}

    if (scripts['get-model'] && !bundleScript?.includes('rushx get-model')) {
      console.log(`    [get-model] Running for ${packageJson.name}`)

      const script = scripts['get-model']
      const esbuildMatch = script.match(/node\s+.*?esbuild\.js\s+(.*?)\s*&&/)

      if (esbuildMatch) {
        const esbuild = require('esbuild')
        const path = require('path')

        const args = parseEsbuildArgs(script, cwd)

        fs.mkdirSync(path.join(cwd, args.outdir), { recursive: true })

        const define = {}
        const version = getVersion()
        if (version) {
          define['process.env.VERSION'] = `"${version}"`
        }

        if (args.define.MODEL_VERSION) {
          const modelVersion = cachedModelVersion
          if (modelVersion) {
            define['process.env.MODEL_VERSION'] = modelVersion
          }
        }
        if (args.define.GIT_REVISION) {
          const revision = getGitRevisionCached()
          if (revision) {
            define['process.env.GIT_REVISION'] = JSON.stringify(revision)
          }
        }

        await esbuild.build({
          absWorkingDir: cwd,
          entryPoints: [args.entryPoint],
          bundle: true,
          platform: args.platform,
          outfile: path.join(args.outdir, 'bundle.js'),
          logLevel: args.logLevel,
          minify: args.minify,
          keepNames: args.keepNames,
          sourcemap: args.sourcemap,
          external: args.external,
          define
        })

        const { execSync } = require('child_process')
        const modelJson = execSync(`node ${join(args.outdir, 'bundle.js')}`, { cwd }).toString()
        fs.writeFileSync(join(args.outdir, 'model.json'), modelJson)

        console.log(`    [get-model] Generated model.json`)
      }

      getModelCache.set(cacheKey, { modelHash: currentModelHash, pkgHash: currentPkgHash })
      return { success: true }
    }
  } catch (error) {
    console.error(`    [get-model] Error:`, error.message)
    return { success: false, error }
  }

  return { success: true }
}

// Run esbuild directly
async function runEsbuildDirect(cwd, config, bundleScript, packageName) {
  const esbuild = require('esbuild')
  const path = require('path')

  // Run get-model first if needed
  if (bundleScript && needsGetModel(bundleScript)) {
    const getModelResult = await runGetModel(cwd, bundleScript, packageName)
    if (!getModelResult.success) {
      return getModelResult
    }
  }

  fs.mkdirSync(path.join(cwd, config.outdir), { recursive: true })

  const define = {}
  const version = getVersion()
  if (version) {
    define['process.env.VERSION'] = `"${version}"`
  }

  if (config.define.MODEL_VERSION) {
    const modelVersion = cachedModelVersion
    if (modelVersion) {
      define['process.env.MODEL_VERSION'] = modelVersion
    }
  }
  if (config.define.GIT_REVISION) {
    const revision = getGitRevisionCached()
    if (revision) {
      define['process.env.GIT_REVISION'] = JSON.stringify(revision)
    }
  }

  try {
    await esbuild.build({
      absWorkingDir: cwd,
      entryPoints: [config.entryPoint],
      bundle: true,
      platform: config.platform,
      plugins: [{
        name: 'ignore-apache-arrow',
        setup(build) {
          build.onResolve({ filter: /^apache-arrow\/Arrow\.node$/ }, args => {
            return { path: args.path, namespace: 'ignore-arrow' }
          })
          build.onLoad({ filter: /.*/, namespace: 'ignore-arrow' }, args => {
            return { contents: 'module.exports = {};' }
          })
        }
      }],
      outfile: path.join(config.outdir, 'bundle.js'),
      logLevel: config.logLevel,
      minify: config.minify,
      keepNames: config.keepNames,
      sourcemap: config.sourcemap,
      external: config.external,
      define
    })

    // Handle post-processing (e.g., models/all: && node ./bundle/bundle.js > ./bundle/model.json)
    if (bundleScript && hasPostProcessing(bundleScript)) {
      console.log(`    [post-process] Running post-processing for ${cwd}`)
      const esbuildIndex = bundleScript.indexOf('esbuild.js')
      const afterEsbuild = bundleScript.slice(esbuildIndex + 10)
      const postProcessMatch = afterEsbuild.match(/\s*&&\s*(node\s+.*)$/)
      if (postProcessMatch) {
        const postProcessCmd = postProcessMatch[1]
        const { execSync } = require('child_process')
        execSync(postProcessCmd, { cwd, stdio: 'pipe' })
        console.log(`    [post-process] Completed`)
      }
    }

    return { success: true }
  } catch (error) {
    return { success: false, error }
  }
}

// Run bundle via rushx (with optional arguments)
async function runBundleRushx(cwd, bundleScript) {
  return new Promise((resolve) => {
    let args = ['bundle']
    if (bundleScript) {
      const rushxMatch = bundleScript.match(/\brushx\s+bundle\s+(.+)$/)
      if (rushxMatch) {
        const extraArgs = rushxMatch[1].trim().split(/\s+/)
        args = args.concat(extraArgs)
      }
    }

    const startTime = performance.now()
    const child = spawn('rushx', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (data) => {
      stdout += data.toString()
    })
    child.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      const time = performance.now() - startTime

      if (code === 0) {
        resolve({ success: true, time })
      } else {
        const error = new Error(`Bundle failed with exit code ${code}`)
        error.stdout = stdout
        error.stderr = stderr
        resolve({ success: false, error, time })
      }
    })

    child.on('error', (err) => {
      resolve({ success: false, error: err })
    })
  })
}

/**
 * Check if bundle output exists
 */
function hasBundleOutput(cwd, bundleScript) {
  const isStandard = isStandardEsbuild(bundleScript)
  const bundleOutput = isStandard
    ? join(cwd, 'bundle', 'bundle.js')
    : join(cwd, 'bundle')
  return fs.existsSync(bundleOutput)
}

/**
 * Run bundle phase
 */
async function runBundlePhase(graph, packageNames, concurrency, options = {}) {
  const { force = false, packageHash } = options
  const results = {
    successCount: 0,
    cacheHits: 0,
    total: packageNames.length,
    errors: [],
    time: 0
  }

  const startTime = performance.now()

  async function bundlePackage(packageName) {
    const node = graph.get(packageName)
    const cwd = node.project.fullPath
    // Use phaseBundle (_phase:bundle) if it contains arguments after 'rushx bundle',
    // otherwise use bundleScript (bundle) directly
    let bundleScript = node.bundleScript
    if (node.phaseBundle?.includes('rushx bundle')) {
      const argsMatch = node.phaseBundle.match(/\brushx\s+bundle\s+(.+)$/)
      if (argsMatch && argsMatch[1].trim()) {
        bundleScript = node.bundleScript + ' ' + argsMatch[1].trim()
      }
    }

    // Skip "echo done" type scripts
    if (bundleScript?.startsWith('echo ')) {
      return { success: true, skipped: true }
    }

    // Check cache using pre-calculated package hash
    if (!force && packageHash) {
      if (isPhaseCached(cwd, packageHash, 'bundle', (pkgPath) => hasBundleOutput(pkgPath, bundleScript), ['bundle'])) {
        return { success: true, fromCache: true }
      }
    }

    let result
    // Check if we can use optimized esbuild
    if (isStandardEsbuild(bundleScript)) {
      const config = parseEsbuildArgs(bundleScript, cwd)
      console.log(`    [esbuild] ${packageName} - direct build`)
      result = await runEsbuildDirect(cwd, config, bundleScript, packageName)
    } else {
      // Fall back to rushx bundle
      console.log(`    [rushx] ${packageName} - using rushx bundle`)
      result = await runBundleRushx(cwd, bundleScript)
    }

    if (result.success && packageHash) {
      markPhaseCompleted(cwd, packageHash, 'bundle', null, ['bundle'])
    }
    return result
  }

  // Process packages
  const promises = packageNames.map(async (name) => {
    const result = await bundlePackage(name)
    if (result.success) {
      results.successCount++
      if (result.fromCache) results.cacheHits++
    } else {
      results.errors.push({ package: name, error: result.error })
    }
    return result
  })

  await Promise.all(promises)
  results.time = performance.now() - startTime

  return results
}

module.exports = { runBundlePhase, isStandardEsbuild, needsGetModel, hasPostProcessing, parseEsbuildArgs }

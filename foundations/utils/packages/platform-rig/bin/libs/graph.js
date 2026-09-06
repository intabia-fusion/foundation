const { join } = require('path')
const { readFileSync, promises: fsPromises, existsSync } = require('fs')
const { execSync } = require('child_process')

// In-memory cache for rush list result
let rushListCache = null

/**
 * Get rush list result with caching based on rush.json mtime
 * Uses both in-memory and file-based caching for persistence between runs
 */
async function getRushList(rootDir, verbose) {
  const { statSync } = require('fs')
  const rushJsonPath = join(rootDir, 'rush.json')
  const pnpmLockPath = join(rootDir, 'common/config/rush/pnpm-lock.yaml')
  const cacheFilePath = join(rootDir, 'common/temp/.rush-list-cache.json')

  // Get mtime of rush.json and pnpm-lock for cache invalidation
  let rushJsonMtime = 0
  let pnpmLockMtime = 0
  try {
    rushJsonMtime = statSync(rushJsonPath).mtimeMs
  } catch {}
  try {
    pnpmLockMtime = statSync(pnpmLockPath).mtimeMs
  } catch {}

  const cacheKey = `${rushJsonMtime}:${pnpmLockMtime}`

  // Check in-memory cache first
  if (rushListCache && rushListCache.key === cacheKey) {
    if (verbose) {
      console.log(`rush list from memory cache (${rushListCache.projects.length} projects)`)
    }
    return rushListCache.projects
  }

  // Check file-based cache
  try {
    if (existsSync(cacheFilePath)) {
      const cacheContent = JSON.parse(readFileSync(cacheFilePath, 'utf-8'))
      if (cacheContent.key === cacheKey && Array.isArray(cacheContent.projects)) {
        if (verbose) {
          console.log(`rush list from file cache (${cacheContent.projects.length} projects)`)
        }
        // Store in memory cache too
        rushListCache = {
          key: cacheKey,
          projects: cacheContent.projects
        }
        return cacheContent.projects
      }
    }
  } catch {
    // Cache file corrupted or unreadable, will regenerate
  }

  // Run rush list --json
  const { performance } = require('perf_hooks')
  const rushListStart = performance.now()
  let rushOutput
  try {
    rushOutput = execSync('rush list --json', {
      cwd: rootDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (err) {
    throw new Error(`Failed to run rush list --json: ${err.message}`)
  }

  if (verbose) {
    console.log(`rush list completed in ${(performance.now() - rushListStart).toFixed(0)}ms`)
  }

  // Parse JSON output (skip any non-JSON lines at the beginning)
  const jsonStart = rushOutput.indexOf('{')
  if (jsonStart === -1) {
    throw new Error('Could not find JSON in rush output')
  }

  const jsonStr = rushOutput.slice(jsonStart)
  let rushList

  try {
    rushList = JSON.parse(jsonStr)
  } catch (err) {
    throw new Error(`Failed to parse rush list output: ${err.message}`)
  }

  // Store in memory cache
  rushListCache = {
    key: cacheKey,
    projects: rushList.projects
  }

  // Store in file cache (async, don't wait)
  try {
    const cacheData = JSON.stringify({ key: cacheKey, projects: rushList.projects })
    require('fs').writeFileSync(cacheFilePath, cacheData, 'utf-8')
  } catch {
    // Ignore cache write errors
  }

  return rushList.projects
}

/**
 * Read package.json and extract dependencies and phase scripts
 */
async function getPackageInfoAsync(packageJsonPath) {
  try {
    const content = await fsPromises.readFile(packageJsonPath, 'utf-8')
    const packageJson = JSON.parse(content)
    return parsePackageJson(packageJson)
  } catch {
    return {
      dependencies: [],
      phaseBuild: null,
      phaseTest: null,
      phaseBundle: null,
      phasePackage: null,
      phaseDockerBuild: null,
      phaseFormat: null,
      phaseSvelteCheck: null,
      bundleScript: null,
      packageScript: null,
      dockerBuildScript: null
    }
  }
}

function parsePackageJson(packageJson) {
  const phaseBuild = packageJson.scripts?.['_phase:build']
  const phaseTest = packageJson.scripts?.['_phase:test']
  const phaseBundle = packageJson.scripts?.['_phase:bundle']
  const phasePackage = packageJson.scripts?.['_phase:package']
  const phaseDockerBuild = packageJson.scripts?.['_phase:docker-build']
  const phaseFormat = packageJson.scripts?.['_phase:format']
  const phaseSvelteCheck = packageJson.scripts?.['_phase:svelte-check']
  const bundleScript = packageJson.scripts?.['bundle']
  const packageScript = packageJson.scripts?.['package']
  const dockerBuildScript = packageJson.scripts?.['docker:build']

  // Collect all workspace dependencies
  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies
  }

  const dependencies = Object.keys(allDeps).filter(dep => {
    const version = allDeps[dep]
    // workspace: dependencies are local packages
    return version && (version.startsWith('workspace:') || version.startsWith('link:'))
  })

  return {
    dependencies,
    phaseBuild,
    phaseTest,
    phaseBundle,
    phasePackage,
    phaseDockerBuild,
    phaseFormat,
    phaseSvelteCheck,
    bundleScript,
    packageScript,
    dockerBuildScript
  }
}

/**
 * Build dependency graph for all projects
 */
async function buildDependencyGraph(rootDir, verbose) {
  const projects = await getRushList(rootDir, verbose)
  const graph = new Map()
  const projectByName = new Map()

  // First pass: read all package.json files in parallel
  const packageInfoPromises = projects.map(async (project) => {
    const packageJsonPath = join(project.fullPath, 'package.json')
    const info = await getPackageInfoAsync(packageJsonPath)
    return { project, info }
  })

  const packageInfos = await Promise.all(packageInfoPromises)

  // Second pass: initialize all nodes
  for (const { project, info } of packageInfos) {
    projectByName.set(project.name, project)
    const {
      dependencies,
      phaseBuild,
      phaseTest,
      phaseBundle,
      phasePackage,
      phaseDockerBuild,
      phaseFormat,
      phaseSvelteCheck,
      bundleScript,
      packageScript,
      dockerBuildScript
    } = info

    graph.set(project.name, {
      project,
      dependencies: new Set(dependencies),
      dependents: new Set(),
      phaseBuild,
      phaseTest,
      phaseBundle,
      phasePackage,
      phaseDockerBuild,
      phaseFormat,
      phaseSvelteCheck,
      bundleScript,
      packageScript,
      dockerBuildScript
    })
  }

  // Third pass: filter dependencies to only include projects in our list and build dependents
  for (const [name, node] of graph) {
    const validDeps = new Set()
    for (const dep of node.dependencies) {
      if (graph.has(dep)) {
        validDeps.add(dep)
        // Add this package as a dependent of the dependency
        graph.get(dep).dependents.add(name)
      }
    }
    node.dependencies = validDeps
  }

  return { graph, projects, projectByName }
}

/**
 * Get all dependencies of a package (transitive closure)
 */
function getAllDependencies(graph, packageName, result = new Set()) {
  const node = graph.get(packageName)
  if (!node) return result

  for (const dep of node.dependencies) {
    if (!result.has(dep)) {
      result.add(dep)
      getAllDependencies(graph, dep, result)
    }
  }

  return result
}

/**
 * Topological sort using Kahn's algorithm
 * Returns array of "waves" - each wave contains packages that can be built in parallel
 */
function topologicalSortWaves(graph, filterFn) {
  // Filter to only packages we want to compile
  const filteredNames = new Set()
  for (const [name, node] of graph) {
    if (filterFn(node, name)) {
      filteredNames.add(name)
    }
  }

  // Calculate in-degree for filtered packages only
  const inDegree = new Map()
  for (const name of filteredNames) {
    let count = 0
    for (const dep of graph.get(name).dependencies) {
      if (filteredNames.has(dep)) {
        count++
      }
    }
    inDegree.set(name, count)
  }

  const waves = []
  const processed = new Set()

  while (processed.size < filteredNames.size) {
    // Find all packages with no remaining dependencies (in-degree = 0)
    const wave = []
    for (const name of filteredNames) {
      if (!processed.has(name) && inDegree.get(name) === 0) {
        const node = graph.get(name)
        wave.push({ ...node.project })
      }
    }

    if (wave.length === 0) {
      // Circular dependency detected
      const remaining = [...filteredNames].filter(n => !processed.has(n))
      throw new Error(`Circular dependency detected among: ${remaining.join(', ')}`)
    }

    waves.push(wave)

    // Mark these as processed and update in-degrees
    for (const project of wave) {
      processed.add(project.name)
      const node = graph.get(project.name)
      for (const dependent of node.dependents) {
        if (filteredNames.has(dependent) && inDegree.has(dependent)) {
          inDegree.set(dependent, inDegree.get(dependent) - 1)
        }
      }
    }
  }

  return waves
}

module.exports = {
  getRushList,
  buildDependencyGraph,
  getAllDependencies,
  topologicalSortWaves
}

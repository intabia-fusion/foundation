const { join } = require('path')
const { readFileSync, promises: fsPromises, existsSync } = require('fs')

const { listWorkspaceProjects } = require('./workspace')

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
  const projects = listWorkspaceProjects(rootDir)
  if (verbose) console.log(`workspace: ${projects.length} projects`)
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
  listWorkspaceProjects,
  buildDependencyGraph,
  getAllDependencies,
  topologicalSortWaves
}

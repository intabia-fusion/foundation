#!/usr/bin/env node

const { resolve, join } = require('path')
const { existsSync } = require('fs')
const { performance } = require('perf_hooks')

const { BuildTaskQueue, TaskType } = require('./libs/task-queue')
const { CpuTracker, getOptimalWorkerCount, getDefaultWorkerCount, getPeakMemoryMB } = require('./libs/utils')
const { calculatePackageHash } = require('./libs/cache')
const { success, error, warn, info, dim, bold, colorizeErrorMessage } = require('./libs/colors')

// Import phases
const { runBuildPhase } = require('./phases/build')
const { runBundlePhase } = require('./phases/bundle-phase')
const { runPackagePhase } = require('./phases/package')
const { runDockerBuildPhase, preloadDockerImages, getDockerImageName } = require('./phases/docker-build')
const { runFormatPhase } = require('./phases/format')
const { runLintPhase } = require('./phases/lint')
const { runTestPhase } = require('./phases/test')
const { runSvelteCheckPhase } = require('./phases/svelte-check')
const { selectPackagesForPhases } = require('./libs/phase-select')
const { computeTypesHashes, compositeHashFromTypes } = require('./libs/composite-hash')

function parseArgs(args) {
  let parallel = getDefaultWorkerCount()
  let verbose = false
  let doTest = false
  let doLint = false
  let doFormat = false
  let force = false
  let doBundle = false
  let doPackage = false
  let doDockerBuild = false
  let doSvelteCheck = false
  let help = false
  let list = false
  let toPackage = null
  let rootDir = ''
  let forceWorkers = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--force-workers') {
      forceWorkers = true
    } else if (arg === '--parallel' || arg === '-p') {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        parallel = parseInt(next, 10)
        if (isNaN(parallel) || parallel < 1) {
          parallel = 1
        }
        i++
      } else {
        // Default to CPU count if no number specified
        parallel = require('os').cpus().length
      }
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--validate') {
      // Accepted for compatibility: validation is part of the build phase now.
    } else if (arg === '--test') {
      doTest = true
    } else if (arg === '--lint') {
      doLint = true
    } else if (arg === '--format') {
      doFormat = true
    } else if (arg === '--force' || arg === '-f') {
      force = true
    } else if (arg === '--bundle') {
      doBundle = true
    } else if (arg === '--package') {
      doPackage = true
      doBundle = true  // package implies bundle
    } else if (arg === '--docker-build') {
      doDockerBuild = true
      doPackage = true  // docker-build implies package
      doBundle = true  // docker-build implies bundle
    } else if (arg === '--svelte-check') {
      doSvelteCheck = true
    } else if (arg === '--list' || arg === '-l') {
      list = true
    } else if (arg === '--to') {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        if (toPackage) {
          toPackage += ',' + next
        } else {
          toPackage = next
        }
        i++
      }
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else if (!arg.startsWith('-')) {
      // Positional argument - rootDir
      rootDir = arg
    }
  }

  if (!toPackage) {
    toPackage = process.env.TO || null
  }
  if (!list) {
    list = process.env.LIST === '1'
  }
  if (!verbose) {
    verbose = process.env.VERBOSE === '1'
  }

  return { parallel, verbose, doTest, doLint, doFormat, force, doBundle, doPackage, doDockerBuild, doSvelteCheck, help, list, toPackage, rootDir, forceWorkers }
}

function printUsage() {
  console.log(`
Usage: compile-all <rootDir> [options]

Arguments:
  rootDir              Root directory of the monorepo (where pnpm-workspace.yaml is located)

Options:
  --parallel, -p <n>   Run compilation in parallel with n workers (default: 4, or 8 on systems with >64GB RAM)
                       If no number specified, uses CPU count (limited by available memory)
                       Parallel compilation respects dependency order (builds in waves)
  --force-workers      Force exact worker count, ignore memory limits (use with caution!)
  --verbose, -v        Show detailed output for each package
  --validate           Accepted for compatibility: type checking is part of the build
  --test               Run tests for packages with "_phase:test"
  --lint               Run ESLint check (no fix) after the build; for packages with "_phase:format"
  --format             Run the format phase only, for packages with "_phase:format"
  --force, -f          Disable all caching (forces full rebuild, revalidation)
  --bundle             Run bundle phase for packages with "_phase:bundle"
  --docker-build       Run docker-build phase (implies --bundle)
  --svelte-check       Run svelte-check for packages with "_phase:svelte-check"
  --list, -l           Only print the list of packages in compilation order (no actual compilation)
  --to <package>       Only compile the specified package and its dependencies
  --help, -h           Show this help message

Description:
  This script compiles all workspace packages that have a "_phase:build" script
  in their package.json scripts section. Packages are compiled in dependency order.

  When --lint is specified, also runs ESLint check (no fix) for
  packages that have "_phase:format" defined.

  When --format is specified, runs only the format phase for packages with "_phase:format".
  No transpile or validate phases are executed (standalone formatter command).

  When --bundle is specified, runs the bundle phase for packages with "_phase:bundle".

  When --docker-build is specified, runs bundle first, then docker-build for packages
  with "_phase:docker-build".

  When --svelte-check is specified, runs svelte-check for packages
  with "_phase:svelte-check" defined.

  When --to is specified, only the specified package and all its dependencies will be compiled.

  When --list is specified, prints the compilation order without actually compiling.

  The script automatically detects available memory and limits workers to prevent OOM.

Examples:
  compile-all .
  compile-all . --parallel 4 --verbose
  compile-all /path/to/repo -p -v --validate
  compile-all . --validate --force
  compile-all . --bundle --to @hcengineering/pod-server
  compile-all . --docker-build --to @hcengineering/pod-server
  compile-all . --list
  compile-all . --to @hcengineering/core
  compile-all . --format
  compile-all . --format --to @hcengineering/core
  compile-all . --lint
  compile-all . --lint --to @hcengineering/core
`)
}

// Transitive hash: dependency change invalidates dependents.
function calculatePackageHashWithDeps(packageName, graph, packageHashes, processed = new Set(), depTypesHashes = null) {
  if (processed.has(packageName)) {
    return ''
  }
  processed.add(packageName)

  const node = graph.get(packageName)
  if (!node) {
    return ''
  }

  // Get base hash of this package
  const baseHash = packageHashes.get(packageName) || ''
  const parts = [baseHash]

  for (const depName of node.dependencies) {
    const depHash = calculatePackageHashWithDeps(depName, graph, packageHashes, processed, depTypesHashes)
    if (depHash) {
      parts.push(`${depName}:${depHash}`)
    }
    // Fold in dep's emitted .d.ts hash: API change without src change still invalidates dependents.
    if (depTypesHashes) {
      const t = depTypesHashes.get(depName)
      if (t) {
        parts.push(`${depName}:types:${t}`)
      }
    }
  }

  parts.sort()

  const crypto = require('crypto')
  return crypto.createHash('md5').update(parts.join('\n')).digest('hex')
}

async function runBuildPipeline(packagesToBundle, packagesToPackage, packagesToDockerBuild, graph, buildWorkers, force, packageHashes) {
  const taskQueue = new BuildTaskQueue(graph, { concurrency: buildWorkers })

  // Preload docker image metadata in a single `docker inspect` call
  // instead of spawning 2 docker processes per package later.
  let dockerImageCache = null
  if (packagesToDockerBuild.length > 0 && !force) {
    const imageNames = []
    for (const pkg of packagesToDockerBuild) {
      const node = graph.get(pkg)
      if (!node) continue
      const name = getDockerImageName(node.project.fullPath)
      if (name) imageNames.push(name)
    }
    if (imageNames.length > 0) {
      const preloadStart = performance.now()
      dockerImageCache = await preloadDockerImages(imageNames)
      const preloadTime = Math.round(performance.now() - preloadStart)
      console.log(`    [docker-build] preloaded ${imageNames.length} image states in ${preloadTime}ms`)
    }
  }

  if (packagesToBundle.length > 0) {
    taskQueue.addTasks(TaskType.BUNDLE, packagesToBundle)
  }
  if (packagesToPackage.length > 0) {
    taskQueue.addTasks(TaskType.PACKAGE, packagesToPackage)
  }
  if (packagesToDockerBuild.length > 0) {
    taskQueue.addTasks(TaskType.DOCKER_BUILD, packagesToDockerBuild)
  }

  const phases = []
  if (packagesToBundle.length > 0) phases.push(`bundle(${packagesToBundle.length})`)
  if (packagesToPackage.length > 0) phases.push(`package(${packagesToPackage.length})`)
  if (packagesToDockerBuild.length > 0) phases.push(`docker-build(${packagesToDockerBuild.length})`)
  console.log(`\n=== Phase: Running pipeline [${phases.join(' -> ')}] ===`)

  const results = {
    bundle: { successCount: 0, total: packagesToBundle.length, cacheHits: 0, errors: [] },
    package: { successCount: 0, total: packagesToPackage.length, cacheHits: 0, errors: [] },
    dockerBuild: { successCount: 0, total: packagesToDockerBuild.length, cacheHits: 0, errors: [] }
  }

  const completedCount = { bundle: 0, package: 0, dockerBuild: 0 }

  async function worker() {
    while (true) {
      const task = taskQueue.getNextTask()

      if (!task) {
        if (taskQueue.isAllComplete()) {
          break
        }
        await new Promise(resolve => setTimeout(resolve, 10))
        continue
      }

      const { taskType, packageName } = task
      const node = graph.get(packageName)
      const pkgStart = performance.now()
      // Always include dependency hashes to ensure rebuilds when any dependency changes
      const packageHash = calculatePackageHashWithDeps(packageName, graph, packageHashes)

      try {
        let result

        switch (taskType) {
          case TaskType.BUNDLE: {
            result = await runBundlePhase(graph, [packageName], 1, { force, packageHash })
            completedCount.bundle++
            if (result.successCount > 0) {
              results.bundle.successCount++
              if (result.cacheHits > 0) results.bundle.cacheHits++
              const time = Math.round(performance.now() - pkgStart)
              const cacheInfo = result.cacheHits > 0 ? ' (cached)' : ''
              console.log(`    ${success('B')} ${dim(completedCount.bundle)}/${packagesToBundle.length} ${packageName} ${success('bundled')}${cacheInfo} ${dim(time + 'ms')}`)
            } else {
              results.bundle.errors.push(...result.errors)
              const time = Math.round(performance.now() - pkgStart)
              console.error(`    ${error('B')} ${dim(completedCount.bundle)}/${packagesToBundle.length} ${packageName} ${error('FAILED')} ${dim(time + 'ms')}`)
              if (result.errors && result.errors.length > 0) {
                for (const err of result.errors) {
                  const errMsg = err.error?.message || err.error?.stderr?.trim()?.split('\n')?.slice(-1)?.[0] || 'Unknown error'
                  const { colored } = colorizeErrorMessage(errMsg)
                  console.error(`      ${colored}`)
                }
              }
            }
            break
          }

          case TaskType.PACKAGE: {
            result = await runPackagePhase(graph, [packageName], 1, { force, packageHash })
            completedCount.package++
            if (result.successCount > 0) {
              results.package.successCount++
              if (result.cacheHits > 0) results.package.cacheHits++
              const time = Math.round(performance.now() - pkgStart)
              const cacheInfo = result.cacheHits > 0 ? ' (cached)' : ''
              console.log(`    ${success('P')} ${dim(completedCount.package)}/${packagesToPackage.length} ${packageName} ${success('packaged')}${cacheInfo} ${dim(time + 'ms')}`)
            } else {
              results.package.errors.push(...result.errors)
              const time = Math.round(performance.now() - pkgStart)
              console.error(`    ${error('P')} ${dim(completedCount.package)}/${packagesToPackage.length} ${packageName} ${error('FAILED')} ${dim(time + 'ms')}`)
              if (result.errors && result.errors.length > 0) {
                for (const err of result.errors) {
                  const errMsg = err.error?.message || err.error?.stderr?.trim()?.split('\n')?.slice(-1)?.[0] || 'Unknown error'
                  const { colored } = colorizeErrorMessage(errMsg)
                  console.error(`      ${colored}`)
                }
              }
            }
            break
          }

          case TaskType.DOCKER_BUILD: {
            result = await runDockerBuildPhase(graph, [packageName], 1, { force, packageHash, imageCache: dockerImageCache })
            completedCount.dockerBuild++
            if (result.successCount > 0) {
              results.dockerBuild.successCount++
              if (result.cacheHits > 0) results.dockerBuild.cacheHits++
              const time = Math.round(performance.now() - pkgStart)
              const cacheInfo = result.cacheHits > 0 ? ' (cached)' : ''
              console.log(`    ${success('D')} ${dim(completedCount.dockerBuild)}/${packagesToDockerBuild.length} ${packageName} ${success('docker built')}${cacheInfo} ${dim(Math.round(time / 1000) + 's')}`)
            } else {
              results.dockerBuild.errors.push(...result.errors)
              const time = Math.round(performance.now() - pkgStart)
              console.error(`    ${error('D')} ${dim(completedCount.dockerBuild)}/${packagesToDockerBuild.length} ${packageName} ${error('FAILED')} ${dim(Math.round(time / 1000) + 's')}`)
              if (result.errors && result.errors.length > 0) {
                for (const err of result.errors) {
                  const errMsg = err.error?.message || err.error?.stderr?.trim()?.split('\n')?.slice(-1)?.[0] || 'Unknown error'
                  const { colored } = colorizeErrorMessage(errMsg)
                  console.error(`      ${colored}`)
                }
              }
            }
            break
          }

          default:
            continue
        }

        taskQueue.completeTask(taskType, packageName, result)
      } catch (err) {
        console.error(`    ${packageName} ${taskType} failed: ${err.message}`)
        // A thrown task was only logged before, so it never affected the exit code.
        const bucket = taskType === TaskType.BUNDLE ? 'bundle' : taskType === TaskType.PACKAGE ? 'package' : 'dockerBuild'
        results[bucket].errors.push({ package: packageName, error: err })
        taskQueue.completeTask(taskType, packageName, { success: false, error: err })
      }
    }
  }

  // Start workers
  const workers = []
  for (let i = 0; i < buildWorkers; i++) {
    workers.push(worker())
  }
  await Promise.all(workers)

  // Print results
  if (packagesToBundle.length > 0) {
    console.log(`\nBundled: ${results.bundle.successCount}/${results.bundle.total} packages`)
    if (results.bundle.cacheHits > 0) console.log(`  (${results.bundle.cacheHits} from cache)`)
    if (results.bundle.errors.length > 0) {
      console.error(`\n  ${results.bundle.errors.length} bundle error(s):`)
      for (const err of results.bundle.errors) {
        console.error(`    - ${err.package}: ${err.error?.message || err.error}`)
      }
    }
  }
  if (packagesToPackage.length > 0) {
    console.log(`Packaged: ${results.package.successCount}/${results.package.total} packages`)
    if (results.package.cacheHits > 0) console.log(`  (${results.package.cacheHits} from cache)`)
    if (results.package.errors.length > 0) {
      console.error(`\n  ${results.package.errors.length} package error(s):`)
      for (const err of results.package.errors) {
        console.error(`    - ${err.package}: ${err.error?.message || err.error}`)
      }
    }
  }
  if (packagesToDockerBuild.length > 0) {
    console.log(`Docker built: ${results.dockerBuild.successCount}/${results.dockerBuild.total} packages`)
    if (results.dockerBuild.cacheHits > 0) console.log(`  (${results.dockerBuild.cacheHits} from cache)`)
    if (results.dockerBuild.errors.length > 0) {
      console.error(`\n  ${results.dockerBuild.errors.length} docker build error(s):`)
      for (const err of results.dockerBuild.errors) {
        console.error(`    - ${err.package}: ${err.error?.message || err.error}`)
      }
    }
  }

  return results
}

// Per-phase timing plus what the run was allowed to use. Printed on every build so a CI
// log carries the numbers needed to tell "slow" from "starved" without a rerun.
function printResourceSummary(phaseStats, validationPlan, buildPlan, tscPlan) {
  const { peakMB, source } = getPeakMemoryMB()

  console.log(`\n=== Resources ===`)
  console.log(`  CPUs usable        : ${validationPlan.cpuCount}`)
  console.log(`  Memory available   : ${validationPlan.availableMemoryMB} MB`)
  console.log(`  Memory budget (85%): ${validationPlan.budgetMB} MB`)
  console.log(`  tsc pool           : ${tscPlan.workers} processes`)
  console.log(`  Lint/format pool   : ${validationPlan.workers} workers x ${validationPlan.heapMB} MB heap ` +
    `= ${validationPlan.workers * validationPlan.heapMB} MB`)
  console.log(`  Bundle pool        : ${buildPlan.workers} workers`)
  if (peakMB != null) {
    const pct = validationPlan.budgetMB > 0 ? Math.round((peakMB / validationPlan.budgetMB) * 100) : 0
    console.log(`  Peak memory        : ${peakMB} MB (${pct}% of budget) — ${source}`)
  }
  if (validationPlan.belowSafeHeap) {
    console.log(`  ${warn('Heap per worker is below what the heaviest packages need — expect OOM failures')}`)
  }

  const rows = phaseStats.filter(p => p.seconds != null && p.total > 0)
  if (rows.length === 0) return

  console.log(`\n=== Phases ===`)
  console.log(`  ${'phase'.padEnd(14)} ${'time'.padStart(8)} ${'pkgs'.padStart(6)} ${'cached'.padStart(7)} ${'errors'.padStart(7)}  workers`)
  for (const r of rows) {
    const workers = r.workers != null
      ? `${r.workers}${r.heapMB ? ` x ${r.heapMB}MB` : ''}` +
        (r.peakChildRssMB ? ` (worst proc ${r.peakChildRssMB}MB)` : '')
      : ''
    console.log(
      `  ${r.name.padEnd(14)} ${(r.seconds.toFixed(1) + 's').padStart(8)} ${String(r.total).padStart(6)} ` +
      `${String(r.cacheHits).padStart(7)} ${String(r.errors).padStart(7)}  ${workers}`
    )
  }
}

// Reprint all errors at end of log so they're findable without scrolling.
function printErrorSummary(allErrors) {
  if (allErrors.length === 0) return
  console.error(`\n${'='.repeat(60)}`)
  console.error(`=== ERROR SUMMARY (${allErrors.length} error(s)) ===`)
  console.error(`${'='.repeat(60)}`)
  for (const err of allErrors) {
    const errMsg = err.error?.stderr || err.error?.stdout || err.error?.message || err.error || 'Unknown error'
    const output = err.output || ''
    console.error(`\n[${err.phase}] ${error(err.package)}:`)
    console.error(errMsg)
    if (output && !errMsg.includes(output.substring(0, 50))) {
      console.error(output)
    }
  }
  console.error(`${'='.repeat(60)}`)
}

async function compileAll(rootDir, options = {}) {
  const {
    parallel = 4,
    verbose = false,
    doTest = false,
    doLint = false,
    doFormat = false,
    force = false,
    doBundle = false,
    doPackage = false,
    doDockerBuild = false,
    doSvelteCheck = false,
    list = false,
    toPackage = null,
    forceWorkers = false
  } = options

  const startTime = performance.now()

  // Size every pool against the memory this process may actually use (cgroup limit in a
  // container, MemAvailable otherwise) rather than the host's total RAM.
  const validationPlan = getOptimalWorkerCount(parallel, 'typescript')
  const tscPlan = getOptimalWorkerCount(parallel, 'tsc')
  const buildPlan = getOptimalWorkerCount(parallel, 'bundle')
  const validationWorkers = forceWorkers ? parallel : validationPlan.workers
  const tscWorkers = forceWorkers ? parallel : tscPlan.workers
  const buildWorkers = forceWorkers ? parallel : buildPlan.workers

  // Start CPU tracking
  const cpuTracker = new CpuTracker(100)
  cpuTracker.start()

  console.log(`Building with ${tscWorkers} tsc workers, ${validationWorkers} lint/format workers, ${buildWorkers} bundle workers...`)
  console.log(`  Memory: ${validationPlan.availableMemoryMB}MB available, ${validationPlan.budgetMB}MB budget, ` +
    `${validationPlan.cpuCount} usable CPU(s); worker heap ${validationPlan.heapMB}MB/worker`)
  if (validationPlan.belowSafeHeap) {
    console.warn(warn(`  Warning: only ${validationPlan.heapMB}MB per validation worker; the heaviest ` +
      `packages need ~${validationPlan.minHeapMB}MB and may fail. Give the runner more memory ` +
      `or set FAST_BUILD_MEMORY_MB if this figure is wrong.`))
  }

  // Build dependency graph
  const { buildDependencyGraph } = require('./libs/graph')
  const { graph, projects } = await buildDependencyGraph(rootDir, verbose)

  // Pre-calculate package hashes for all packages (once per run)
  console.log('Calculating package hashes...')
  const packageHashes = new Map()
  for (const [name, node] of graph) {
    packageHashes.set(name, calculatePackageHash(node.project.fullPath))
  }
  console.log(`  Calculated ${packageHashes.size} package hashes`)

  // If --to is specified, collect target packages and all their dependencies
  let targetPackages = null
  if (toPackage) {
    // Parse multiple --to packages (comma-separated)
    const targets = toPackage.split(',').map(t => t.trim()).filter(Boolean)
    targetPackages = new Set()

    // Helper to get all dependencies recursively
    function getAllDependencies(packageName, visited = new Set()) {
      if (visited.has(packageName)) return
      visited.add(packageName)

      const node = graph.get(packageName)
      if (!node) return

      targetPackages.add(packageName)

      // Add all dependencies
      for (const dep of node.dependencies) {
        getAllDependencies(dep, visited)
      }
    }

    // Collect all targets and their dependencies
    for (const target of targets) {
      getAllDependencies(target)
    }

    console.log(`\nFiltering to ${targetPackages.size} packages (targets: ${targets.join(', ')})`)
  }

  const selection = selectPackagesForPhases(graph, {
    doTest, doBundle, doPackage, doDockerBuild, doSvelteCheck, targetPackages
  })

  const packagesToBuild = selection.build
  const packagesToTest = selection.test
  const packagesToFormat = selection.format
  const packagesToBundle = selection.bundle
  const packagesToPackage = selection.package
  const packagesToDockerBuild = selection.dockerBuild
  const packagesToSvelteCheck = selection.svelteCheck

  // Packages whose phase script this tool cannot run used to disappear without a word.
  if (selection.unknown.length > 0) {
    console.warn(`\n${warn(`Warning: ${selection.unknown.length} unrecognised phase script(s), these packages are NOT built:`)}`)
    for (const u of selection.unknown) {
      console.warn(`  ${u.package} — _phase:${u.phase}: ${dim(u.script)}`)
    }
    console.warn(`  Run them with ${bold('pnpm run')} inside the package, or express them as a supported phase script.`)
  }

  if (list) {
    console.log('\nPackages to process:')
    console.log(`  Build: ${packagesToBuild.length}`)
    console.log(`  Test: ${packagesToTest.length}`)
    console.log(`  Format: ${packagesToFormat.length}`)
    console.log(`  Bundle: ${packagesToBundle.length}`)
    console.log(`  Package: ${packagesToPackage.length}`)
    console.log(`  Docker-build: ${packagesToDockerBuild.length}`)
    console.log(`  Svelte-check: ${packagesToSvelteCheck.length}`)
    return { success: true, listOnly: true }
  }

  // Format-only mode: skip transpile/validate/bundle entirely
  if (doFormat) {
    const formatTargets = packagesToFormat
    console.log(`\n=== Phase: Formatting ${formatTargets.length} packages ===`)
    const formatResults = await runFormatPhase(graph, formatTargets, validationWorkers, { force, packageHashes })
    console.log(`Formatted: ${formatResults.successCount}/${formatResults.total} packages in ${Math.round(formatResults.time)}ms`)
    if (formatResults.cacheHits > 0) console.log(`  (${formatResults.cacheHits} from cache)`)

    cpuTracker.stop()
    const cpuStats = cpuTracker.getStats()
    const totalTime = performance.now() - startTime
    console.log(`\n=== Summary ===`)
    console.log(`Total time: ${Math.round(totalTime)}ms`)
    console.log(`CPU usage: avg ${cpuStats.avg}%, peak ${cpuStats.peak}%`)

    if (formatResults.errors.length > 0) {
      console.error('\nFormat errors:')
      for (const err of formatResults.errors) {
        const errMsg = err.error?.message || err.error || 'Unknown error'
        console.error(`  ${error(err.package)}: ${errMsg.split('\n')[0]}`)
      }
      return { success: false, errors: formatResults.errors.length }
    }

    return { success: true, time: totalTime, cpuStats }
  }

  // When --force is used with a "leaf" phase (--test, --lint, --svelte-check),
  // only force that specific phase — prerequisite phases (transpile, validate) use cache.
  const hasLeafPhase = doTest || doLint || doSvelteCheck
  const forcePrerequisites = force && !hasLeafPhase

  // Collect all errors across phases for final summary
  const allErrors = []
  const phaseStats = []
  const recordPhase = (name, r, workers, heapMB) => {
    if (!r) return
    phaseStats.push({
      name,
      seconds: r.time != null ? r.time / 1000 : null,
      total: r.total ?? 0,
      cacheHits: r.cacheHits ?? 0,
      errors: r.errors?.length ?? 0,
      workers: r.workers ?? workers,
      heapMB: r.heapMB ?? heapMB,
      peakChildRssMB: r.peakChildRssMB ?? 0
    })
  }

  // Single build phase: one tsc pass per package emits JS and .d.ts together.
  const buildPhaseResults = await runBuildPhase(graph, packagesToBuild, tscWorkers, {
    force: forcePrerequisites,
    packageHashes
  })

  if (buildPhaseResults.errors.length > 0) {
    for (const err of buildPhaseResults.errors) allErrors.push({ phase: 'build', ...err })
    console.error('\nBuild errors - stopping')
    printErrorSummary(allErrors)
    return { success: false, errors: buildPhaseResults.errors.length }
  }

  // Refresh hashes of rebuilt packages so later phases see correct hashes.
  for (const pkg of buildPhaseResults.changedPackages) {
    const node = graph.get(pkg)
    if (node?.project?.fullPath) {
      packageHashes.set(pkg, calculatePackageHash(node.project.fullPath))
    }
  }

  if (doLint) {
    const packagesToLint = packagesToBuild.filter((name) => graph.get(name)?.phaseFormat)
    if (packagesToLint.length > 0) {
      console.log(`\n=== Phase: Linting ${packagesToLint.length} packages ===`)
      const lintResults = await runLintPhase(graph, packagesToLint, validationWorkers, { force, packageHashes, typesHashes: computeTypesHashes(graph) })
      console.log(`Linted: ${lintResults.successCount}/${lintResults.total} packages in ${Math.round(lintResults.time)}ms`)
      recordPhase('lint', lintResults, null, null)
      if (lintResults.cacheHits > 0) console.log(`  (${lintResults.cacheHits} from cache)`)

      if (lintResults.errors.length > 0) {
        for (const err of lintResults.errors) allErrors.push({ phase: 'lint', ...err })
        console.error(`\n${lintResults.errors.length} lint error(s) - stopping build`)
        printErrorSummary(allErrors)
        return { success: false, errors: lintResults.errors.length }
      }
    }
  }

  // Phase: Svelte-check (runs after build)
  if (doSvelteCheck && packagesToSvelteCheck.length > 0) {
    console.log(`\n=== Phase: Svelte-checking ${packagesToSvelteCheck.length} packages ===`)
    const svelteCheckResults = await runSvelteCheckPhase(graph, packagesToSvelteCheck, validationWorkers, { force, packageHashes, typesHashes: computeTypesHashes(graph) })
    console.log(`Svelte-checked: ${svelteCheckResults.successCount}/${svelteCheckResults.total} packages in ${Math.round(svelteCheckResults.time)}ms`)
    recordPhase('svelte-check', svelteCheckResults, null, null)
    if (svelteCheckResults.cacheHits > 0) console.log(`  (${svelteCheckResults.cacheHits} from cache)`)

    if (svelteCheckResults.errors.length > 0) {
      for (const err of svelteCheckResults.errors) allErrors.push({ phase: 'svelte-check', ...err })
      console.error('\nSvelte-check errors - stopping build')
      printErrorSummary(allErrors)
      return { success: false, errors: svelteCheckResults.errors.length }
    }
  }

  // Phase: Test
  if (doTest && packagesToTest.length > 0) {
    console.log(`\n=== Phase: Testing ${packagesToTest.length} packages ===`)
    const testResults = await runTestPhase(graph, packagesToTest, validationWorkers, { force, packageHashes, verbose })
    console.log(`Tested: ${testResults.successCount}/${testResults.total} packages in ${Math.round(testResults.time)}ms`)
    recordPhase('test', testResults, validationWorkers, null)
    if (testResults.cacheHits > 0) console.log(`  (${testResults.cacheHits} from cache)`)
    if (testResults.skippedCount > 0) console.log(`  (${testResults.skippedCount} skipped — no test files)`)

    if (testResults.errors.length > 0) {
      for (const err of testResults.errors) allErrors.push({ phase: 'test', ...err })
      console.error('\nTest errors:')
      for (const err of testResults.errors) {
        const errMsg = err.error?.stderr || err.error?.stdout || err.error?.message || err.error || 'Unknown error'
        console.error(`  ${error(err.package)}:`)
        console.error(errMsg)
      }
      printErrorSummary(allErrors)
      return { success: false, errors: testResults.errors.length }
    }
  }

  // Phase 3: Build pipeline (bundle -> package -> docker-build)
  let buildResults = {}
  if (doBundle || doPackage || doDockerBuild) {
    buildResults = await runBuildPipeline(
      packagesToBundle,
      packagesToPackage,
      packagesToDockerBuild,
      graph,
      buildWorkers,
      force,
      packageHashes
    )
    // Pipeline failures never reached allErrors, so a failed bundle/package/docker build still exited 0.
    for (const phase of ['bundle', 'package', 'dockerBuild']) {
      for (const err of buildResults[phase]?.errors ?? []) allErrors.push({ phase, ...err })
    }
  }

  // Stop CPU tracking
  cpuTracker.stop()
  const cpuStats = cpuTracker.getStats()

  const totalTime = performance.now() - startTime

  recordPhase('build', buildPhaseResults, tscWorkers, null)

  console.log(`\n=== Summary ===`)
  console.log(`Total time: ${Math.round(totalTime)}ms`)
  console.log(`CPU usage: avg ${cpuStats.avg}%, peak ${cpuStats.peak}%`)
  printResourceSummary(phaseStats, validationPlan, buildPlan, tscPlan)

  if (allErrors.length > 0) {
    printErrorSummary(allErrors)
  }

  return {
    success: allErrors.length === 0,
    time: totalTime,
    cpuStats
  }
}

async function main() {
  const args = process.argv.slice(2)
  const options = parseArgs(args)

  if (options.help) {
    printUsage()
    process.exit(0)
  }

  if (!options.rootDir) {
    console.error('Error: rootDir argument is required')
    printUsage()
    process.exit(1)
  }

  const rootDir = resolve(options.rootDir)

  if (!existsSync(join(rootDir, 'pnpm-workspace.yaml'))) {
    console.error(`Error: pnpm-workspace.yaml not found in ${rootDir}`)
    process.exit(1)
  }

  try {
    const result = await compileAll(rootDir, options)

    // Terminate all worker pools so the process can exit cleanly
    try {
      const { terminateWorkerPool } = require('./libs/workers')
      await terminateWorkerPool()
    } catch { /* ignore */ }

    if (result.listOnly) {
      process.exit(0)
    }

    if (!result.success) {
      process.exit(1)
    }
    process.exit(0)
  } catch (err) {
    console.error('Error:', err.message)
    try {
      const { terminateWorkerPool } = require('./libs/workers')
      await terminateWorkerPool()
    } catch { /* ignore */ }
    process.exit(1)
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Unhandled error:', err)
    process.exit(1)
  })
}

module.exports = { compileAll, runBuildPhase, calculatePackageHashWithDeps }

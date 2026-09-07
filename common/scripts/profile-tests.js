/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

// Runs the unit tests package by package under --cpu-prof and reports where the time went.
// The split matters: most of this phase waits on kafka/postgres/elastic rather than burning CPU,
// and a CPU profile alone reports that as idle.

const { spawn } = require('child_process')
const { readFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } = require('fs')
const { join } = require('path')
const { listWorkspaceProjects, findWorkspaceRoot } = require('../../foundations/utils/packages/platform-rig/bin/libs/workspace')

const TEST_FILE = /\.(test|spec)\.(ts|js|tsx|jsx)$/

function hasTestFiles (dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    if (e.isDirectory()) {
      if (hasTestFiles(join(dir, e.name))) return true
    } else if (TEST_FILE.test(e.name)) {
      return true
    }
  }
  return false
}

function parseArgs (argv) {
  const args = { to: [], concurrency: 1, top: 20, out: '.profile-tests', inBand: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--to') args.to.push(...argv[++i].split(','))
    else if (a === '--concurrency') args.concurrency = parseInt(argv[++i], 10)
    else if (a === '--top') args.top = parseInt(argv[++i], 10)
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--in-band') args.inBand = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

// Self time per call frame, plus the idle/native split, summed over every profile a package wrote
// (jest parent and each of its workers).
function readProfiles (dir) {
  const totals = { cpu: 0, idle: 0, native: 0, frames: new Map(), files: 0 }
  if (!existsSync(dir)) return totals
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.cpuprofile')) continue
    let profile
    try {
      profile = JSON.parse(readFileSync(join(dir, name), 'utf-8'))
    } catch {
      continue
    }
    const { nodes, samples, timeDeltas } = profile
    if (nodes == null || samples == null || timeDeltas == null) continue
    totals.files++
    const byId = new Map(nodes.map((n) => [n.id, n]))
    for (let i = 0; i < samples.length; i++) {
      const us = timeDeltas[i] ?? 0
      if (us <= 0) continue
      const node = byId.get(samples[i])
      if (node == null) continue
      const fn = node.callFrame.functionName || '(anonymous)'
      if (fn === '(idle)') {
        totals.idle += us
        continue
      }
      if (fn === '(program)' || fn === '(garbage collector)') {
        totals.native += us
        continue
      }
      totals.cpu += us
      const url = (node.callFrame.url || '').replace(/^file:\/\//, '')
      const key = `${fn} ${shortenUrl(url)}`
      totals.frames.set(key, (totals.frames.get(key) ?? 0) + us)
    }
  }
  return totals
}

function shortenUrl (url) {
  if (url === '') return ''
  const m = url.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//)
  if (m != null) return m[1]
  const root = findWorkspaceRoot() ?? ''
  return url.startsWith(root) ? url.slice(root.length + 1) : url
}

function runPackage (project, outRoot, inBand) {
  const profDir = join(outRoot, project.name.replace(/[@/]/g, '_'))
  rmSync(profDir, { recursive: true, force: true })
  mkdirSync(profDir, { recursive: true })
  const jsonFile = join(profDir, 'jest.json')

  // No `--` separator: pnpm forwards it verbatim and jest then reads the rest as path patterns.
  const jestArgs = ['run', 'test', '--json', `--outputFile=${jsonFile}`]
  if (inBand) jestArgs.push('--runInBand')

  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('pnpm', jestArgs, {
      cwd: project.fullPath,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --cpu-prof --cpu-prof-dir=${profDir}`.trim() }
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => {
      const wall = Date.now() - started
      let tests = 0
      let suiteWall = 0
      let testCount = 0
      const slowest = []
      if (existsSync(jsonFile)) {
        try {
          const report = JSON.parse(readFileSync(jsonFile, 'utf-8'))
          for (const suite of report.testResults ?? []) {
            suiteWall += (suite.endTime - suite.startTime)
            for (const a of suite.assertionResults ?? []) {
              tests += a.duration ?? 0
              testCount++
              slowest.push({ title: a.title, duration: a.duration ?? 0, suite: suite.name })
            }
          }
        } catch { /* keep the zeros, the profile is still usable */ }
      }
      resolve({
        name: project.name,
        code,
        wall,
        suiteWall,
        tests,
        testCount,
        slowest,
        profiles: readProfiles(profDir),
        stderr: code === 0 ? '' : stderr.split('\n').filter((l) => l.trim()).slice(-5).join('\n')
      })
    })
  })
}

const fmt = (ms) => (ms / 1000).toFixed(1) + 's'

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    console.log(`Usage: node common/scripts/profile-tests.js [options]

  --to <pkg[,pkg]>   only these packages (repeatable)
  --concurrency <n>  packages in parallel (default 1: parallel runs distort the wall/idle split)
  --in-band          jest --runInBand, one process per package
  --top <n>          how many CPU frames to print (default 20)
  --out <dir>        where profiles land (default .profile-tests)

Writes a .cpuprofile per process; open them in Chrome DevTools for the full tree.`)
    return
  }

  const root = findWorkspaceRoot()
  const outRoot = join(root, args.out)
  mkdirSync(outRoot, { recursive: true })

  let projects = listWorkspaceProjects(root)
  if (args.to.length > 0) {
    const wanted = new Set(args.to)
    projects = projects.filter((p) => wanted.has(p.name))
    const missing = args.to.filter((n) => !projects.some((p) => p.name === n))
    if (missing.length > 0) {
      console.error(`Unknown package(s): ${missing.join(', ')}`)
      process.exit(1)
    }
  }

  projects = projects.filter((p) => {
    const pkgJson = join(p.fullPath, 'package.json')
    if (!existsSync(pkgJson)) return false
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8'))
    return pkg.scripts?.test != null && hasTestFiles(join(p.fullPath, 'src'))
  })

  if (projects.length === 0) {
    console.error('No packages with tests matched')
    process.exit(1)
  }

  console.log(`Profiling ${projects.length} package(s), concurrency ${args.concurrency}`)

  const results = []
  for (let i = 0; i < projects.length; i += args.concurrency) {
    const chunk = projects.slice(i, i + args.concurrency)
    const done = await Promise.all(chunk.map((p) => runPackage(p, outRoot, args.inBand)))
    for (const r of done) {
      results.push(r)
      const mark = r.code === 0 ? (r.testCount === 0 ? 'EMPTY' : 'ok   ') : 'FAIL '
      console.log(`  ${mark} ${fmt(r.wall).padStart(7)} ${r.name}${r.testCount > 0 ? ` (${r.testCount} tests)` : ''}`)
      if (r.stderr !== '') console.log(r.stderr.split('\n').map((l) => '       ' + l).join('\n'))
    }
  }

  results.sort((a, b) => b.wall - a.wall)

  console.log('\n=== Where the time went ===')
  console.log('  ' + 'package'.padEnd(46) + 'wall'.padStart(8) + 'cpu'.padStart(8) + 'cpu%'.padStart(7) +
    'tests'.padStart(8) + 'setup'.padStart(8) + 'procs'.padStart(7))
  let totWall = 0
  let totCpu = 0
  for (const r of results) {
    const cpu = r.profiles.cpu / 1000
    const setup = Math.max(0, r.suiteWall - r.tests)
    totWall += r.wall
    totCpu += cpu
    const pct = r.wall > 0 ? Math.round((cpu / r.wall) * 100) + '%' : '-'
    console.log('  ' + r.name.padEnd(46) + fmt(r.wall).padStart(8) + fmt(cpu).padStart(8) + pct.padStart(7) +
      fmt(r.tests).padStart(8) + fmt(setup).padStart(8) + String(r.profiles.files).padStart(7))
  }
  console.log('  ' + 'TOTAL'.padEnd(46) + fmt(totWall).padStart(8) + fmt(totCpu).padStart(8))
  console.log('\n  wall  = process wall time, the only figure that is a real elapsed duration')
  console.log('  cpu   = non-idle sample time summed over all procs; cpu% far below 100 means waiting, not compute')
  console.log('  tests = sum of jest test bodies, setup = suite wall minus test bodies (hooks, module load)')
  console.log('  tests/setup are summed over suites, so parallel suites can push them past wall')

  const slowTests = results.flatMap((r) => r.slowest.map((t) => ({ ...t, pkg: r.name })))
    .sort((a, b) => b.duration - a.duration).slice(0, args.top)
  if (slowTests.length > 0) {
    console.log('\n=== Slowest individual tests ===')
    for (const t of slowTests) {
      console.log(`  ${fmt(t.duration).padStart(8)}  ${t.pkg}  ${t.title.slice(0, 70)}`)
    }
  }

  const frames = new Map()
  for (const r of results) {
    for (const [k, v] of r.profiles.frames) frames.set(k, (frames.get(k) ?? 0) + v)
  }
  const top = [...frames.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.top)
  if (top.length > 0) {
    console.log('\n=== Top CPU frames (self time) ===')
    for (const [frame, us] of top) {
      console.log(`  ${fmt(us / 1000).padStart(8)}  ${frame}`)
    }
  }

  const profileCount = results.reduce((s, r) => s + r.profiles.files, 0)
  console.log(`\n${profileCount} .cpuprofile files in ${args.out}/ — open in Chrome DevTools for the full tree.`)

  const failed = results.filter((r) => r.code !== 0)
  if (failed.length > 0) {
    console.log(`\n${failed.length} package(s) failed: ${failed.map((r) => r.name).join(', ')}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

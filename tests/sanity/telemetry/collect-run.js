#!/usr/bin/env node
//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//

// Folds one run into run.json: timings, per-file cost, worker packing, flaky tests, load.
//
//   node telemetry/collect-run.js --dir runs/<ts> [--report <f>] [--steps <f>] [--docker <f>]
//
// CI fields read both GitHub and GitLab vars so history survives the move between them.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')

function arg (name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

function sh (cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

function fingerprint (workers) {
  const cpus = os.cpus()
  const ci = process.env.GITHUB_ACTIONS === 'true' ? 'github' : process.env.GITLAB_CI === 'true' ? 'gitlab' : undefined
  return {
    ci,
    // Lets compare-runs refuse a laptop-vs-runner diff instead of producing nonsense.
    env: ci ?? 'local',
    host: ci === undefined ? os.hostname() : undefined,
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0]?.model,
    cpuCount: cpus.length,
    memTotal: os.totalmem(),
    docker: sh('docker version --format "{{.Server.Version}}"'),
    workers,
    sha: process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA ?? sh('git rev-parse HEAD'),
    branch:
      process.env.GITHUB_REF_NAME ??
      process.env.CI_COMMIT_REF_NAME ??
      sh('git rev-parse --abbrev-ref HEAD'),
    pipeline: process.env.GITHUB_RUN_ID ?? process.env.CI_PIPELINE_ID
  }
}

function readTests (reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const runs = []
  const walk = (suite, file, project) => {
    const f = suite.file ?? file
    for (const child of suite.suites ?? []) walk(child, f, project)
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const attempts = test.results ?? []
        for (const r of attempts) {
          runs.push({
            file: f ?? spec.file,
            title: spec.title,
            project: test.projectName ?? project,
            status: r.status,
            retry: r.retry ?? 0,
            attempts: attempts.length,
            worker: r.workerIndex,
            start: new Date(r.startTime).getTime(),
            duration: r.duration ?? 0
          })
        }
      }
    }
  }
  for (const suite of report.suites ?? []) walk(suite, suite.file, undefined)
  // auth.setup registers itself only when .auth is missing, so counting it makes the totals
  // depend on whether the previous run left the files behind.
  const tests = runs.filter((r) => r.project !== 'setup')
  return { runs: tests, stats: report.stats ?? {}, workers: report.config?.workers }
}

function readSteps (stepsPath) {
  if (!fs.existsSync(stepsPath)) return []
  return fs
    .readFileSync(stepsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return undefined
      }
    })
    .filter((r) => r !== undefined)
}

function summariseDocker (dockerPath) {
  if (!fs.existsSync(dockerPath)) return undefined
  const byName = new Map()
  let ticks = 0
  let firstTs
  let lastTs
  for (const line of fs.readFileSync(dockerPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (firstTs === undefined || row.ts < firstTs) firstTs = row.ts
    if (lastTs === undefined || row.ts > lastTs) lastTs = row.ts
    let c = byName.get(row.name)
    if (c === undefined) {
      c = { name: row.name, samples: 0, cpuSum: 0, cpuPeak: 0, memSum: 0, memPeak: 0, rx: 0, tx: 0, dr: 0, dw: 0 }
      byName.set(row.name, c)
    }
    c.samples++
    c.cpuSum += row.cpu
    c.cpuPeak = Math.max(c.cpuPeak, row.cpu)
    c.memSum += row.mem
    c.memPeak = Math.max(c.memPeak, row.mem)
    c.rx += row.rx
    c.tx += row.tx
    c.dr += row.dr ?? 0
    c.dw += row.dw ?? 0
    ticks++
  }
  const spanSec = firstTs !== undefined && lastTs !== undefined ? (lastTs - firstTs) / 1000 : 0
  const containers = [...byName.values()]
    .map((c) => ({
      name: c.name,
      cpuAvg: round(c.cpuSum / c.samples),
      cpuPeak: round(c.cpuPeak),
      // "cores busy for the whole run" - the only container number that adds up across the fleet.
      cpuSeconds: round(((c.cpuSum / c.samples) / 100) * spanSec),
      memAvg: Math.round(c.memSum / c.samples),
      memPeak: c.memPeak,
      rx: c.rx,
      tx: c.tx,
      diskRead: c.dr,
      diskWrite: c.dw
    }))
    .sort((a, b) => b.cpuSeconds - a.cpuSeconds)
  return {
    spanSec: round(spanSec),
    rows: ticks,
    containers,
    totals: {
      cpuSeconds: round(containers.reduce((a, c) => a + c.cpuSeconds, 0)),
      memPeak: containers.reduce((a, c) => a + c.memPeak, 0),
      rx: containers.reduce((a, c) => a + c.rx, 0),
      tx: containers.reduce((a, c) => a + c.tx, 0),
      diskRead: containers.reduce((a, c) => a + c.diskRead, 0),
      diskWrite: containers.reduce((a, c) => a + c.diskWrite, 0)
    }
  }
}

const round = (v) => Math.round(v * 10) / 10

// `client/client.*` rows are browser-side, forwarded by analytics-collector.
function summariseStats (statsPath) {
  if (!fs.existsSync(statsPath)) return undefined
  let data
  try {
    data = JSON.parse(fs.readFileSync(statsPath, 'utf8'))
  } catch {
    return undefined
  }
  const entries = data.entries ?? []
  const pick = (e) => ({
    service: e.service,
    path: e.path,
    operations: e.operations,
    total: Math.round(e.total),
    avg: e.avg
  })
  const byService = new Map()
  for (const e of entries) {
    const svc = byService.get(e.service) ?? { service: e.service, operations: 0, timeMs: 0 }
    svc.operations += e.operations ?? 0
    // `client/*` carries browser-reported values, not server time - summing it made the collector
    // look like it spent an hour of a six-minute run.
    if (!String(e.path ?? '').startsWith('client/')) svc.timeMs += e.total ?? 0
    byService.set(e.service, svc)
  }
  return {
    totals: data.totals,
    client: data.client ?? [],
    services: [...byService.values()]
      .map((s) => ({ ...s, timeMs: Math.round(s.timeMs) }))
      .sort((a, b) => b.operations - a.operations)
      .slice(0, 20),
    top: entries
      .slice()
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
      .slice(0, 25)
      .map(pick),
    // By call count, not time: an N+1 shows here before it shows in latency.
    topByOps: entries
      .slice()
      .sort((a, b) => (b.operations ?? 0) - (a.operations ?? 0))
      .slice(0, 25)
      .map(pick)
  }
}

function main () {
  const dir = arg('dir', undefined)
  const reportPath = arg('report', 'playwright-report.json')
  const stepsPath = arg('steps', 'step-report.ndjson')
  const dockerPath = arg('docker', dir !== undefined ? path.join(dir, 'docker.ndjson') : 'docker.ndjson')

  if (!fs.existsSync(reportPath)) {
    console.error(`[telemetry] ${reportPath} not found - run the tests first`)
    process.exit(1)
  }

  const { runs, stats, workers: configuredWorkers } = readTests(reportPath)
  const steps = readSteps(stepsPath)

  const t0 = Math.min(...runs.map((r) => r.start))
  const tEnd = Math.max(...runs.map((r) => r.start + r.duration))

  const workers = new Map()
  for (const r of runs) {
    if (r.worker === undefined || r.worker < 0) continue
    const w = workers.get(r.worker) ?? { busy: 0, first: Infinity, last: 0 }
    w.busy += r.duration
    w.first = Math.min(w.first, r.start - t0)
    w.last = Math.max(w.last, r.start + r.duration - t0)
    workers.set(r.worker, w)
  }

  const files = new Map()
  for (const s of steps) {
    if (s.depth !== 0) continue
    files.set(s.file, (files.get(s.file) ?? 0) + s.ms)
  }

  const projects = new Map()
  for (const r of runs) {
    const p = projects.get(r.project ?? '-') ?? { tests: 0, duration: 0 }
    p.tests++
    p.duration += r.duration
    projects.set(r.project ?? '-', p)
  }

  // A test is flaky when it failed at least once and still ended up passing. Counting attempts
  // alone overstates it: a serial group is retried whole, so its passing tests get two attempts.
  const byTest = new Map()
  for (const r of runs) {
    const key = `${r.file} :: ${r.title}`
    const t = byTest.get(key) ?? { file: r.file, title: r.title, statuses: [], duration: 0 }
    t.statuses.push(r.status)
    t.duration += r.duration
    byTest.set(key, t)
  }
  const flaky = [...byTest.values()]
    .filter((t) => t.statuses.includes('passed') && t.statuses.some((st) => st !== 'passed' && st !== 'skipped'))
    .map((t) => ({ file: t.file, title: t.title, attempts: t.statuses.length, seconds: round(t.duration / 1000) }))
    .sort((a, b) => b.seconds - a.seconds)
  const failed = [...byTest.values()]
    .filter((t) => !t.statuses.includes('passed') && !t.statuses.includes('skipped'))
    .map((t) => ({ file: t.file, title: t.title, attempts: t.statuses.length }))

  const stepWork = steps.filter((s) => s.depth === 0).reduce((a, s) => a + s.ms, 0)
  const retryTime = runs.filter((r) => r.retry > 0).reduce((a, r) => a + r.duration, 0)

  const run = {
    generatedAt: new Date().toISOString(),
    fingerprint: fingerprint(configuredWorkers ?? workers.size),
    // Playwright never reuses a crashed worker's index, so extra indices mean crashed workers.
    workerRestarts: Math.max(0, workers.size - (configuredWorkers ?? workers.size)),
    totals: {
      wallSec: round((tEnd - t0) / 1000),
      workSec: round(stepWork / 1000),
      testDurationSec: round(runs.reduce((a, r) => a + r.duration, 0) / 1000),
      retrySec: round(retryTime / 1000),
      expected: [...byTest.values()].filter((t) => t.statuses.includes('passed')).length,
      unexpected: failed.length,
      flaky: flaky.length,
      skipped: [...byTest.values()].filter((t) => t.statuses.every((s) => s === 'skipped')).length,
      attempts: runs.length
    },
    workers: [...workers.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, w]) => ({
        index,
        busySec: round(w.busy / 1000),
        startedSec: round(w.first / 1000),
        endedSec: round(w.last / 1000)
      })),
    projects: [...projects.entries()].map(([name, p]) => ({
      name,
      tests: p.tests,
      seconds: round(p.duration / 1000)
    })),
    files: [...files.entries()]
      .map(([file, ms]) => ({ file, seconds: round(ms / 1000) }))
      .sort((a, b) => b.seconds - a.seconds),
    flaky,
    failed,
    docker: summariseDocker(dockerPath),
    stats: summariseStats(path.join(dir ?? '.', 'stats.json'))
  }

  const outDir = dir ?? '.'
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, 'run.json')
  fs.writeFileSync(outPath, JSON.stringify(run, null, 2))

  const d = run.docker
  console.log(
    `[telemetry] ${outPath}\n` +
      `  wall ${run.totals.wallSec}s  work ${run.totals.workSec}s  ` +
      `tests ${run.totals.expected ?? '?'} passed / ${run.totals.flaky} flaky / ${run.totals.unexpected ?? 0} failed\n` +
      (d !== undefined
        ? `  docker ${d.containers.length} containers  cpu ${d.totals.cpuSeconds}s  ` +
          `peak mem ${(d.totals.memPeak / 1024 ** 3).toFixed(1)}GB  net ${(
            (d.totals.rx + d.totals.tx) /
            1024 ** 3
          ).toFixed(2)}GB`
        : '  docker: no samples')
  )
}

main()

#!/usr/bin/env node
//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Diffs two run.json files - what got slower or chattier between two builds.
//
//   node telemetry/compare-runs.js <old>/run.json <new>/run.json [--json] [--force]
//
// Counts are properties of the code and always significant; wall clock also depends on the
// runner and swings by tens of percent between identical builds, so it is reported separately.

const fs = require('fs')

const NOISY = new Set(['wallSec', 'workSec', 'testDurationSec', 'cpuSeconds'])

function load (p) {
  if (!fs.existsSync(p)) {
    console.error(`[compare] ${p} not found`)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

const pct = (from, to) => (from === 0 ? (to === 0 ? 0 : 100) : ((to - from) / from) * 100)
const sign = (v) => (v > 0 ? `+${v}` : `${v}`)
const fmtPct = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`

function diffMaps (before, after, keyOf, valueOf, limit = 20) {
  const b = new Map(before.map((r) => [keyOf(r), valueOf(r)]))
  const a = new Map(after.map((r) => [keyOf(r), valueOf(r)]))
  const rows = []
  for (const key of new Set([...b.keys(), ...a.keys()])) {
    const from = b.get(key) ?? 0
    const to = a.get(key) ?? 0
    if (from === to) continue
    rows.push({ key, from, to, delta: to - from, pct: pct(from, to) })
  }
  return rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, limit)
}

function table (title, rows, unit = '') {
  if (rows.length === 0) return
  console.log(`\n${title}`)
  const w = Math.min(72, Math.max(...rows.map((r) => r.key.length)))
  for (const r of rows) {
    console.log(
      `  ${r.key.slice(0, w).padEnd(w)}  ${String(r.from).padStart(9)}${unit} -> ${String(r.to).padStart(9)}${unit}` +
        `  ${sign(Math.round(r.delta * 10) / 10).padStart(9)}  ${fmtPct(r.pct).padStart(8)}`
    )
  }
}

function main () {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  if (files.length !== 2) {
    console.error('usage: compare-runs.js <old run.json> <new run.json> [--json] [--force]')
    process.exit(1)
  }
  const [before, after] = files.map(load)
  const asJson = process.argv.includes('--json')
  const force = process.argv.includes('--force')

  const fpA = before.fingerprint ?? {}
  const fpB = after.fingerprint ?? {}
  // A laptop vs a CI runner produces confident nonsense - refuse unless told.
  const mismatch = ['env', 'cpuCount', 'workers'].filter((k) => fpA[k] !== fpB[k])
  if (mismatch.length > 0 && !force) {
    console.error(
      `[compare] environments differ (${mismatch
        .map((k) => `${k}: ${fpA[k]} vs ${fpB[k]}`)
        .join(', ')}) - numbers are not comparable. Pass --force to override.`
    )
    process.exit(2)
  }

  const counters = {
    'stats: operations': [before.stats?.totals?.operations ?? 0, after.stats?.totals?.operations ?? 0],
    'docker: rx bytes': [before.docker?.totals?.rx ?? 0, after.docker?.totals?.rx ?? 0],
    'docker: tx bytes': [before.docker?.totals?.tx ?? 0, after.docker?.totals?.tx ?? 0],
    // Passed/skipped are not comparable: auth.setup registers itself only when .auth is missing,
    // and love tests skip themselves when no room is free. Only failures mean something.
    'tests: failed': [before.totals?.unexpected ?? 0, after.totals?.unexpected ?? 0],
    'tests: flaky': [before.totals?.flaky ?? 0, after.totals?.flaky ?? 0]
  }
  const timings = {
    wallSec: [before.totals?.wallSec ?? 0, after.totals?.wallSec ?? 0],
    workSec: [before.totals?.workSec ?? 0, after.totals?.workSec ?? 0],
    cpuSeconds: [before.docker?.totals?.cpuSeconds ?? 0, after.docker?.totals?.cpuSeconds ?? 0],
    memPeak: [before.docker?.totals?.memPeak ?? 0, after.docker?.totals?.memPeak ?? 0]
  }

  const result = {
    before: { sha: fpA.sha, branch: fpA.branch, env: fpA.env, at: before.generatedAt },
    after: { sha: fpB.sha, branch: fpB.branch, env: fpB.env, at: after.generatedAt },
    counters: Object.fromEntries(
      Object.entries(counters).map(([k, [f, t]]) => [k, { from: f, to: t, delta: t - f, pct: pct(f, t) }])
    ),
    timings: Object.fromEntries(
      Object.entries(timings).map(([k, [f, t]]) => [
        k,
        { from: f, to: t, delta: t - f, pct: pct(f, t), noisy: NOISY.has(k) }
      ])
    ),
    services: diffMaps(before.stats?.services ?? [], after.stats?.services ?? [], (r) => r.service, (r) => r.operations),
    paths: diffMaps(
      before.stats?.topByOps ?? [],
      after.stats?.topByOps ?? [],
      (r) => `${r.service} ${r.path}`,
      (r) => r.operations
    ),
    files: diffMaps(before.files ?? [], after.files ?? [], (r) => r.file, (r) => r.seconds),
    containers: diffMaps(
      before.docker?.containers ?? [],
      after.docker?.containers ?? [],
      (r) => r.name,
      (r) => r.cpuSeconds
    )
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(
    `${(fpA.sha ?? '?').slice(0, 7)} -> ${(fpB.sha ?? '?').slice(0, 7)}  (${fpA.env ?? '?'}, ${fpA.cpuCount ?? '?'} cpu, ${fpA.workers ?? '?'} workers)`
  )

  console.log('\nCounters - properties of the code, any change is significant')
  for (const [k, v] of Object.entries(result.counters)) {
    console.log(
      `  ${k.padEnd(20)} ${String(v.from).padStart(12)} -> ${String(v.to).padStart(12)}  ${fmtPct(v.pct).padStart(8)}`
    )
  }

  console.log('\nTime and resources - noisy on shared runners')
  for (const [k, v] of Object.entries(result.timings)) {
    console.log(
      `  ${k.padEnd(20)} ${String(v.from).padStart(12)} -> ${String(v.to).padStart(12)}  ${fmtPct(v.pct).padStart(8)}`
    )
  }

  table('Requests by service', result.services)
  table('Requests by path', result.paths)
  table('Test files, s', result.files)
  table('Container CPU, s', result.containers)
}

main()

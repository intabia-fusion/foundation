#!/usr/bin/env node
//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Spread of repeated runs of the SAME sha - the floor below which a diff between two builds
// means nothing. Feeds the regression threshold (TSK-2026-08-30-015).
//
//   node telemetry/noise.js runs/*/run.json [--json] [--force]
//
// Counters are listed too, but as a control: they are properties of the code, so on one sha they
// should barely move. If they do, the stand is not reproducible and the timings say even less.

const fs = require('fs')

const METRICS = [
  ['wallSec', (r) => r.totals?.wallSec, 'time'],
  ['workSec', (r) => r.totals?.workSec, 'time'],
  ['cpuSeconds', (r) => r.docker?.totals?.cpuSeconds, 'time'],
  ['stats: operations', (r) => r.stats?.totals?.operations, 'count'],
  ['docker: rx bytes', (r) => r.docker?.totals?.rx, 'count'],
  ['tests: flaky', (r) => r.totals?.flaky, 'count']
]

// Nearest-rank on a sorted array: with 3-10 samples interpolation invents precision we lack.
function quantile (sorted, q) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[idx]
}

function stats (values) {
  const sorted = [...values].sort((a, b) => a - b)
  const median = quantile(sorted, 0.5)
  const p10 = quantile(sorted, 0.1)
  const p90 = quantile(sorted, 0.9)
  return {
    n: sorted.length,
    min: sorted[0],
    p10,
    median,
    p90,
    max: sorted[sorted.length - 1],
    spreadPct: median === 0 ? 0 : ((p90 - p10) / median) * 100
  }
}

function main () {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const asJson = process.argv.includes('--json')
  const force = process.argv.includes('--force')
  if (files.length < 3) {
    console.error('usage: noise.js <run.json> <run.json> <run.json> [...] [--json] [--force]')
    console.error('at least 3 runs of the same sha are needed for p10/p90 to mean anything')
    process.exit(1)
  }

  const runs = files.map((p) => JSON.parse(fs.readFileSync(p, 'utf8')))
  const fps = runs.map((r) => r.fingerprint ?? {})
  for (const key of ['sha', 'env', 'cpuCount', 'workers']) {
    const distinct = [...new Set(fps.map((f) => f[key]))]
    if (distinct.length > 1) {
      const msg = `[noise] runs differ in ${key}: ${distinct.join(', ')} - this measures build differences, not noise`
      if (!force) {
        console.error(`${msg}. Pass --force to override.`)
        process.exit(2)
      }
      console.error(`${msg} (--force)`)
    }
  }

  const result = {}
  for (const [name, pick] of METRICS) {
    const values = runs.map(pick).filter((v) => typeof v === 'number')
    if (values.length < 3) continue
    result[name] = { ...stats(values), kind: METRICS.find(([n]) => n === name)[2] }
  }

  if (asJson) {
    console.log(JSON.stringify({ sha: fps[0].sha, env: fps[0].env, runs: runs.length, metrics: result }, null, 2))
    return
  }

  console.log(
    `sha ${(fps[0].sha ?? '?').slice(0, 7)}  env ${fps[0].env ?? '?'}  ` +
      `${fps[0].cpuCount ?? '?'} cpu  ${fps[0].workers ?? '?'} workers  ${runs.length} runs`
  )
  console.log(`\n${'metric'.padEnd(20)}${'min'.padStart(11)}${'p10'.padStart(11)}${'median'.padStart(11)}` +
    `${'p90'.padStart(11)}${'max'.padStart(11)}${'spread'.padStart(9)}`)
  for (const [name, s] of Object.entries(result)) {
    console.log(
      name.padEnd(20) +
        [s.min, s.p10, s.median, s.p90, s.max].map((v) => String(Math.round(v)).padStart(11)).join('') +
        `${s.spreadPct.toFixed(1)}%`.padStart(9)
    )
  }
  const wall = result.wallSec
  if (wall !== undefined) {
    console.log(
      `\nThreshold for comparing builds: a time difference below ${Math.ceil(wall.spreadPct)}% is noise. ` +
        'Counters are significant at any change.'
    )
  }
}

main()

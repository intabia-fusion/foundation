#!/usr/bin/env node
//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Stability across runs: which tests keep coming back as flaky, and whether the wall time drifts.
//
//   node telemetry/stability.js                 # the last 10 runs
//   node telemetry/stability.js 20              # the last 20
//   node telemetry/stability.js 20260908-161248 20260908-153027
//
const fs = require('node:fs')
const path = require('node:path')

const RUNS = 'runs'

function pickStamps (args) {
  if (args.length > 1 || (args.length === 1 && !/^\d+$/.test(args[0]))) return args
  const limit = args.length === 1 ? Number(args[0]) : 10
  return fs
    .readdirSync(RUNS)
    .filter((d) => fs.existsSync(path.join(RUNS, d, 'run.json')))
    .sort()
    .slice(-limit)
}

function load (stamp) {
  try {
    return { stamp, run: JSON.parse(fs.readFileSync(path.join(RUNS, stamp, 'run.json'), 'utf8')) }
  } catch (err) {
    console.error(`skip ${stamp}: ${err.message}`)
    return undefined
  }
}

function main () {
  const runs = pickStamps(process.argv.slice(2)).map(load).filter(Boolean)
  if (runs.length === 0) {
    console.error('no runs found')
    process.exit(1)
  }

  console.log('stamp             wall    work   passed  flaky  failed')
  for (const { stamp, run } of runs) {
    const t = run.totals ?? {}
    console.log(
      [
        stamp.padEnd(16),
        String(t.wallSec ?? '?').padStart(6),
        String(t.workSec ?? '?').padStart(7),
        String(t.expected ?? '?').padStart(8),
        String(t.flaky ?? 0).padStart(6),
        String(t.unexpected ?? 0).padStart(7)
      ].join(' ')
    )
  }

  // The point of the loop: a test that flakes in several runs is a defect, one that flakes once is
  // still a candidate but ranks below it.
  const tally = new Map()
  for (const { stamp, run } of runs) {
    for (const kind of ['flaky', 'failed']) {
      for (const t of run[kind] ?? []) {
        const key = `${t.file} > ${t.title}`
        const e = tally.get(key) ?? { flaky: 0, failed: 0, runs: [] }
        e[kind === 'flaky' ? 'flaky' : 'failed']++
        e.runs.push(stamp)
        tally.set(key, e)
      }
    }
  }

  if (tally.size === 0) {
    console.log(`\nno flaky or failed tests in ${runs.length} runs`)
    return
  }

  console.log(`\nunstable tests in ${runs.length} runs (flaky/failed, runs):`)
  for (const [key, e] of [...tally.entries()].sort((a, b) => b[1].flaky + b[1].failed - (a[1].flaky + a[1].failed))) {
    console.log(`  ${String(e.flaky)}/${String(e.failed)}  ${key}   [${e.runs.join(' ')}]`)
  }
}

main()

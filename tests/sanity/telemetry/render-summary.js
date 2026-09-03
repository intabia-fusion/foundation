#!/usr/bin/env node
//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//

// run.json -> markdown for $GITHUB_STEP_SUMMARY, so a run reads from the job page itself.
//
//   node telemetry/render-summary.js --dir runs/ci [--title "UI tests: pg"]
//
// Sparklines, not images: a step summary renders markdown, and GitHub strips inline SVG.

const fs = require('fs')
const path = require('path')

const TOP = 10
const SPARK = '▁▂▃▄▅▆▇█'

function arg (name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const sec = (v) => (v == null ? 'n/a' : v >= 60 ? `${Math.floor(v / 60)}m ${Math.round(v % 60)}s` : `${Math.round(v)}s`)
const bytes = (v) => {
  if (v == null) return 'n/a'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}
const num = (v) => (v == null ? 'n/a' : v.toLocaleString('en-US').replace(/,/g, ' '))

function sparkline (values, buckets = 40) {
  if (values.length === 0) return ''
  const step = Math.max(1, Math.ceil(values.length / buckets))
  const folded = []
  for (let i = 0; i < values.length; i += step) {
    const slice = values.slice(i, i + step)
    folded.push(slice.reduce((a, b) => a + b, 0) / slice.length)
  }
  const max = Math.max(...folded)
  if (max === 0) return ''
  return folded.map((v) => SPARK[Math.min(SPARK.length - 1, Math.round((v / max) * (SPARK.length - 1)))]).join('')
}

// Per-tick totals across all containers, for the load sparklines.
function dockerTotals (dockerPath) {
  if (!fs.existsSync(dockerPath)) return undefined
  const cpu = new Map()
  const mem = new Map()
  for (const line of fs.readFileSync(dockerPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    cpu.set(r.ts, (cpu.get(r.ts) ?? 0) + (r.cpu ?? 0))
    mem.set(r.ts, (mem.get(r.ts) ?? 0) + (r.mem ?? 0))
  }
  const stamps = [...cpu.keys()].sort((a, b) => a - b)
  if (stamps.length === 0) return undefined
  return { cpu: stamps.map((s) => cpu.get(s)), mem: stamps.map((s) => mem.get(s) / 1073741824) }
}

function table (header, rows) {
  if (rows.length === 0) return []
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    ''
  ]
}

function details (title, body) {
  if (body.length === 0) return []
  return ['<details><summary>' + title + '</summary>', '', ...body, '</details>', '']
}

function main () {
  const dir = arg('dir', '.')
  const runPath = path.join(dir, 'run.json')
  if (!fs.existsSync(runPath)) {
    console.error(`[telemetry] ${runPath} not found`)
    process.exit(1)
  }
  const run = JSON.parse(fs.readFileSync(runPath, 'utf8'))
  const t = run.totals ?? {}
  const fp = run.fingerprint ?? {}
  const d = run.docker?.totals
  const out = []

  const title = arg('title', 'Run telemetry')
  out.push(`### ${title}`, '')
  out.push(
    `\`${(fp.sha ?? '?').slice(0, 7)}\` · ${fp.env ?? '?'} · ${fp.cpuCount ?? '?'} cpu · ${fp.workers ?? '?'} workers`,
    ''
  )

  out.push(
    ...table(
      ['Wall', 'Work', 'Retries', 'Passed', 'Flaky', 'Failed', 'Skipped'],
      [
        [
          sec(t.wallSec),
          sec(t.workSec),
          sec(t.retrySec),
          t.expected ?? 0,
          t.flaky ?? 0,
          t.unexpected ?? 0,
          t.skipped ?? 0
        ]
      ]
    )
  )

  if (d !== undefined) {
    const load = dockerTotals(path.join(dir, 'docker.ndjson'))
    out.push(
      ...table(
        ['CPU', 'Peak memory', 'Network', 'Disk'],
        [
          [
            sec(d.cpuSeconds),
            bytes(d.memPeak),
            bytes((d.rx ?? 0) + (d.tx ?? 0)),
            `${bytes(d.diskRead ?? 0)} read / ${bytes(d.diskWrite ?? 0)} write`
          ]
        ]
      )
    )
    if (load !== undefined) {
      out.push(
        ...table(
          ['Over the run', 'Shape', 'Peak'],
          [
            ['CPU, % of a core', `\`${sparkline(load.cpu)}\``, `${Math.round(Math.max(...load.cpu))}%`],
            ['Memory', `\`${sparkline(load.mem)}\``, `${Math.max(...load.mem).toFixed(1)} GB`]
          ]
        )
      )
    }
  }

  const failed = run.failed ?? []
  if (failed.length > 0) {
    out.push(
      ...table(
        ['Failed', 'Attempts'],
        failed.slice(0, TOP).map((f) => [`${f.file} · ${f.title}`, f.attempts])
      )
    )
  }

  const flaky = run.flaky ?? []
  out.push(
    ...details(
      `Flaky (${flaky.length})`,
      table(
        ['Test', 'Attempts', 'Time'],
        flaky.slice(0, TOP).map((f) => [`${f.file} · ${f.title}`, f.attempts, sec(f.seconds)])
      )
    )
  )

  out.push(
    ...details(
      'Slowest test files',
      table(
        ['File', 'Time'],
        (run.files ?? []).slice(0, TOP).map((f) => [f.file, sec(f.seconds)])
      )
    )
  )

  out.push(
    ...details(
      `Container load (${(run.docker?.containers ?? []).length} pods)`,
      table(
        ['Container', 'CPU', 'Peak memory', 'Net rx/tx'],
        (run.docker?.containers ?? []).map((c) => [
          c.name,
          sec(c.cpuSeconds),
          bytes(c.memPeak),
          `${bytes(c.rx)} / ${bytes(c.tx)}`
        ])
      )
    )
  )

  const stats = run.stats
  if (stats !== undefined) {
    out.push(
      ...details(
        `Service requests (${num(stats.totals?.operations)} operations)`,
        [
          ...table(
            ['Service', 'Operations', 'Time'],
            (stats.services ?? []).slice(0, TOP).map((s) => [s.service, num(s.operations), sec(s.timeMs / 1000)])
          ),
          ...table(
            ['Busiest path', 'Operations', 'Avg'],
            (stats.topByOps ?? []).slice(0, TOP).map((s) => [`${s.service} ${s.path}`, num(s.operations), `${s.avg} ms`])
          )
        ]
      )
    )
    out.push(
      ...details(
        'Client metrics',
        table(
          ['Metric', 'Reports', 'Total'],
          (stats.client ?? []).slice(0, TOP).map((c) => [c.metric, num(c.operations), num(Math.round(c.total))])
        )
      )
    )
  }

  console.log(out.join('\n'))
}

main()

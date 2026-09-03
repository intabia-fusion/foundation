#!/usr/bin/env node
//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//

// Renders run.json + docker.ndjson into a self-contained report.html.
//
//   node telemetry/render-report.js --dir runs/<ts>
//
// Inline SVG on purpose: the page must open from a CI artifact with no network.

const fs = require('fs')
const path = require('path')

function arg (name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const fmtBytes = (b) => {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`
  return `${(b / 1024).toFixed(0)} KB`
}
const fmtSec = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s}s`)

const PALETTE = [
  '#4c78a8', '#f58518', '#54a24b', '#e45756', '#72b7b2',
  '#eeca3b', '#b279a2', '#ff9da6', '#9d755d', '#bab0ac'
]

// Past the palette the golden angle keeps neighbouring bands apart - 30+ pods repeat 10 colours.
const bandColor = (i) => (i < PALETTE.length ? PALETTE[i] : `hsl(${Math.round((i * 137.508) % 360)} 52% 56%)`)

function readSeries (dockerPath) {
  if (!fs.existsSync(dockerPath)) return undefined
  const byTs = new Map()
  const names = new Set()
  for (const line of fs.readFileSync(dockerPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    names.add(r.name)
    let slot = byTs.get(r.ts)
    if (slot === undefined) {
      slot = {}
      byTs.set(r.ts, slot)
    }
    slot[r.name] = r
  }
  const stamps = [...byTs.keys()].sort((a, b) => a - b)
  if (stamps.length === 0) return undefined
  return { stamps, byTs, names: [...names], t0: stamps[0] }
}

// Stacked area over time. `pick` maps a per-container sample to the plotted value.
function stackedChart (series, keys, pick, opts) {
  const { width = 1040, height = 260, unit = '', scale = 1 } = opts ?? {}
  const padL = 56
  const padB = 24
  const padT = 12
  const plotW = width - padL - 12
  const plotH = height - padB - padT

  const spanMs = series.stamps[series.stamps.length - 1] - series.t0
  const x = (ts) => padL + (spanMs > 0 ? ((ts - series.t0) / spanMs) * plotW : 0)

  const totals = series.stamps.map((ts) => {
    const slot = series.byTs.get(ts)
    return keys.reduce((a, k) => a + (slot[k] !== undefined ? pick(slot[k]) : 0), 0)
  })
  const max = Math.max(...totals, 1)
  const y = (v) => padT + plotH - (v / max) * plotH

  // Cumulative bands so areas stack instead of overlapping.
  const running = new Map(series.stamps.map((ts) => [ts, 0]))
  let bands = ''
  keys.forEach((key, i) => {
    let top = ''
    let bottom = ''
    for (let n = 0; n < series.stamps.length; n++) {
      const ts = series.stamps[n]
      const slot = series.byTs.get(ts)
      const base = running.get(ts)
      const v = slot[key] !== undefined ? pick(slot[key]) : 0
      top += `${n === 0 ? 'M' : 'L'}${x(ts).toFixed(1)},${y(base + v).toFixed(1)} `
      running.set(ts, base + v)
    }
    for (let n = series.stamps.length - 1; n >= 0; n--) {
      const ts = series.stamps[n]
      bottom += `L${x(ts).toFixed(1)},${y(running.get(ts) - (series.byTs.get(ts)[key] !== undefined ? pick(series.byTs.get(ts)[key]) : 0)).toFixed(1)} `
    }
    bands += `<path d="${top}${bottom}Z" fill="${bandColor(i)}" fill-opacity="0.85"/>`
  })

  let grid = ''
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i
    const gy = y(v)
    grid +=
      `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${width - 12}" y2="${gy.toFixed(1)}" class="grid"/>` +
      `<text x="${padL - 8}" y="${(gy + 4).toFixed(1)}" class="axis" text-anchor="end">${(v * scale).toFixed(max * scale < 10 ? 1 : 0)}${unit}</text>`
  }
  let ticks = ''
  for (let i = 0; i <= 4; i++) {
    const ts = series.t0 + (spanMs / 4) * i
    ticks += `<text x="${x(ts).toFixed(1)}" y="${height - 6}" class="axis" text-anchor="middle">${Math.round((ts - series.t0) / 1000)}s</text>`
  }

  const legend = keys
    .map(
      (k, i) =>
        `<span class="key"><i style="background:${bandColor(i)}"></i>${esc(k.replace(/^sanity-/, '').replace(/-1$/, ''))}</span>`
    )
    .join('')

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="chart">${grid}${bands}${ticks}</svg><div class="legend">${legend}</div>`
}

// Fold per-path deltas to service level: 500 near-empty bands make no chart.
function readStatsSeries (statsPath) {
  if (!fs.existsSync(statsPath)) return undefined
  const byTs = new Map()
  const totals = new Map()
  for (const line of fs.readFileSync(statsPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const svc = String(r.service ?? '').replace(/^[0-9a-f]{12}-/, '')
    let slot = byTs.get(r.ts)
    if (slot === undefined) {
      slot = {}
      byTs.set(r.ts, slot)
    }
    slot[svc] = { ops: (slot[svc]?.ops ?? 0) + r.ops }
    totals.set(svc, (totals.get(svc) ?? 0) + r.ops)
  }
  const stamps = [...byTs.keys()].sort((a, b) => a - b)
  if (stamps.length === 0) return undefined
  // Deltas are per tick; divide by the real gap so the axis is requests per second.
  for (let i = 0; i < stamps.length; i++) {
    const gap = i === 0 ? 1 : (stamps[i] - stamps[i - 1]) / 1000
    const slot = byTs.get(stamps[i])
    for (const key of Object.keys(slot)) {
      slot[key].ops = gap > 0 ? slot[key].ops / gap : slot[key].ops
    }
  }
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k)
  return { series: { stamps, byTs, t0: stamps[0] }, top }
}

function barList (rows, valueOf, labelOf, format) {
  const max = Math.max(...rows.map(valueOf), 1)
  return rows
    .map(
      (r) =>
        `<div class="bar"><span class="bar-label">${esc(labelOf(r))}</span>` +
        `<span class="bar-track"><span class="bar-fill" style="width:${((valueOf(r) / max) * 100).toFixed(1)}%"></span></span>` +
        `<span class="bar-value">${esc(format(r))}</span></div>`
    )
    .join('')
}

function main () {
  const dir = arg('dir', '.')
  const runPath = path.join(dir, 'run.json')
  if (!fs.existsSync(runPath)) {
    console.error(`[telemetry] ${runPath} not found - run collect-run.js first`)
    process.exit(1)
  }
  const run = JSON.parse(fs.readFileSync(runPath, 'utf8'))
  const series = readSeries(path.join(dir, 'docker.ndjson'))
  const statsSeries = readStatsSeries(path.join(dir, 'stats.ndjson'))
  const fp = run.fingerprint ?? {}
  const t = run.totals ?? {}

  // Every pod, not a top slice: the charts are stacked, so a quiet container costs a thin band
  // and the sum stays honest.
  const topNames = (run.docker?.containers ?? []).map((c) => c.name)

  const cards = [
    ['Wall', fmtSec(t.wallSec ?? 0), 'first test start to last test end'],
    ['Work', fmtSec(t.workSec ?? 0), 'steps summed over every worker'],
    ['Tests', `${t.expected ?? 0}`, `${t.flaky ?? 0} flaky, ${t.unexpected ?? 0} failed, ${t.skipped ?? 0} skipped`],
    ['Retries', fmtSec(t.retrySec ?? 0), `${t.attempts ?? 0} attempts in total`]
  ]
  if ((run.workerRestarts ?? 0) > 0) {
    cards.push(['Workers died', `${run.workerRestarts}`, 'Playwright started a replacement process'])
  }
  cards.push(...[
  ])
  if (run.docker !== undefined) {
    cards.push(
      ['CPU', `${fmtSec(run.docker.totals.cpuSeconds)}`, 'summed over containers'],
      ['Memory', fmtBytes(run.docker.totals.memPeak), 'peaks summed over containers'],
      ['Network', fmtBytes(run.docker.totals.rx + run.docker.totals.tx), 'rx+tx over the run'],
      [
        'Disk',
        fmtBytes((run.docker.totals.diskRead ?? 0) + (run.docker.totals.diskWrite ?? 0)),
        `${fmtBytes(run.docker.totals.diskRead ?? 0)} read, ${fmtBytes(run.docker.totals.diskWrite ?? 0)} written`
      ]
    )
  }

  const workerRows = (run.workers ?? []).map((w) => ({
    ...w,
    idle: Math.max(0, (t.wallSec ?? 0) - w.busySec)
  }))

  const html = `<meta charset="utf-8">
<title>Sanity run - ${esc(fp.branch ?? 'local')} ${esc((fp.sha ?? '').slice(0, 7))}</title>
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --card:#f9fafb; --accent:#4c78a8; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --fg:#e8e8e8; --muted:#9aa1ab; --line:#2b2f36; --card:#1c1f25; --accent:#79a6d2; }
  }
  body { background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0 auto; padding: 28px 20px 60px; max-width: 1100px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 32px 0 10px; font-weight: 600; }
  .sub { color: var(--muted); margin-bottom: 20px; font-size: 13px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
  .card b { display: block; font-size: 22px; font-weight: 600; }
  .card span { color: var(--muted); font-size: 12px; }
  .card em { display: block; color: var(--muted); font-size: 11px; font-style: normal; margin-top: 2px; }
  .chart { width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .grid { stroke: var(--line); stroke-width: 1; }
  .axis { fill: var(--muted); font-size: 10px; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 8px 0 0; font-size: 12px; color: var(--muted); }
  .key i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
  .bar { display: grid; grid-template-columns: minmax(120px, 260px) 1fr 92px; gap: 10px; align-items: center; margin: 3px 0; font-size: 12.5px; }
  .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { background: var(--card); border-radius: 3px; height: 14px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
  .bar-value { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th, td { text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; }
  th.num, td.num { text-align: right; }
  td.num { font-variant-numeric: tabular-nums; }
  .wrap { overflow-x: auto; }
  .empty { color: var(--muted); font-style: italic; }
</style>
<h1>Sanity run - ${esc(fp.branch ?? 'local')} <span class="sub">${esc((fp.sha ?? '').slice(0, 7))}</span></h1>
<div class="sub">
  ${esc(fp.env ?? 'local')}${fp.host !== undefined ? ' / ' + esc(fp.host) : ''} -
  ${esc(fp.cpuModel ?? '?')} x${esc(fp.cpuCount ?? '?')}, ${fmtBytes(fp.memTotal ?? 0)} RAM,
  docker ${esc(fp.docker ?? '?')}, ${esc(fp.workers ?? '?')} workers - ${esc(run.generatedAt)}
</div>

<div class="cards">
  ${cards.map(([k, v, note]) => `<div class="card"><span>${esc(k)}</span><b>${esc(v)}</b><em>${esc(note)}</em></div>`).join('')}
</div>

${
  series !== undefined
    ? `<h2>CPU by container</h2>
${stackedChart(series, topNames, (r) => r.cpu, { unit: '%', height: 240 })}

<h2>Memory by container</h2>
${stackedChart(series, topNames, (r) => r.mem, { unit: ' GB', scale: 1 / 1024 ** 3, height: 240 })}

<h2>Network, bytes per second</h2>
${stackedChart(series, topNames, (r) => r.rx + r.tx, { unit: ' MB', scale: 1 / 1024 ** 2, height: 200 })}

<h2>Disk, bytes per second</h2>
${stackedChart(series, topNames, (r) => (r.dr ?? 0) + (r.dw ?? 0), { unit: ' MB', scale: 1 / 1024 ** 2, height: 200 })}`
    : '<h2>Container load</h2><p class="empty">No docker.ndjson next to run.json - the sampler never ran.</p>'
}

<h2>Worker packing</h2>
<div class="sub">Busy time against wall clock: the gap is idle tail at the end of the run.</div>
${barList(workerRows, (w) => w.busySec, (w) => `worker ${w.index}`, (w) => `${w.busySec}s / ends ${w.endedSec}s`)}

<h2>Test files by time</h2>
${barList((run.files ?? []).slice(0, 20), (f) => f.seconds, (f) => f.file, (f) => `${f.seconds}s`)}

${
  (run.flaky ?? []).length > 0
    ? `<h2>Flaky</h2>
<div class="wrap"><table><tr><th>Test</th><th>File</th><th class="num">Attempts</th><th class="num">Time</th></tr>
${run.flaky.map((f) => `<tr><td>${esc(f.title)}</td><td>${esc(f.file)}</td><td class="num">${f.attempts}</td><td class="num">${f.seconds}s</td></tr>`).join('')}
</table></div>`
    : '<h2>Flaky</h2><p class="empty">None.</p>'
}

${
  (run.failed ?? []).length > 0
    ? `<h2>Failed</h2>
<div class="wrap"><table><tr><th>Test</th><th>File</th><th class="num">Attempts</th></tr>
${run.failed.map((f) => `<tr><td>${esc(f.title)}</td><td>${esc(f.file)}</td><td class="num">${f.attempts}</td></tr>`).join('')}
</table></div>`
    : ''
}

${
  run.stats !== undefined
    ? `<h2>Client to server</h2>
<div class="sub">Browser counters via analytics-collector. Bytes are on the wire, after compression.</div>
${
  (run.stats.client ?? []).length > 0
    ? `<div class="wrap"><table><tr><th>Metric</th><th class="num">Reports</th><th class="num">Total</th><th class="num">Average</th></tr>
${run.stats.client.map((c) => `<tr><td>${esc(c.metric)}</td><td class="num">${c.operations}</td><td class="num">${Math.round(c.total)}</td><td class="num">${c.avg}</td></tr>`).join('')}
</table></div>`
    : '<p class="empty">No client.* metrics: the front bundle ships without client counters, or analytics-collector is not configured.</p>'
}

<h2>Services: requests and time</h2>
<div class="sub">${esc(run.stats.totals?.operations ?? 0)} operations, ${esc(Math.round((run.stats.totals?.timeMs ?? 0) / 1000))}s in total.</div>
${barList((run.stats.services ?? []).slice(0, 15), (x) => x.operations, (x) => x.service, (x) => `${x.operations} / ${Math.round(x.timeMs / 1000)}s`)}

${
  statsSeries !== undefined
    ? `<h2>Requests per second, by service</h2>
<div class="sub">The series is no finer than the stats push interval (10s by default, 1s under test) -
spikes shorter than that are invisible.</div>
${stackedChart(statsSeries.series, statsSeries.top, (r) => r.ops, { unit: '/s', height: 220 })}`
    : ''
}

<h2>Most called</h2>
<div class="sub">Sorted by call count: an N+1 shows up here before it shows up in latency.</div>
<div class="wrap"><table><tr><th>Service</th><th>Path</th><th class="num">Calls</th><th class="num">Time</th><th class="num">Average</th></tr>
${(run.stats.topByOps ?? []).map((e) => `<tr><td>${esc(e.service)}</td><td>${esc(e.path)}</td><td class="num">${e.operations}</td><td class="num">${Math.round(e.total / 1000)}s</td><td class="num">${e.avg}</td></tr>`).join('')}
</table></div>

<h2>Most expensive paths</h2>
<div class="wrap"><table><tr><th>Service</th><th>Path</th><th class="num">Calls</th><th class="num">Time</th><th class="num">Average</th></tr>
${(run.stats.top ?? []).map((e) => `<tr><td>${esc(e.service)}</td><td>${esc(e.path)}</td><td class="num">${e.operations}</td><td class="num">${Math.round(e.total / 1000)}s</td><td class="num">${e.avg}</td></tr>`).join('')}
</table></div>`
    : ''
}

${
  run.docker !== undefined
    ? `<h2>Containers</h2>
<div class="wrap"><table>
<tr><th>Container</th><th class="num">CPU, s</th><th class="num">CPU avg</th><th class="num">CPU peak</th><th class="num">Mem avg</th><th class="num">Mem peak</th><th class="num">Net rx</th><th class="num">Net tx</th><th class="num">Disk read</th><th class="num">Disk write</th></tr>
${run.docker.containers
  .map(
    (c) =>
      `<tr><td>${esc(c.name)}</td><td class="num">${c.cpuSeconds}</td><td class="num">${c.cpuAvg}%</td><td class="num">${c.cpuPeak}%</td><td class="num">${fmtBytes(c.memAvg)}</td><td class="num">${fmtBytes(c.memPeak)}</td><td class="num">${fmtBytes(c.rx)}</td><td class="num">${fmtBytes(c.tx)}</td>` +
      `<td class="num">${fmtBytes(c.diskRead ?? 0)}</td><td class="num">${fmtBytes(c.diskWrite ?? 0)}</td></tr>`
  )
  .join('')}
</table></div>`
    : ''
}
`

  const outPath = path.join(dir, 'report.html')
  fs.writeFileSync(outPath, html)
  console.log(`[telemetry] ${outPath}`)
}

main()

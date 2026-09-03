#!/usr/bin/env node
//
// Answers "where did the run actually spend its time" from step-report.ndjson (StepReporter).
//
//   node analyze_steps.js               # cost by action, setup share, unstable steps
//   node analyze_steps.js --top 40
//   node analyze_steps.js other.ndjson
//
// The unstable-steps table is the flake radar: an action whose p50 is 300ms but whose max is 30s
// is one slow stand away from a timeout, and it shows up here before it ever turns a test red.
//
const fs = require('node:fs')

const args = process.argv.slice(2)
const top = Number(args[args.indexOf('--top') + 1]) || 25
const FILE = args.find((a) => a.endsWith('.ndjson')) ?? 'step-report.ndjson'

if (!fs.existsSync(FILE)) {
  console.error(`no ${FILE} - run the tests first (rushx uitest)`)
  process.exit(1)
}

const rows = fs
  .readFileSync(FILE, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l))

// Ids, uuids and generated names make every step title unique; strip them so the same click
// across 200 tests groups into one row.
const norm = (s) =>
  (s ?? '')
    .replace(/[0-9a-f]{8,}/gi, '#')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90)

const pct = (sorted, p) => sorted[Math.max(0, Math.ceil((sorted.length * p) / 100) - 1)]
const s = (ms) => (ms / 1000).toFixed(1) + 's'

function table (title, list, cols) {
  console.log(`\n=== ${title} ===`)
  console.log(cols.map((c) => c.h).join('\t'))
  for (const row of list) console.log(cols.map((c) => c.f(row)).join('\t'))
}

// Nested steps double-count: a test.step contains the clicks inside it. Leaf actions only.
const leaves = rows.filter((r) => r.category === 'pw:api' || r.category === 'expect')

const byAction = new Map()
for (const r of leaves) {
  const k = `${r.category} ${norm(r.title)}`
  const e = byAction.get(k) ?? { k, ms: 0, n: 0, list: [], files: new Set() }
  e.ms += r.ms
  e.n++
  e.list.push(r)
  e.files.add(r.file)
  byAction.set(k, e)
}
const actions = [...byAction.values()].map((e) => {
  const sorted = e.list.map((r) => r.ms).sort((a, b) => a - b)
  const slowest = e.list.reduce((a, b) => (a.ms > b.ms ? a : b))
  return { ...e, p50: pct(sorted, 50), p95: pct(sorted, 95), max: sorted[sorted.length - 1], slowest }
})

console.log(
  `${FILE}: ${rows.length} steps, ${new Set(rows.map((r) => r.file + r.test)).size} tests, ` +
    `${s(leaves.reduce((a, r) => a + r.ms, 0))} in actions`
)

table(
  `top ${top} by total time`,
  [...actions].sort((a, b) => b.ms - a.ms).slice(0, top),
  [
    { h: 'total', f: (r) => s(r.ms) },
    { h: 'n', f: (r) => r.n },
    { h: 'p50', f: (r) => r.p50 + 'ms' },
    { h: 'p95', f: (r) => r.p95 + 'ms' },
    { h: 'max', f: (r) => s(r.max) },
    { h: 'action', f: (r) => r.k }
  ]
)

// Flake radar. Needs enough samples for p50 to mean anything, and a spread wide enough that the
// slow case is a different event, not the same one plus noise.
const unstable = actions
  .filter((r) => r.n >= 5 && r.max > 3000 && r.max > r.p50 * 8)
  .sort((a, b) => b.max - a.max)
  .slice(0, top)
table(
  `unstable steps (max >> p50) - flake candidates`,
  unstable,
  [
    { h: 'max', f: (r) => s(r.max) },
    { h: 'p50', f: (r) => r.p50 + 'ms' },
    { h: 'n', f: (r) => r.n },
    { h: 'worst test', f: (r) => `${r.slowest.file}: ${r.slowest.test}`.slice(0, 60) },
    { h: 'action', f: (r) => r.k }
  ]
)

// Per-test setup share: a beforeEach that logs in and creates a workspace can cost more than the
// test it prepares, and it is charged to every test in the file.
const byTest = new Map()
for (const r of rows) {
  const k = `${r.file} :: ${r.test}`
  const e = byTest.get(k) ?? { k, hooks: 0, body: 0 }
  if (r.depth === 0 && r.category === 'hook') e.hooks += r.ms
  else if (r.depth === 0 && r.category !== 'fixture') e.body += r.ms
  byTest.set(k, e)
}
const hooks = [...byTest.values()].sort((a, b) => b.hooks - a.hooks)
const hookTotal = hooks.reduce((a, e) => a + e.hooks, 0)
const bodyTotal = hooks.reduce((a, e) => a + e.body, 0)
console.log(
  `\n=== setup cost: ${s(hookTotal)} in hooks vs ${s(bodyTotal)} in test bodies ` +
    `(${((hookTotal / (hookTotal + bodyTotal)) * 100).toFixed(0)}% of the run is setup) ===`
)
table(
  `top ${top} tests by hook time`,
  hooks.slice(0, top),
  [
    { h: 'hooks', f: (r) => s(r.hooks) },
    { h: 'body', f: (r) => s(r.body) },
    { h: 'test', f: (r) => r.k.slice(0, 80) }
  ]
)

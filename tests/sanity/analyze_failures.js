#!/usr/bin/env node
//
// Turns the two-pass JSON reports into an answer to "what actually broke".
//
//   node analyze_failures.js              # what broke, what was just flaky
//   node analyze_failures.js --all        # list every failing test, not just the top ones
//   node analyze_failures.js <file.json>  # analyse a specific report
//
// Reads the json reporter's output. With trace: 'on-first-retry' a test that passed on a retry
// is a flake; one that is still red after its retries is a real failure.
//
const fs = require('node:fs')

const args = process.argv.slice(2)
const showAll = args.includes('--all')
const explicit = args.find((a) => a.endsWith('.json'))
const REPORT = explicit ?? 'playwright-report.json'

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const strip = (s) => (s ?? '').replace(ANSI, '')

// Collapses an error into something groupable - the assertion kind plus the locator, without
// the ids and timestamps that make every message unique.
function classify (message) {
  const m = strip(message).replace(/\s+/g, ' ').trim()
  if (m === '') return 'no error message'
  if (/Test timeout of \d+ms exceeded/.test(m)) return 'test timeout'
  if (/Timeout \d+ms exceeded while waiting on the predicate/.test(m)) return 'predicate timeout'
  if (/Target (page|frame|browser).*closed/.test(m)) return 'page closed'
  const expect = m.match(/expect\((?:locator|received)\)\.(\w+)/)
  const locator = m.match(/Locator: ([^\n]{0,60})/)
  if (expect !== null) return `expect.${expect[1]}${locator !== null ? ` -> ${locator[1].trim()}` : ''}`
  return m.slice(0, 70)
}

// Walks the JSON reporter's nested suites into a flat list of attempts per test.
function readReport (file) {
  if (!fs.existsSync(file)) return null
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const tests = []
  const walk = (suite) => {
    for (const child of suite.suites ?? []) walk(child)
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const results = t.results ?? []
        tests.push({
          file: spec.file ?? suite.file ?? '?',
          line: spec.line,
          title: spec.title,
          statuses: results.map((r) => r.status),
          duration: results.reduce((a, r) => a + (r.duration ?? 0), 0),
          errors: results.map((r) => strip(r.error?.message ?? '')).filter((e) => e !== ''),
          traces: results.flatMap((r) => (r.attachments ?? []).filter((a) => a.name === 'trace').map((a) => a.path))
        })
      }
    }
  }
  for (const s of data.suites ?? []) walk(s)
  return { file, tests }
}

function outcome (t) {
  if (t.statuses.length === 0) return 'skipped'
  const last = t.statuses[t.statuses.length - 1]
  if (last === 'skipped') return 'skipped'
  if (last === 'passed') return t.statuses.length > 1 ? 'flaky' : 'passed'
  return 'failed'
}

const rep = readReport(REPORT)
if (rep === null) {
  console.error(`no ${REPORT} - run the tests first (rushx uitest)`)
  process.exit(1)
}

function bucket (r) {
  const b = { passed: [], failed: [], flaky: [], skipped: [] }
  for (const t of r.tests) b[outcome(t)].push(t)
  return b
}

function group (tests, fn) {
  const m = new Map()
  for (const t of tests) {
    const k = fn(t)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(t)
  }
  return [...m].sort((a, b) => b[1].length - a[1].length)
}

const b = bucket(rep)
const real = b.failed
const flaky = b.flaky
console.log(`\n=== ${REPORT} ===`)
console.log(`passed ${b.passed.length}   flaky ${flaky.length}   failed ${real.length}   skipped ${b.skipped.length}`)

if (real.length > 0) {
  console.log(`\n=== ${real.length} real failures, by error ===`)
  for (const [err, tests] of group(real, (t) => classify(t.errors[t.errors.length - 1]))) {
    console.log(`\n  ${tests.length}x  ${err}`)
    for (const t of showAll ? tests : tests.slice(0, 5)) {
      console.log(`      ${t.file}:${t.line}  ${t.title.slice(0, 70)}`)
    }
    if (!showAll && tests.length > 5) console.log(`      ... and ${tests.length - 5} more (--all)`)
  }

  console.log('\n=== by file ===')
  for (const [file, tests] of group(real, (t) => t.file)) {
    console.log(`  ${String(tests.length).padStart(3)}  ${file}`)
  }

  const traces = real.flatMap((t) => t.traces).slice(0, 3)
  if (traces.length > 0) {
    console.log('\n=== traces ===')
    for (const tr of traces) console.log(`  npx playwright show-trace ${tr}`)
  }
}

if (flaky.length > 0) {
  console.log(`\n=== ${flaky.length} flaky (passed on a retry), by error ===`)
  for (const [err, tests] of group(flaky, (t) => classify(t.errors[0]))) {
    console.log(`  ${String(tests.length).padStart(3)}x  ${err}`)
    if (showAll) for (const t of tests) console.log(`        ${t.file}:${t.line}  ${t.title.slice(0, 70)}`)
  }
}

const slow = [...rep.tests].sort((a, b) => b.duration - a.duration).slice(0, 8)
console.log('\n=== slowest tests ===')
for (const t of slow) {
  console.log(`  ${(t.duration / 1000).toFixed(1).padStart(7)} s  ${t.file}  ${t.title.slice(0, 55)}`)
}

process.exit(real.length > 0 ? 1 : 0)

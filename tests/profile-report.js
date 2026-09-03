#!/usr/bin/env node
// Aggregates every ./profiles/<service>/*.cpuprofile into one hot-path table.
// Self time comes from samples/timeDeltas, not hitCount - a sample's cost is its own delta.
const fs = require('fs')
const path = require('path')
const { SourceMap } = require('node:module')

// Frames with no code behind them.
const SYNTHETIC = new Set(['(idle)', '(program)', '(root)'])
// Background polling that runs whether or not the stand is doing anything. Reported as a
// lump sum per service instead of crowding out the frames that reflect real work.
const IDLE_URL = /node:internal\/timers|node:timers|kafkajs\/src\/network\/requestQueue/
const isGc = (name) => name === '(garbage collector)'
const REPO = path.resolve(__dirname, '..')

// service -> package dir holding bundle/bundle.js.map, for resolving frames back to sources.
const BUNDLES = {
  stream: 'services/stream',
  'time-machine': 'services/worker',
  activity: 'services/activity',
  account: 'pods/account',
  workspace: 'pods/workspace',
  front0: 'pods/front',
  transactor0: 'pods/server',
  collaborator0: 'pods/collaborator',
  rekoni: 'services/rekoni',
  fulltext: 'pods/fulltext',
  stats: 'pods/stats',
  analytics: 'services/analytics-collector/pod-analytics-collector',
  notifications: 'services/notifications',
  datalake: 'services/datalake/pod-datalake',
  preview: 'pods/preview',
  billing: 'services/billing/pod-billing',
  payment: 'services/payment/pod-payment',
  'tbank-subscriptions': 'services/payment/pod-tbank-subscriptions',
  love: 'services/love',
  aibot: 'services/ai-bot/pod-ai-bot',
  aibot_client_llm: 'services/ai-bot/pod-ai-bot',
  sign: 'services/sign/pod-sign',
  print: 'services/print/pod-print'
}

const dir = process.argv[2] ?? './profiles'
const topN = Number(process.argv[3] ?? 25)
const warnings = []

// Loads the service's source map, but only when the bundle on disk is byte-identical to the one
// the container ran - otherwise every resolved line would be confidently wrong.
function loadMap (svc) {
  let result = null
  const pkg = BUNDLES[svc]
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, svc, 'meta.json'), 'utf8'))
    const bundle = path.join(REPO, pkg, 'bundle', 'bundle.js')
    const hostSize = fs.statSync(bundle).size
    if (hostSize !== meta.size) {
      warnings.push(`${svc}: bundle.js differs from the one that ran (${hostSize} vs ${meta.size}) - rebuild, no source lines`)
    } else {
      result = new SourceMap(JSON.parse(fs.readFileSync(`${bundle}.map`, 'utf8')))
    }
  } catch (err) {
    warnings.push(`${svc}: no source map (${err.code ?? err.message})`)
  }
  return result
}

function resolveFrame (map, url, line, col) {
  if (map === null || !url.endsWith('bundle.js')) return null
  try {
    const e = map.findEntry(line, col)
    if (e?.originalSource == null) return null
    const src = e.originalSource.replace(/^.*?((foundations|pods|services|packages|plugins|models)\/)/, '$1')
    return `${src}:${e.originalLine + 1}`
  } catch {
    return null
  }
}

// Frames are resolved here, once per profile, so the idle/gc split below can look at real
// source paths instead of the bundle they were minified into.
function selfTimeByFrame (profile, map) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n.callFrame]))
  const locOf = new Map()
  const out = new Map()
  const { samples = [], timeDeltas = [] } = profile
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i]
    const frame = byId.get(id)
    if (frame === undefined) continue
    // timeDeltas[i] is the gap *before* sample i, so it is the cost attributed to it.
    const us = timeDeltas[i] ?? 0
    if (us <= 0) continue
    let key = locOf.get(id)
    if (key === undefined) {
      const name = frame.functionName === '' ? '(anonymous)' : frame.functionName
      let loc = ''
      if (frame.url !== '') {
        loc =
          resolveFrame(map, frame.url, frame.lineNumber, frame.columnNumber) ??
          `${frame.url.replace(/^file:\/\//, '')}:${frame.lineNumber + 1}`
      }
      key = `${name}\t${loc}`
      locOf.set(id, key)
    }
    out.set(key, (out.get(key) ?? 0) + us)
  }
  return out
}

const services = fs.existsSync(dir)
  ? fs
      .readdirSync(dir, { withFileTypes: true })
      // .old-reports and friends are bookkeeping, not services.
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  : []
if (services.length === 0) {
  console.error(`no profiles under ${dir} - run ./prepare-pg.sh --profile, then ./profile-collect.sh`)
  process.exit(1)
}

const perService = new Map()
const global = new Map()
let grandTotal = 0

for (const svc of services) {
  const files = fs.readdirSync(path.join(dir, svc)).filter((f) => f.endsWith('.cpuprofile'))
  const map = loadMap(svc)
  const merged = new Map()
  let total = 0
  let gc = 0
  let idle = 0
  for (const f of files) {
    let profile
    try {
      profile = JSON.parse(fs.readFileSync(path.join(dir, svc, f), 'utf8'))
    } catch (err) {
      console.error(`skipping ${svc}/${f}: ${err.message}`)
      continue
    }
    for (const [k, us] of selfTimeByFrame(profile, map)) {
      const [name, url] = k.split('\t')
      if (SYNTHETIC.has(name)) continue
      total += us
      if (isGc(name)) {
        gc += us
        continue
      }
      if (IDLE_URL.test(url)) {
        idle += us
        continue
      }
      merged.set(k, (merged.get(k) ?? 0) + us)
      global.set(`${svc}\t${k}`, (global.get(`${svc}\t${k}`) ?? 0) + us)
    }
  }
  if (total > 0) {
    perService.set(svc, { merged, total, gc, idle, files: files.length })
    grandTotal += total
  }
}

const ms = (us) => (us / 1000).toFixed(1).padStart(9)
const pct = (us, of) => `${((us / of) * 100).toFixed(1)}%`.padStart(6)

console.log('\n=== CPU per service (self time) ===')
console.log(`${'service'.padEnd(22)} ${'total'.padStart(9)}     ${'work'.padStart(9)}     ${'gc'.padStart(9)}     ${'timers'.padStart(9)}`)
for (const [svc, s] of [...perService].sort((a, b) => b[1].total - a[1].total)) {
  const work = s.total - s.gc - s.idle
  console.log(
    `${svc.padEnd(22)} ${ms(s.total)} ms ${ms(work)} ms ${pct(work, s.total)} ${ms(s.gc)} ms ${pct(s.gc, s.total)} ${ms(s.idle)} ms ${pct(s.idle, s.total)}`
  )
}

console.log(`\n=== Top ${topN} hot frames across all services (gc and timers excluded) ===`)
for (const [key, us] of [...global].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
  const idx = key.indexOf('\t')
  const svc = key.slice(0, idx)
  const [name, loc] = key.slice(idx + 1).split('\t')
  console.log(`${ms(us)} ms ${pct(us, grandTotal)}  ${svc.padEnd(18)} ${name.padEnd(38)} ${loc}`)
}

console.log('\n=== Top 5 per service ===')
for (const [svc, s] of [...perService].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`\n${svc}  (work ${ms(s.total - s.gc - s.idle)} ms of ${ms(s.total)} ms)`)
  for (const [key, us] of [...s.merged].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    const [name, loc] = key.split('\t')
    console.log(`  ${ms(us)} ms ${pct(us, s.total - s.gc - s.idle)}  ${name.padEnd(38)} ${loc}`)
  }
}

if (warnings.length > 0) {
  console.log('\n=== Source maps unavailable ===')
  for (const w of warnings) console.log(`  ${w}`)
}

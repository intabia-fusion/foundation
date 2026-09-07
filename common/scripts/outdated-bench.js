#!/usr/bin/env node
//
// Copyright © 2026 Intabia Fusion
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

// Compares two published versions of a dependency on repo-shaped workloads before upgrading.
// Scenario per package: common/scripts/bench/<package>.js, exporting (module) => [{ name, run }]
// or an async (module) => { cases, teardown } for servers/sockets. A case may set
// { async: true, concurrency: N } to be measured with N operations in flight.
//
// Usage:
//   node common/scripts/outdated-bench.js fast-equals              # current (upgrade_plan.tsv) vs latest
//   node common/scripts/outdated-bench.js uuid 8.3.2 11.1.1
//   node common/scripts/outdated-bench.js --all                    # every package that has a scenario
// Env: ROUNDS (7), ROUND_MS (250)

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = process.cwd()
const BENCH_DIR = path.join(ROOT, 'common/scripts/bench')
const WORK_DIR = path.join(ROOT, 'combined_dependencies/bench')
const PLAN = path.join(ROOT, 'combined_dependencies/upgrade_plan.tsv')
const ROUNDS = Number(process.env.ROUNDS ?? 7)
const ROUND_MS = Number(process.env.ROUND_MS ?? 250)

function planRow (name) {
  if (!fs.existsSync(PLAN)) return undefined
  return fs
    .readFileSync(PLAN, 'utf8')
    .split('\n')
    .slice(1)
    .map((l) => l.split('\t'))
    .find((r) => r[0] === name)
}

function install (pkg, versions) {
  fs.mkdirSync(WORK_DIR, { recursive: true })
  const pkgJson = path.join(WORK_DIR, 'package.json')
  if (!fs.existsSync(pkgJson)) fs.writeFileSync(pkgJson, '{"name":"dep-bench","private":true}')
  const aliases = versions.map((v, i) => `bench${i}@npm:${pkg}@${v}`)
  execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', ...aliases], { cwd: WORK_DIR, stdio: 'inherit' })
  return versions.map((_, i) => path.join(WORK_DIR, 'node_modules', `bench${i}`))
}

function round (fn, ms) {
  for (let i = 0; i < 2000; i++) fn()
  const t0 = performance.now()
  const end = t0 + ms
  let n = 0
  while (performance.now() < end) {
    for (let i = 0; i < 50; i++) fn()
    n += 50
  }
  return n / (performance.now() - t0)
}

// Async cases (servers, sockets): ops/ms too, measured with `concurrency` in flight.
async function roundAsync (fn, ms, concurrency) {
  for (let i = 0; i < 20; i++) await fn()
  const t0 = performance.now()
  const end = t0 + ms
  let n = 0
  while (performance.now() < end) {
    await Promise.all(Array.from({ length: concurrency }, () => fn()))
    n += concurrency
  }
  return n / (performance.now() - t0)
}

async function benchOne (pkg, versions) {
  const scenarioFile = path.join(BENCH_DIR, `${pkg.replace('/', '__')}.js`)
  if (!fs.existsSync(scenarioFile)) {
    console.log(`no scenario for ${pkg}: create ${path.relative(ROOT, scenarioFile)}`)
    return
  }
  install(pkg, versions)
  // resolve aliases from the bench workspace so ESM-only packages load too
  const loaderFile = path.join(WORK_DIR, 'loader.mjs')
  fs.writeFileSync(loaderFile, 'export default (name) => import(name)\n')
  const { default: load } = await import(require('url').pathToFileURL(loaderFile).href)
  const scenario = require(scenarioFile)
  const suites = []
  const teardowns = []
  for (let i = 0; i < versions.length; i++) {
    const ns = await load(`bench${i}`)
    const result = await scenario(Object.keys(ns).length === 1 && ns.default !== undefined ? ns.default : ns)
    suites.push(Array.isArray(result) ? result : result.cases)
    if (!Array.isArray(result) && result.teardown !== undefined) teardowns.push(result.teardown)
  }

  console.log(`\n${pkg}: ${versions.join(' vs ')} (best of ${ROUNDS} x ${ROUND_MS}ms, ops/ms)\n`)
  console.log('case'.padEnd(26), ...versions.map((v) => v.padStart(20)))
  for (let c = 0; c < suites[0].length; c++) {
    const best = versions.map(() => 0)
    const spec = suites[0][c]
    for (let r = 0; r < ROUNDS; r++) {
      for (let v = 0; v < suites.length; v++) {
        const case_ = suites[v][c]
        const ops =
          case_.async === true
            ? await roundAsync(case_.run, ROUND_MS, case_.concurrency ?? 1)
            : round(case_.run, ROUND_MS)
        best[v] = Math.max(best[v], ops)
      }
    }
    console.log(
      spec.name.padEnd(26),
      ...best.map((b) => `${b.toFixed(1)} (${(b / best[0]).toFixed(2)}x)`.padStart(20))
    )
  }
  for (const t of teardowns) await t()
}

async function main () {
  const args = process.argv.slice(2)
  if (args[0] === '--all') {
    for (const f of fs.readdirSync(BENCH_DIR).filter((f) => !f.startsWith('_'))) {
      const pkg = f.replace(/\.js$/, '').replace('__', '/')
      const row = planRow(pkg)
      if (row === undefined) {
        console.log(`\n${pkg}: не устарел, пропуск`)
        continue
      }
      await benchOne(pkg, [row[1], row[2]])
    }
    return
  }
  const pkg = args[0]
  if (pkg === undefined) {
    console.error('usage: outdated-bench.js <package> [<verA> <verB>] | --all')
    process.exit(1)
  }
  let versions = args.slice(1)
  if (versions.length === 0) {
    const row = planRow(pkg)
    if (row === undefined) {
      console.error(`${pkg} нет в upgrade_plan.tsv, укажи версии явно`)
      process.exit(1)
    }
    versions = [row[1], row[2]]
  }
  await benchOne(pkg, versions)
}

void main()

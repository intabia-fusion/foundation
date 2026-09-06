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

// Bumps an external dependency version across all workspace package.json files.
// Version data comes from combined_dependencies/upgrade_plan.tsv (see outdated.js).
// Usage:
//   node common/scripts/outdated-apply.js <package> <version> [--dry]
//   node common/scripts/outdated-apply.js [--category ui] [--bump patch] [--except pkg1,pkg2] [--dry]
// --category selects dependencies of that category (see UPGRADE.md), but bumps them
// everywhere: rush check requires a single version per dependency across the repo.
// Writes combined_dependencies/verify.sh with the check commands for touched packages.

const fs = require('fs')
const path = require('path')

const DEPS_DIR = path.join(process.cwd(), 'combined_dependencies')
// packages capped at an exact version are written without a range prefix
const PINNED_EXACT = new Set(
  Object.entries(
    (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'common/config/dependency-pins.json'), 'utf8')).pins ?? {}
      } catch (err) {
        return {}
      }
    })()
  )
    .filter(([, pin]) => pin.maxVersion !== undefined)
    .map(([name]) => name)
)
const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const opt = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const category = opt('--category')
const bump = opt('--bump')
const except = (opt('--except') ?? '').split(',').filter((x) => x.length > 0)
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))

function plan () {
  return fs
    .readFileSync(path.join(DEPS_DIR, 'upgrade_plan.tsv'), 'utf8')
    .split('\n')
    .slice(1)
    .filter((l) => l.trim().length > 0)
    .map((l) => l.split('\t'))
    .map(([name, current, latest, kind, category]) => ({ name, current, latest, kind, category }))
}

let targets
if (positional.length === 2) {
  targets = [[positional[0], positional[1]]]
} else if (category !== undefined || bump !== undefined) {
  targets = plan()
    .filter((r) => (category === undefined || r.category === category) && (bump === undefined || r.kind === bump) && !except.includes(r.name))
    .map((r) => [r.name, r.latest])
} else {
  console.error('usage: outdated-apply.js <package> <version> [--dry] | [--category <name>] [--bump <patch|minor|major>] [--dry]')
  process.exit(1)
}

if (targets.length === 0) {
  console.log('nothing matched')
  process.exit(0)
}

const files = fs
  .readFileSync(path.join(DEPS_DIR, 'package_list.txt'), 'utf8')
  .split('\n')
  .filter((f) => f.trim().length > 0)

let changed = 0
const touchedNames = []
for (const file of files) {
  let raw = fs.readFileSync(file, 'utf8')
  const json = JSON.parse(raw)
  let touched = false
  for (const [name, version] of targets) {
    for (const field of FIELDS) {
      const cur = json[field]?.[name]
      if (cur === undefined || cur.startsWith('workspace:')) continue
      // a capped package is written exact: even ~ would let a later patch cross the cap
      const prefix = PINNED_EXACT.has(name) ? '' : /^[\^~]/.exec(cur)?.[0] ?? '^'
      const next = `${prefix}${version}`
      if (cur === next) continue
      // Text replace keeps original formatting intact
      const q = `"${name}": "${cur}"`
      if (!raw.includes(q)) {
        console.log(`${file}: SKIP ${name} (${cur} not found verbatim)`)
        continue
      }
      raw = raw.split(q).join(`"${name}": "${next}"`)
      touched = true
      console.log(`${file}: ${name} ${cur} -> ${next}`)
    }
  }
  if (touched) {
    changed++
    if (json.name !== undefined) touchedNames.push(json.name)
    if (!dry) fs.writeFileSync(file, raw)
  }
}

console.log(`${dry ? '[dry] ' : ''}${changed} package.json files ${dry ? 'would change' : 'updated'}`)

if (touchedNames.length > 0) {
  // build takes one --to with a comma-separated list
  const to = `--to ${touchedNames.join(',')}`
  const verify = ['#!/usr/bin/env bash', 'set -e', 'pnpm install', `pnpm build:lint ${to}`, ''].join('\n')
  if (!dry) fs.writeFileSync(path.join(DEPS_DIR, 'verify.sh'), verify)
  console.log(`\ncheck (${touchedNames.length} workspace packages)${dry ? '' : ', also written to combined_dependencies/verify.sh'}:`)
  console.log('  pnpm install')
  console.log(`  pnpm build:lint ${to}`)
}

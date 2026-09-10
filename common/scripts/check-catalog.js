#!/usr/bin/env node
/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

// Keeps package.json in step with the catalog in pnpm-workspace.yaml: any literal version for a
// catalogued dependency is drift, and `--fix` rewrites it to "catalog:". A literal that disagrees
// with the catalog is rewritten too, but reported loudly — bump the catalog if that was intended.

const { readFileSync, writeFileSync, existsSync } = require('fs')
const { join } = require('path')
const { listWorkspaceProjects, findWorkspaceRoot } = require('../../foundations/utils/packages/platform-rig/bin/libs/workspace')

const SECTIONS = ['dependencies', 'devDependencies']

/** The catalog block, read without a YAML dependency — it is a flat `name: version` list. */
function readCatalog (rootDir) {
  const text = readFileSync(join(rootDir, 'pnpm-workspace.yaml'), 'utf-8')
  const catalog = new Map()
  let inCatalog = false
  for (const raw of text.split('\n')) {
    if (/^catalog:\s*$/.test(raw)) { inCatalog = true; continue }
    if (!inCatalog) continue
    if (/^\S/.test(raw)) break
    const m = raw.match(/^\s+'?([^':\s]+)'?:\s*(\S.*?)\s*$/)
    if (m) catalog.set(m[1], m[2])
  }
  return catalog
}

function main () {
  const fix = process.argv.includes('--fix')
  const root = findWorkspaceRoot()
  if (root == null) {
    console.error('pnpm-workspace.yaml not found')
    process.exit(1)
  }
  const catalog = readCatalog(root)
  if (catalog.size === 0) {
    console.error('catalog: block is empty or missing in pnpm-workspace.yaml')
    process.exit(1)
  }

  const drifted = []
  const conflicts = []

  for (const project of listWorkspaceProjects(root)) {
    const path = join(project.fullPath, 'package.json')
    if (!existsSync(path)) continue
    const pkg = JSON.parse(readFileSync(path, 'utf-8'))
    let touched = false
    for (const section of SECTIONS) {
      for (const [name, value] of Object.entries(pkg[section] ?? {})) {
        const pinned = catalog.get(name)
        if (pinned === undefined || typeof value !== 'string' || value.startsWith('catalog:')) continue
        const entry = { project: project.name, section, name, value, pinned }
        if (value === pinned) drifted.push(entry)
        else conflicts.push(entry)
        if (fix) {
          pkg[section][name] = 'catalog:'
          touched = true
        }
      }
    }
    if (touched) writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
  }

  if (drifted.length > 0) {
    console.log(`${fix ? 'Rewrote' : 'Found'} ${drifted.length} literal version(s) that match the catalog:`)
    for (const d of drifted.slice(0, 20)) {
      console.log(`  ${d.project} (${d.section}): ${d.name} = ${d.value}`)
    }
    if (drifted.length > 20) console.log(`  ... and ${drifted.length - 20} more`)
  }

  if (conflicts.length > 0) {
    console.error(`\n${conflicts.length} version(s) disagreed with the catalog and ${fix ? 'were' : 'would be'} replaced by it:`)
    for (const c of conflicts) {
      console.error(`  ${c.project} (${c.section}): ${c.name} = ${c.value}, catalog says ${c.pinned}`)
    }
    console.error('\nIf the new version was intended, bump the catalog entry in pnpm-workspace.yaml instead.')
  }

  if (drifted.length + conflicts.length === 0) {
    console.log(`✓ All ${catalog.size} catalog entries are referenced as "catalog:"`)
    process.exit(0)
  }
  if (!fix) {
    console.error('\nRun "pnpm check-catalog --fix" to rewrite them.')
    process.exit(1)
  }
  process.exit(0)
}

main()

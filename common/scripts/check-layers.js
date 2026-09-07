#!/usr/bin/env node
/**
 * Layer boundary check.
 *
 * `foundations/{utils,core,server}` used to be separate Rush workspaces, so a package could not
 * physically depend on a layer that was not installed next to it. One pnpm workspace links
 * everything, so the boundary is enforced here instead.
 */

const fs = require('fs')
const path = require('path')

const { listWorkspaceProjects, findWorkspaceRoot } = require(
  path.join(__dirname, '..', '..', 'foundations', 'utils', 'packages', 'platform-rig', 'bin', 'libs', 'workspace')
)

// A layer may depend on itself and on everything listed here.
const LAYERS = [
  { name: 'utils', prefix: 'foundations/utils/', allow: [] },
  { name: 'core', prefix: 'foundations/core/', allow: ['utils'] },
  { name: 'server', prefix: 'foundations/server/', allow: ['utils', 'core'] },
  { name: 'app', prefix: '', allow: ['utils', 'core', 'server'] }
]

// Pre-existing violations. Do not add to this list - fix the dependency instead.
const ALLOWED_VIOLATIONS = new Set(['@hcengineering/middleware -> @hcengineering/contact'])

function layerOf (project) {
  return LAYERS.find((l) => l.prefix !== '' && project.path.startsWith(l.prefix))?.name ?? 'app'
}

function main () {
  const root = findWorkspaceRoot(process.cwd())
  const projects = listWorkspaceProjects(root)
  const byName = new Map(projects.map((p) => [p.name, p]))
  const allow = new Map(LAYERS.map((l) => [l.name, new Set([l.name, ...l.allow])]))

  const violations = []
  const stale = new Set(ALLOWED_VIOLATIONS)

  for (const p of projects) {
    const pkg = JSON.parse(fs.readFileSync(path.join(p.fullPath, 'package.json'), 'utf8'))
    const from = layerOf(p)
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const target = byName.get(dep)
      if (target == null) continue
      const to = layerOf(target)
      if (allow.get(from).has(to)) continue
      const edge = `${p.name} -> ${dep}`
      if (ALLOWED_VIOLATIONS.has(edge)) {
        stale.delete(edge)
        continue
      }
      violations.push({ edge, from, to, path: p.path })
    }
  }

  for (const edge of stale) {
    console.log(`ℹ️  allowed violation no longer present, drop it from ALLOWED_VIOLATIONS: ${edge}`)
  }

  if (violations.length === 0) {
    console.log(`✓ layer boundaries respected (${projects.length} packages)`)
    return
  }

  console.error(`\n❌ ${violations.length} layer violation(s):\n`)
  for (const v of violations) {
    console.error(`  ${v.edge}`)
    console.error(`    ${v.from} (${v.path}) may only depend on: ${[v.from, ...LAYERS.find((l) => l.name === v.from).allow].join(', ')}`)
  }
  console.error('\nMove the code, or invert the dependency. Do not widen the layer rules.')
  process.exit(1)
}

main()

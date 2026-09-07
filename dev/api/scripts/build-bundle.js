#!/usr/bin/env node
//
// Copyright 2026 Intabia Fusion
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
// Build a flat @intabia-fusion/api bundle by:
//  1. Reading roots from config.yml
//  2. Traversing dependencies (scope-local) via the workspace project list
//  3. Copying src/ of each bundled package to bundle/src/<shortname>/
//  4. Rewriting imports to use the new subpath exports (@intabia-fusion/api/<shortname>)
//  5. Emitting bundle/package.json with `exports` map and merged external deps
//  6. Emitting bundle/tsconfig.json and invoking tsc
//
// Any reachable @hcengineering/* package that is NOT in the bundle (e.g. excluded
// because of svelte) is a hard error — build stops.
//

'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const yaml = require('js-yaml')
const semver = require('semver')

const DEV_API_DIR = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(DEV_API_DIR, '..', '..')
const BUNDLE_DIR = path.join(DEV_API_DIR, 'bundle')
const BUNDLE_SRC = path.join(BUNDLE_DIR, 'src')

const CONFIG_PATH = path.join(DEV_API_DIR, 'config.yml')

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  const cfg = yaml.load(raw)
  if (!cfg || !Array.isArray(cfg.roots) || cfg.roots.length === 0) {
    throw new Error('config.yml: "roots" must be a non-empty array')
  }
  // sourceScopes: scopes of input monorepo packages (what we read and rewrite from).
  // Accepts `sourceScopes: [..]` or legacy `sourceScope: "@foo"`.
  // scope: scope of the output bundle (what we publish as)
  let scopes = cfg.sourceScopes
  if (scopes == null && cfg.sourceScope != null) {
    scopes = Array.isArray(cfg.sourceScope) ? cfg.sourceScope : [cfg.sourceScope]
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    scopes = ['@hcengineering', '@intabiafusion']
  }
  cfg.sourceScopes = scopes.map((s) => String(s))
  // Keep legacy field pointing at the first scope for any external consumers.
  cfg.sourceScope = cfg.sourceScopes[0]
  cfg.scope = cfg.scope || '@intabia-fusion'
  cfg.bundleName = cfg.bundleName || `${cfg.scope}/api`
  cfg.version = cfg.version || '1.0.0'
  cfg.depsMerge = cfg.depsMerge || 'highest'
  cfg.excludeScope = new Set(cfg.excludeScope || [])
  cfg.partial = cfg.partial || {}
  for (const [name, p] of Object.entries(cfg.partial)) {
    if (!p || !Array.isArray(p.include) || p.include.length === 0) {
      throw new Error(`config.yml: partial.${name}.include must be non-empty array`)
    }
  }
  return cfg
}

function listWorkspaceProjectsScoped(sourceScopes) {
  const projects = require(REPO_ROOT + '/foundations/utils/packages/platform-rig/bin/libs/workspace')
    .listWorkspaceProjects(REPO_ROOT)
  const map = new Map()
  for (const p of projects) {
    if (!p.name || !matchScope(p.name, sourceScopes)) continue
    map.set(p.name, {
      name: p.name,
      fullPath: p.fullPath,
      pkgJson: JSON.parse(fs.readFileSync(path.join(p.fullPath, 'package.json'), 'utf8'))
    })
  }
  return map
}

function matchScope(name, sourceScopes) {
  for (const s of sourceScopes) {
    if (name.startsWith(s + '/')) return s
  }
  return null
}

function shortName(fullName, sourceScopes) {
  const scope = matchScope(fullName, sourceScopes)
  if (!scope) throw new Error(`shortName: ${fullName} does not match any sourceScope`)
  return fullName.slice(scope.length + 1)
}

function hasSvelte(proj) {
  const pkg = proj.pkgJson
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (pkg[field] && pkg[field].svelte) return true
  }
  const srcDir = path.join(proj.fullPath, 'src')
  if (!fs.existsSync(srcDir)) return false
  return walkHas(srcDir, (f) => f.endsWith('.svelte'))
}

function walkHas(dir, predicate) {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (predicate(entry.name)) return true
    }
  }
  return false
}

function scopeDeps(pkg, sourceScopes) {
  const out = new Set()
  for (const field of ['dependencies', 'peerDependencies']) {
    const deps = pkg[field]
    if (!deps) continue
    for (const name of Object.keys(deps)) {
      if (matchScope(name, sourceScopes)) out.add(name)
    }
  }
  return out
}

function resolveBundleSet(cfg, projects) {
  const bundle = new Set()
  const partial = new Set(Object.keys(cfg.partial))
  const excluded = new Set(cfg.excludeScope)
  const stack = [...cfg.roots]
  while (stack.length) {
    const name = stack.pop()
    if (bundle.has(name) || excluded.has(name)) continue
    const proj = projects.get(name)
    if (!proj) {
      throw new Error(`Root or transitive dep ${name} not found in workspace projects`)
    }
    if (partial.has(name)) {
      // Partial packages do not propagate their scope deps (they are type-only subsets).
      bundle.add(name)
      continue
    }
    if (hasSvelte(proj)) {
      excluded.add(name)
      continue
    }
    bundle.add(name)
    for (const d of scopeDeps(proj.pkgJson, cfg.sourceScopes)) stack.push(d)
  }
  return { bundle, partial, excluded }
}

function walkFiles(dir) {
  const results = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else results.push(full)
    }
  }
  return results
}

// Rewrite `<sourceScope>/<X>` -> `<bundleName>/<X>` for X in bundle.
// Partial packages get their subpath collapsed to the short name root (all whitelisted
// files copied under bundle/src/<short>/, preserving relative structure below src/).
function rewriteImports(content, bundleShortNames, cfg, filePath) {
  const escapedAlt = cfg.sourceScopes
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const regex = new RegExp(`(['"])(${escapedAlt})\\/([a-zA-Z0-9\\-_]+)((?:\\/[^'"]*)?)\\1`, 'g')
  return content.replace(regex, (full, quote, scope, short, rest) => {
    if (!bundleShortNames.has(short)) {
      throw new Error(
        `${filePath}: import of excluded package ${scope}/${short} — add it to roots or bundle, or strip the usage`
      )
    }
    // Strip a leading /src or /src/ from subpath (common in refs like @hcengineering/ui/src/types or @hcengineering/client/src)
    let normalized = rest
    if (normalized === '/src') normalized = ''
    else normalized = normalized.replace(/^\/src\//, '/')
    return `${quote}${cfg.bundleName}/${short}${normalized}${quote}`
  })
}

const IMPORT_RE = /(?:import|export)(?:\s+type)?\s+(?:[\s\S]*?)from\s+['"]([^'"]+)['"]/g
const DYN_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

function extractRelativeImports(content) {
  const out = []
  let m
  while ((m = IMPORT_RE.exec(content)) !== null) {
    if (m[1].startsWith('.')) out.push(m[1])
  }
  while ((m = DYN_IMPORT_RE.exec(content)) !== null) {
    if (m[1].startsWith('.')) out.push(m[1])
  }
  return out
}

function resolveRelativeTs(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx'), base]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

const LICENSE_HEADER = `//
// Copyright 2026 Intabia Fusion
//
// Auto-generated bundle source from foundation monorepo. Do not edit by hand.
//
`

// When @types/node is loaded, setTimeout/setInterval return NodeJS.Timeout,
// but foundation source code sometimes declares these fields as `number` (DOM).
// Rewrite narrow field types to `any` to keep both shapes.
function patchTimerTypes(content, rel) {
  const norm = rel.replace(/\\/g, '/')
  if (norm !== 'connection.ts') return content
  return content
    .replace(/(private\s+interval\s*:\s*)number(\s*\|\s*undefined)/, '$1any$2')
    .replace(/(private\s+dialTimer\s*:\s*)number(\s*\|\s*undefined)/, '$1any$2')
}

function copyAndRewrite(proj, bundleShortNames, cfg, stats) {
  const short = shortName(proj.name, cfg.sourceScopes)
  const srcDir = path.join(proj.fullPath, 'src')
  if (!fs.existsSync(srcDir)) {
    console.warn(`skip ${proj.name}: no src/ directory`)
    return
  }
  const destDir = path.join(BUNDLE_SRC, short)
  fs.rmSync(destDir, { recursive: true, force: true })
  fs.mkdirSync(destDir, { recursive: true })

  for (const file of walkFiles(srcDir)) {
    const rel = path.relative(srcDir, file)
    if (rel.split(path.sep).includes('__tests__')) continue
    if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file)) continue
    if (/(?:^|\/)testUtils\.(ts|tsx|js|jsx)$/.test(rel.replace(/\\/g, '/'))) continue
    const dst = path.join(destDir, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) {
      let raw = fs.readFileSync(file, 'utf8')
      // Drop re-exports of testUtils
      raw = raw.replace(/^\s*export\s*\*\s*from\s+['"][^'"]*testUtils['"];?\s*$/gm, '')
      let rewritten = rewriteImports(raw, bundleShortNames, cfg, path.relative(REPO_ROOT, file))
      rewritten = patchTimerTypes(rewritten, rel)
      fs.writeFileSync(dst, rewritten, 'utf8')
      stats.tsFiles++
    } else {
      fs.copyFileSync(file, dst)
    }
  }
  stats.packages++
}

function copyPartial(proj, bundleShortNames, cfg, partialSpec, stats) {
  const short = shortName(proj.name, cfg.sourceScopes)
  const pkgRoot = proj.fullPath
  const destDir = path.join(BUNDLE_SRC, short)
  fs.rmSync(destDir, { recursive: true, force: true })
  fs.mkdirSync(destDir, { recursive: true })

  const seeds = partialSpec.include.map((rel) => path.resolve(pkgRoot, rel))
  for (const s of seeds) {
    if (!fs.existsSync(s)) throw new Error(`${proj.name}: partial include missing: ${path.relative(pkgRoot, s)}`)
    if (!/\.tsx?$/.test(s)) throw new Error(`${proj.name}: partial include must be .ts/.tsx: ${s}`)
  }

  const queue = [...seeds]
  const visited = new Set()
  const srcDir = path.join(pkgRoot, 'src')

  while (queue.length) {
    const file = queue.shift()
    if (visited.has(file)) continue
    visited.add(file)

    if (/\.svelte$/.test(file)) {
      throw new Error(`${proj.name}: partial traversal hit svelte file: ${path.relative(pkgRoot, file)}`)
    }
    if (!/\.tsx?$/.test(file)) {
      throw new Error(`${proj.name}: partial traversal hit non-ts file: ${path.relative(pkgRoot, file)}`)
    }

    const rel = path.relative(srcDir, file)
    if (rel.startsWith('..')) {
      throw new Error(`${proj.name}: partial file outside src/: ${file}`)
    }
    const dst = path.join(destDir, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })

    const raw = fs.readFileSync(file, 'utf8')
    const rewritten = rewriteImports(raw, bundleShortNames, cfg, path.relative(REPO_ROOT, file))
    fs.writeFileSync(dst, rewritten, 'utf8')
    stats.tsFiles++

    for (const spec of extractRelativeImports(raw)) {
      const resolved = resolveRelativeTs(file, spec)
      if (!resolved) {
        throw new Error(`${proj.name}: cannot resolve partial import '${spec}' from ${path.relative(pkgRoot, file)}`)
      }
      queue.push(resolved)
    }
  }

  // Generate an index.ts that re-exports all included seeds (stripping .ts).
  const indexPath = path.join(destDir, 'index.ts')
  if (!fs.existsSync(indexPath)) {
    const exports = []
    for (const s of seeds) {
      const relFromSrc = path.relative(srcDir, s).replace(/\\/g, '/').replace(/\.tsx?$/, '')
      exports.push(`export * from './${relFromSrc}'`)
    }
    fs.writeFileSync(indexPath, LICENSE_HEADER + exports.join('\n') + '\n')
  }

  stats.packages++
}

function mergeVersion(existing, incoming, strategy, name, from) {
  if (existing == null) return incoming
  if (existing === incoming) return existing

  const cleanA = String(existing).replace(/^[~^]/, '')
  const cleanB = String(incoming).replace(/^[~^]/, '')

  if (strategy === 'first') return existing
  if (strategy === 'fail') {
    throw new Error(`dep conflict on ${name}: ${existing} vs ${incoming} (from ${from})`)
  }
  // highest
  try {
    if (semver.valid(cleanA) && semver.valid(cleanB)) {
      return semver.gt(cleanB, cleanA) ? incoming : existing
    }
    const mA = semver.minVersion(existing)
    const mB = semver.minVersion(incoming)
    if (mA && mB) return semver.gt(mB, mA) ? incoming : existing
  } catch {
    // fall through
  }
  return existing
}

function collectExternalDeps(bundle, projects, partial, strategy, sourceScopes) {
  const deps = {}
  for (const name of bundle) {
    if (partial.has(name)) continue
    const pkg = projects.get(name).pkgJson
    for (const field of ['dependencies', 'peerDependencies']) {
      const src = pkg[field]
      if (!src) continue
      for (const [dep, range] of Object.entries(src)) {
        if (matchScope(dep, sourceScopes)) continue
        if (typeof range !== 'string' || range.startsWith('workspace:')) continue
        deps[dep] = mergeVersion(deps[dep], range, strategy, dep, name)
      }
    }
  }
  return deps
}

function emitPackageJson(cfg, bundle, projects, partial) {
  const exportsMap = {
    '.': {
      types: './types/index.d.ts',
      default: './lib/index.js'
    }
  }
  const bundleSorted = [...bundle].sort()
  for (const name of bundleSorted) {
    const short = shortName(name, cfg.sourceScopes)
    exportsMap[`./${short}`] = {
      types: `./types/${short}/index.d.ts`,
      default: `./lib/${short}/index.js`
    }
    exportsMap[`./${short}/*`] = {
      types: `./types/${short}/*.d.ts`,
      default: `./lib/${short}/*.js`
    }
  }

  const pkg = {
    name: cfg.bundleName,
    version: cfg.version,
    description: 'Intabia Fusion API bundle (auto-generated from foundation)',
    license: 'EPL-2.0',
    main: './lib/index.js',
    types: './types/index.d.ts',
    exports: exportsMap,
    files: ['lib', 'types', 'src'],
    repository: {
      type: 'git',
      url: 'https://github.com/intabia-fusion/foundation.git'
    },
    publishConfig: {
      access: 'public'
    },
    dependencies: collectExternalDeps(bundle, projects, partial, cfg.depsMerge, cfg.sourceScopes),
    devDependencies: {
      typescript: '~5.9.3',
      '@types/node': '^22.18.1',
      '@types/cors': '^2.8.17',
      '@types/express': '^4.17.21',
      '@types/morgan': '^1.9.9',
      '@types/ws': '^8.5.12',
      '@types/uuid': '^10.0.0'
    },
    scripts: {
      build: 'tsc'
    }
  }

  fs.writeFileSync(path.join(BUNDLE_DIR, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
}

function emitIndex(cfg, bundle) {
  const shorts = [...bundle].map((n) => shortName(n, cfg.sourceScopes)).sort()
  const indexPath = path.join(BUNDLE_SRC, 'index.ts')
  const body = LICENSE_HEADER + shorts.map((s) => `export * as ${toIdent(s)} from './${s}'`).join('\n') + '\n'
  fs.writeFileSync(indexPath, body)
}

function toIdent(name) {
  return name.replace(/[^a-zA-Z0-9_]+/g, '_')
}

function emitTsconfig(cfg, bundle) {
  const paths = {}
  const shorts = [...bundle].map((n) => shortName(n, cfg.sourceScopes)).sort()
  for (const s of shorts) {
    paths[`${cfg.bundleName}/${s}`] = [`./src/${s}/index.ts`]
    paths[`${cfg.bundleName}/${s}/*`] = [`./src/${s}/*`]
  }
  const tsconfig = {
    compilerOptions: {
      target: 'esnext',
      module: 'commonjs',
      moduleResolution: 'node',
      lib: ['esnext', 'dom', 'dom.iterable', 'dom.asynciterable'],
      types: ['node'],
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      inlineSources: true,
      allowSyntheticDefaultImports: true,
      useDefineForClassFields: true,
      strictBuiltinIteratorReturn: true,
      outDir: './lib',
      declarationDir: './types',
      rootDir: './src',
      baseUrl: '.',
      paths,
      resolveJsonModule: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      isolatedModules: true,
      forceConsistentCasingInFileNames: true
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'lib', 'types', '**/*.test.ts', '**/__tests__/**']
  }
  fs.writeFileSync(path.join(BUNDLE_DIR, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n')
}

function emitShims() {
  const shimPath = path.join(BUNDLE_SRC, 'shims.d.ts')
  const content = LICENSE_HEADER + `
declare module 'snappyjs'
declare module 'snappy'

declare module 'svelte' {
  export type ComponentType<T = any> = any
  export type SvelteComponent<T = any> = any
  const _default: any
  export default _default
}
declare module 'svelte/store' {
  export type Readable<T = any> = { subscribe: (run: (v: T) => void) => () => void }
  export type Writable<T = any> = Readable<T> & { set: (v: T) => void; update: (fn: (v: T) => T) => void }
  export function readable<T>(v: T, start?: any): Readable<T>
  export function writable<T>(v: T, start?: any): Writable<T>
  export function derived(a: any, b: any, c?: any): any
  export function get<T>(store: Readable<T>): T
}

declare module 'markdown-it/lib/parser_core' {
  export type RuleCore = (state: any) => boolean | void
  const _default: any
  export default _default
}
declare module 'markdown-it/lib/rules_core/state_core' {
  export default class StateCore {
    src: string
    env: any
    tokens: any[]
    Token: any
    inlineMode: boolean
    md: any
    constructor(src: string, md: any, env: any)
  }
}
`
  fs.writeFileSync(shimPath, content)
}

function emitReadme() {
  const src = path.join(DEV_API_DIR, 'BUNDLE-README.md')
  if (!fs.existsSync(src)) return
  fs.copyFileSync(src, path.join(BUNDLE_DIR, 'README.md'))
}

function main() {
  const cfg = loadConfig()
  console.log(`Loading workspace project list from ${REPO_ROOT}...`)
  const projects = listWorkspaceProjectsScoped(cfg.sourceScopes)
  console.log(`  ${projects.size} [${cfg.sourceScopes.join(', ')}]/* projects`)

  const { bundle, partial, excluded } = resolveBundleSet(cfg, projects)
  console.log(`Bundle: ${bundle.size} packages (${partial.size} partial), excluded: ${excluded.size}`)

  const bundleShortNames = new Set([...bundle].map((n) => shortName(n, cfg.sourceScopes)))

  // Keep bundle/node_modules across rebuilds; wipe only src/lib/types/package.json/tsconfig.
  fs.rmSync(BUNDLE_SRC, { recursive: true, force: true })
  fs.rmSync(path.join(BUNDLE_DIR, 'lib'), { recursive: true, force: true })
  fs.rmSync(path.join(BUNDLE_DIR, 'types'), { recursive: true, force: true })
  fs.mkdirSync(BUNDLE_SRC, { recursive: true })

  const stats = { packages: 0, tsFiles: 0 }
  for (const name of [...bundle].sort()) {
    if (partial.has(name)) {
      copyPartial(projects.get(name), bundleShortNames, cfg, cfg.partial[name], stats)
    } else {
      copyAndRewrite(projects.get(name), bundleShortNames, cfg, stats)
    }
  }

  emitIndex(cfg, bundle)
  emitPackageJson(cfg, bundle, projects, partial)
  emitTsconfig(cfg, bundle)
  emitShims()
  emitReadme()

  console.log(`Bundled ${stats.packages} packages, ${stats.tsFiles} source files`)
  console.log(`Output: ${BUNDLE_DIR}`)
  console.log(`Next: cd ${path.relative(process.cwd(), BUNDLE_DIR)} && npm install && npx tsc`)
}

main()

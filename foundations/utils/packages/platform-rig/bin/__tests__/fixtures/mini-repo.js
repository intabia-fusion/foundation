/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

// Builds a throwaway Rush-shaped monorepo on disk. `rush list --json` is never
// invoked: graph.js prefers common/temp/.rush-list-cache.json when its key
// (rush.json mtime + pnpm-lock mtime) matches, so we pre-seed that file.

const fs = require('node:fs')
const os = require('node:os')
const { join, relative } = require('node:path')

const RIG_ROOT = join(__dirname, '..', '..', '..')

function write (root, rel, content) {
  const full = join(root, rel)
  fs.mkdirSync(join(full, '..'), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}

function tsconfig (extraCompilerOptions = {}) {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2021',
      module: 'CommonJS',
      moduleResolution: 'node',
      strict: true,
      declaration: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: 'lib',
      rootDir: 'src',
      ...extraCompilerOptions
    },
    include: ['src/**/*.ts']
  }, null, 2)
}

/**
 * @param {Record<string, {deps?: string[], scripts?: object, files?: Record<string,string>, extraPkgJson?: object}>} packages
 * @returns {{root: string, cleanup: () => void, pkgDir: (name: string) => string}}
 */
function createMiniRepo (packages) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'rig-mini-'))
  const projects = []

  for (const [name, spec] of Object.entries(packages)) {
    const folder = name.replace(/^@[^/]+\//, '')
    const dir = join(root, 'packages', folder)
    fs.mkdirSync(dir, { recursive: true })

    const deps = {}
    for (const d of spec.deps ?? []) deps[d] = 'workspace:^1.0.0'

    write(root, join('packages', folder, 'package.json'), JSON.stringify({
      name,
      version: '1.0.0',
      main: 'lib/index.js',
      types: 'types/index.d.ts',
      dependencies: deps,
      scripts: spec.scripts ?? { '_phase:build': 'compile transpile src', '_phase:validate': 'compile validate' },
      ...spec.extraPkgJson
    }, null, 2))

    write(root, join('packages', folder, 'tsconfig.json'), tsconfig(spec.compilerOptions))

    for (const [rel, content] of Object.entries(spec.files ?? {})) {
      write(root, join('packages', folder, rel), content)
    }

    // Workspace dependencies resolve through node_modules symlinks, same as Rush/pnpm.
    for (const d of spec.deps ?? []) {
      const depFolder = d.replace(/^@[^/]+\//, '')
      const linkPath = join(dir, 'node_modules', d)
      fs.mkdirSync(join(linkPath, '..'), { recursive: true })
      fs.symlinkSync(join(root, 'packages', depFolder), linkPath, 'dir')
    }
    // The rig itself is required by compile.js at runtime for esbuild/typescript.
    const rigLink = join(dir, 'node_modules', '@hcengineering', 'platform-rig')
    fs.mkdirSync(join(rigLink, '..'), { recursive: true })
    fs.symlinkSync(RIG_ROOT, rigLink, 'dir')

    projects.push({ name, fullPath: dir, projectFolder: relative(root, dir) })
  }

  write(root, 'rush.json', JSON.stringify({
    rushVersion: '5.169.3',
    pnpmVersion: '10.28.0',
    projects: projects.map(p => ({ packageName: p.name, projectFolder: p.projectFolder }))
  }, null, 2))
  write(root, join('common', 'config', 'rush', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  write(root, join('common', 'scripts', 'version.txt'), '1.0.0\n')

  const key = `${fs.statSync(join(root, 'rush.json')).mtimeMs}:${fs.statSync(join(root, 'common/config/rush/pnpm-lock.yaml')).mtimeMs}`
  write(root, join('common', 'temp', '.rush-list-cache.json'), JSON.stringify({ key, projects }))

  return {
    root,
    pkgDir: (name) => join(root, 'packages', name.replace(/^@[^/]+\//, '')),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  }
}

module.exports = { createMiniRepo }

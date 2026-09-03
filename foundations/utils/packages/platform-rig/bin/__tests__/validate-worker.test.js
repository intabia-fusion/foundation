/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const { join } = require('node:path')

// validate-worker guards its parentPort wiring, so requiring it from the main thread is safe.
const { syncDirectory } = require('../validate-worker')

let root, src, dest

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'rig-sync-'))
  src = join(root, 'emit')
  dest = join(root, 'types')
  fs.mkdirSync(src, { recursive: true })
  fs.mkdirSync(dest, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const write = (dir, rel, content) => {
  const full = join(dir, rel)
  fs.mkdirSync(join(full, '..'), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}

describe('syncDirectory', () => {
  test('copies new files and reports the count', () => {
    write(src, 'index.d.ts', 'export const a: number\n')
    write(src, 'nested/b.d.ts', 'export const b: string\n')

    const r = syncDirectory(src, dest)
    assert.equal(r.copied, 2)
    assert.equal(fs.readFileSync(join(dest, 'index.d.ts'), 'utf8'), 'export const a: number\n')
    assert.ok(fs.existsSync(join(dest, 'nested/b.d.ts')))
  })

  test('leaves identical files untouched', () => {
    write(src, 'index.d.ts', 'same\n')
    write(dest, 'index.d.ts', 'same\n')

    const r = syncDirectory(src, dest)
    assert.equal(r.copied, 0)
    assert.equal(r.unchanged, 1)
  })

  test('overwrites a file whose content changed', () => {
    write(src, 'index.d.ts', 'new\n')
    write(dest, 'index.d.ts', 'old\n')

    const r = syncDirectory(src, dest)
    assert.equal(r.copied, 1)
    assert.equal(fs.readFileSync(join(dest, 'index.d.ts'), 'utf8'), 'new\n')
  })

  test('removes a declaration the compiler no longer emits', () => {
    write(src, 'index.d.ts', 'export {}\n')
    write(dest, 'index.d.ts', 'export {}\n')
    write(dest, 'gone.d.ts', 'export {}\n')

    const r = syncDirectory(src, dest)
    assert.equal(r.removed, 1)
    assert.ok(!fs.existsSync(join(dest, 'gone.d.ts')))
  })

  // Regression: generateSvelteTypes writes types/*.svelte.d.ts, but tsc emits no declaration
  // for a .d.ts input, so the prune deleted them on every validate. That dirtied the transpile
  // output hash, forcing an endless regenerate/delete cycle for ui-esbuild packages.
  test('keeps *.svelte.d.ts that the compiler never emits', () => {
    write(src, 'index.d.ts', 'export {}\n')
    write(dest, 'index.d.ts', 'export {}\n')
    const svelteDts = write(dest, 'Widget.svelte.d.ts', 'declare const W: unknown\nexport default W\n')
    const nestedSvelteDts = write(dest, 'nested/Panel.svelte.d.ts', 'declare const P: unknown\nexport default P\n')

    const r = syncDirectory(src, dest)

    assert.ok(fs.existsSync(svelteDts), 'top-level svelte declaration must survive')
    assert.ok(fs.existsSync(nestedSvelteDts), 'nested svelte declaration must survive')
    assert.equal(r.removed, 0)
  })

  test('rewrites source map paths one level up', () => {
    write(src, 'index.d.ts.map', JSON.stringify({ version: 3, sources: ['../../src/index.ts'], mappings: '' }))

    syncDirectory(src, dest)
    const map = JSON.parse(fs.readFileSync(join(dest, 'index.d.ts.map'), 'utf8'))
    assert.deepEqual(map.sources, ['../src/index.ts'])
  })

  test('a missing source directory is a no-op', () => {
    const r = syncDirectory(join(root, 'nope'), dest)
    assert.deepEqual(r, { copied: 0, unchanged: 0, removed: 0 })
  })
})

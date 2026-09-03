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

const cache = require('../libs/cache')

let dir

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'rig-cache-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writePkg (files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    fs.mkdirSync(join(full, '..'), { recursive: true })
    fs.writeFileSync(full, content)
  }
}

describe('calculatePackageHash', () => {
  test('changes when a src file changes', () => {
    writePkg({ 'package.json': '{"name":"x"}', 'src/a.ts': 'export const a = 1' })
    const h1 = cache.calculatePackageHash(dir)
    writePkg({ 'src/a.ts': 'export const a = 2' })
    assert.notEqual(cache.calculatePackageHash(dir), h1)
  })

  test('is stable when only mtime changes', () => {
    writePkg({ 'package.json': '{"name":"x"}', 'src/a.ts': 'export const a = 1' })
    const h1 = cache.calculatePackageHash(dir)
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(join(dir, 'src/a.ts'), later, later)
    assert.equal(cache.calculatePackageHash(dir), h1)
  })

  test('ignores files with non-source extensions', () => {
    writePkg({ 'package.json': '{"name":"x"}', 'src/a.ts': 'x' })
    const h1 = cache.calculatePackageHash(dir)
    writePkg({ 'src/notes.md': 'irrelevant' })
    assert.equal(cache.calculatePackageHash(dir), h1)
  })
})

describe('phase cache isolation', () => {
  test('marking one phase does not invalidate another', () => {
    writePkg({ 'package.json': '{"name":"x"}', 'src/a.ts': 'x' })
    cache.markPhaseCompleted(dir, 'hash-transpile', 'transpile', null, [])
    cache.markPhaseCompleted(dir, 'hash-bundle', 'bundle', null, [])

    assert.equal(cache.isPhaseCached(dir, 'hash-transpile', 'transpile', null, []), true)
    assert.equal(cache.isPhaseCached(dir, 'hash-bundle', 'bundle', null, []), true)
  })

  test('a different hash for the same phase misses', () => {
    writePkg({ 'package.json': '{"name":"x"}' })
    cache.markPhaseCompleted(dir, 'h1', 'validate', null, [])
    assert.equal(cache.isPhaseCached(dir, 'h2', 'validate', null, []), false)
  })

  test('missing output directory invalidates the phase', () => {
    writePkg({ 'package.json': '{"name":"x"}', 'types/index.d.ts': 'export {}' })
    cache.markPhaseCompleted(dir, 'h1', 'validate', null, ['types'])
    assert.equal(cache.isPhaseCached(dir, 'h1', 'validate', null, ['types']), true)

    fs.rmSync(join(dir, 'types'), { recursive: true })
    assert.equal(cache.isPhaseCached(dir, 'h1', 'validate', null, ['types']), false)
  })

  test('modified output content invalidates the phase', () => {
    writePkg({ 'package.json': '{"name":"x"}', 'types/index.d.ts': 'export const a: 1' })
    cache.markPhaseCompleted(dir, 'h1', 'validate', null, ['types'])
    fs.writeFileSync(join(dir, 'types/index.d.ts'), 'export const a: 2')
    assert.equal(cache.isPhaseCached(dir, 'h1', 'validate', null, ['types']), false)
  })
})

describe('v1 -> v2 migration', () => {
  test('a v1 cache file is migrated and its phases stay valid', () => {
    writePkg({ 'package.json': '{"name":"x"}' })
    fs.writeFileSync(join(dir, '.fast-build-cache.json'), JSON.stringify({
      hash: 'shared',
      timestamp: 1,
      phases: { transpile: { completedAt: 1 }, bundle: { completedAt: 2 } }
    }))

    const loaded = cache.loadPackageCache(dir)
    assert.equal(loaded.version, 2)
    assert.equal(loaded.phases.transpile.hash, 'shared')
    assert.equal(loaded.phases.bundle.hash, 'shared')
    assert.equal(cache.isPhaseCached(dir, 'shared', 'transpile', null, []), true)
  })

  test('an unrecognised cache file is discarded, not thrown on', () => {
    writePkg({ 'package.json': '{"name":"x"}' })
    fs.writeFileSync(join(dir, '.fast-build-cache.json'), '{ this is not json')
    assert.equal(cache.loadPackageCache(dir), null)
    assert.equal(cache.isPhaseCached(dir, 'h', 'transpile', null, []), false)
  })
})

describe('invalidatePhase', () => {
  // Regression: transpile used to call invalidateCache(), wiping the whole file and
  // destroying validate/lint/svelte-check/bundle/package/docker-build entries for the
  // entire downstream closure on any upstream change.
  test('drops only the named phase, leaving siblings intact', () => {
    writePkg({ 'package.json': '{"name":"x"}' })
    cache.markPhaseCompleted(dir, 'h-t', 'transpile', null, [])
    cache.markPhaseCompleted(dir, 'h-v', 'validate', null, [])
    cache.markPhaseCompleted(dir, 'h-b', 'bundle', null, [])

    assert.equal(typeof cache.invalidatePhase, 'function', 'invalidatePhase must be exported')
    cache.invalidatePhase(dir, 'transpile')

    assert.equal(cache.isPhaseCached(dir, 'h-t', 'transpile', null, []), false)
    assert.equal(cache.isPhaseCached(dir, 'h-v', 'validate', null, []), true)
    assert.equal(cache.isPhaseCached(dir, 'h-b', 'bundle', null, []), true)
  })

  test('invalidateCache still removes everything', () => {
    writePkg({ 'package.json': '{"name":"x"}' })
    cache.markPhaseCompleted(dir, 'h-t', 'transpile', null, [])
    cache.markPhaseCompleted(dir, 'h-v', 'validate', null, [])
    cache.invalidateCache(dir)
    assert.equal(cache.isPhaseCached(dir, 'h-t', 'transpile', null, []), false)
    assert.equal(cache.isPhaseCached(dir, 'h-v', 'validate', null, []), false)
  })
})

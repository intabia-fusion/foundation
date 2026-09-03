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

const { computeTypesHashes, compositeHashFromTypes } = require('../libs/composite-hash')

let root

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'rig-comp-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

// core <- mid <- app
function makeGraph () {
  const graph = new Map()
  const add = (name, deps) => {
    const fullPath = join(root, name)
    fs.mkdirSync(join(fullPath, 'types'), { recursive: true })
    fs.writeFileSync(join(fullPath, 'types', 'index.d.ts'), `export declare const ${name}: number\n`)
    graph.set(name, { project: { name, fullPath }, dependencies: new Set(deps), dependents: new Set() })
  }
  add('core', [])
  add('mid', ['core'])
  add('app', ['mid'])
  return graph
}

const OWN = new Map([['core', 'h-core'], ['mid', 'h-mid'], ['app', 'h-app']])

describe('compositeHashFromTypes', () => {
  // Regression: lint/svelte-check keyed on dependency *sources*, so editing anything
  // upstream re-ran them for the whole downstream closure even when no API changed.
  test('ignores a dependency source change that leaves its types alone', () => {
    const graph = makeGraph()
    const before = compositeHashFromTypes('app', graph, OWN, computeTypesHashes(graph))

    const changedSources = new Map(OWN)
    changedSources.set('core', 'h-core-EDITED')
    const after = compositeHashFromTypes('app', graph, changedSources, computeTypesHashes(graph))

    assert.equal(after, before)
  })

  test('changes when a transitive dependency emits different types', () => {
    const graph = makeGraph()
    const before = compositeHashFromTypes('app', graph, OWN, computeTypesHashes(graph))

    fs.writeFileSync(join(root, 'core', 'types', 'index.d.ts'), 'export declare const core: string\n')
    const after = compositeHashFromTypes('app', graph, OWN, computeTypesHashes(graph))

    assert.notEqual(after, before)
  })

  test('changes when the package own sources change', () => {
    const graph = makeGraph()
    const types = computeTypesHashes(graph)
    const before = compositeHashFromTypes('app', graph, OWN, types)

    const own = new Map(OWN)
    own.set('app', 'h-app-EDITED')
    assert.notEqual(compositeHashFromTypes('app', graph, own, types), before)
  })

  test('changes when a listed config file changes', () => {
    const graph = makeGraph()
    const types = computeTypesHashes(graph)
    const cfg = ['.eslintrc.js']
    const before = compositeHashFromTypes('app', graph, OWN, types, cfg)

    fs.writeFileSync(join(root, 'app', '.eslintrc.js'), 'module.exports = { rules: {} }\n')
    assert.notEqual(compositeHashFromTypes('app', graph, OWN, types, cfg), before)
  })

  test('is independent of an unrelated package', () => {
    const graph = makeGraph()
    graph.set('other', { project: { name: 'other', fullPath: join(root, 'other') }, dependencies: new Set(), dependents: new Set() })
    fs.mkdirSync(join(root, 'other', 'types'), { recursive: true })
    fs.writeFileSync(join(root, 'other', 'types', 'index.d.ts'), 'export declare const other: 1\n')

    const before = compositeHashFromTypes('app', graph, OWN, computeTypesHashes(graph))
    fs.writeFileSync(join(root, 'other', 'types', 'index.d.ts'), 'export declare const other: 2\n')
    assert.equal(compositeHashFromTypes('app', graph, OWN, computeTypesHashes(graph)), before)
  })

  test('computeTypesHashes reports an empty hash for a package without types/', () => {
    const graph = makeGraph()
    graph.set('notypes', { project: { name: 'notypes', fullPath: join(root, 'notypes') }, dependencies: new Set(), dependents: new Set() })
    fs.mkdirSync(join(root, 'notypes'), { recursive: true })

    assert.equal(computeTypesHashes(graph).get('notypes'), '')
  })
})

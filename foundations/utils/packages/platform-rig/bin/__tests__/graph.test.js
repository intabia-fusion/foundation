/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { getAllDependencies, topologicalSortWaves } = require('../libs/graph')

// a -> b -> c, and d standing alone.
function makeGraph (spec) {
  const graph = new Map()
  for (const [name, node] of Object.entries(spec)) {
    graph.set(name, {
      project: { name, fullPath: `/repo/${name}` },
      dependencies: new Set(node.deps ?? []),
      dependents: new Set(),
      phaseBuild: node.phaseBuild ?? 'compile transpile src',
      phaseValidate: node.phaseValidate ?? 'compile validate',
      phaseBundle: node.phaseBundle,
      phasePackage: node.phasePackage,
      phaseDockerBuild: node.phaseDockerBuild,
      phaseFormat: node.phaseFormat,
      phaseSvelteCheck: node.phaseSvelteCheck,
      phaseTest: node.phaseTest
    })
  }
  for (const [name, node] of graph) {
    for (const dep of node.dependencies) {
      graph.get(dep)?.dependents.add(name)
    }
  }
  return graph
}

describe('getAllDependencies', () => {
  test('collects the transitive closure', () => {
    const graph = makeGraph({ a: { deps: ['b'] }, b: { deps: ['c'] }, c: {}, d: {} })
    assert.deepEqual([...getAllDependencies(graph, 'a')].sort(), ['b', 'c'])
  })

  test('does not include the package itself', () => {
    const graph = makeGraph({ a: { deps: ['b'] }, b: {} })
    assert.equal(getAllDependencies(graph, 'a').has('a'), false)
  })

  test('terminates on a dependency cycle', () => {
    const graph = makeGraph({ a: { deps: ['b'] }, b: { deps: ['a'] } })
    assert.deepEqual([...getAllDependencies(graph, 'a')].sort(), ['a', 'b'])
  })

  test('returns empty for an unknown package', () => {
    const graph = makeGraph({ a: {} })
    assert.equal(getAllDependencies(graph, 'nope').size, 0)
  })
})

describe('topologicalSortWaves', () => {
  test('orders dependencies before dependents', () => {
    const graph = makeGraph({ a: { deps: ['b'] }, b: { deps: ['c'] }, c: {} })
    const waves = topologicalSortWaves(graph, () => true)
    const order = waves.map(w => w.map(p => p.name))
    assert.deepEqual(order, [['c'], ['b'], ['a']])
  })

  test('puts independent packages in the same wave', () => {
    const graph = makeGraph({ a: {}, b: {}, c: { deps: ['a', 'b'] } })
    const waves = topologicalSortWaves(graph, () => true)
    assert.deepEqual(waves[0].map(p => p.name).sort(), ['a', 'b'])
    assert.deepEqual(waves[1].map(p => p.name), ['c'])
  })

  test('ignores edges to packages excluded by the filter', () => {
    const graph = makeGraph({ a: { deps: ['b'] }, b: {} })
    const waves = topologicalSortWaves(graph, (_node, name) => name === 'a')
    assert.deepEqual(waves, [[waves[0][0]]].map(w => w))
    assert.deepEqual(waves[0].map(p => p.name), ['a'])
  })

  test('throws on a cycle instead of looping forever', () => {
    const graph = makeGraph({ a: { deps: ['b'] }, b: { deps: ['a'] } })
    assert.throws(() => topologicalSortWaves(graph, () => true), /Circular dependency/)
  })
})

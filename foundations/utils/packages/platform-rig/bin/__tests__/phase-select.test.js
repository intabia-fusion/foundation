/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { selectPackagesForPhases } = require('../libs/phase-select')

function makeGraph (spec) {
  const graph = new Map()
  for (const [name, node] of Object.entries(spec)) {
    graph.set(name, {
      project: { name, fullPath: `/repo/${name}` },
      dependencies: new Set(node.deps ?? []),
      dependents: new Set(),
      phaseBuild: node.phaseBuild,
      phaseBundle: node.phaseBundle,
      phasePackage: node.phasePackage,
      phaseDockerBuild: node.phaseDockerBuild,
      phaseFormat: node.phaseFormat,
      phaseSvelteCheck: node.phaseSvelteCheck,
      phaseTest: node.phaseTest
    })
  }
  return graph
}

const ALL = { doTest: true, doBundle: true, doPackage: true, doDockerBuild: true, doSvelteCheck: true }

describe('selectPackagesForPhases', () => {
  test('picks up the three known build scripts', () => {
    const graph = makeGraph({
      src: { phaseBuild: 'compile build' },
      ui: { phaseBuild: 'compile build-ui' },
      uiEsbuild: { phaseBuild: 'compile ui-esbuild' }
    })
    const sel = selectPackagesForPhases(graph, ALL)
    assert.deepEqual(sel.build.sort(), ['src', 'ui', 'uiEsbuild'])
    assert.deepEqual(sel.unknown, [])
  })

  // Regression: `services/ai-bot/love-agent` ("wasm && node esbuild.config.js") was dropped
  // by a strict string comparison — never built and never reported.
  test('reports an unrecognised build script instead of dropping it silently', () => {
    const graph = makeGraph({ wasmPkg: { phaseBuild: 'wasm && node esbuild.config.js' } })
    const sel = selectPackagesForPhases(graph, ALL)
    assert.deepEqual(sel.build, [])
    assert.deepEqual(sel.unknown, [{ package: 'wasmPkg', phase: 'build', script: 'wasm && node esbuild.config.js' }])
  })

  test('"echo done" is an explicit no-op, not an unknown script', () => {
    const graph = makeGraph({
      noop: { phaseBuild: 'echo done', phaseBundle: 'echo done' }
    })
    const sel = selectPackagesForPhases(graph, ALL)
    assert.deepEqual(sel.build, [])
    assert.deepEqual(sel.bundle, [])
    assert.deepEqual(sel.unknown, [])
  })

  test('phases are skipped unless their flag is set', () => {
    const graph = makeGraph({
      a: {
        phaseBuild: 'compile build',
        phaseTest: 'jest --passWithNoTests',
        phaseBundle: 'node esbuild.js',
        phaseSvelteCheck: 'do-svelte-check'
      }
    })
    const sel = selectPackagesForPhases(graph, {})
    assert.deepEqual(sel.build, ['a'])
    assert.deepEqual(sel.test, [])
    assert.deepEqual(sel.bundle, [])
    assert.deepEqual(sel.svelteCheck, [])
  })

  test('honours the --to target set', () => {
    const graph = makeGraph({
      a: { phaseBuild: 'compile build' },
      b: { phaseBuild: 'compile build' }
    })
    const sel = selectPackagesForPhases(graph, { ...ALL, targetPackages: new Set(['a']) })
    assert.deepEqual(sel.build, ['a'])
  })

  test('format is always collected', () => {
    const graph = makeGraph({ a: { phaseBuild: 'compile build', phaseFormat: 'format src' } })
    assert.deepEqual(selectPackagesForPhases(graph, {}).format, ['a'])
  })
})

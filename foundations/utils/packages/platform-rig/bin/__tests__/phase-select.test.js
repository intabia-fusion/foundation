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
      phaseValidate: node.phaseValidate,
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

const ALL = { doValidate: true, doTest: true, doBundle: true, doPackage: true, doDockerBuild: true, doSvelteCheck: true }

describe('selectPackagesForPhases', () => {
  test('picks up the three known build scripts', () => {
    const graph = makeGraph({
      src: { phaseBuild: 'compile transpile src' },
      tests: { phaseBuild: 'compile transpile tests' },
      uiEsbuild: { phaseBuild: 'compile ui-esbuild' }
    })
    const sel = selectPackagesForPhases(graph, ALL)
    assert.deepEqual(sel.transpile.sort(), ['src', 'tests', 'uiEsbuild'])
  })

  test('"compile ui" has nothing to transpile and is not an unknown script', () => {
    const graph = makeGraph({ ui: { phaseBuild: 'compile ui', phaseValidate: 'compile validate' } })
    const sel = selectPackagesForPhases(graph, ALL)
    assert.deepEqual(sel.transpile, [])
    assert.deepEqual(sel.validate, ['ui'])
    assert.deepEqual(sel.unknown, [])
  })

  // Regression: `services/ai-bot/love-agent` ("wasm && node esbuild.config.js") and
  // `dev/prod` ("rm -rf ./types && compile validate") were dropped by a strict string
  // comparison — never transpiled, never validated, and never reported.
  test('reports an unrecognised build script instead of dropping it silently', () => {
    const graph = makeGraph({ wasmPkg: { phaseBuild: 'wasm && node esbuild.config.js' } })
    const sel = selectPackagesForPhases(graph, ALL)
    assert.deepEqual(sel.transpile, [])
    assert.deepEqual(sel.unknown, [{ package: 'wasmPkg', phase: 'build', script: 'wasm && node esbuild.config.js' }])
  })

  test('reports an unrecognised validate script instead of dropping it silently', () => {
    const graph = makeGraph({
      devProd: { phaseBuild: 'compile transpile src', phaseValidate: 'rm -rf ./types && compile validate' }
    })
    const sel = selectPackagesForPhases(graph, ALL)
    assert.deepEqual(sel.validate, [])
    assert.deepEqual(sel.unknown, [
      { package: 'devProd', phase: 'validate', script: 'rm -rf ./types && compile validate' }
    ])
  })

  test('"echo done" is an explicit no-op, not an unknown script', () => {
    const graph = makeGraph({
      noop: { phaseBuild: 'compile transpile src', phaseValidate: 'echo done', phaseBundle: 'echo done' }
    })
    const sel = selectPackagesForPhases(graph, ALL)
    assert.deepEqual(sel.validate, [])
    assert.deepEqual(sel.bundle, [])
    assert.deepEqual(sel.unknown, [])
  })

  test('phases are skipped unless their flag is set', () => {
    const graph = makeGraph({
      a: {
        phaseBuild: 'compile transpile src',
        phaseValidate: 'compile validate',
        phaseTest: 'jest --passWithNoTests',
        phaseBundle: 'node esbuild.js',
        phaseSvelteCheck: 'do-svelte-check'
      }
    })
    const sel = selectPackagesForPhases(graph, {})
    assert.deepEqual(sel.transpile, ['a'])
    assert.deepEqual(sel.validate, [])
    assert.deepEqual(sel.test, [])
    assert.deepEqual(sel.bundle, [])
    assert.deepEqual(sel.svelteCheck, [])
  })

  test('honours the --to target set', () => {
    const graph = makeGraph({
      a: { phaseBuild: 'compile transpile src' },
      b: { phaseBuild: 'compile transpile src' }
    })
    const sel = selectPackagesForPhases(graph, { ...ALL, targetPackages: new Set(['a']) })
    assert.deepEqual(sel.transpile, ['a'])
  })

  test('format is collected regardless of the validate flag', () => {
    const graph = makeGraph({ a: { phaseBuild: 'compile transpile src', phaseFormat: 'format src' } })
    assert.deepEqual(selectPackagesForPhases(graph, {}).format, ['a'])
  })
})

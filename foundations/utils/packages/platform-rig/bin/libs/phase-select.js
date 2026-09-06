/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

// Phase scripts this tool knows how to run itself. Anything else in a `_phase:*`
// script is reported through `unknown` rather than silently dropped.
// `compile build` emits JS + .d.ts, `compile build-ui` only .d.ts (UI packages ship sources),
// `compile ui-esbuild` is the one svelte package that still needs esbuild.
const BUILD_SCRIPTS = new Set(['compile build', 'compile build-ui', 'compile ui-esbuild'])

// An explicit opt-out written by hand in package.json.
const NOOP_SCRIPTS = new Set(['echo done', ''])

function isNoop (script) {
  return script == null || NOOP_SCRIPTS.has(script.trim())
}

/**
 * Decide which packages take part in which phase.
 *
 * @param {Map<string, object>} graph
 * @param {object} options
 * @param {Set<string>|null} [options.targetPackages] restrict to these packages (--to)
 * @returns {{build: string[], test: string[], format: string[],
 *            bundle: string[], package: string[], dockerBuild: string[], svelteCheck: string[],
 *            unknown: Array<{package: string, phase: string, script: string}>}}
 */
function selectPackagesForPhases (graph, options = {}) {
  const {
    doTest = false,
    doBundle = false,
    doPackage = false,
    doDockerBuild = false,
    doSvelteCheck = false,
    targetPackages = null
  } = options

  const result = {
    build: [],
    test: [],
    format: [],
    bundle: [],
    package: [],
    dockerBuild: [],
    svelteCheck: [],
    unknown: []
  }

  for (const [name, node] of graph) {
    if (targetPackages && !targetPackages.has(name)) continue

    if (BUILD_SCRIPTS.has(node.phaseBuild)) {
      result.build.push(name)
    } else if (!isNoop(node.phaseBuild)) {
      result.unknown.push({ package: name, phase: 'build', script: node.phaseBuild })
    }

    // The remaining phases shell out to the package's own script, so any non-empty
    // value is runnable and there is nothing to recognise.
    if (doTest && !isNoop(node.phaseTest)) result.test.push(name)
    if (!isNoop(node.phaseFormat)) result.format.push(name)
    if (doBundle && !isNoop(node.phaseBundle)) result.bundle.push(name)
    if ((doPackage || doDockerBuild) && !isNoop(node.phasePackage)) result.package.push(name)
    if (doDockerBuild && !isNoop(node.phaseDockerBuild)) result.dockerBuild.push(name)
    if (doSvelteCheck && !isNoop(node.phaseSvelteCheck)) result.svelteCheck.push(name)
  }

  return result
}

module.exports = { selectPackagesForPhases, BUILD_SCRIPTS }

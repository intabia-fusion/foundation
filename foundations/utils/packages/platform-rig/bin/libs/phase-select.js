/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

// Phase scripts this tool knows how to run itself. Anything else in a `_phase:*`
// script is reported through `unknown` rather than silently dropped.
const BUILD_SCRIPTS = new Set(['compile transpile src', 'compile transpile tests', 'compile ui-esbuild'])
const NO_BUILD_SCRIPTS = new Set(['compile ui'])
const VALIDATE_SCRIPTS = new Set(['compile validate'])

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
 * @returns {{transpile: string[], validate: string[], test: string[], format: string[],
 *            bundle: string[], package: string[], dockerBuild: string[], svelteCheck: string[],
 *            unknown: Array<{package: string, phase: string, script: string}>}}
 */
function selectPackagesForPhases (graph, options = {}) {
  const {
    doValidate = false,
    doTest = false,
    doBundle = false,
    doPackage = false,
    doDockerBuild = false,
    doSvelteCheck = false,
    targetPackages = null
  } = options

  const result = {
    transpile: [],
    validate: [],
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
      result.transpile.push(name)
    } else if (!isNoop(node.phaseBuild) && !NO_BUILD_SCRIPTS.has(node.phaseBuild)) {
      result.unknown.push({ package: name, phase: 'build', script: node.phaseBuild })
    }

    if (doValidate) {
      if (VALIDATE_SCRIPTS.has(node.phaseValidate)) {
        result.validate.push(name)
      } else if (!isNoop(node.phaseValidate)) {
        result.unknown.push({ package: name, phase: 'validate', script: node.phaseValidate })
      }
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

module.exports = { selectPackagesForPhases }

/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

const crypto = require('crypto')
const fs = require('fs')
const { join } = require('path')
const { xxh64 } = require('@node-rs/xxhash')

const { calculateOutputHashForDirs } = require('./cache')

/**
 * Hash the emitted types/ of every package, once per run.
 * @param {Map<string, object>} graph
 * @returns {Map<string, string>} package name -> types hash ('' when it emits none)
 */
function computeTypesHashes (graph) {
  const hashes = new Map()
  for (const [name, node] of graph) {
    const path = node.project?.fullPath
    if (!path) continue
    hashes.set(name, calculateOutputHashForDirs(path, ['types']) ?? '')
  }
  return hashes
}

function collectDeps (name, graph, seen) {
  const node = graph.get(name)
  if (!node) return
  for (const dep of node.dependencies) {
    if (seen.has(dep)) continue
    seen.add(dep)
    collectDeps(dep, graph, seen)
  }
}

function hashFileIfPresent (absPath) {
  try {
    if (!fs.statSync(absPath).isFile()) return null
    return xxh64(fs.readFileSync(absPath)).toString(16)
  } catch {
    return null
  }
}

/**
 * Composite hash for phases that only read a dependency's public API (lint, svelte-check).
 *
 * Keying on a dependency's *sources* meant any edit anywhere upstream re-ran the phase for
 * the whole downstream closure. These phases see dependencies through their emitted .d.ts,
 * so the dependency's types hash is the input that actually matters.
 *
 * @param {string} name
 * @param {Map<string, object>} graph
 * @param {Map<string, string>} packageHashes own-source hash per package
 * @param {Map<string, string>} typesHashes from computeTypesHashes
 * @param {string[]} [extraConfigFiles] package-relative config files that change the result
 * @returns {string}
 */
function compositeHashFromTypes (name, graph, packageHashes, typesHashes, extraConfigFiles = []) {
  const parts = [`self:${packageHashes.get(name) ?? ''}`]

  const deps = new Set()
  collectDeps(name, graph, deps)
  for (const dep of [...deps].sort()) {
    parts.push(`${dep}:types:${typesHashes.get(dep) ?? ''}`)
  }

  const packagePath = graph.get(name)?.project?.fullPath
  if (packagePath) {
    for (const rel of extraConfigFiles) {
      const h = hashFileIfPresent(join(packagePath, rel))
      if (h) parts.push(`cfg:${rel}:${h}`)
    }
  }

  return crypto.createHash('md5').update(parts.join('\n')).digest('hex')
}

module.exports = { computeTypesHashes, compositeHashFromTypes }

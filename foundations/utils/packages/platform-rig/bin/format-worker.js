#!/usr/bin/env node

/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

const { parentPort, threadId } = require('worker_threads')
const { join, relative, basename } = require('path')
const { createRequire } = require('module')
const { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } = require('fs')

const prettier = require('prettier')
const { ESLint } = require('eslint')

const pluginCache = new Map()

function resolvePluginFromCwd(pluginName, cwd) {
  const key = `${cwd}::${pluginName}`
  if (pluginCache.has(key)) return pluginCache.get(key)
  try {
    const req = createRequire(join(cwd, 'noop.js'))
    const mod = req(pluginName)
    pluginCache.set(key, mod)
    return mod
  } catch {
    pluginCache.set(key, null)
    return null
  }
}

function resolvePluginList(plugins, cwd) {
  if (!Array.isArray(plugins)) return []
  const result = []
  for (const p of plugins) {
    if (typeof p === 'string') {
      const mod = resolvePluginFromCwd(p, cwd)
      if (mod) result.push(mod)
    } else if (p) {
      result.push(p)
    }
  }
  return result
}

function clearParserCaches(cwd) {
  try {
    const parser = resolvePluginFromCwd('@typescript-eslint/parser', cwd)
    if (parser && typeof parser.clearCaches === 'function') parser.clearCaches()
  } catch { /* parser layout differs across versions; recycling still bounds memory */ }
}

function collectSourceFiles(dir, result = []) {
  if (!existsSync(dir)) return result
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = lstatSync(full)
    if (stat.isDirectory()) {
      collectSourceFiles(full, result)
    } else {
      const name = basename(full)
      if (name.endsWith('.d.ts')) continue
      if (name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.svelte')) {
        result.push(full)
      }
    }
  }
  return result
}

/**
 * Format a package in-memory: for each file run prettier → eslint --fix via lintText,
 * then write to disk ONLY if final content differs from original. No intermediate
 * writes — webpack watchers never see half-formatted files.
 */
async function formatPackage(cwd, options = {}) {
  const { srcDir = 'src' } = options
  const srcPath = join(cwd, srcDir)
  const startedAt = Date.now()

  const files = collectSourceFiles(srcPath)
  if (files.length === 0) {
    return { success: true, changed: 0, total: 0, errors: [], memoryMB: 0, durationMs: Date.now() - startedAt }
  }

  let eslint = new ESLint({ fix: true, cwd, cache: false })

  const errors = []
  let changedCount = 0
  let errorCount = 0
  let warningCount = 0
  let peakMB = 0
  let failingResults = null

  for (const file of files) {
    let original
    try {
      original = readFileSync(file, 'utf8')
    } catch (err) {
      errors.push(`${relative(cwd, file)}: read: ${err.message}`)
      continue
    }

    let content = original

    // prettier in memory
    try {
      const cfg = await prettier.resolveConfig(file)
      const info = await prettier.getFileInfo(file, { resolveConfig: false })
      if (info.ignored) {
        continue
      }
      const resolvedPlugins = resolvePluginList(cfg && cfg.plugins, cwd)
      content = await prettier.format(original, {
        ...(cfg || {}),
        filepath: file,
        plugins: resolvedPlugins
      })
    } catch (err) {
      errors.push(`${relative(cwd, file)}: prettier: ${err.message}`)
      content = original
    }

    // eslint --fix in memory
    try {
      const lintResults = await eslint.lintText(content, { filePath: file })
      const r = lintResults[0]
      if (r) {
        errorCount += r.errorCount
        warningCount += r.warningCount
        if (r.errorCount > 0 || r.warningCount > 0) {
          if (!failingResults) failingResults = []
          failingResults.push(r)
        }
        if (r.output !== undefined) content = r.output
      }
    } catch (err) {
      errors.push(`${relative(cwd, file)}: eslint: ${err.message}`)
    }

    // Single atomic write only if final content differs
    if (content !== original) {
      try {
        writeFileSync(file, content, 'utf8')
        changedCount++
      } catch (err) {
        errors.push(`${relative(cwd, file)}: write: ${err.message}`)
      }
    }

    const mb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    if (mb > peakMB) peakMB = mb
  }

  let lintOutput = ''
  if (failingResults) {
    try {
      const formatter = await eslint.loadFormatter('stylish')
      lintOutput = formatter.format(failingResults)
    } catch {}
  }

  eslint = null
  failingResults = null

  if (typeof prettier.clearConfigCache === 'function') {
    prettier.clearConfigCache()
  }

  // @typescript-eslint/parser keeps every Program it built in a module-level cache.
  // Dropping it here frees the same memory a worker respawn did, without paying for
  // a new thread plus a fresh require of eslint/prettier/typescript on every 2nd package.
  clearParserCaches(cwd)

  return {
    success: errorCount === 0 && errors.length === 0,
    changed: changedCount,
    total: files.length,
    errors,
    errorCount,
    warningCount,
    lintOutput,
    hasLintErrors: errorCount > 0,
    memoryMB: peakMB,
    durationMs: Date.now() - startedAt
  }
}

if (parentPort) {
  parentPort.on('message', async (task) => {
    const { id, type, cwd } = task

    if (type === 'format') {
      try {
        const result = await formatPackage(cwd, { srcDir: task.srcDir || 'src' })
        parentPort.postMessage({ id, threadId, ...result })
      } catch (err) {
        parentPort.postMessage({ id, threadId, success: false, error: err.stack || err.message || String(err) })
      }
    } else if (type === 'exit') {
      process.exit(0)
    }
  })

  parentPort.postMessage({ type: 'ready', threadId })
}

module.exports = { formatPackage }

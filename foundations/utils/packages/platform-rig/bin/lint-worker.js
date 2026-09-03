#!/usr/bin/env node

/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

const { parentPort, threadId } = require('worker_threads')
const { join, basename } = require('path')
const { existsSync, readdirSync, lstatSync } = require('fs')

const { ESLint } = require('eslint')

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

async function lintPackage(cwd, options = {}) {
  const { srcDir = 'src', chunkSize = 50 } = options
  const srcPath = join(cwd, srcDir)
  const startedAt = Date.now()

  const files = collectSourceFiles(srcPath)
  if (files.length === 0) {
    const memoryMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    return { success: true, errorCount: 0, warningCount: 0, total: 0, output: '', memoryMB, durationMs: Date.now() - startedAt }
  }

  // ESLint's own file cache skips unchanged files before parsing, so with everything
  // cached no TS Program gets built at all. Content strategy, because mtime changes on
  // every git checkout. The phase-level hash still covers dependency type changes,
  // which this cache cannot see.
  let eslint = new ESLint({
    fix: false,
    cwd,
    cache: true,
    cacheLocation: join(cwd, '.eslintcache'),
    cacheStrategy: 'content'
  })
  const formatter = await eslint.loadFormatter('stylish')

  let errorCount = 0
  let warningCount = 0
  let output = ''
  let peakMB = 0

  // Process files in chunks to cap memory: ESLint retains AST/messages for all lintFiles results.
  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize)
    let results = await eslint.lintFiles(chunk)
    for (const r of results) {
      errorCount += r.errorCount
      warningCount += r.warningCount
    }
    // Only keep formatted output for files with problems to avoid retaining massive strings
    const withProblems = results.filter(r => r.errorCount > 0 || r.warningCount > 0)
    if (withProblems.length > 0) {
      output += formatter.format(withProblems)
    }
    results = null
    const mb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    if (mb > peakMB) peakMB = mb
  }

  eslint = null

  return {
    success: errorCount === 0,
    errorCount,
    warningCount,
    total: files.length,
    output,
    memoryMB: peakMB,
    durationMs: Date.now() - startedAt
  }
}

if (parentPort) {
  parentPort.on('message', async (task) => {
    const { id, type, cwd } = task

    if (type === 'lint') {
      try {
        const result = await lintPackage(cwd, { srcDir: task.srcDir || 'src' })
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

module.exports = { lintPackage }

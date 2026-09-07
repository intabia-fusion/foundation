#!/usr/bin/env node

/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

// Per-package formatter (invoked as `format <srcDir>` from `_phase:format`).
// Shares the unified `.fast-build-cache.json` cache used by `pnpm format`,
// so a package formatted by either entry point is recognised as up-to-date by the other.

const { existsSync } = require('fs')
const { join } = require('path')

const { formatPackage } = require('./format-worker')
const {
  isPhaseCached,
  markPhaseCompleted,
  calculatePackageHash
} = require('./libs/cache')

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('-f') || args.includes('--force')
  const srcArg = args.find((a) => !a.startsWith('-')) || 'src'
  const cwd = process.cwd()

  if (!existsSync(join(cwd, srcArg))) {
    console.info(`format: ${srcArg} not found, skipping`)
    process.exit(0)
  }

  const hash = calculatePackageHash(cwd)

  if (!force && isPhaseCached(cwd, hash, 'format', null, [])) {
    console.info('format: cached, no changes')
    process.exit(0)
  }

  const result = await formatPackage(cwd, { srcDir: srcArg })

  if (result.lintOutput) {
    process.stderr.write(result.lintOutput + '\n')
  }
  if (result.errors && result.errors.length > 0) {
    process.stderr.write(result.errors.join('\n') + '\n')
  }

  if (!result.success) {
    console.error(`format: failed (${result.errorCount || 0} errors, ${result.errors?.length || 0} io errors)`)
    process.exit(1)
  }

  // Hash changes after formatting if files were rewritten — store the new hash.
  const finalHash = result.changed > 0 ? calculatePackageHash(cwd) : hash
  markPhaseCompleted(cwd, finalHash, 'format', null, [])

  console.info(`format: ${result.changed}/${result.total} files changed`)
  process.exit(0)
}

main().catch((err) => {
  console.error('format: unexpected failure:', err.stack || err.message || err)
  process.exit(1)
})

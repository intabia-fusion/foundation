#!/usr/bin/env node
// Validate electron-builder update manifests after `rushx dist`.
// Usage: node scripts/verify-manifests.js [deployDir] [channel] [--suffixes=-mac,-linux]
const path = require('path')
require('ts-node').register({ transpileOnly: true, project: path.join(__dirname, '..', 'tsconfig.json') })
const { verifyManifests } = require(path.join(__dirname, '..', 'src', 'verifyManifests.ts'))

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const dir = args[0] ?? 'deploy'
const channel = args[1] ?? 'latest'
// Partial builds (a single platform) only produce some manifests.
const only = process.argv.find((a) => a.startsWith('--suffixes='))
const suffixes = only ? only.slice('--suffixes='.length).split(',') : undefined
const problems = verifyManifests(dir, channel, suffixes ? { suffixes } : {})

if (problems.length === 0) {
  console.log(`Update manifests for channel '${channel}' look good.`)
  process.exit(0)
}
for (const { manifest, problem } of problems) {
  console.error(`${manifest}: ${problem}`)
}
process.exit(1)

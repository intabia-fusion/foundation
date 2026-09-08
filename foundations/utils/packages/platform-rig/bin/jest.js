#!/usr/bin/env node
/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

// Runs the workspace-wide jest.config.js with jest's own reporter. jest is a dependency of the
// packages, not of the root, so the binary is resolved from one of them.
//
//   pnpm jest                       every package that can share a run
//   pnpm jest -t 'batch removal'    one test by name, across all of them

const { spawn } = require('child_process')
const { join } = require('path')
const { planTestRun, collectTestEntries, findJestBin } = require('./libs/test-groups')
const { findWorkspaceRoot } = require('./libs/workspace')

const root = findWorkspaceRoot()
const { shared } = planTestRun(collectTestEntries(root))
if (shared === null) {
  console.error('No packages can share a jest run')
  process.exit(1)
}
const jestBin = findJestBin(shared.packages)
if (jestBin == null) {
  console.error('jest not found in any workspace package; run pnpm install')
  process.exit(1)
}

const child = spawn(jestBin, ['-c', join(root, 'jest.config.js'), ...shared.flags, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit'
})
child.on('close', (code) => process.exit(code ?? 1))

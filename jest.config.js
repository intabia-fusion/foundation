//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

// Runs the whole workspace as one jest, for jest's own reporter and flags:
//
//   pnpm exec jest                       every package that can share a run
//   pnpm exec jest -t 'batch removal'    one test by name, across all of them
//
// Projects come from pnpm-workspace.yaml, so a new package needs no edit here, and each keeps its
// own jest.config.js. Packages that cannot share a run (their own `projects`, an unsupported flag,
// `testIsolated` in package.json) are left out — `pnpm test` still runs those, one at a time.

const { planTestRun, collectTestEntries, buildSharedConfig } = require('./foundations/utils/packages/platform-rig/bin/libs/test-groups')

const { shared } = planTestRun(collectTestEntries(__dirname))
const { projects, testTimeout } = shared === null ? { projects: [] } : buildSharedConfig(shared)

module.exports = { projects, testTimeout }

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

import { buildToolProgram, prepareTools, registerToolLocations, runToolCommand } from '@hcengineering/tool'
import { execFileSync } from 'child_process'
import { resolve } from 'path'
import { action } from './log'

/**
 * @public
 */
export type ToolEnv = Record<string, string>

/**
 * @public
 */
export const repoRoot = resolve(__dirname, '../../..')

let appliedKeys: string[] = []

/**
 * The tool reads its configuration from process.env at command time, so a whole phase runs under one
 * env. Commands of different regions must therefore be grouped into separate phases. Keys of the
 * previous env are dropped, otherwise a region-only variable (REGION_INFO) would leak into the next.
 * @public
 */
export function applyEnv (env: ToolEnv): void {
  for (const key of appliedKeys) {
    if (env[key] === undefined) {
      // Not `delete`: assigning undefined would set the literal string 'undefined'.
      Reflect.deleteProperty(process.env, key)
    }
  }
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value
  }
  appliedKeys = Object.keys(env)
}

let modelVersion: string | undefined

/**
 * @public
 */
export function getModelVersionString (): string {
  if (modelVersion === undefined) {
    modelVersion = execFileSync('node', [resolve(repoRoot, 'common/scripts/show_version.js')])
      .toString()
      .trim()
  }
  return modelVersion
}

/**
 * Server plugin registration and building the model cost several seconds and are process-wide. Doing
 * them while docker is still starting takes them off the critical path. Requires the tool env to be
 * applied already.
 * @public
 */
export function warmupTool (): void {
  registerToolLocations()
  buildToolProgram(prepareTools)
  prepareTools()
}

/**
 * Runs one dev/tool command in this process. Model and DB pools are built once and reused by every
 * subsequent command, which is what makes the whole stand setup cheap.
 * @public
 */
export async function runTool (args: string[]): Promise<void> {
  await action(`tool ${args.join(' ')}`, async () => {
    await runToolCommand(args)
  })
}

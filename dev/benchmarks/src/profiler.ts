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

import { generateToken } from '@hcengineering/server-token'
import { systemAccountUuid } from '@hcengineering/core'
import { writeFile, mkdir } from 'fs/promises'
import { dirname, resolve } from 'path'
import { existsSync } from 'fs'

function getAdminToken (): string {
  // Transactor /api/v1/manage accepts the system account; no admin flag needed.
  return generateToken(systemAccountUuid, undefined, { service: 'tool' })
}

export async function startProfile (transactorUrl: string): Promise<void> {
  const token = getAdminToken()
  const url = `${transactorUrl}/api/v1/manage?operation=profile-start`
  const resp = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } })
  if (!resp.ok) {
    throw new Error(`Failed to start profiling: ${resp.status} ${resp.statusText}`)
  }
  console.log(`  profiling started on ${transactorUrl}`)
}

export async function stopProfile (transactorUrl: string, outputPath?: string): Promise<string> {
  const token = getAdminToken()
  const url = `${transactorUrl}/api/v1/manage?operation=profile-stop`
  const resp = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } })
  if (!resp.ok) {
    throw new Error(`Failed to stop profiling: ${resp.status} ${resp.statusText}`)
  }

  const bytes = await resp.arrayBuffer()
  const outDir = resolve(outputPath ?? './profiles')
  if (!existsSync(outDir)) {
    await mkdir(outDir, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = resolve(outDir, `profile-${timestamp}.cpuprofile`)
  await writeFile(filePath, new Uint8Array(bytes))
  console.log(`  profile saved to ${filePath}`)
  return filePath
}

export interface ProfileGuard {
  stop: () => Promise<string>
}

/** Start profiling and return a guard to stop it later */
export async function withProfiling (transactorUrl: string, outputDir?: string): Promise<ProfileGuard> {
  await startProfile(transactorUrl)
  return {
    stop: async () => await stopProfile(transactorUrl, outputDir)
  }
}

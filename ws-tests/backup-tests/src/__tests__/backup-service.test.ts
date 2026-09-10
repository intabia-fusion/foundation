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

/**
 * The backup pod itself, as it runs on the stand: it must pick a freshly created workspace up on
 * its own, write the archive into the bucket and report it back to the account service.
 *
 * A workspace of its own is created for this - resetting the shared one's backupInfo would race
 * with backup-incremental.test.ts.
 */

import { type WorkspaceDataId, type WorkspaceUuid } from '@hcengineering/core'
import { createStorageBackupStorage } from '@hcengineering/server-backup'
import { type StorageAdapter } from '@hcengineering/server-core'

import { createBackupStorageAdapter, createCtx, env, registerBackupTools, shutdown, withAccountDb } from '../harness'

jest.setTimeout(600000)

async function rpc (method: string, params: Record<string, any>, token?: string): Promise<any> {
  const res = await fetch(env('ACCOUNTS_URL'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ method, params })
  })
  const body = await res.json()
  if (body.error != null) {
    throw new Error(`${method} failed: ${JSON.stringify(body.error)}`)
  }
  return body.result
}

describe('backup service', () => {
  const bucket = env('BACKUP_BUCKET_NAME')
  const ctx = createCtx('backup-service')

  let adapter: StorageAdapter
  let wsUuid: WorkspaceUuid
  let dataId: WorkspaceDataId

  beforeAll(async () => {
    registerBackupTools()
    adapter = createBackupStorageAdapter()

    const login = await rpc('login', { email: 'user1', password: '1234' })
    const ws = await rpc('createWorkspace', { workspaceName: `backup-svc-${Date.now()}` }, login.token)
    wsUuid = ws.workspace

    // Only getWorkspaceInfo({ updateLastVisit: true }) stamps lastVisit, and the pod skips a
    // workspace that was never visited - createWorkspace alone leaves the field empty.
    const selected = await rpc('selectWorkspace', { workspaceUrl: ws.workspaceUrl, kind: 'external' }, login.token)
    await rpc('getWorkspaceInfo', { updateLastVisit: true }, selected.token)

    const deadline = Date.now() + 240000
    while (Date.now() < deadline) {
      const row = await withAccountDb(async (db) => await db.workspaceStatus.findOne({ workspaceUuid: wsUuid }))
      if (row?.mode === 'active') break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    const wsRow = await withAccountDb(async (db) => await db.workspace.findOne({ uuid: wsUuid }))
    dataId = (wsRow?.dataId ?? wsUuid) as WorkspaceDataId
  })

  afterAll(async () => {
    await adapter.close()
    await shutdown()
  })

  it('backs the new workspace up without being asked', async () => {
    const deadline = Date.now() + 420000
    let backups = 0

    while (Date.now() < deadline) {
      const status = await withAccountDb(async (db) => await db.workspaceStatus.findOne({ workspaceUuid: wsUuid }))
      backups = status?.backupInfo?.backups ?? 0
      if (backups > 0) break
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }

    expect(backups).toBeGreaterThan(0)

    const storage = await createStorageBackupStorage(
      ctx,
      adapter,
      { uuid: bucket as WorkspaceUuid, dataId: bucket as WorkspaceDataId, url: '' },
      dataId
    )
    expect(await storage.exists('backup.json.gz')).toBe(true)
  })
})

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
 * Retention of archives belonging to deleted workspaces, against a live stand.
 *
 * The grace period is configured in days, so instead of waiting the tests move
 * `last_processing_time` back in the account DB - the same field the `delete-done` transition
 * stamps, and the one the cleanup reads as "deleted at".
 */

import { type AccountDB } from '@hcengineering/account'
import {
  generateUuid,
  systemAccountUuid,
  type MeasureContext,
  type WorkspaceDataId,
  type WorkspaceUuid
} from '@hcengineering/core'
import {
  cleanupDeletedBackups,
  createStorageBackupStorage,
  type BackupConfig,
  type BackupInfo,
  type BackupStorage
} from '@hcengineering/server-backup'
import { type StorageAdapter } from '@hcengineering/server-core'
import { gzipSync } from 'node:zlib'
import { generateToken } from '@hcengineering/server-token'

import { createBackupStorageAdapter, createCtx, env, registerBackupTools, shutdown, withAccountDb } from '../harness'

jest.setTimeout(300000)

const DAY = 24 * 3600 * 1000

describe('backup retention', () => {
  const bucket = env('BACKUP_BUCKET_NAME')

  let ctx: MeasureContext
  let adapter: StorageAdapter
  let config: BackupConfig
  const created: WorkspaceUuid[] = []

  /** A workspace row plus one file in the archive bucket, as a real backup would leave it. */
  async function seedWorkspace (mode: 'active' | 'deleted', deletedDaysAgo: number): Promise<WorkspaceDataId> {
    const dataId = `retention-${generateUuid()}` as WorkspaceDataId
    await withAccountDb(async (db: AccountDB) => {
      const uuid = await db.createWorkspace(
        {
          url: dataId,
          name: dataId,
          dataId,
          region: '',
          allowGuestSignUp: false,
          allowReadOnlyGuest: false
        },
        {
          mode,
          isDisabled: mode === 'deleted',
          versionMajor: 0,
          versionMinor: 7,
          versionPatch: 0,
          lastProcessingTime: Date.now() - deletedDaysAgo * DAY,
          backupInfo: { backups: 1, backupSize: 1, blobsSize: 0, dataSize: 1, lastBackup: Date.now() }
        }
      )
      created.push(uuid)
    })

    // A real archive shape: cleanup deletes the files the index names, so the index has to be one.
    const storage = await archiveOf(dataId)
    const info: BackupInfo = {
      workspace: generateUuid() as WorkspaceUuid,
      version: '0.6',
      snapshots: [
        {
          date: Date.now(),
          stIndex: 0,
          domains: { tx: { snapshots: ['tx-1.snp.gz'], storage: ['tx-1.tar.gz'], added: 0, updated: 0, removed: 0 } }
        }
      ],
      domainHashes: {},
      migrations: {}
    } as unknown as BackupInfo
    await storage.writeFile('tx-1.snp.gz', Buffer.from('snapshot'))
    await storage.writeFile('tx-1.tar.gz', Buffer.from('data'))
    await storage.writeFile('blob-info.json.gz', gzipSync(Buffer.from('{}')))
    await storage.writeFile('backup.json.gz', gzipSync(Buffer.from(JSON.stringify(info))))
    expect(await storage.exists('backup.json.gz')).toBe(true)
    return dataId
  }

  async function archiveFiles (dataId: WorkspaceDataId): Promise<string[]> {
    const storage = await archiveOf(dataId)
    const names = ['backup.json.gz', 'blob-info.json.gz', 'tx-1.snp.gz', 'tx-1.tar.gz']
    const present: string[] = []
    for (const name of names) {
      if (await storage.exists(name)) present.push(name)
    }
    return present
  }

  async function archiveOf (dataId: WorkspaceDataId): Promise<BackupStorage> {
    return await createStorageBackupStorage(
      ctx,
      adapter,
      { uuid: bucket as WorkspaceUuid, dataId: bucket as WorkspaceDataId, url: '' },
      dataId
    )
  }

  async function backupsRecorded (dataId: WorkspaceDataId): Promise<number> {
    return await withAccountDb(async (db) => {
      const ws = await db.workspace.findOne({ url: dataId })
      if (ws == null) return -1
      const status = await db.workspaceStatus.findOne({ workspaceUuid: ws.uuid })
      return status?.backupInfo?.backups ?? 0
    })
  }

  beforeAll(async () => {
    registerBackupTools()
    ctx = createCtx('backup-retention')
    adapter = createBackupStorageAdapter()
    config = {
      AccountsURL: env('ACCOUNTS_URL'),
      AccountsDbURL: env('ACCOUNT_DB_URL'),
      Token: generateToken(systemAccountUuid, undefined, { service: 'backup' }),
      Interval: 0,
      CoolDown: 0,
      Timeout: 0,
      BucketName: bucket,
      SkipWorkspaces: '',
      Parallel: 1,
      KeepSnapshots: 1,
      DeletedRetentionDays: 7
    }
  })

  afterAll(async () => {
    await withAccountDb(async (db) => {
      for (const uuid of created) {
        await db.workspaceStatus.deleteMany({ workspaceUuid: uuid })
        await db.workspace.deleteMany({ uuid })
      }
    })
    await adapter.close()
    await shutdown()
  })

  it('drops the archive once the grace period is over', async () => {
    const dataId = await seedWorkspace('deleted', 8)

    const cleaned = await cleanupDeletedBackups(ctx, adapter, config, '')

    const ws = await withAccountDb(async (db) => await db.workspace.findOne({ url: dataId }))
    expect(cleaned).toContain(ws?.uuid)
    // Every file the index named is gone, not just the index.
    expect(await archiveFiles(dataId)).toEqual([])
    // The emptied status is what stops the next pass from looking at it again.
    expect(await backupsRecorded(dataId)).toBe(0)
  })

  it('keeps the archive while the workspace is still within the grace period', async () => {
    const dataId = await seedWorkspace('deleted', 2)

    await cleanupDeletedBackups(ctx, adapter, config, '')

    expect(await archiveFiles(dataId)).toHaveLength(4)
    expect(await backupsRecorded(dataId)).toBe(1)
  })

  it('never touches a workspace that is still alive', async () => {
    const dataId = await seedWorkspace('active', 400)

    await cleanupDeletedBackups(ctx, adapter, config, '')

    expect(await archiveFiles(dataId)).toHaveLength(4)
    expect(await backupsRecorded(dataId)).toBe(1)
  })

  it('does nothing on a second pass', async () => {
    const dataId = await seedWorkspace('deleted', 8)

    await cleanupDeletedBackups(ctx, adapter, config, '')
    const again = await cleanupDeletedBackups(ctx, adapter, config, '')

    const ws = await withAccountDb(async (db) => await db.workspace.findOne({ url: dataId }))
    expect(again).not.toContain(ws?.uuid)
  })

  it('is disabled by a zero retention', async () => {
    const dataId = await seedWorkspace('deleted', 400)

    const cleaned = await cleanupDeletedBackups(ctx, adapter, { ...config, DeletedRetentionDays: 0 }, '')

    expect(cleaned).toEqual([])
    expect(await archiveFiles(dataId)).toHaveLength(4)
  })
})

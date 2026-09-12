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

import { MeasureMetricsContext, newMetrics, type Domain, type WorkspaceUuid } from '@hcengineering/core'
import { gzipSync } from 'node:zlib'

import { removeBackupFiles } from '../service'
import { type BackupStorage } from '../storage'
import { type BackupInfo, type DomainData } from '../types'

const ctx = new MeasureMetricsContext('test', {}, {}, newMetrics())

/** In-memory archive: only what removeBackupFiles touches, everything else throws. */
function archive (files: Record<string, Buffer | string>): { storage: BackupStorage, deleted: string[] } {
  const content = new Map<string, Buffer>(
    Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? Buffer.from(v) : v])
  )
  const deleted: string[] = []

  const storage = {
    async exists (name: string) {
      return content.has(name)
    },
    async loadFile (name: string) {
      const data = content.get(name)
      if (data === undefined) throw new Error(`no such file: ${name}`)
      return data
    },
    async delete (name: string) {
      if (!content.has(name)) throw new Error(`no such file: ${name}`)
      content.delete(name)
      deleted.push(name)
    }
  } as unknown as BackupStorage

  return { storage, deleted }
}

function index (domains: Record<string, { snapshot?: string, snapshots?: string[], storage?: string[] }>): Buffer {
  const snapshotDomains: Record<Domain, DomainData> = {}
  for (const [name, data] of Object.entries(domains)) {
    snapshotDomains[name as Domain] = { ...data, added: 0, updated: 0, removed: 0 }
  }
  const info: BackupInfo = {
    workspace: 'ws-1' as WorkspaceUuid,
    version: '0.6',
    snapshots: [{ date: Date.now(), stIndex: 0, domains: snapshotDomains }],
    domainHashes: {},
    migrations: {}
  }
  return gzipSync(Buffer.from(JSON.stringify(info)))
}

describe('removeBackupFiles', () => {
  it('removes exactly what the index lists, plus both indices', async () => {
    const { storage, deleted } = archive({
      'backup.json.gz': index({
        tx: { snapshots: ['tx-1.snp.gz'], storage: ['tx-1.tar.gz'] },
        blob: { snapshot: 'blob-0.json.gz', storage: ['blob-1.tar.gz'] }
      }),
      'blob-info.json.gz': 'blobs',
      'tx-1.snp.gz': 'a',
      'tx-1.tar.gz': 'b',
      'blob-0.json.gz': 'c',
      'blob-1.tar.gz': 'd'
    })

    const removed = await removeBackupFiles(ctx, storage)

    expect(removed).toBe(6)
    expect(deleted.sort()).toEqual(
      ['backup.json.gz', 'blob-0.json.gz', 'blob-1.tar.gz', 'blob-info.json.gz', 'tx-1.snp.gz', 'tx-1.tar.gz'].sort()
    )
  })

  it('drops the index last, so an interrupted run leaves a readable archive', async () => {
    const { storage, deleted } = archive({
      'backup.json.gz': index({ tx: { storage: ['tx-1.tar.gz'] } }),
      'blob-info.json.gz': 'blobs',
      'tx-1.tar.gz': 'b'
    })

    await removeBackupFiles(ctx, storage)

    expect(deleted[deleted.length - 1]).toBe('backup.json.gz')
  })

  it('leaves everything alone when there is no index', async () => {
    const { storage, deleted } = archive({ 'stray.tar.gz': 'x' })

    const removed = await removeBackupFiles(ctx, storage)

    expect(removed).toBe(0)
    expect(deleted).toEqual([])
  })

  it('survives a file the index names but the archive never got', async () => {
    const { storage, deleted } = archive({
      'backup.json.gz': index({ tx: { storage: ['present.tar.gz', 'missing.tar.gz'] } }),
      'present.tar.gz': 'a'
    })

    const removed = await removeBackupFiles(ctx, storage)

    // present + backup.json.gz; blob-info and the missing one were not there.
    expect(removed).toBe(2)
    expect(deleted).toContain('present.tar.gz')
    expect(deleted).not.toContain('missing.tar.gz')
  })

  it('touches no name the index does not mention', async () => {
    const { storage, deleted } = archive({
      'backup.json.gz': index({ tx: { storage: ['mine.tar.gz'] } }),
      'mine.tar.gz': 'a',
      // A neighbour's file that a prefix sweep would have matched.
      'not-mine.tar.gz': 'b'
    })

    await removeBackupFiles(ctx, storage)

    expect(deleted).not.toContain('not-mine.tar.gz')
  })
})

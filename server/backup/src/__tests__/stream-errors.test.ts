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

import { MeasureMetricsContext, type Doc, type Domain, type Ref } from '@hcengineering/core'
import { PassThrough, Readable, Writable } from 'stream'
import { gunzipSync } from 'zlib'
import { type BackupStorage, type FileInfo } from '../storage'
import { collectAccountObjects } from '../restore'
import { type BackupSnapshot, type DomainData, type Snapshot } from '../types'
import { verifyDocsFromSnapshot, watchStreamErrors, writeChanges } from '../utils'

/** Storage whose write stream fails, so a missing error path shows up as a hang. */
class FailingWriteStorage implements BackupStorage {
  chunks: Buffer[] = []

  constructor (readonly failAfter: number) {}

  async write (name: string): Promise<Writable> {
    let seen = 0
    const failAfter = this.failAfter
    return new Writable({
      write (chunk, enc, cb) {
        cb(seen++ >= failAfter ? new Error('storage write failed') : null)
      }
    })
  }

  async loadFile (name: string): Promise<Buffer> {
    throw new Error('not used')
  }

  async load (name: string): Promise<Readable> {
    throw new Error('not used')
  }

  async writeFile (name: string, data: string | Buffer | Readable): Promise<void> {}
  async exists (name: string): Promise<boolean> {
    return false
  }

  async stat (name: string): Promise<number> {
    return 0
  }

  async statInfo (name: string): Promise<FileInfo> {
    return { size: 0, etag: name, lastModified: 0 }
  }

  async delete (name: string): Promise<void> {}
  async deleteRecursive (name: string): Promise<void> {}
}

function bigSnapshot (n: number): Snapshot {
  const added = new Map<any, string>()
  for (let i = 0; i < n; i++) {
    added.set(`doc${i}`, `hash${i}`)
  }
  return { added, updated: new Map(), removed: [] }
}

/** Destination that acknowledges writes asynchronously, so an early resolve loses data. */
class SlowWriteStorage implements BackupStorage {
  chunks: Buffer[] = []
  stream!: Writable

  async write (name: string): Promise<Writable> {
    const chunks = this.chunks
    this.stream = new Writable({
      write (chunk, enc, cb) {
        setTimeout(() => {
          chunks.push(Buffer.from(chunk))
          cb()
        }, 5)
      }
    })
    return this.stream
  }

  async loadFile (name: string): Promise<Buffer> {
    throw new Error('not used')
  }

  async load (name: string): Promise<Readable> {
    throw new Error('not used')
  }

  async writeFile (name: string, data: string | Buffer | Readable): Promise<void> {}
  async exists (name: string): Promise<boolean> {
    return false
  }

  async stat (name: string): Promise<number> {
    return 0
  }

  async statInfo (name: string): Promise<FileInfo> {
    return { size: 0, etag: name, lastModified: 0 }
  }

  async delete (name: string): Promise<void> {}
  async deleteRecursive (name: string): Promise<void> {}
}

/** In-memory storage; the named data file's read stream fails mid-flight. */
class MemStorage implements BackupStorage {
  files = new Map<string, Buffer>()

  constructor (readonly failingLoad: string) {}

  async write (name: string): Promise<Writable> {
    const chunks: Buffer[] = []
    const w = new PassThrough()
    w.on('data', (c: Buffer) => chunks.push(c))
    w.on('end', () => this.files.set(name, Buffer.concat(chunks)))
    return w
  }

  async loadFile (name: string): Promise<Buffer> {
    const f = this.files.get(name)
    if (f === undefined) throw new Error(`no such file ${name}`)
    return f
  }

  async load (name: string): Promise<Readable> {
    if (name === this.failingLoad) {
      const s = new Readable({ read () {} })
      setImmediate(() => s.emit('error', new Error('storage read failed')))
      return s
    }
    return Readable.from([await this.loadFile(name)])
  }

  async writeFile (name: string, data: string | Buffer | Readable): Promise<void> {}
  async exists (name: string): Promise<boolean> {
    return this.files.has(name)
  }

  async stat (name: string): Promise<number> {
    return this.files.get(name)?.length ?? 0
  }

  async statInfo (name: string): Promise<FileInfo> {
    return { size: await this.stat(name), etag: name, lastModified: 0 }
  }

  async delete (name: string): Promise<void> {}
  async deleteRecursive (name: string): Promise<void> {}
}

describe('backup stream error handling', () => {
  // Without the error->reject path this hangs forever, so the timeout is the assertion.
  it('writeChanges rejects when the destination write stream fails', async () => {
    await expect(writeChanges(new FailingWriteStorage(0), 'snapshot.gz', bigSnapshot(50000))).rejects.toThrow(
      'storage write failed'
    )
  }, 10000)

  it('writeChanges succeeds when the destination accepts everything', async () => {
    await expect(
      writeChanges(new FailingWriteStorage(Number.MAX_SAFE_INTEGER), 'snapshot.gz', bigSnapshot(1000))
    ).resolves.toBeUndefined()
  }, 10000)

  // Pack streams error while documents are still being written, long before _packClose awaits.
  it('watchStreamErrors captures an error raised before anyone awaits it', async () => {
    const a = new PassThrough()
    const b = new PassThrough()
    const failed = watchStreamErrors(a, b)

    expect(() => b.emit('error', new Error('pack write failed'))).not.toThrow()
    await expect(failed).rejects.toThrow('pack write failed')
  }, 10000)

  it('writeChanges waits for the destination to finish, not just for gzip flush', async () => {
    const storage = new SlowWriteStorage()
    await writeChanges(storage, 'snapshot.gz', bigSnapshot(200))

    expect(storage.stream.writableFinished).toBe(true)
    const text = gunzipSync(Buffer.concat(storage.chunks)).toString()
    expect(text.startsWith('200\n')).toBe(true)
    expect(text).toContain('doc199;hash199\n')
  }, 10000)

  it('a destination error after writeChanges returned does not become an unhandled error event', async () => {
    const storage = new SlowWriteStorage()
    await writeChanges(storage, 'snapshot.gz', bigSnapshot(10))
    expect(() => storage.stream.emit('error', new Error('late storage failure'))).not.toThrow()
  }, 10000)

  // readStream.pipe(unzip).on('error') attached the handler to unzip, not to readStream,
  // so a failing storage read never rejected and the await hung forever.
  it('verifyDocsFromSnapshot marks the file broken when the data read stream errors', async () => {
    const ctx = new MeasureMetricsContext('test', {})
    const domain = 'test' as Domain
    const dataFile = 'test-data-1.tar.gz'
    const snapshotFile = 'test-snapshot-1.snp.gz'

    const storage = new MemStorage(dataFile)
    const changes: Snapshot = { added: new Map([['doc1' as any, 'hash1']]), updated: new Map(), removed: [] }
    await writeChanges(storage, snapshotFile, changes)

    const d: DomainData = { domain, storage: [dataFile], snapshots: [snapshotFile] } as any
    const s: BackupSnapshot = { date: 1, domains: { [domain]: d } } as any
    const digest = new Map([['doc1' as Ref<Doc>, 'hash1']])

    // The read error is caught inside and the file marked broken - the point is that it returns at all.
    const res = await verifyDocsFromSnapshot(ctx, domain, d, s, storage, digest, async () => {}, 100)
    expect(res.modified).toBe(true)
    expect(res.modifiedFiles).toContain(dataFile)
  }, 10000)

  it('collectAccountObjects rejects when the data read stream errors', async () => {
    const ctx = new MeasureMetricsContext('test', {})
    const domain = 'test' as Domain
    const dataFile = 'test-data-1.tar.gz'
    const snapshotFile = 'test-snapshot-1.snp.gz'

    const storage = new MemStorage(dataFile)
    const changes: Snapshot = { added: new Map([['doc1' as any, 'hash1']]), updated: new Map(), removed: [] }
    await writeChanges(storage, snapshotFile, changes)

    const d: DomainData = { domain, storage: [dataFile], snapshots: [snapshotFile] } as any
    const s: BackupSnapshot = { date: 1, domains: { [domain]: d } } as any

    await expect(collectAccountObjects(ctx, storage, [s], domain, 1)).rejects.toThrow('storage read failed')
  }, 10000)
})

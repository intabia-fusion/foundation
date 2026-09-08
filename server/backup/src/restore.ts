//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021 Hardcore Engineering Inc.
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

import { Analytics } from '@hcengineering/analytics'
import { type Person as GlobalPerson, type SocialId, type AccountDB, Account } from '@hcengineering/account'
import core, {
  AccountRole,
  AccountUuid,
  Doc,
  Domain,
  DOMAIN_BLOB,
  MeasureContext,
  type PersonUuid,
  RateLimiter,
  Ref,
  toIdMap,
  TxProcessor,
  type Blob,
  type LowLevelStorage,
  type TxCUD,
  type WorkspaceIds
} from '@hcengineering/core'
import { BlobClient } from '@hcengineering/server-client'
import { BackupClientOps, createDummyStorageAdapter, type Pipeline } from '@hcengineering/server-core'
import { deepEqual } from 'fast-equals'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { extract } from 'tar-stream'
import { createGunzip, gunzipSync } from 'zlib'
import { BackupStorage } from './storage'
import type { BackupInfo, BackupSnapshot } from './types'
import { chunkArray, doTrimHash, isAccountDomain, loadDigest, migradeBlobData, toAccountDomain } from './utils'
export * from './storage'

const dataUploadSize = 2 * 1024 * 1024

const defaultLevel = 9

type BlobVerifyResult = 'ok' | 'missing' | 'mismatch'

// Download a blob back and compare its content byte-for-byte with the source.
async function verifyBlobContent (
  ctx: MeasureContext,
  blobClient: BlobClient,
  name: string,
  expected: Buffer
): Promise<BlobVerifyResult> {
  const stat = await blobClient.storageAdapter.stat(ctx, blobClient.workspace, name)
  if (stat === undefined) {
    return 'missing'
  }
  // Size guard: writeTo reads only expected.length, so a longer remote blob would compare equal otherwise.
  if (stat.size !== expected.length) {
    return 'mismatch'
  }
  const chunks: Buffer[] = []
  try {
    await blobClient.writeTo(ctx, name, expected.length, {
      write: (buffer, cb) => {
        chunks.push(buffer)
        cb()
      },
      end: (cb) => {
        cb()
      }
    })
  } catch (err: any) {
    ctx.warn('failed to download blob for verification', { name, err })
    return 'mismatch'
  }
  return Buffer.concat(chunks).equals(expected) ? 'ok' : 'mismatch'
}

/**
 * @public
 * Collect account-domain objects (person/socialId) from backup snapshots for a domain.
 * Shared by restore and account-remap analysis.
 */
export async function collectAccountObjects (
  ctx: MeasureContext,
  storage: BackupStorage,
  snapshots: BackupSnapshot[],
  domain: Domain,
  date: number
): Promise<any[]> {
  const changeset = await loadDigest(ctx, storage, snapshots, domain, date)
  if (changeset.size === 0) return []

  const rsnapshots = Array.from(snapshots).reverse()
  const processed = new Set<string>()
  const collectedObjects: any[] = []

  for (const s of rsnapshots) {
    const d = s.domains[domain]
    if (d === undefined) continue

    for (const sf of d.storage ?? []) {
      const readStream = await storage.load(sf)
      const ex = extract()

      const endPromise = new Promise<void>((resolve, reject) => {
        ex.on('entry', (headers, stream, next) => {
          const name = headers.name ?? ''
          if (name.endsWith('.json')) {
            const objKey = name.substring(0, name.length - 5)
            if (changeset.has(objKey) && !processed.has(objKey)) {
              const chunks: Buffer[] = []
              stream.on('data', (chunk) => {
                chunks.push(chunk)
              })
              stream.on('end', () => {
                try {
                  processed.add(objKey)
                  collectedObjects.push(JSON.parse(Buffer.concat(chunks).toString()))
                } catch (err) {
                  ctx.warn('failed to parse account object', { name, err })
                }
                next()
              })
            } else {
              next()
            }
          } else {
            next()
          }
          stream.resume()
        })
        const onError = (err: any): void => {
          readStream.destroy()
          reject(err)
        }
        ex.on('finish', () => {
          resolve()
        })
        ex.on('error', onError)
        const unzip = createGunzip({ level: defaultLevel })
        readStream.on('end', () => {
          readStream.destroy()
        })
        readStream.on('error', onError)
        unzip.on('error', onError)
        readStream.pipe(unzip)
        unzip.pipe(ex)
      })

      await endPromise
    }
  }

  return collectedObjects
}

/**
 * @public
 * Restore state of DB to specified point.
 *
 * Recheck mean we download and compare every document on our side and if found difference upload changed version to server.
 */
export async function restore (
  ctx: MeasureContext,
  pipeline: Pipeline,
  wsIds: WorkspaceIds,
  storage: BackupStorage,
  accountDb: AccountDB | undefined,
  opt: {
    date: number
    merge?: boolean
    parallel?: number
    recheck?: boolean
    include?: Set<string>
    skip?: Set<string>
    progress?: (progress: number) => Promise<void>
    cleanIndexState?: boolean
    historyFile?: string
    verifyBlobs?: boolean
    // Do not upload anything. For blobs: download from storage and compare content, report missing/mismatch.
    verifyOnly?: boolean
  }
): Promise<boolean> {
  const infoFile = 'backup.json.gz'
  const workspaceId = wsIds.uuid
  if (!(await storage.exists(infoFile))) {
    ctx.error('file not pressent', { file: infoFile })
    throw new Error(`${infoFile} should present to restore`)
  }
  const backupInfo: BackupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
  let snapshots = backupInfo.snapshots
  if (opt.date !== -1) {
    const bk = backupInfo.snapshots.findIndex((it) => it.date === opt.date)
    if (bk === -1) {
      ctx.error('could not restore to', { date: opt.date, file: infoFile, workspaceId })
      throw new Error(`${infoFile} could not restore to ${opt.date}. Snapshot is missing.`)
    }
    snapshots = backupInfo.snapshots.slice(0, bk + 1)
  } else {
    opt.date = snapshots[snapshots.length - 1].date
  }

  backupInfo.domainHashes ??= {}
  ctx.info('restore to ', { id: opt.date, date: new Date(opt.date).toDateString() })
  const rsnapshots = Array.from(snapshots).reverse()

  // Collect all possible domains
  const domains = new Set<Domain>()
  for (const s of snapshots) {
    Object.keys(s.domains).forEach((it) => domains.add(it as Domain))
  }

  const historyFile: Record<string, string> =
    opt.historyFile !== undefined && existsSync(opt.historyFile)
      ? JSON.parse(readFileSync(opt.historyFile).toString())
      : {}

  const blobClient = new BlobClient(pipeline.context.storageAdapter ?? createDummyStorageAdapter(), wsIds)
  console.log('connected')

  // verifyOnly report counters (full counts in verifyStats; ids capped to bound memory)
  const verifyIdCap = 1000
  const verifyStats = { ok: 0, missing: 0, mismatch: 0 }
  const verifyMissing: string[] = []
  const verifyMismatch: string[] = []

  // We need to find empty domains and clean them.
  const allDomains = pipeline.context.hierarchy.domains()
  for (const d of allDomains) {
    domains.add(d)
  }

  // We do not backup elastic anymore
  domains.delete('fulltext-blob' as Domain)
  domains.delete('doc-index-state' as Domain)

  let uploadedMb = 0
  let uploaded = 0

  let domainProgress = 0

  const connection = pipeline.context.lowLevelStorage as LowLevelStorage
  const ops = new BackupClientOps(connection)

  const printUploaded = (msg: string, size: number): void => {
    if (size == null) {
      return
    }
    uploaded += size
    const newDownloadedMb = Math.round(uploaded / (1024 * 1024))
    const newId = Math.round(newDownloadedMb / 10)
    if (uploadedMb !== newId) {
      uploadedMb = newId
      ctx.info('Uploaded', {
        msg,
        written: newDownloadedMb,
        workspace: workspaceId
      })
    }
  }

  async function processDomain (c: Domain): Promise<void> {
    const dHash = await connection.getDomainHash(ctx, c)
    if (backupInfo.domainHashes[c] === dHash) {
      ctx.info('no changes in domain', { domain: c })
      return
    }
    const changeset = (await loadDigest(ctx, storage, snapshots, c, opt.date)) as Map<Ref<Doc>, string>
    // We need to load full changeset from server
    const serverChangeset = new Map<Ref<Doc>, string>()

    const oldUsed = process.memoryUsage().heapUsed
    try {
      global.gc?.()
    } catch (err) {}
    const mm = { old: oldUsed / (1024 * 1024), current: process.memoryUsage().heapUsed / (1024 * 1024) }
    if (mm.old > mm.current + mm.current / 10) {
      ctx.info('memory-stats', mm)
    }

    let idx: number | undefined
    let loaded = 0
    let el = 0
    let chunks = 0
    let dataSize = 0
    try {
      while (true) {
        if (opt.progress !== undefined) {
          await opt.progress?.(domainProgress)
        }
        const st = Date.now()
        const it = await ops.loadChunk(ctx, c, idx)
        dataSize += it.size ?? 0
        chunks++

        idx = it.idx
        el += Date.now() - st

        for (const { id, hash } of it.docs) {
          serverChangeset.set(id as Ref<Doc>, hash)
          loaded++
        }

        if (el > 2500) {
          ctx.info('loaded from server', { domain: c, loaded, el, chunks, workspace: workspaceId })
          el = 0
          chunks = 0
        }
        if (it.finished) {
          break
        }
      }
    } finally {
      if (idx !== undefined) {
        await ops.closeChunk(ctx, idx)
      }
    }
    ctx.info('loaded', {
      domain: c,
      loaded,
      workspace: workspaceId,
      dataSize: Math.round((dataSize / (1024 * 1024)) * 100) / 100
    })
    ctx.info('\tcompare documents', {
      size: changeset.size,
      serverSize: serverChangeset.size,
      workspace: workspaceId
    })

    // Let's find difference
    const docsToAdd = new Map(
      opt.recheck === true || opt.verifyOnly === true // recheck/verifyOnly process all documents.
        ? Array.from(changeset.entries())
        : Array.from(changeset.entries()).filter(
            ([it]) =>
              !serverChangeset.has(it) ||
              (serverChangeset.has(it) && doTrimHash(serverChangeset.get(it)) !== doTrimHash(changeset.get(it)))
          )
    )
    const docsToRemove = Array.from(serverChangeset.keys()).filter((it) => !changeset.has(it))

    const docs: Doc[] = []
    const blobs = new Map<string, { doc: Doc | undefined, buffer: Buffer | undefined }>()
    let sendSize = 0
    let totalSend = 0
    async function sendChunk (doc: Doc | undefined, len: number): Promise<void> {
      if (opt.progress !== undefined) {
        await opt.progress?.(domainProgress)
      }
      if (doc !== undefined) {
        docsToAdd.delete(doc._id)
        docs.push(doc)
      }
      sendSize = sendSize + len

      if (sendSize > dataUploadSize || (doc === undefined && docs.length > 0)) {
        let docsToSend = docs
        totalSend += docs.length
        ctx.info('upload-' + c, {
          docs: docs.length,
          totalSend,
          from: docsToAdd.size + totalSend,
          sendSize,
          workspace: workspaceId
        })
        // Correct docs without space
        for (const d of docs) {
          d.space ??= core.space.Workspace

          if (TxProcessor.isExtendsCUD(d._class)) {
            const tx = d as TxCUD<Doc>
            tx.objectSpace ??= core.space.Workspace
          }
        }

        if (opt.recheck === true) {
          // We need to download all documents and compare them.
          const serverDocs = toIdMap(
            await ops.loadDocs(
              ctx,
              c,
              docs.map((it) => it._id)
            )
          )
          docsToSend = docs.filter((doc) => {
            const serverDoc = serverDocs.get(doc._id)
            if (serverDoc !== undefined) {
              const { '%hash%': _h1, ...dData } = doc as any
              const { '%hash%': _h2, ...sData } = serverDoc as any

              return !deepEqual(dData, sData)
            }
            return true
          })
        }
        if (opt.verifyOnly !== true) {
          try {
            await ops.upload(ctx, c, docsToSend)
          } catch (err: any) {
            ctx.error('error during upload', { err, docs: JSON.stringify(docs) })
          }
        }

        docs.length = 0
        sendSize = 0
      }
      printUploaded('upload', len)
    }

    let processed = 0

    const blobUploader = new RateLimiter(10)

    for (const s of rsnapshots) {
      const d = s.domains[c]

      if (d !== undefined && docsToAdd.size > 0) {
        const sDigest = (await loadDigest(ctx, storage, [s], c)) as Map<Ref<Doc>, string>
        const requiredDocs = new Map(Array.from(sDigest.entries()).filter(([it]) => docsToAdd.has(it)))

        let lastSendTime = Date.now()
        async function sendBlob (blob: Blob, data: Buffer, next: (err?: any) => void): Promise<void> {
          await blobUploader.add(async () => {
            next()
            let needSend = true
            if (opt.historyFile !== undefined) {
              if (historyFile[blob._id] === blob.etag) {
                needSend = false
              }
            }

            if (opt.verifyOnly === true) {
              // No upload. Download existing blob and compare content.
              const res = await verifyBlobContent(ctx, blobClient, blob._id, data)
              verifyStats[res]++
              if (res === 'missing') {
                if (verifyMissing.length < verifyIdCap) verifyMissing.push(blob._id)
                ctx.warn('blob missing', { _id: blob._id, size: blob.size, workspace: wsIds.uuid })
              } else if (res === 'mismatch') {
                if (verifyMismatch.length < verifyIdCap) verifyMismatch.push(blob._id)
                ctx.warn('blob content mismatch', { _id: blob._id, size: blob.size, workspace: wsIds.uuid })
              }
            } else if (needSend) {
              try {
                await blobClient.upload(ctx, blob._id, blob.size, blob.contentType, data)
                if (opt.verifyBlobs === true) {
                  let res = await verifyBlobContent(ctx, blobClient, blob._id, data)
                  if (res !== 'ok') {
                    ctx.warn('blob content mismatch, re-uploading', { _id: blob._id, res, workspace: wsIds.uuid })
                    await blobClient.upload(ctx, blob._id, blob.size, blob.contentType, data)
                    res = await verifyBlobContent(ctx, blobClient, blob._id, data)
                    if (res !== 'ok') {
                      ctx.error('blob content mismatch after re-upload', { _id: blob._id, res, workspace: wsIds.uuid })
                    }
                  }
                }
                if (opt.historyFile !== undefined) {
                  historyFile[blob._id] = blob.etag
                  if (totalSend % 1000 === 0) {
                    writeFileSync(opt.historyFile, JSON.stringify(historyFile, undefined, 2))
                  }
                }
              } catch (err: any) {
                ctx.warn('failed to upload blob', { _id: blob._id, err, workspace: wsIds.uuid })
                next(err)
              }
            }
            docsToAdd.delete(blob._id)
            requiredDocs.delete(blob._id)
            printUploaded('upload:' + blobUploader.processingQueue.size, data.length)
            totalSend++
            if (lastSendTime < Date.now()) {
              lastSendTime = Date.now() + 2500

              ctx.info('upload ' + c, {
                totalSend,
                from: docsToAdd.size + totalSend,
                sendSize,
                workspace: workspaceId
              })
            }
          })
        }

        if (requiredDocs.size > 0) {
          ctx.info('updating', { domain: c, requiredDocs: requiredDocs.size, workspace: workspaceId })
          // We have required documents here.
          for (const sf of d.storage ?? []) {
            if (docsToAdd.size === 0) {
              break
            }
            ctx.info('processing', { storageFile: sf, processed, workspace: wsIds.url })
            try {
              const readStream = await storage.load(sf)
              const ex = extract()

              ex.on('entry', (headers, stream, next) => {
                const name = headers.name ?? ''
                processed++
                // We found blob data
                if (requiredDocs.has(name as Ref<Doc>)) {
                  const chunks: Buffer[] = []
                  stream.on('data', (chunk) => {
                    chunks.push(chunk)
                  })
                  stream.on('end', () => {
                    const bf = Buffer.concat(chunks)
                    const d = blobs.get(name)
                    if (d === undefined) {
                      blobs.set(name, { doc: undefined, buffer: bf })
                      next()
                    } else {
                      blobs.delete(name)
                      const blob = d?.doc as Blob
                      ;(blob as any)['%hash%'] = changeset.get(blob._id)
                      let sz = blob.size
                      if (Number.isNaN(sz) || sz !== bf.length) {
                        sz = bf.length
                      }
                      void sendBlob(blob, bf, next).catch((err) => {
                        ctx.error('failed to send blob', { message: err.message })
                      })
                    }
                  })
                } else if (name.endsWith('.json') && requiredDocs.has(name.substring(0, name.length - 5) as Ref<Doc>)) {
                  const chunks: Buffer[] = []
                  const bname = name.substring(0, name.length - 5)
                  stream.on('data', (chunk) => {
                    chunks.push(chunk)
                  })
                  stream.on('end', () => {
                    const bf = Buffer.concat(chunks)
                    let doc: Doc
                    try {
                      doc = JSON.parse(bf.toString()) as Doc
                    } catch (err) {
                      ctx.warn('failed to parse blob metadata', { name, workspace: wsIds.url, err })
                      next()
                      return
                    }

                    if (doc._class === core.class.Blob || doc._class === 'core:class:BlobData') {
                      const data = migradeBlobData(doc as Blob, changeset.get(doc._id) as string)
                      const d = blobs.get(bname) ?? (data !== '' ? Buffer.from(data, 'base64') : undefined)
                      if (d === undefined) {
                        blobs.set(bname, { doc, buffer: undefined })
                        next()
                      } else {
                        blobs.delete(bname)
                        const blob = doc as Blob
                        const buff = d instanceof Buffer ? d : d.buffer
                        if (buff != null) {
                          void sendBlob(blob, d instanceof Buffer ? d : (d.buffer as Buffer), next).catch((err) => {
                            ctx.error('failed to send blob', { err })
                          })
                        } else {
                          next()
                        }
                      }
                    } else {
                      ;(doc as any)['%hash%'] = changeset.get(doc._id)
                      void sendChunk(doc, bf.length)
                        .finally(() => {
                          requiredDocs.delete(doc._id)
                          next()
                        })
                        .catch((err) => {
                          ctx.error('failed to sendChunk', { err })
                          next(err)
                        })
                    }
                  })
                } else {
                  next()
                }
                stream.resume() // just auto drain the stream
              })

              await blobUploader.waitProcessing()

              const unzip = createGunzip({ level: defaultLevel })

              const endPromise = new Promise((resolve, reject) => {
                const onError = (err: any): void => {
                  readStream.destroy()
                  reject(err)
                }
                ex.on('finish', () => {
                  resolve(null)
                })
                ex.on('error', onError)

                readStream.on('end', () => {
                  readStream.destroy()
                })
                readStream.on('error', onError)
                unzip.on('error', onError)
                readStream.pipe(unzip)
                unzip.pipe(ex)
              })

              await endPromise
            } catch (err: any) {
              ctx.error('failed to processing', { storageFile: sf, processed, workspace: wsIds.url })
            }
          }
        }
      }
    }

    await sendChunk(undefined, 0)
    async function performCleanOfDomain (docsToRemove: Ref<Doc>[], c: Domain): Promise<void> {
      ctx.info('cleanup', { toRemove: docsToRemove.length, workspace: workspaceId, domain: c })
      while (docsToRemove.length > 0) {
        const part = docsToRemove.splice(0, 10000)
        try {
          await ops.clean(ctx, c, part)
        } catch (err: any) {
          ctx.error('failed to clean, will retry', { error: err.message, workspaceId })
          docsToRemove.push(...part)
        }
      }
    }
    if (c !== DOMAIN_BLOB) {
      // Clean domain documents if not blob
      if (docsToRemove.length > 0 && opt.merge !== true) {
        await performCleanOfDomain(docsToRemove, c)
      }
    }
  }

  async function processAccountDomain (c: Domain): Promise<void> {
    if (accountDb === undefined) {
      ctx.info('skipping account domain restore, no accountDb provided', { domain: c })
      return
    }

    const isPersonDomain = c === toAccountDomain('person')

    const collectedObjects = await collectAccountObjects(ctx, storage, snapshots, c, opt.date)
    if (collectedObjects.length === 0) {
      ctx.info('no account domain data to restore', { domain: c })
      return
    }

    ctx.info('collected account objects', { domain: c, count: collectedObjects.length, workspace: workspaceId })

    if (isPersonDomain) {
      await restorePersons(ctx, accountDb, collectedObjects as GlobalPerson[], wsIds)
    } else {
      await restoreSocialIds(ctx, accountDb, collectedObjects as SocialId[])
    }
  }

  const limiter = new RateLimiter(opt.parallel ?? 1)

  try {
    let i = 0
    for (const c of domains) {
      if (opt.progress !== undefined) {
        await opt.progress?.(domainProgress)
      }
      if (opt.include !== undefined && !opt.include.has(c)) {
        continue
      }
      if (opt.skip?.has(c) === true) {
        continue
      }
      await limiter.add(async () => {
        ctx.info('processing domain', { domain: c, workspaceId })
        let retry = 5
        let delay = 1
        while (retry > 0) {
          retry--
          try {
            const doProcessDomain = isAccountDomain(c) ? processAccountDomain : processDomain
            await doProcessDomain(c)
            if (delay > 1) {
              ctx.warn('retry-success', { retry, delay, workspaceId })
            }
            break
          } catch (err: any) {
            ctx.error('failed to process domain', { err, domain: c, workspaceId })
            if (retry !== 0) {
              ctx.warn('cool-down to retry', { delay, domain: c, workspaceId })
              await new Promise((resolve) => setTimeout(resolve, delay * 1000))
              delay++
            }
          }
        }
        domainProgress = Math.round(i / domains.size) * 100
        i++
      })
    }
    await limiter.waitProcessing()
  } catch (err: any) {
    Analytics.handleError(err)
    return false
  }
  if (opt.verifyOnly === true) {
    ctx.info('blob verification report', {
      workspace: workspaceId,
      ok: verifyStats.ok,
      missing: verifyStats.missing,
      mismatch: verifyStats.mismatch
    })
    if (verifyMissing.length > 0) {
      ctx.warn('missing blobs', { count: verifyMissing.length, ids: verifyMissing.slice(0, 100) })
    }
    if (verifyMismatch.length > 0) {
      ctx.warn('mismatch blobs', { count: verifyMismatch.length, ids: verifyMismatch.slice(0, 100) })
    }
  }
  return true
}

const accountBatchSize = 500

async function restorePersons (
  ctx: MeasureContext,
  accountDb: AccountDB,
  persons: GlobalPerson[],
  wsIds: WorkspaceIds
): Promise<void> {
  const chunks = chunkArray(persons, accountBatchSize)
  for (const chunk of chunks) {
    const uuids = chunk.map((p) => p.uuid)

    // Find existing persons
    const existingPersons = await accountDb.person.find({ uuid: { $in: uuids } })
    const existingPersonUuids = new Set(existingPersons.map((p) => p.uuid))

    // Insert missing persons
    const personsToInsert = chunk
      .filter((p) => !existingPersonUuids.has(p.uuid))
      .map((it) => {
        const { '%hash%': _, ...data } = it as any
        // firstName/lastName are NOT NULL in account_db; backup may carry nulls
        return { ...data, firstName: data.firstName ?? '', lastName: data.lastName ?? '' }
      })
    if (personsToInsert.length > 0) {
      await accountDb.person.insertMany(personsToInsert)
      ctx.info('inserted persons', { count: personsToInsert.length })
    }

    // Find existing accounts
    const accountUuids = uuids as AccountUuid[]
    const existingAccounts = await accountDb.account.find({ uuid: { $in: accountUuids } })
    const existingAccountUuids = new Set(existingAccounts.map((a) => a.uuid))

    // Insert missing accounts (without password)
    const accountsToInsert: Account[] = chunk
      .filter((p) => !existingAccountUuids.has(p.uuid as AccountUuid))
      .map((p) => ({ uuid: p.uuid as AccountUuid }))
    if (accountsToInsert.length > 0) {
      await accountDb.account.insertMany(accountsToInsert)
      ctx.info('inserted accounts', { count: accountsToInsert.length })
    }

    // Assign workspace to all accounts
    const workspaceRoles = new Map<AccountUuid, AccountRole>()
    for (const uuid of accountUuids) {
      const role = await accountDb.getWorkspaceRole(uuid, wsIds.uuid)
      if (role !== null) {
        workspaceRoles.set(uuid, role)
      }
    }

    const toAssign: [AccountUuid, typeof wsIds.uuid, AccountRole][] = accountUuids
      .filter((uuid) => !workspaceRoles.has(uuid))
      .map((uuid) => [uuid, wsIds.uuid, AccountRole.User])

    if (toAssign.length > 0) {
      await accountDb.batchAssignWorkspace(toAssign)
      ctx.info('assigned workspace to accounts', { count: toAssign.length, workspace: wsIds.uuid })
    }
  }
}

async function restoreSocialIds (ctx: MeasureContext, accountDb: AccountDB, socialIds: SocialId[]): Promise<void> {
  const chunks = chunkArray(socialIds, accountBatchSize)
  for (const chunk of chunks) {
    const ids = chunk.map((s) => s.key)

    // Find existing socialIds
    const existingSocialIds = await accountDb.socialId.find({ key: { $in: ids } })
    const existingIds = new Set(existingSocialIds.map((s) => s.key))

    // Insert missing socialIds
    const socialIdsToInsert: SocialId[] = chunk
      .filter((s) => !existingIds.has(s.key))
      .map((it) => {
        const { '%hash%': _1, key: _2, ...data } = it as any
        return data
      })
    if (socialIdsToInsert.length > 0) {
      // Orphan socialId (person removed in source) gets a stub person to satisfy social_id_person_fk.
      const refPersonUuids = Array.from(
        new Set(socialIdsToInsert.map((s) => s.personUuid).filter((u): u is PersonUuid => u != null))
      )
      if (refPersonUuids.length > 0) {
        const existingPersons = await accountDb.person.find({ uuid: { $in: refPersonUuids } })
        const existingPersonUuids = new Set(existingPersons.map((p) => p.uuid))
        const stubPersons = refPersonUuids
          .filter((u) => !existingPersonUuids.has(u))
          .map((uuid) => ({ uuid, firstName: '', lastName: '' }))
        if (stubPersons.length > 0) {
          await accountDb.person.insertMany(stubPersons)
          ctx.warn('inserted stub persons for orphan socialIds', { count: stubPersons.length })
        }
      }
      await accountDb.socialId.insertMany(socialIdsToInsert)
      ctx.info('inserted socialIds', { count: socialIdsToInsert.length })
    }
  }
}

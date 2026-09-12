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

import { type Person as GlobalPerson, type SocialId } from '@hcengineering/account'
import core, {
  Doc,
  Domain,
  DOMAIN_BLOB,
  MeasureContext,
  MeasureMetricsContext,
  Ref,
  type Blob
} from '@hcengineering/core'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { type EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { PassThrough, type Writable } from 'node:stream'
import { createGzip } from 'node:zlib'
import { join } from 'path'
import { extract, Pack, pack } from 'tar-stream'
import { createGunzip, gunzipSync, gzipSync } from 'zlib'
import { BackupStorage } from './storage'
import type {
  BackupDocId,
  BackupInfo,
  BackupResult,
  BackupSnapshot,
  BlobData,
  DomainData,
  Snapshot,
  SnapshotV6
} from './types'
export * from './storage'

const dataBlobSize = 250 * 1024 * 1024

const defaultLevel = 9

/**
 * Watches every stream of a pack pipeline from creation until it is closed. Attaching only at
 * close time leaves the whole document-writing window unguarded: an error there has no listener
 * and Node turns it into an unhandled 'error' event that kills the process.
 * @public
 */
export function watchStreamErrors (...streams: EventEmitter[]): Promise<never> {
  let fail: (err: any) => void = () => {}
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject
  })
  failed.catch(() => {}) // no unhandled rejection when the pack closes fine
  for (const s of streams) {
    s.on('error', fail)
  }
  return failed
}

/**
 * @public
 */
export async function backupList (storage: BackupStorage): Promise<void> {
  const infoFile = 'backup.json.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  const backupInfo: BackupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)
  for (const s of backupInfo.snapshots) {
    console.log('snapshot: id:', s.date, ' date:', new Date(s.date))
  }
}

/**
 * @public
 */
export async function backupRemoveLast (storage: BackupStorage, date: number): Promise<void> {
  const infoFile = 'backup.json.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  const backupInfo: BackupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)
  const old = backupInfo.snapshots.length
  backupInfo.snapshots = backupInfo.snapshots.filter((it) => it.date < date)
  if (old !== backupInfo.snapshots.length) {
    console.log('removed snapshots: id:', old - backupInfo.snapshots.length)

    await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
  }
}

/**
 * @public
 */
export async function backupSize (storage: BackupStorage): Promise<void> {
  const infoFile = 'backup.json.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  let size = 0

  const backupInfo: BackupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)
  const addFileSize = async (file: string | undefined | null): Promise<void> => {
    if (file != null && (await storage.exists(file))) {
      try {
        const fileSize = await storage.stat(file)
        console.log(file, fileSize)
        size += fileSize
      } catch (err: any) {
        console.error('failed to calculate size', { file, err })
      }
    }
  }

  // calculate data size for backup
  for (const sn of backupInfo.snapshots) {
    for (const [, d] of Object.entries(sn.domains)) {
      await addFileSize(d.snapshot)
      for (const snp of d.snapshots ?? []) {
        await addFileSize(snp)
      }
      for (const snp of d.storage ?? []) {
        await addFileSize(snp)
      }
    }
  }
  await addFileSize(infoFile)

  console.log('Backup size', size / (1024 * 1024), 'Mb')
}

/**
 * @public
 */
export async function backupDownload (storage: BackupStorage, storeIn: string, skipDomains: Set<string>): Promise<void> {
  const infoFile = 'backup.json.gz'
  const sizeFile = 'backup.size.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  let size = 0

  const backupInfo: BackupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)

  let sizeInfo: Record<string, number> = {}
  if (existsSync(join(storeIn, sizeFile))) {
    console.log('Parse size file')
    sizeInfo = JSON.parse(gunzipSync(new Uint8Array(readFileSync(join(storeIn, sizeFile)))).toString())
  }
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)

  const downloadFile = async (file: string | undefined | null, force: boolean = false): Promise<void> => {
    console.log('Checking file', file)
    if (file != null) {
      const target = join(storeIn, file)
      const dir = dirname(target)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const serverSize: number | undefined = sizeInfo[file] ?? (await storage.stat(file))
      if (serverSize !== sizeInfo[file]) {
        sizeInfo[file] = serverSize
        writeFileSync(
          join(storeIn, sizeFile),
          gzipSync(JSON.stringify(sizeInfo, undefined, 2), { level: defaultLevel })
        )
      }

      if (!existsSync(target) || force || (serverSize !== undefined && serverSize !== statSync(target).size)) {
        try {
          console.log('downloading', file, serverSize)
          const readStream = await storage.load(file)
          const outp = createWriteStream(target)

          readStream.pipe(outp)
          await new Promise<void>((resolve, reject) => {
            readStream.on('error', (err) => {
              console.error('failed to download file', { file, err })
              reject(err)
            })
            outp.on('error', (err) => {
              console.error('failed to write file', { file, err })
              reject(err)
            })
            outp.on('finish', () => {
              readStream.destroy()
              outp.close()
              resolve()
            })
            readStream.on('end', () => {
              outp.end()
            })
          })
          size += serverSize
        } catch (err: any) {
          console.error('failed to calculate size', { file, err })
        }
      }
    }
  }

  await downloadFile(infoFile, true)
  // calculate data size for backup
  for (const sn of backupInfo.snapshots) {
    for (const [k, d] of Object.entries(sn.domains)) {
      console.log('processing', sn.date, k)
      if (skipDomains.has(k)) {
        continue
      }
      await downloadFile(d.snapshot)
      for (const snp of d.snapshots ?? []) {
        await downloadFile(snp)
      }
      for (const snp of d.storage ?? []) {
        await downloadFile(snp)
      }
    }
  }

  console.log('Backup size', size / (1024 * 1024), 'Mb')
}

/**
 * @public
 */
export async function backupFind (
  storage: BackupStorage,
  id: Ref<Doc>,
  showAll: boolean,
  domain?: string
): Promise<void> {
  const infoFile = 'backup.json.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  const backupInfo: BackupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)

  const toolCtx = new MeasureMetricsContext('', {})

  const snapshots = backupInfo.snapshots
  const rnapshots = Array.from(backupInfo.snapshots).reverse()

  // Collect all possible domains
  const domains = new Set<Domain>()
  for (const s of snapshots) {
    Object.keys(s.domains).forEach((it) => domains.add(it as Domain))
  }

  for (const dd of domains) {
    if (domain !== undefined && dd !== domain) {
      continue
    }
    console.log('checking:', dd)
    const sDigest = await loadDigest(toolCtx, storage, snapshots, dd)
    if (sDigest.has(id)) {
      console.log('we found file')
      let found = false
      for (const sn of rnapshots) {
        const ssDigest = await loadDigest(toolCtx, storage, [sn], dd)
        if (!ssDigest.has(id)) {
          continue
        }
        const d = sn.domains[dd]
        if (found && !showAll) {
          break
        }
        for (const sf of d?.storage ?? []) {
          if (found && !showAll) {
            break
          }
          console.log('processing', sf)
          const readStream = await storage.load(sf)
          const ex = extract()
          ex.on('entry', (headers, stream, next) => {
            if (headers.name === id + '.json') {
              console.log('file found in:', sf)

              const chunks: Buffer[] = []
              stream.on('data', (chunk) => {
                chunks.push(chunk)
              })
              stream.on('end', () => {
                const bf = Buffer.concat(chunks)
                console.log('>>>>>>>>>>>')
                console.log(JSON.stringify(JSON.parse(bf.toString()), undefined, 2))
                console.log('>>>>>>>>>>>')
                next()
              })

              found = true
            } else {
              stream.resume() // auto drain for non-matching entries
              next() // continue to the next entry
            }
          })

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
            unzip.on('error', onError)
            readStream.on('error', onError)
          })

          readStream.on('end', () => {
            readStream.destroy()
          })
          readStream.pipe(unzip)
          unzip.pipe(ex)

          await endPromise
        }
      }
    }
  }
}

export function extendZero (value: number, count: number = 4): string {
  let idxName = `${value}`
  while (idxName.length < count) {
    idxName = '0' + idxName
  }
  return idxName
}

/**
 * Compacting backup into just one snapshot.
 * @public
 */
export async function compactBackup (
  ctx: MeasureContext,
  storage: BackupStorage,
  force: boolean = false,
  opt?: {
    blobLimit?: number // In megabytes
    skipContentTypes?: string[]
    msg?: Record<string, any>
  },
  recalculateDigest: boolean = false
): Promise<void> {
  console.log('starting backup compaction')

  const tmpRoot = mkdtempSync('huly')

  try {
    let backupInfo: BackupInfo

    // Version 0.6.2, format of digest file is changed to

    const infoFile = 'backup.json.gz'
    const blobInfoFile = 'blob-info.json.gz'

    if (await storage.exists(infoFile)) {
      backupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
    } else {
      ctx.info('No backup found', { ...(opt?.msg ?? {}) })
      return
    }
    if (backupInfo.version !== '0.6.2') {
      ctx.info('Invalid backup version', { ...(opt?.msg ?? {}) })
      return
    }

    if (backupInfo.snapshots.length < 1 && !force) {
      ctx.info('No need to compact', { ...(opt?.msg ?? {}) })
      return
    }

    // Find compacting backup or create new one
    const snapshot: BackupSnapshot = backupInfo.snapshots.find((it) => it.compacting === true) ?? {
      date: Date.now(),
      domains: {},
      compacting: true,
      stIndex: 0
    }

    let backupIndex = `${(backupInfo.snapshotsIndex ?? backupInfo.snapshots.length) + 1}`
    while (backupIndex.length < 6) {
      backupIndex = '0' + backupIndex
    }

    const domains: Domain[] = []
    for (const sn of backupInfo.snapshots) {
      for (const d of Object.keys(sn.domains)) {
        if (!domains.includes(d as Domain)) {
          domains.push(d as Domain)
        }
      }
    }
    const snapshotsToClean = backupInfo.snapshots.filter((it) => it.compacting !== true).reverse()
    backupInfo.snapshots.push(snapshot)

    const dirsToClean = new Set<string>()
    const filesToClean = new Set<string>()

    const cleanFiles = async (): Promise<void> => {
      if (filesToClean.size > 0) {
        for (const file of filesToClean) {
          try {
            await storage.delete(file)
          } catch (err: any) {
            // Ignore
          }
        }
        filesToClean.clear()
      }
    }

    for (const domain of domains) {
      ctx.info('compacting domain...', { domain, ...(opt?.msg ?? {}) })
      const getObjKey = getGetObjKey(domain)

      const processedChanges: Snapshot = {
        added: new Map(),
        updated: new Map(),
        removed: []
      }

      let changed = 0
      let snapshotIndex = 0
      const domainInfo: DomainData = {
        snapshot: undefined,
        snapshots: [],
        storage: [],
        added: 0,
        updated: 0,
        removed: 0
      }

      // Cumulative digest
      // Documents modified in compacting snapshots in case of restart
      const untouchedDigest = await loadDigest(ctx, storage, [snapshot], domain, undefined, opt?.msg)

      // We need to load snapshots from removed ones and
      const digest = await loadDigest(ctx, storage, snapshotsToClean, domain, undefined, opt?.msg)

      // We remove all items we have in last part
      Array.from(untouchedDigest.keys()).forEach((it) => digest.delete(it))

      const digestAdded = new Map<BackupDocId, string>()

      let _pack: Pack | undefined
      let _packClose = async (): Promise<void> => {}
      let addedDocuments: () => number = () => 0

      let processed = 0

      let skipBlobs = 0
      let skipSize = 0

      let lastSkipPrint = 0

      const blobs = new Map<string, { doc: Doc | undefined, buffer: Buffer | undefined }>()

      async function pushDocs (doc: Doc | undefined, size: number, blobData: Record<Ref<Doc>, Buffer>): Promise<void> {
        if (doc == null) {
          return
        }
        changed += 1
        // Chunk data into small pieces
        // The size check 'addedDocuments() > dataBlobSize' is performed here, evaluating the archive's size
        // *before* the documents in the current 'docs' batch are added.
        // If the archive is, e.g., 49MB, this check passes. If the current 'docs' batch then adds 5MB,
        // the archive becomes 54MB. This oversized archive is closed only on the *next* call to pushDocs.
        const addedDocsValue = addedDocuments()
        if (addedDocsValue > dataBlobSize && _pack !== undefined) {
          await _packClose()

          if (changed > 0) {
            snapshot.domains[domain] = domainInfo
            domainInfo.added += processedChanges.added.size
            domainInfo.updated += processedChanges.updated.size
            domainInfo.removed += processedChanges.removed.length

            snapshotIndex++
            const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${extendZero(snapshotIndex)}.snp.gz`)
            domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
            await writeChanges(storage, snapshotFile, processedChanges)

            processedChanges.added.clear()
            processedChanges.removed = []
            processedChanges.updated.clear()
            await storage.writeFile(
              infoFile,
              gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel })
            )

            await cleanFiles()
          }
        }
        if (_pack === undefined) {
          _pack = pack()
          snapshot.stIndex++
          const storageFile = join(
            backupIndex,
            `${domain}-data-${snapshot.date}-${extendZero(snapshot.stIndex)}.tar.gz`
          )
          ctx.info('storing from domain', { domain, storageFile, ...(opt?.msg ?? {}) })
          domainInfo.storage = [...(domainInfo.storage ?? []), storageFile]

          const tmpFile = join(tmpRoot, basename(storageFile) + '.tmp')
          const tempFile = createWriteStream(tmpFile)

          const sizePass = new PassThrough()
          let sz = 0
          sizePass._transform = (chunk, encoding, cb) => {
            // No transformation, just pass through data
            sz += chunk.length
            sizePass.push(chunk)
            cb()
          }

          sizePass.pipe(tempFile)

          const storageZip = createGzip({ level: defaultLevel, memLevel: 9 })
          addedDocuments = () => sz

          _pack.pipe(storageZip)
          storageZip.pipe(sizePass)

          const packFailed = watchStreamErrors(_pack, storageZip, sizePass, tempFile)

          _packClose = async () => {
            _packClose = async () => {} // tempFile emits 'close' once, a second call would hang
            ctx.info('finalize pack(compact)', { storageFile, size: sz, ...(opt?.msg ?? {}) })
            await Promise.race([
              new Promise<void>((resolve) => {
                tempFile.on('close', () => {
                  resolve()
                })
                _pack?.finalize()
              }),
              packFailed
            ])
            // We need to upload file to storage
            ctx.info('>>>> upload pack(compact)', { storageFile, size: sz, ...(opt?.msg ?? {}) })
            await storage.writeFile(storageFile, createReadStream(tmpFile))
            await rm(tmpFile)

            _pack = undefined
          }
        }

        const docKey = getObjKey(doc as any)

        // Move processed document to processedChanges
        processedChanges.added.set(docKey, digestAdded.get(docKey) ?? '')

        if (doc._class === core.class.Blob || doc._class === 'core:class:BlobData') {
          const blob = doc as Blob | BlobData

          const data = blobData[blob._id]
          const descrJson = JSON.stringify(doc)
          await new Promise<void>((resolve, reject) => {
            _pack?.entry({ name: doc._id + '.json' }, descrJson, function (err) {
              if (err != null) reject(err)
              resolve()
            })
          })
          await new Promise<void>((resolve, reject) => {
            _pack?.entry({ name: doc._id }, data, function (err) {
              if (err != null) reject(err)
              resolve()
            })
          })
        } else {
          const data = JSON.stringify(doc)
          await new Promise<void>((resolve, reject) => {
            _pack?.entry({ name: docKey + '.json' }, data, function (err) {
              if (err != null) reject(err)
              resolve()
            })
          })
        }
      }
      async function sendChunk (
        key: string,
        doc: Doc | undefined,
        len: number,
        blobData: Record<Ref<Doc>, Buffer>
      ): Promise<void> {
        if (doc !== undefined) {
          if (domain === DOMAIN_BLOB) {
            if (opt?.skipContentTypes !== undefined || (opt?.blobLimit ?? 0) > 0) {
              // Check if we need to skip blob
              const blob = doc as Blob

              const newSkipPrint = Math.round(skipSize / (1024 * 1024 * 100))
              if (newSkipPrint !== lastSkipPrint) {
                lastSkipPrint = newSkipPrint
                ctx.info('skipping blobs', {
                  skipBlobs,
                  size: Math.round(skipSize / (1024 * 1024)),
                  ...(opt?.msg ?? {})
                })
              }
              const bsize = blob.size == null || Number.isNaN(blob.size) || !Number.isInteger(blob.size) ? 0 : blob.size

              if (opt?.skipContentTypes?.some((it) => (blob.contentType ?? '').includes(it)) === true) {
                skipBlobs++
                skipSize += bsize
                digest.delete(doc._id)
                return
              }
              if (opt?.blobLimit !== undefined && opt?.blobLimit > 0 && bsize > opt.blobLimit * 1024 * 1024) {
                skipBlobs++
                skipSize += bsize
                digest.delete(doc._id)
                return
              }
            }
          }
          const hash = digest.get(key)
          digest.delete(key)
          digestAdded.set(key, hash ?? '')
          await pushDocs(doc, len, blobData)
        }
      }

      for (const s of snapshotsToClean) {
        const d = s.domains[domain]

        if (d !== undefined && digest.size > 0) {
          ctx.info('checking-domain', { domain, name: s.date, ...(opt?.msg ?? {}) })
          const sDigest = await loadDigest(ctx, storage, [s], domain)
          const requiredDocs = new Map(Array.from(sDigest.entries()).filter(([it]) => digest.has(it)))
          if (requiredDocs.size > 0) {
            ctx.info('updating', { domain, requiredDocs: requiredDocs.size, ...(opt?.msg ?? {}) })
            // We have required documents here.
            for (const sf of d.storage ?? []) {
              if (digest.size === 0) {
                break
              }
              try {
                const sfStart = Date.now()
                let sfEntries = 0
                let sfMatched = 0
                let lastLog = Date.now()
                ctx.info('processing', {
                  sf,
                  processed,
                  requiredLeft: requiredDocs.size,
                  digestLeft: digest.size,
                  ...(opt?.msg ?? {})
                })

                const readStream = await storage.load(sf)
                const ex = extract()

                ex.on('entry', (headers, stream, next) => {
                  const name = headers.name ?? ''
                  processed++
                  sfEntries++
                  const isMatch =
                    requiredDocs.has(name) ||
                    (name.endsWith('.json') && requiredDocs.has(name.substring(0, name.length - 5)))
                  if (isMatch) sfMatched++
                  if (Date.now() - lastLog > 10000) {
                    lastLog = Date.now()
                    ctx.info('processing progress', {
                      sf,
                      sfEntries,
                      sfMatched,
                      requiredLeft: requiredDocs.size,
                      digestLeft: digest.size,
                      elapsedMs: Date.now() - sfStart,
                      ...(opt?.msg ?? {})
                    })
                  }
                  // We found blob data
                  if (requiredDocs.has(name)) {
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
                        const doc = d.doc as Blob | undefined // d here is from the outer scope, known not to be undefined.
                        if (doc == null) {
                          const errorMsg = `CompactBackup: Metadata (doc) missing in blobs entry for data file ${name}`
                          ctx.error(errorMsg, { name })
                          next() // Just skip
                          return
                        }
                        void sendChunk(doc._id, doc, bf.length, { [doc._id]: bf })
                          .finally(() => {
                            requiredDocs.delete(doc._id)
                            next()
                          })
                          .catch((err) => {
                            next(err)
                          })
                      }
                    })
                  } else if (name.endsWith('.json') && requiredDocs.has(name.substring(0, name.length - 5))) {
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
                      } catch (err: any) {
                        console.error(err)
                        next()
                        return
                      }
                      if (doc._class === core.class.Blob || doc._class === 'core:class:BlobData') {
                        const d = blobs.get(bname)
                        if (d === undefined) {
                          blobs.set(bname, { doc, buffer: undefined })
                          next()
                        } else {
                          blobs.delete(bname)
                          ;(doc as any)['%hash%'] = digest.get(doc._id)
                          void sendChunk(doc._id, doc, bf.length, { [doc._id]: d?.buffer as Buffer })
                            .finally(() => {
                              requiredDocs.delete(doc._id)
                              next()
                            })
                            .catch((err) => {
                              ctx.error('failed to sendChunk', { err })
                              next(err)
                            })
                        }
                      } else {
                        const key = getObjKey(doc as any)
                        ;(doc as any)['%hash%'] = digest.get(key)
                        void sendChunk(key, doc, bf.length, {})
                          .finally(() => {
                            requiredDocs.delete(key)
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

                const unzip = createGunzip({ level: defaultLevel })
                const endPromise = new Promise((resolve, reject) => {
                  ex.on('finish', () => {
                    resolve(null)
                  })
                  const onError = (err: any): void => {
                    ctx.error('error during processing', { snapshot, err, ...(opt?.msg ?? {}) })
                    readStream.destroy()
                    reject(err)
                  }
                  readStream.on('error', onError)
                  unzip.on('error', onError)
                  ex.on('error', onError)
                })

                readStream.on('end', () => {
                  readStream.destroy()
                })
                readStream.pipe(unzip)
                unzip.pipe(ex)

                await endPromise
                ctx.info('processed file', {
                  sf,
                  sfEntries,
                  sfMatched,
                  requiredLeft: requiredDocs.size,
                  digestLeft: digest.size,
                  elapsedMs: Date.now() - sfStart,
                  ...(opt?.msg ?? {})
                })
              } catch (err: any) {
                ctx.error('error processing', err)
              }
            }
          } else {
            ctx.info('domain had no changes', { domain, ...(opt?.msg ?? {}) })
          }
        }
        if (d !== undefined) {
          for (const sf of d.storage ?? []) {
            ctx.info('removing', { sf, ...(opt?.msg ?? {}) })
            dirsToClean.add(dirname(sf))
            filesToClean.add(sf)
          }
          for (const sf of d.snapshots ?? []) {
            ctx.info('removing', { sf, ...(opt?.msg ?? {}) })
            dirsToClean.add(dirname(sf))
            filesToClean.add(sf)
          }
          if (d.snapshot !== undefined) {
            dirsToClean.add(dirname(d.snapshot))
            filesToClean.add(d.snapshot)
          }
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete s.domains[domain]
        }
      }

      if (changed > 0) {
        domainInfo.added += processedChanges.added.size
        domainInfo.updated += processedChanges.updated.size
        domainInfo.removed += processedChanges.removed.length

        if (domainInfo.added + domainInfo.updated + domainInfo.removed > 0) {
          snapshot.domains[domain] = domainInfo

          snapshotIndex++
          const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${extendZero(snapshotIndex)}.snp.gz`)
          domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
          await writeChanges(storage, snapshotFile, processedChanges)
        }

        processedChanges.added.clear()
        processedChanges.removed = []
        processedChanges.updated.clear()
        await _packClose()
      }
      // This will allow to retry in case of critical error.
      await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
    }
    snapshot.compacting = false
    backupInfo.snapshots = [snapshot]
    backupInfo.snapshotsIndex = (backupInfo.snapshotsIndex ?? backupInfo.snapshots.length) + 1
    await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))

    await cleanFiles()
    for (const dir of dirsToClean) {
      try {
        await storage.deleteRecursive(dir)
      } catch (err: any) {
        // Ignore
      }
    }
    const result: BackupResult = {
      result: true,
      dataSize: 0,
      blobsSize: 0,
      backupSize: 0
    }
    if (recalculateDigest) {
      await rebuildSizeInfo(storage, [], ctx, result, backupInfo, infoFile, blobInfoFile)
    }
  } catch (err: any) {
    ctx.error(err, { ...(opt?.msg ?? {}) })
  } finally {
    await rm(tmpRoot, { recursive: true })
    ctx.info('end compacting', { ...(opt?.msg ?? {}) })
  }
}

export * from './service'
export function migradeBlobData (blob: Blob, etag: string): string {
  if (blob._class === 'core:class:BlobData') {
    const bd = blob as unknown as BlobData
    blob.contentType = blob.contentType ?? bd.type
    blob.etag = etag
    blob._class = core.class.Blob
    delete (blob as any).type
    const result = (blob as any).base64Data
    delete (blob as any).base64Data
    return result
  }
  return ''
}

/**
 * Will check backup integrity, and in case of some missing resources, will update digest files, so next backup will backup all missing parts.
 * @public
 */
export async function checkBackupIntegrity (
  ctx: MeasureContext,
  storage: BackupStorage,
  msg?: Record<string, any>
): Promise<void> {
  ctx.info('check backup integrity', { ...(msg ?? {}) })
  try {
    let backupInfo: BackupInfo

    // Version 0.6.2, format of digest file is changed to

    const infoFile = 'backup.json.gz'
    const blobInfoFile = 'blob-info.json.gz'

    if (await storage.exists(infoFile)) {
      backupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
    } else {
      ctx.info('No backup found', { ...(msg ?? {}) })
      return
    }
    if (backupInfo.version !== '0.6.2') {
      ctx.info('Invalid backup version', { ...(msg ?? {}) })
      return
    }

    const recheckSizes: string[] = []

    const domains: Domain[] = []
    for (const sn of backupInfo.snapshots) {
      for (const d of Object.keys(sn.domains)) {
        if (!domains.includes(d as Domain)) {
          domains.push(d as Domain)
        }
      }
    }
    let modified = false

    for (const domain of domains) {
      ctx.info('checking domain...', { domain, ...(msg ?? {}) })
      const { modified: mm, modifiedFiles } = await verifyDigest(ctx, storage, backupInfo.snapshots, domain)
      if (mm) {
        recheckSizes.push(...modifiedFiles)
        modified = true
      }
    }
    backupInfo.migrations ??= {}
    if (backupInfo.migrations.zeroCheckSize !== true) {
      backupInfo.migrations.zeroCheckSize = true
      modified = true
    }
    if (modified) {
      await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
    }

    const bresult: BackupResult = {
      backupSize: 0,
      blobsSize: 0,
      dataSize: 0,
      result: true
    }
    await rebuildSizeInfo(storage, recheckSizes, ctx, bresult, backupInfo, infoFile, blobInfoFile)
  } catch (err: any) {
    ctx.error(err, { ...(msg ?? {}) })
  } finally {
    ctx.info('end checking integrity', { ...(msg ?? {}) })
  }
}

export function doTrimHash (s: string | undefined): string | undefined {
  if (s == null) {
    return undefined
  }
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, s.length - 1)
  }
  return s
}

export async function loadDigest (
  ctx: MeasureContext,
  storage: BackupStorage,
  snapshots: BackupSnapshot[],
  domain: Domain,
  date?: number,
  msg?: Record<string, any>
): Promise<Map<BackupDocId, string>> {
  const result = new Map<BackupDocId, string>()
  for (const s of snapshots) {
    const d = s.domains[domain]

    // Load old JSON snapshot
    if (d?.snapshot !== undefined) {
      try {
        const dChanges: SnapshotV6 = JSON.parse(
          gunzipSync(new Uint8Array(await storage.loadFile(d.snapshot))).toString()
        )
        for (const [k, v] of Object.entries(dChanges.added)) {
          result.set(k, v)
        }
        for (const [k, v] of Object.entries(dChanges.updated)) {
          result.set(k, v)
        }
        for (const d of dChanges.removed) {
          result.delete(d)
        }
      } catch (err: any) {
        ctx.warn('failed to load digest', { snapshot: d.snapshot, ...(msg ?? {}) })
      }
    }
    for (const snapshot of d?.snapshots ?? []) {
      try {
        const dataBlob = gunzipSync(new Uint8Array(await storage.loadFile(snapshot)))
          .toString()
          .split('\n')
        const addedCount = parseInt(dataBlob.shift() ?? '0')
        const added = dataBlob.splice(0, addedCount)
        for (const it of added) {
          const [k, v] = it.split(';')
          result.set(k, v)
        }

        const updatedCount = parseInt(dataBlob.shift() ?? '0')
        const updated = dataBlob.splice(0, updatedCount)
        for (const it of updated) {
          const [k, v] = it.split(';')
          result.set(k, v)
        }

        const removedCount = parseInt(dataBlob.shift() ?? '0')
        const removed = dataBlob.splice(0, removedCount)
        for (const k of removed) {
          result.delete(k)
        }
      } catch (err: any) {
        ctx.warn('digest is broken', { domain, err: err.message, snapshot, ...(msg ?? {}) })
      }
    }
    // Stop if stop date is matched and provided
    if (date !== undefined && date === s.date) {
      break
    }
  }
  return result
}
export async function verifyDigest (
  ctx: MeasureContext,
  storage: BackupStorage,
  snapshots: BackupSnapshot[],
  domain: Domain
): Promise<{ modified: boolean, modifiedFiles: string[] }> {
  ctx = ctx.newChild('verify digest', { domain, count: snapshots.length })
  ctx.info('verify-digest', { domain, count: snapshots.length })
  let modified = false
  const modifiedFiles: string[] = []
  for (const s of snapshots) {
    const d = s.domains[domain]
    if (d === undefined) {
      continue
    }

    const storageToRemove = new Set<string>()
    // We need to verify storage has all necessary resources
    ctx.info('checking', { domain })
    // We have required documents here.
    const validDocs = new Set<Ref<Doc>>()
    const zeroEntres = new Set<Ref<Doc>>()

    for (const sf of d.storage ?? []) {
      const blobs = new Map<string, { doc: Doc | undefined, buffer: Buffer | undefined }>()
      try {
        ctx.info('checking storage', { sf })
        const readStream = await storage.load(sf)
        const ex = extract()

        ex.on('entry', (headers, stream, next) => {
          const name = headers.name ?? ''
          // We found blob data
          if (name.endsWith('.json')) {
            const chunks: Buffer[] = []
            const bname = name.substring(0, name.length - 5)
            stream.on('data', (chunk) => {
              chunks.push(chunk)
            })
            stream.on('end', () => {
              try {
                const bf = Buffer.concat(chunks)
                const doc = JSON.parse(bf.toString()) as Doc
                if (doc._class === core.class.Blob || doc._class === 'core:class:BlobData') {
                  const data = migradeBlobData(doc as Blob, '')
                  const d = blobs.get(bname) ?? (data !== '' ? Buffer.from(data, 'base64') : undefined)
                  if (d === undefined) {
                    blobs.set(bname, { doc, buffer: undefined })
                  } else {
                    blobs.delete(bname)
                  }
                }
                validDocs.add(bname as Ref<Doc>)
              } catch (err: any) {
                // If not a json, skip
              }
              next()
            })
          } else {
            if (headers.size === 0) {
              zeroEntres.add(name as any)
            }
            next()
          }
          stream.resume() // just auto drain the stream
        })

        const unzip = createGunzip({ level: defaultLevel })
        const endPromise = new Promise((resolve, reject) => {
          readStream.on('error', (err) => {
            console.error(err)
            reject(err)
          })
          ex.on('finish', () => {
            resolve(null)
          })
          const onBroken = (err: any): void => {
            ctx.error('error during reading of', { sf, err })
            modified = true
            storageToRemove.add(sf)
            readStream.destroy()
            resolve(null)
          }
          unzip.on('error', onBroken)
          ex.on('error', onBroken)
        })

        readStream.on('end', () => {
          readStream.destroy()
        })
        readStream.pipe(unzip)
        unzip.pipe(ex)

        await endPromise
      } catch (err: any) {
        ctx.error('error during reading of', { sf, err })
        // In case of invalid archive, we need to
        // We need to remove broken storage file
        modified = true
        storageToRemove.add(sf)
      }
    }

    // Clear zero files, they potentially wrong downloaded.
    for (const zz of zeroEntres.values()) {
      validDocs.delete(zz)
    }
    if (storageToRemove.size > 0) {
      modified = true
      d.storage = (d.storage ?? []).filter((it) => !storageToRemove.has(it))
      modifiedFiles.push(...Array.from(storageToRemove))
      for (const sf of storageToRemove) {
        await storage.delete(sf)
      }
    }
    let mfiles: string[] = []
    ;({ modified, modifiedFiles: mfiles } = await updateDigest(d, ctx, storage, validDocs, modified, domain))
    modifiedFiles.push(...mfiles)
  }
  ctx.end()
  return { modified, modifiedFiles }
}

export async function updateDigest (
  d: DomainData,
  ctx: MeasureContext<any>,
  storage: BackupStorage,
  validDocs: Set<Ref<Doc>>,
  modified: boolean,
  domain: Domain
): Promise<{ modified: boolean, modifiedFiles: string[] }> {
  const digestToRemove = new Set<string>()
  const modifiedFiles: string[] = []
  for (const snapshot of d?.snapshots ?? []) {
    try {
      ctx.info('checking', { snapshot })
      const changes: Snapshot = {
        added: new Map(),
        removed: [],
        updated: new Map()
      }
      let lmodified = false
      try {
        const dataBlob = gunzipSync(new Uint8Array(await storage.loadFile(snapshot)))
          .toString()
          .split('\n')
        const addedCount = parseInt(dataBlob.shift() ?? '0')
        const added = dataBlob.splice(0, addedCount)
        for (const it of added) {
          const [k, v] = it.split(';')
          if (validDocs.has(k as any)) {
            changes.added.set(k, v)
          } else {
            lmodified = true
          }
        }

        const updatedCount = parseInt(dataBlob.shift() ?? '0')
        const updated = dataBlob.splice(0, updatedCount)
        for (const it of updated) {
          const [k, v] = it.split(';')
          if (validDocs.has(k as any)) {
            changes.updated.set(k, v)
          } else {
            lmodified = true
          }
        }

        const removedCount = parseInt(dataBlob.shift() ?? '0')
        const removed = dataBlob.splice(0, removedCount)
        changes.removed = removed
        if (addedCount === 0 && removedCount === 0 && updatedCount === 0) {
          // Empty digest, need to clean
          digestToRemove.add(snapshot)
          lmodified = true
        }
      } catch (err: any) {
        ctx.warn('failed during processing of snapshot file, it will be skipped', { snapshot })
        digestToRemove.add(snapshot)
        modified = true
      }

      if (lmodified) {
        modified = true
        if (digestToRemove.has(snapshot)) {
          await storage.delete(snapshot) // No need for digest, lets' remove it
        } else {
          // Store changes without missing files
          await writeChanges(storage, snapshot, changes)
        }
      }
    } catch (err: any) {
      digestToRemove.add(snapshot)
      modifiedFiles.push(snapshot)
      ctx.warn('digest is broken', { domain, err: err.message, snapshot })
      modified = true
    }
  }
  d.snapshots = (d.snapshots ?? []).filter((it) => !digestToRemove.has(it))
  return { modified, modifiedFiles }
}

async function write (chunk: any, stream: Writable): Promise<void> {
  let needDrain = false
  await new Promise((resolve, reject) => {
    needDrain = !stream.write(chunk, (err) => {
      if (err != null) {
        reject(err)
      } else {
        resolve(null)
      }
    })
  })
  if (needDrain) {
    // No 'error' listener here on purpose: it is once() per call and would pile up on the stream.
    // writeChanges races every await against a single shared error promise instead.
    await new Promise((resolve) => stream.once('drain', resolve))
  }
}

export async function writeChanges (storage: BackupStorage, snapshot: string, changes: Snapshot): Promise<void> {
  const snapshotWritable = await storage.write(snapshot)
  const writable = createGzip({ level: defaultLevel })
  writable.pipe(snapshotWritable)

  // Destination errors are not propagated back to gzip, race them against every await.
  let fail: (err: any) => void = () => {}
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject
  })
  failed.catch(() => {}) // no unhandled rejection if writeChanges completes fine
  // Listeners stay for the lifetime of the streams: detaching them would turn a late
  // destination error into an unhandled 'error' event.
  snapshotWritable.on('error', fail)
  writable.on('error', fail)

  const step = async (p: Promise<unknown>): Promise<void> => {
    await Promise.race([p, failed])
  }

  // Write size
  await step(write(`${changes.added.size}\n`, writable))
  for (const [k, v] of changes.added.entries()) {
    await step(write(`${k};${v}\n`, writable))
  }
  await step(write(`${changes.updated.size}\n`, writable))
  for (const [k, v] of changes.updated.entries()) {
    await step(write(`${k};${v}\n`, writable))
  }
  await step(write(`${changes.removed.length}\n`, writable))
  for (const k of changes.removed) {
    await step(write(`${k}\n`, writable))
  }
  writable.end()
  // Wait for the destination, not just for gzip: flush() returns while compressed data is still in flight.
  await step(
    new Promise((resolve) => {
      snapshotWritable.on('finish', resolve)
    })
  )
}

export async function verifyDocsFromSnapshot (
  ctx: MeasureContext,
  domain: Domain,
  d: DomainData,
  s: BackupSnapshot,
  storage: BackupStorage,
  digest: Map<BackupDocId, string>,
  verify: (docs: Doc[]) => Promise<void>,
  chunkSize: number
): Promise<{ modified: boolean, modifiedFiles: string[] }> {
  let result: Doc[] = []
  const storageToRemove = new Set<string>()
  const validDocs = new Set<Ref<Doc>>()
  const modifiedFiles: string[] = []
  if (digest.size > 0) {
    const sDigest = await loadDigest(ctx, storage, [s], domain)
    const requiredDocs = new Map(Array.from(sDigest.entries()).filter(([it]) => digest.has(it)))

    if (requiredDocs.size > 0) {
      ctx.info('updating (verifyDocsFromSnapshot)', {
        domain,
        requiredDocs: requiredDocs.size,
        storageFiles: (d.storage ?? []).length
      })
      // We have required documents here.
      for (const sf of d.storage ?? []) {
        if (digest.size === 0) {
          break
        }
        try {
          const sfStart = Date.now()
          let sfEntries = 0
          let sfMatched = 0
          let lastLog = Date.now()
          ctx.info('verify processing', {
            sf,
            requiredLeft: requiredDocs.size,
            digestLeft: digest.size,
            domain
          })
          const readStream = await storage.load(sf)
          const ex = extract()

          ex.on('entry', (headers, stream, next) => {
            const name = headers.name ?? ''
            sfEntries++
            if (Date.now() - lastLog > 10000) {
              lastLog = Date.now()
              ctx.info('verify progress', {
                sf,
                sfEntries,
                sfMatched,
                requiredLeft: requiredDocs.size,
                digestLeft: digest.size,
                pendingResult: result.length,
                elapsedMs: Date.now() - sfStart,
                domain
              })
            }
            // We found blob data
            const rdoc = name.substring(0, name.length - 5) as Ref<Doc>
            if (name.endsWith('.json') && requiredDocs.has(rdoc)) {
              sfMatched++
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
                  // Do not failure on this.
                  next()
                  return
                }

                if (doc._class === core.class.Blob || doc._class === 'core:class:BlobData') {
                  // Skip blob
                  validDocs.add(bname as Ref<Doc>)
                } else {
                  ;(doc as any)['%hash%'] = digest.get(rdoc)
                  digest.delete(rdoc)
                  result.push(doc)
                  validDocs.add(bname as Ref<Doc>)

                  if (result.length > chunkSize) {
                    void verify(result)
                      .then(() => {
                        result = []
                        next()
                      })
                      .catch((err) => {
                        ctx.error('failed to verify', { err })
                        next(err)
                      })
                  } else {
                    next()
                  }
                }
              })
            } else {
              next()
            }
            stream.resume() // just auto drain the stream
          })

          const unzip = createGunzip({ level: defaultLevel })

          const endPromise = new Promise((resolve, reject) => {
            const onError = (err: any): void => {
              readStream.destroy()
              storageToRemove.add(sf)
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
          if (result.length > 0) {
            await verify(result)
          }
          ctx.info('verify processed file', {
            sf,
            sfEntries,
            sfMatched,
            requiredLeft: requiredDocs.size,
            digestLeft: digest.size,
            elapsedMs: Date.now() - sfStart,
            domain
          })
        } catch (err: any) {
          storageToRemove.add(sf)
          ctx.error('failed to processing', { storageFile: sf })
        }
      }
    }
  }
  let modified = false
  if (storageToRemove.size > 0) {
    modifiedFiles.push(...Array.from(storageToRemove))
    d.storage = (d.storage ?? []).filter((it) => !storageToRemove.has(it))
    for (const sf of storageToRemove) {
      await storage.delete(sf)
    }
    modified = true
  }
  let smodifiedFiles: string[] = []
  ;({ modified, modifiedFiles: smodifiedFiles } = await updateDigest(d, ctx, storage, validDocs, modified, domain))
  modifiedFiles.push(...smodifiedFiles)
  return { modified, modifiedFiles }
}

export async function rebuildSizeInfo (
  storage: BackupStorage,
  recheckSizes: string[],
  ctx: MeasureContext<any>,
  result: BackupResult,
  backupInfo: BackupInfo,
  infoFile: string,
  blobInfoFile: string
): Promise<void> {
  const sizeFile = 'backup.size.gz'

  let sizeInfo: Record<string, number> = {}

  if (await storage.exists(sizeFile)) {
    sizeInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(sizeFile))).toString())
  }
  let processed = 0

  for (const file of recheckSizes) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete sizeInfo[file]
  }

  const addFileSize = async (file: string | undefined | null, force: boolean = false): Promise<void> => {
    if (file != null) {
      try {
        const sz = sizeInfo[file]
        const fileSize = force ? await storage.stat(file) : (sz ?? (await storage.stat(file)))
        if (sz === undefined) {
          sizeInfo[file] = fileSize
          processed++
          if (processed % 10 === 0) {
            ctx.info('Calculate size processed', { processed, size: Math.round(result.backupSize / (1024 * 1024)) })
          }
        }
        result.backupSize += fileSize
      } catch (err: any) {
        ctx.error('failed to calculate size', { file, err })
      }
    }
  }

  // calculate data size for backup
  for (const sn of backupInfo.snapshots) {
    for (const [, d] of Object.entries(sn.domains)) {
      await addFileSize(d.snapshot)
      for (const snp of d.snapshots ?? []) {
        await addFileSize(snp)
      }
      for (const snp of d.storage ?? []) {
        await addFileSize(snp)
      }
    }
  }
  await addFileSize(infoFile, true)
  await addFileSize(blobInfoFile, true)

  await storage.writeFile(sizeFile, gzipSync(JSON.stringify(sizeInfo, undefined, 2), { level: defaultLevel }))
}

export function chunkArray<T> (array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize))
  }
  return chunks
}

// Using sha1 as we don't need security critical but faster hash
export function getObjectHash (obj: Record<string, any>): string {
  const h = createHash('sha1')
  h.update(JSON.stringify(obj))
  return h.digest('hex')
}

const accountPrefix = 'account.'

export function toAccountDomain (domain: string): Domain {
  return `${accountPrefix}${domain}` as Domain
}

export function isAccountDomain (domain: Domain): boolean {
  return domain.startsWith(accountPrefix)
}

export function getGetObjKey (domain: Domain): GetObjKeyFn {
  if (isAccountDomain(domain)) {
    if (domain === toAccountDomain('person')) {
      return getAccountPersonObjKey
    } else if (domain === toAccountDomain('socialId')) {
      return getAccountSocialIdObjKey
    }
  }
  return getDocObjKey
}

type GetObjKeyFn = (doc: any) => BackupDocId

function getDocObjKey (doc: Doc): BackupDocId {
  return doc._id
}

function getAccountPersonObjKey (doc: GlobalPerson): BackupDocId {
  return doc.uuid
}

function getAccountSocialIdObjKey (doc: SocialId): BackupDocId {
  return doc._id
}

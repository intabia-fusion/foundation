//
// Copyright © 2023 Hardcore Engineering Inc.
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
/* eslint-disable @typescript-eslint/no-unused-vars */
import { getAccountDB } from '@hcengineering/account'
import calendar from '@hcengineering/calendar'
import chunter, { type ChatMessage } from '@hcengineering/chunter'
import { loadCollabYdoc, saveCollabYdoc, yDocToBuffer } from '@hcengineering/collaboration'
import contact from '@hcengineering/contact'
import core, {
  type ArrOf,
  type BackupClient,
  type Class,
  ClassifierKind,
  type CollaborativeDoc,
  type Client as CoreClient,
  DOMAIN_BENCHMARK,
  DOMAIN_MIGRATION,
  DOMAIN_MODEL,
  DOMAIN_STATUS,
  DOMAIN_TX,
  type Doc,
  type DocumentUpdate,
  type Domain,
  type Hierarchy,
  type Markup,
  type MeasureContext,
  type MigrationState,
  type Ref,
  type RefTo,
  type RelatedDocument,
  SortingOrder,
  type Status,
  type StatusCategory,
  type Tx,
  type TxCUD,
  type TxCreateDoc,
  type TxMixin,
  TxOperations,
  TxProcessor,
  type TxRemoveDoc,
  type TxUpdateDoc,
  type WorkspaceUuid,
  type WorkspaceDataId,
  type WorkspaceIds,
  generateId,
  getObjectValue,
  toIdMap,
  updateAttribute,
  platformNow,
  platformNowDiff
} from '@hcengineering/core'
import activity, { DOMAIN_ACTIVITY } from '@hcengineering/model-activity'
import { DOMAIN_SPACE } from '@hcengineering/model-core'
import recruitModel, { defaultApplicantStatuses } from '@hcengineering/model-recruit'
import recruit, { type Applicant, type Vacancy } from '@hcengineering/recruit'
import { getTransactorEndpoint } from '@hcengineering/server-client'
import { type StorageAdapter } from '@hcengineering/server-core'
import { generateToken } from '@hcengineering/server-token'
import { connect } from '@hcengineering/server-tool'
import tags, { type TagCategory, type TagElement, type TagReference } from '@hcengineering/tags'
import task, { type ProjectType, type Task, type TaskType } from '@hcengineering/task'
// import { updateYDocContent } from '@hcengineering/text-ydoc'
import tracker from '@hcengineering/tracker'
import { deepEqual } from 'fast-equals'
import { type Db } from 'mongodb'

export async function fixMinioBW (
  ctx: MeasureContext,
  wsIds: WorkspaceIds,
  storageService: StorageAdapter
): Promise<void> {
  console.log('try clean bw miniature for ', wsIds)
  const from = new Date(new Date().setDate(new Date().getDate() - 7)).getTime()
  const list = await storageService.listStream(ctx, wsIds)
  let removed = 0
  try {
    while (true) {
      const objs = await list.next()
      if (objs.length === 0) {
        break
      }
      for (const obj of objs) {
        if (obj.modifiedOn < from) continue
        if ((obj._id as string).includes('%preview%')) {
          await storageService.remove(ctx, wsIds, [obj._id])
          removed++
          if (removed % 100 === 0) {
            console.log('removed: ', removed)
          }
        }
      }
    }
  } finally {
    await list.close()
  }
  console.log('FINISH, removed: ', removed)
}

export async function cleanRemovedTransactions (workspaceId: WorkspaceUuid, transactorUrl: string): Promise<void> {
  const connection = (await connect(transactorUrl, workspaceId, undefined, {
    mode: 'backup'
  })) as unknown as CoreClient & BackupClient
  try {
    let count = 0
    while (true) {
      const removedDocs = await connection.findAll(core.class.TxRemoveDoc, {}, { limit: 1000 })
      if (removedDocs.length === 0) {
        break
      }

      const toRemove = await connection.findAll(core.class.TxCUD, {
        objectId: { $in: removedDocs.map((it) => it.objectId) }
      })
      await connection.clean(
        DOMAIN_TX,
        toRemove.map((it) => it._id)
      )

      count += toRemove.length
      console.log('processed', count)
    }

    console.log('total docs with remove', count)
  } catch (err: any) {
    console.trace(err)
  } finally {
    await connection.close()
  }
}

export async function optimizeModel (workspaceId: WorkspaceUuid, transactorUrl: string): Promise<void> {
  const connection = (await connect(transactorUrl, workspaceId, undefined, {
    mode: 'backup',
    model: 'upgrade'
  })) as unknown as CoreClient & BackupClient
  try {
    let count = 0

    const model = connection.getModel()

    const updateTransactions = await connection.findAll(
      core.class.TxUpdateDoc,
      {
        objectSpace: core.space.Model,
        _class: core.class.TxUpdateDoc
      },
      { sort: { _id: SortingOrder.Ascending, modifiedOn: SortingOrder.Ascending }, limit: 5000 }
    )

    const toRemove: Ref<Doc>[] = []

    let i = 0
    for (const tx of updateTransactions) {
      try {
        const doc = model.findObject(tx.objectId)
        if (doc === undefined) {
          // Document is removed, we could remove update transaction at all
          toRemove.push(tx._id)
          console.log('marking update tx to remove', tx)
          continue
        }
        const opt: any = { ...tx.operations }
        const adoc = doc as any

        let uDoc: any = {}

        // Find next update operations for same doc
        for (const ops of updateTransactions.slice(i + 1).filter((it) => it.objectId === tx.objectId)) {
          uDoc = { ...uDoc, ...ops.operations }
        }

        for (const [k, v] of Object.entries(opt)) {
          // If value is same as in document or we have more transactions with same value updated.
          if (!k.startsWith('$') && (!deepEqual(adoc[k], v) || uDoc[k] !== undefined)) {
            // Current value is not we modify
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete opt[k]
          }
        }
        if (Object.keys(opt).length === 0) {
          // No operations pending, remove update tx.
          toRemove.push(tx._id)
          console.log('marking update tx to remove, since not real update is performed', tx)
        }
      } finally {
        i++
      }
    }

    await connection.clean(DOMAIN_TX, toRemove)

    count += toRemove.length
    console.log('processed', count)

    console.log('total docs with remove', count)
  } catch (err: any) {
    console.trace(err)
  } finally {
    await connection.close()
  }
}
export async function cleanArchivedSpaces (workspaceId: WorkspaceUuid, transactorUrl: string): Promise<void> {
  const connection = (await connect(transactorUrl, workspaceId, undefined, {
    mode: 'backup'
  })) as unknown as CoreClient & BackupClient
  try {
    const count = 0
    const ops = new TxOperations(connection, core.account.System)
    while (true) {
      const spaces = await connection.findAll(core.class.Space, { archived: true }, { limit: 1000 })
      if (spaces.length === 0) {
        break
      }

      const h = connection.getHierarchy()
      const withDomain = h
        .getDescendants(core.class.Doc)
        .filter((it) => h.findDomain(it) !== undefined)
        .filter((it) => !h.isMixin(it))
      for (const c of withDomain) {
        while (true) {
          const docs = await connection.findAll(c, { space: { $in: spaces.map((it) => it._id) } })
          if (docs.length === 0) {
            break
          }
          console.log('removing:', c, docs.length)
          for (const d of docs) {
            await ops.remove(d)
          }
        }
      }
      for (const s of spaces) {
        await ops.remove(s)
      }
    }

    console.log('total docs with remove', count)
  } catch (err: any) {
    console.trace(err)
  } finally {
    await connection.close()
  }
}

export async function fixCommentDoubleIdCreate (workspaceId: WorkspaceUuid, transactorUrl: string): Promise<void> {
  const connection = (await connect(transactorUrl, workspaceId, undefined, {
    mode: 'backup'
  })) as unknown as CoreClient & BackupClient
  try {
    const commentTxes = await connection.findAll(core.class.TxCreateDoc, {
      objectClass: chunter.class.ChatMessage
    })
    const commentTxesRemoved = await connection.findAll(core.class.TxRemoveDoc, {
      objectClass: chunter.class.ChatMessage
    })
    const removed = new Map(commentTxesRemoved.map((it) => [it.objectId, it]))
    // Do not checked removed
    const objSet = new Set<Ref<Doc>>()
    const oldValue = new Map<Ref<Doc>, string>()
    for (const c of commentTxes) {
      const cid = c.objectId
      if (removed.has(cid)) {
        continue
      }
      const has = objSet.has(cid)
      objSet.add(cid)
      if (has) {
        // We have found duplicate one, let's rename it.
        const doc = TxProcessor.createDoc2Doc<ChatMessage>(c as unknown as TxCreateDoc<ChatMessage>)
        if (doc.message !== '' && doc.message.trim() !== '<p></p>') {
          await connection.clean(DOMAIN_TX, [c._id])
          if (oldValue.get(cid) === doc.message.trim()) {
            console.log('delete tx', cid, doc.message)
          } else {
            oldValue.set(doc._id, doc.message)
            console.log('renaming', cid, doc.message)
            // Remove previous transaction.
            c.objectId = generateId()
            doc._id = c.objectId as Ref<ChatMessage>
            await connection.upload(DOMAIN_TX, [c])
            // Also we need to create snapsot
            await connection.upload(DOMAIN_ACTIVITY, [doc])
          }
        }
      }
    }
  } catch (err: any) {
    console.trace(err)
  } finally {
    await connection.close()
  }
}

const DOMAIN_TAGS = 'tags' as Domain

function groupBy<T extends Doc> (docs: T[], key: string): Record<any, T[]> {
  return docs.reduce((storage: Record<string, T[]>, item: T) => {
    const group = getObjectValue(key, item) ?? undefined

    storage[group] = storage[group] ?? []
    storage[group].push(item)

    return storage
  }, {})
}

export async function removeDuplicateIds (
  ctx: MeasureContext,
  mongodbUri: string,
  storageAdapter: StorageAdapter,
  accountsUrl: string,
  initWorkspacesStr: string
): Promise<void> {
  // TODO: FIXME
  throw new Error('Not implemented')
  // const state = 'REMOVE_DUPLICATE_IDS'
  // const [accountsDb, closeAccountsDb] = await getAccountDB(mongodbUri)
  // const mongoClient = getMongoClient(mongodbUri)
  // const _client = await mongoClient.getClient()
  // // disable spaces while change hardocded ids
  // const skippedDomains: string[] = [DOMAIN_DOC_INDEX_STATE, DOMAIN_BENCHMARK, DOMAIN_TX, DOMAIN_SPACE]
  // try {
  //   const workspaces = await listWorkspacesRaw(accountsDb)
  //   workspaces.sort((a, b) => b.status.lastVisit - a.status.lastVisit)
  //   const initWorkspaces = initWorkspacesStr.split(';')
  //   const initWS = workspaces.filter((p) => initWorkspaces.includes(p.uuid))
  //   const ids = new Map<string, RelatedDocument[]>()
  //   for (const workspace of initWS) {
  //     const db = getWorkspaceMongoDB(_client, workspace.dataId)

  //     const txex = await db.collection(DOMAIN_TX).find<TxCUD<Doc>>({}).toArray()
  //     const txesArr = []
  //     for (const obj of txex) {
  //       if (obj.objectSpace === core.space.Model) {
  //         continue
  //       }
  //       txesArr.push({ _id: obj._id, _class: obj._class })
  //     }
  //     txesArr.filter((it, idx, array) => array.findIndex((pt) => pt._id === it._id) === idx)
  //     ids.set(DOMAIN_TX, txesArr)

  //     const colls = await db.collections()
  //     for (const coll of colls) {
  //       if (skippedDomains.includes(coll.collectionName)) continue
  //       const arr = ids.get(coll.collectionName) ?? []
  //       const data = await coll.find<RelatedDocument>({}, { projection: { _id: 1, _class: 1 } }).toArray()
  //       for (const obj of data) {
  //         arr.push(obj)
  //       }
  //       ids.set(coll.collectionName, arr)
  //     }

  //     const arr = ids.get(DOMAIN_MODEL) ?? []
  //     const data = await db
  //       .collection(DOMAIN_TX)
  //       .find<TxCUD<Doc>>(
  //       { objectSpace: core.space.Model },
  //       { projection: { objectId: 1, objectClass: 1, modifiedBy: 1 } }
  //     )
  //       .toArray()
  //     for (const obj of data) {
  //       if (obj.modifiedBy === core.account.ConfigUser || obj.modifiedBy === core.account.System) {
  //         continue
  //       }
  //       if (obj.objectId === core.account.ConfigUser || obj.objectId === core.account.System) continue
  //       arr.push({ _id: obj.objectId, _class: obj.objectClass })
  //     }
  //     arr.filter((it, idx, array) => array.findIndex((pt) => pt._id === it._id) === idx)
  //     ids.set(DOMAIN_MODEL, arr)
  //   }

  //   for (let index = 0; index < workspaces.length; index++) {
  //     const workspace = workspaces[index]
  //     // we should skip init workspace first time, for case if something went wrong
  //     if (initWorkspaces.includes(workspace.uuid)) continue

  //     ctx.info(`Processing workspace ${workspace.name ?? workspace.url ?? workspace.uuid}`)
  //     const workspaceId = workspace.uuid
  //     const wsDataId = workspace.dataId ?? workspaceId
  //     const db = getWorkspaceMongoDB(_client, workspace.dataId)
  //     const plugins = [workspace.uuid]
  //     if (workspace.dataId != null) {
  //       plugins.push(workspace.dataId)
  //     }

  //     const check = await db.collection(DOMAIN_MIGRATION).findOne({ state, plugin: { $in: plugins } })
  //     if (check != null) continue

  //     const endpoint = await getTransactorEndpoint(generateToken(systemAccountUuid, workspaceId, { service: 'tool' }))
  //     const wsClient = (await connect(endpoint, workspaceId, undefined, {
  //       model: 'upgrade'
  //     })) as CoreClient & BackupClient
  //     for (const set of ids) {
  //       if (set[1].length === 0) continue
  //       for (const doc of set[1]) {
  //         await updateId(ctx, wsClient, db, storageAdapter, wsDataId, doc)
  //       }
  //     }
  //     await wsClient.sendForceClose()
  //     await wsClient.close()
  //     await db.collection<MigrationState>(DOMAIN_MIGRATION).insertOne({
  //       _id: generateId(),
  //       state,
  //       plugin: workspace.uuid,
  //       space: core.space.Configuration,
  //       modifiedOn: Date.now(),
  //       modifiedBy: core.account.System,
  //       _class: core.class.MigrationState
  //     })
  //     ctx.info(`Done ${index} / ${workspaces.length - initWorkspaces.length}`)
  //   }
  // } catch (err: any) {
  //   console.trace(err)
  // } finally {
  //   mongoClient.close()
  //   closeAccountsDb()
  // }
}

// async function update<T extends Doc> (h: Hierarchy, db: Db, doc: T, update: DocumentUpdate<T>): Promise<void> {
//   await db
//     .collection(h.getDomain(doc._class))
//     .updateOne({ _id: doc._id }, { $set: { ...update, '%hash%': Date.now().toString(16) } })
// }

// async function updateId (
//   ctx: MeasureContext,
//   client: CoreClient & BackupClient,
//   db: Db,
//   storage: StorageAdapter,
//   workspaceId: WorkspaceDataId,
//   docRef: RelatedDocument
// ): Promise<void> {
//   const h = client.getHierarchy()
//   const txop = new TxOperations(client, core.account.System)
//   try {
//     // chech the doc exists
//     const doc = await client.findOne(docRef._class, { _id: docRef._id })
//     if (doc === undefined) return
//     const domain = h.getDomain(doc._class)
//     const newId = generateId()

//     // update txes
//     await db
//       .collection(DOMAIN_TX)
//       .updateMany({ objectId: doc._id }, { $set: { objectId: newId, '%hash%': Date.now().toString(16) } })

//     // update nested txes
//     await db
//       .collection(DOMAIN_TX)
//       .updateMany({ 'tx.objectId': doc._id }, { $set: { 'tx.objectId': newId, '%hash%': Date.now().toString(16) } })


//     // update backlinks
//     const backlinks = await client.findAll(activity.class.ActivityReference, { attachedTo: doc._id })
//     for (const backlink of backlinks) {
//       const contentDoc = await client.findOne(backlink.attachedDocClass ?? backlink.srcDocClass, {
//         _id: backlink.attachedDocId ?? backlink.srcDocClass
//       })
//       if (contentDoc !== undefined) {
//         const attrs = h.getAllAttributes(contentDoc._class)
//         for (const [attrName, attr] of attrs) {
//           if (attr.type._class === core.class.TypeMarkup) {
//             const markup = (contentDoc as any)[attrName] as Markup
//             const newMarkup = markup.replaceAll(doc._id, newId)
//             await update(h, db, contentDoc, { [attrName]: newMarkup })
//           } else if (attr.type._class === core.class.TypeCollaborativeDoc) {
//             const collabId = makeDocCollabId(contentDoc, attr.name)
//             await updateYDoc(ctx, collabId, storage, workspaceId, contentDoc, newId, doc)
//           }
//         }
//       }
//       await update(h, db, backlink, { attachedTo: newId, message: backlink.message.replaceAll(doc._id, newId) })
//     }

//     // blobs

//     await updateRefs(txop, newId, doc)

//     await updateArrRefs(txop, newId, doc)

//     if (domain !== DOMAIN_MODEL) {
//       const raw = await db.collection(domain).findOne({ _id: doc._id })
//       await db.collection(domain).insertOne({
//         ...raw,
//         _id: newId as any,
//         '%hash%': Date.now().toString(16)
//       })
//       await db.collection(domain).deleteOne({ _id: doc._id })
//     }
//   } catch (err: any) {
//     console.error('Error processing', docRef._id)
//   }
// }

// async function updateYDoc (
//   ctx: MeasureContext,
//   _id: CollaborativeDoc,
//   storage: StorageAdapter,
//   workspaceId: WorkspaceDataId,
//   contentDoc: Doc,
//   newId: Ref<Doc>,
//   doc: RelatedDocument
// ): Promise<void> {
//   try {
//     const ydoc = await loadCollabYdoc(ctx, storage, workspaceId, _id)
//     if (ydoc === undefined) {
//       ctx.error('document content not found', { document: contentDoc._id })
//       return
//     }
//     const buffer = yDocToBuffer(ydoc)

//     const updatedYDoc = updateYDocContent(buffer, (body: Record<string, any>) => {
//       const str = JSON.stringify(body)
//       const updated = str.replaceAll(doc._id, newId)
//       return JSON.parse(updated)
//     })

//     if (updatedYDoc !== undefined) {
//       await saveCollabYdoc(ctx, storage, workspaceId, _id, updatedYDoc)
//     }
//   } catch {
//     // do nothing, the collaborative doc does not sem to exist yet
//   }
// }

// async function updateRefs (client: TxOperations, newId: Ref<Doc>, doc: RelatedDocument): Promise<void> {
//   const h = client.getHierarchy()
//   const ancestors = h.getAncestors(doc._class)
//   const reftos = (await client.findAll(core.class.Attribute, { 'type._class': core.class.RefTo })).filter((it) => {
//     const to = it.type as RefTo<Doc>
//     return ancestors.includes(h.getBaseClass(to.to))
//   })
//   for (const attr of reftos) {
//     if (attr.name === '_id') {
//       continue
//     }
//     const descendants = h.getDescendants(attr.attributeOf)
//     for (const d of descendants) {
//       if (h.isDerived(d, core.class.BenchmarkDoc)) {
//         continue
//       }
//       if (h.isDerived(d, core.class.Tx)) {
//         continue
//       }
//       if (h.findDomain(d) !== undefined) {
//         while (true) {
//           const values = await client.findAll(d, { [attr.name]: doc._id }, { limit: 100 })
//           if (values.length === 0) {
//             break
//           }

//           const builder = client.apply(doc._id)
//           for (const v of values) {
//             await updateAttribute(builder, v, d, { key: attr.name, attr }, newId, true)
//           }
//           const modelTxes = builder.txes.filter((p) => p.objectSpace === core.space.Model)
//           builder.txes = builder.txes.filter((p) => p.objectSpace !== core.space.Model)
//           for (const modelTx of modelTxes) {
//             await client.tx(modelTx)
//           }
//           await builder.commit()
//         }
//       }
//     }
//   }
// }

// async function updateArrRefs (client: TxOperations, newId: Ref<Doc>, doc: RelatedDocument): Promise<void> {
//   const h = client.getHierarchy()
//   const ancestors = h.getAncestors(doc._class)
//   const arrs = await client.findAll(core.class.Attribute, { 'type._class': core.class.ArrOf })
//   for (const attr of arrs) {
//     if (attr.name === '_id') {
//       continue
//     }
//     const to = attr.type as ArrOf<Doc>
//     if (to.of._class !== core.class.RefTo) continue
//     const refto = to.of as RefTo<Doc>
//     if (ancestors.includes(h.getBaseClass(refto.to))) {
//       const descendants = h.getDescendants(attr.attributeOf)
//       for (const d of descendants) {
//         if (h.isDerived(d, core.class.BenchmarkDoc)) {
//           continue
//         }
//         if (h.isDerived(d, core.class.Tx)) {
//           continue
//         }
//         if (h.findDomain(d) !== undefined) {
//           while (true) {
//             const values = await client.findAll(attr.attributeOf, { [attr.name]: doc._id }, { limit: 100 })
//             if (values.length === 0) {
//               break
//             }
//             const builder = client.apply(doc._id)
//             for (const v of values) {
//               await updateAttribute(builder, v, d, { key: attr.name, attr }, newId, true)
//             }
//             const modelTxes = builder.txes.filter((p) => p.objectSpace === core.space.Model)
//             builder.txes = builder.txes.filter((p) => p.objectSpace !== core.space.Model)
//             for (const modelTx of modelTxes) {
//               await client.tx(modelTx)
//             }
//             await builder.commit()
//           }
//         }
//       }
//     }
//   }
// }

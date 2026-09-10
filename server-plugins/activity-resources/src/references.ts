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

import activity, { type ActivityReference, type UserMentionInfo } from '@hcengineering/activity'
import contact, { type Employee } from '@hcengineering/contact'
import core, {
  type Blob,
  type Class,
  type Data,
  type Doc,
  type Hierarchy,
  type Markup,
  type MeasureContext,
  type ModelDb,
  type Ref,
  type Space,
  type Tx,
  type TxCreateDoc,
  type TxCUD,
  TxFactory,
  TxProcessor,
  type TxRemoveDoc,
  type TxUpdateDoc,
  getClassCollaborators
} from '@hcengineering/core'
import notification from '@hcengineering/notification'
import { type StorageAdapter, type TriggerControl } from '@hcengineering/server-core'
import { areEqualJson, extractReferences, jsonToMarkup, markupToJSON } from '@hcengineering/text-core'
import { isCollaborativeType, isMarkupType } from './utils'
import { getAddCollaboratorsTxes } from '@hcengineering/server-contact'

export function isDocMentioned (doc: Ref<Doc>, content: string): boolean {
  const references = []

  const node = markupToJSON(content)
  references.push(...extractReferences(node))

  for (const ref of references) {
    if (ref.objectId === doc) {
      return true
    }
  }

  return false
}

async function getCreateReferencesTxes (
  ctx: MeasureContext,
  control: TriggerControl,
  storage: StorageAdapter,
  txFactory: TxFactory,
  createdDoc: Doc,
  srcDocId: Ref<Doc>,
  srcDocClass: Ref<Class<Doc>>,
  srcDocSpace: Ref<Space>
): Promise<Tx[]> {
  const attachedDocId = createdDoc._id
  const attachedDocClass = createdDoc._class

  const refs: Data<ActivityReference>[] = []
  const attributes = control.hierarchy.getAllAttributes(createdDoc._class)

  for (const attr of attributes.values()) {
    if (isMarkupType(attr.type._class)) {
      const content: string = (createdDoc as any)[attr.name]?.toString() ?? ''
      const attrReferences = getReferencesData(srcDocId, srcDocClass, attachedDocId, attachedDocClass, content)

      refs.push(...attrReferences)
    } else if (attr.type._class === core.class.TypeCollaborativeDoc) {
      const blobId = (createdDoc as any)[attr.name] as Ref<Blob>
      if (blobId != null && blobId !== '') {
        try {
          const buffer = await storage.read(ctx, control.workspace, blobId)
          const markup = Buffer.concat(buffer).toString()
          const attrReferences = getReferencesData(srcDocId, srcDocClass, attachedDocId, attachedDocClass, markup)
          refs.push(...attrReferences)
        } catch {
          // do nothing, the collaborative doc does not sem to exist yet
        }
      }
    }
  }

  const refSpace: Ref<Space> = control.hierarchy.isDerived(srcDocClass, core.class.Space)
    ? (srcDocId as Ref<Space>)
    : srcDocSpace

  return await getReferencesTxes(control, txFactory, refs, refSpace, [], [])
}

async function getUpdateReferencesTxes (
  ctx: MeasureContext,
  control: TriggerControl,
  storage: StorageAdapter,
  txFactory: TxFactory,
  updatedDoc: Doc,
  srcDocId: Ref<Doc>,
  srcDocClass: Ref<Class<Doc>>,
  srcDocSpace: Ref<Space>
): Promise<Tx[]> {
  const attachedDocId = updatedDoc._id
  const attachedDocClass = updatedDoc._class

  // collect attribute references
  let hasReferenceAttrs = false
  const references: Data<ActivityReference>[] = []
  const attributes = control.hierarchy.getAllAttributes(updatedDoc._class)
  for (const attr of attributes.values()) {
    if (isMarkupType(attr.type._class)) {
      hasReferenceAttrs = true
      const content: string = (updatedDoc as any)[attr.name]?.toString() ?? ''
      const attrReferences = getReferencesData(srcDocId, srcDocClass, attachedDocId, attachedDocClass, content)
      references.push(...attrReferences)
    } else if (attr.type._class === core.class.TypeCollaborativeDoc) {
      hasReferenceAttrs = true
      try {
        const blobId = (updatedDoc as any)[attr.name] as Ref<Blob>
        if (blobId != null) {
          const buffer = await storage.read(ctx, control.workspace, blobId)
          const markup = Buffer.concat(buffer).toString()
          const attrReferences = getReferencesData(srcDocId, srcDocClass, attachedDocId, attachedDocClass, markup)
          references.push(...attrReferences)
        }
      } catch {
        // do nothing, the collaborative doc does not sem to exist yet
      }
    }
  }

  // There is a chance that references are managed manually
  // do not update references if there are no reference sources in the doc
  if (hasReferenceAttrs) {
    const current = await control.findAll(ctx, activity.class.ActivityReference, {
      srcDocId,
      srcDocClass,
      attachedDocId,
      collection: 'references'
    })
    const userMentions = await control.findAll(ctx, activity.class.UserMentionInfo, {
      attachedTo: attachedDocId
    })

    const refSpace: Ref<Space> = control.hierarchy.isDerived(srcDocClass, core.class.Space)
      ? (srcDocId as Ref<Space>)
      : srcDocSpace

    return await getReferencesTxes(control, txFactory, references, refSpace, current, userMentions)
  }

  return []
}

export function getReferencesData (
  srcDocId: Ref<Doc>,
  srcDocClass: Ref<Class<Doc>>,
  attachedDocId: Ref<Doc> | undefined,
  attachedDocClass: Ref<Class<Doc>> | undefined,
  content: Markup
): Array<Data<ActivityReference>> {
  const result: Array<Data<ActivityReference>> = []
  const references = []

  const node = markupToJSON(content)
  references.push(...extractReferences(node))

  for (const ref of references) {
    if (ref.objectId !== attachedDocId && ref.objectId !== srcDocId) {
      result.push({
        attachedTo: ref.objectId,
        attachedToClass: ref.objectClass,
        collection: 'references',
        srcDocId,
        srcDocClass,
        message: ref.parentNode !== null ? jsonToMarkup(ref.parentNode) : '',
        attachedDocId,
        attachedDocClass
      })
    }
  }

  return result
}

async function createReferenceTxes (
  control: TriggerControl,
  ref: Data<ActivityReference>,
  space: Ref<Space>
): Promise<Tx[]> {
  if (control.hierarchy.isDerived(ref.attachedToClass, contact.class.Person)) {
    const employee = (
      await control.findAll(control.ctx, contact.mixin.Employee, { _id: ref.attachedTo as Ref<Employee> })
    )[0]
    const account = employee?.personUuid
    if (account == null) return []

    const res: Tx[] = []
    const collaborator = (
      await control.findAll(control.ctx, core.class.Collaborator, { collaborator: account, attachedTo: ref.srcDocId })
    )[0]

    const spaceDoc = (await control.findAll(control.ctx, core.class.Space, { _id: space }))[0]
    if (spaceDoc == null) return []

    const isSpaceAvailable = !spaceDoc.private || spaceDoc.members.includes(account)
    if (collaborator == null && isSpaceAvailable) {
      const srcDoc = (await control.findAll(control.ctx, ref.srcDocClass, { _id: ref.srcDocId }))[0]
      if (srcDoc != null) {
        res.push(...getAddCollaboratorsTxes(srcDoc._id, srcDoc._class, srcDoc.space, control, [account]))
      }
    }

    if (!spaceDoc.private && !spaceDoc.members.includes(account)) {
      res.push(
        control.txFactory.createTxUpdateDoc(spaceDoc._class, spaceDoc.space, spaceDoc._id, {
          $push: { members: account }
        })
      )
      return res
    }

    return res
  }

  const refTx = control.txFactory.createTxCreateDoc(activity.class.ActivityReference, space, ref)
  const tx = control.txFactory.createTxCollectionCUD(ref.attachedToClass, ref.attachedTo, space, ref.collection, refTx)

  return [tx]
}

async function getRemoveMentionTxes (control: TriggerControl, mention: UserMentionInfo): Promise<Tx[]> {
  return [control.txFactory.createTxRemoveDoc(mention._class, mention.space, mention._id)]
}

async function getReferencesTxes (
  control: TriggerControl,
  txFactory: TxFactory,
  references: Data<ActivityReference>[],
  space: Ref<Space>,
  current: ActivityReference[],
  mentions: UserMentionInfo[]
): Promise<Tx[]> {
  const txes: Tx[] = []

  for (const c of current) {
    // Find existing and check if we need to update message
    const pos = references.findIndex(
      (b) => b.srcDocId === c.srcDocId && b.srcDocClass === c.srcDocClass && b.attachedTo === c.attachedTo
    )
    if (pos !== -1) {
      // Update existing references when message changed
      const data = references[pos]
      if (c.message !== data.message) {
        const innerTx = txFactory.createTxUpdateDoc(c._class, c.space, c._id, {
          message: data.message
        })
        txes.push(txFactory.createTxCollectionCUD(c.attachedToClass, c.attachedTo, c.space, c.collection, innerTx))
      }
      references.splice(pos, 1)
    } else {
      // Remove not found references
      const innerTx = txFactory.createTxRemoveDoc(c._class, c.space, c._id)
      txes.push(txFactory.createTxCollectionCUD(c.attachedToClass, c.attachedTo, c.space, c.collection, innerTx))
    }
  }

  for (const mention of mentions) {
    const refIndex = references.findIndex(
      (r) => mention.user === r.attachedTo && mention.attachedTo === r.attachedDocId
    )

    const ref = references[refIndex]

    if (refIndex !== -1) {
      const alreadyProcessed = areEqualJson(JSON.parse(mention.content), JSON.parse(ref.message))

      if (alreadyProcessed) {
        references.splice(refIndex, 1)
      }
    } else {
      const removeTxes = await getRemoveMentionTxes(control, mention)
      txes.push(...removeTxes)
    }
  }

  // Add missing references
  for (const ref of references) {
    txes.push(...(await createReferenceTxes(control, ref, space)))
  }

  return txes
}

async function getRemoveActivityReferenceTxes (
  control: TriggerControl,
  txFactory: TxFactory,
  removedDocId: Ref<Doc>
): Promise<Tx[]> {
  const txes: Tx[] = []
  const refs = await control.findAll(control.ctx, activity.class.ActivityReference, {
    attachedDocId: removedDocId,
    collection: 'references'
  })

  const mentions = await control.findAll(control.ctx, activity.class.UserMentionInfo, {
    attachedTo: removedDocId
  })

  for (const ref of refs) {
    const removeTx = txFactory.createTxRemoveDoc(ref._class, ref.space, ref._id)
    txes.push(txFactory.createTxCollectionCUD(ref.attachedToClass, ref.attachedTo, ref.space, ref.collection, removeTx))
  }

  for (const mention of mentions) {
    const removeTx = txFactory.createTxRemoveDoc(mention._class, mention.space, mention._id)
    txes.push(
      txFactory.createTxCollectionCUD(
        mention.attachedToClass,
        mention.attachedTo,
        mention.space,
        mention.collection,
        removeTx
      )
    )
  }

  return txes
}

function guessReferenceObj (
  modelDb: ModelDb,
  hierarchy: Hierarchy,
  tx: TxCUD<Doc>
): {
    objectId: Ref<Doc>
    objectClass: Ref<Class<Doc>>
  } {
  // Try to guess reference target Tx for TxCollectionCUD txes based on collaborators availability
  if (tx.attachedToClass !== undefined && tx.attachedTo !== undefined) {
    if (hierarchy.isDerived(tx.objectClass, activity.class.ActivityMessage)) {
      return {
        objectId: tx.attachedTo,
        objectClass: tx.attachedToClass
      }
    }

    const mixin = getClassCollaborators(modelDb, hierarchy, tx.objectClass)
    return mixin !== undefined
      ? {
          objectId: tx.objectId,
          objectClass: tx.objectClass
        }
      : {
          objectId: tx.attachedTo,
          objectClass: tx.attachedToClass
        }
  }
  return {
    objectId: tx.objectId,
    objectClass: tx.objectClass
  }
}

async function ActivityReferenceCreate (tx: TxCUD<Doc>, control: TriggerControl): Promise<Tx[]> {
  const ctx = tx as TxCreateDoc<Doc>

  if (ctx._class !== core.class.TxCreateDoc) return []
  if (control.hierarchy.isDerived(ctx.objectClass, notification.class.DocNotifyContext)) return []
  if (control.hierarchy.isDerived(ctx.objectClass, activity.class.ActivityReference)) return []

  const txFactory = new TxFactory(control.txFactory.account)

  const doc = TxProcessor.createDoc2Doc(ctx)
  const target = guessReferenceObj(control.modelDb, control.hierarchy, tx)

  const txes: Tx[] = await getCreateReferencesTxes(
    control.ctx,
    control,
    control.storageAdapter,
    txFactory,
    doc,
    target.objectId,
    target.objectClass,
    tx.objectSpace
  )

  if (txes.length !== 0) {
    await control.apply(control.ctx, txes)
  }

  return []
}

async function ActivityReferenceUpdate (tx: TxCUD<Doc>, control: TriggerControl): Promise<Tx[]> {
  const ctx = tx as TxUpdateDoc<Doc>
  const attributes = control.hierarchy.getAllAttributes(ctx.objectClass)

  let hasUpdates = false

  for (const attr of attributes.values()) {
    if (isMarkupType(attr.type._class) || isCollaborativeType(attr.type._class)) {
      if (TxProcessor.txHasUpdate(ctx, attr.name)) {
        hasUpdates = true
        break
      }
    }
  }

  if (!hasUpdates) {
    return []
  }

  const rawDoc = (await control.findAll(control.ctx, ctx.objectClass, { _id: ctx.objectId }))[0]

  if (rawDoc === undefined) {
    return []
  }

  const txFactory = new TxFactory(control.txFactory.account)
  const doc = TxProcessor.updateDoc2Doc(rawDoc, ctx)
  const target = guessReferenceObj(control.modelDb, control.hierarchy, tx)

  const txes: Tx[] = await getUpdateReferencesTxes(
    control.ctx,
    control,
    control.storageAdapter,
    txFactory,
    doc,
    target.objectId,
    target.objectClass,
    tx.objectSpace
  )

  if (txes.length !== 0) {
    await control.apply(control.ctx, txes)
  }

  return []
}

async function ActivityReferenceRemove (tx: TxCUD<Doc>, control: TriggerControl): Promise<Tx[]> {
  const ctx = tx as TxRemoveDoc<Doc>
  const attributes = control.hierarchy.getAllAttributes(ctx.objectClass)

  let hasMarkdown = false

  for (const attr of attributes.values()) {
    if (isMarkupType(attr.type._class) || isCollaborativeType(attr.type._class)) {
      hasMarkdown = true
      break
    }
  }

  if (hasMarkdown) {
    const txFactory = new TxFactory(control.txFactory.account)

    const txes: Tx[] = await getRemoveActivityReferenceTxes(control, txFactory, ctx.objectId)
    if (txes.length !== 0) {
      await control.apply(control.ctx, txes)
    }
  }

  return []
}

export async function ReferenceTrigger (txes: TxCUD<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []

  for (const tx of txes) {
    if (control.hierarchy.isDerived(tx.objectClass, activity.class.ActivityReference)) continue
    if (control.hierarchy.isDerived(tx.objectClass, notification.class.DocNotifyContext)) continue
    if (control.hierarchy.isDerived(tx.objectClass, notification.class.AppPushNotification)) continue
    if (control.hierarchy.isDerived(tx.objectClass, activity.class.UserMentionInfo)) continue

    if (tx._class === core.class.TxCreateDoc) {
      result.push(...(await ActivityReferenceCreate(tx, control)))
    }
    if (tx._class === core.class.TxUpdateDoc) {
      result.push(...(await ActivityReferenceUpdate(tx, control)))
    }
    if (tx._class === core.class.TxRemoveDoc) {
      result.push(...(await ActivityReferenceRemove(tx, control)))
    }
  }
  return result
}

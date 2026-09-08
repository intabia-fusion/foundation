import core, {
  type Data,
  type Doc,
  groupByArray,
  type Hierarchy,
  matchQuery,
  type MeasureContext,
  type PersonId,
  type TxCreateDoc,
  type TxCUD,
  type TxFactory,
  TxProcessor,
  type TxRemoveDoc,
  type TxUpdateDoc
} from '@hcengineering/core'
import activity, {
  type ActivityMessageControl,
  type DocUpdateMessage,
  type DocUpdateMessageHistory
} from '@hcengineering/activity'

import type Cache from './cache'
import { type Client } from './types'
import {
  canCombineMessage,
  getDocIdentifier,
  getDocTitle,
  getDocUpdateAction,
  getDocUpdateMessageIntl,
  getDocUpdateMessageKey,
  getDocUrl,
  getTxAttributesUpdates,
  isActivityDoc,
  isSpace,
  mergeCollectionHistory,
  mergeDocUpdateAttributes
} from './utils'

const CREATE_COMBINE_THRESHOLD = 100 // Use 100 ms to combine update messages after creation.
const UPDATE_COMBINE_THRESHOLD = 5 * 60 * 1000 //  Use 5 minutes to combine similar messages

export async function ActivityMessagesHandler (tx: TxCUD<Doc>, client: Client, cache: Cache): Promise<TxCUD<Doc>[]> {
  if (tx.space === core.space.DerivedTx) return []

  return await client.ctx.with('generateDocUpdateMessages', {}, (ctx) =>
    generateDocUpdateMessages(ctx, client, cache, tx, [])
  )
}

async function generateDocUpdateMessages (
  ctx: MeasureContext,
  client: Client,
  cache: Cache,
  tx: TxCUD<Doc>,
  res: TxCUD<DocUpdateMessage>[] = [],
  skipAttachedTo = false
): Promise<TxCUD<DocUpdateMessage>[]> {
  if (tx.space === core.space.DerivedTx) return res

  const { hierarchy } = client

  if (hierarchy.isDerived(tx.objectClass, activity.class.ActivityMessage)) return res
  if (tx.attachedToClass !== undefined && hierarchy.isDerived(tx.attachedToClass, activity.class.ActivityMessage)) {
    return res
  }

  if (
    hierarchy.classHierarchyMixin(tx.objectClass, activity.mixin.IgnoreActivity) !== undefined ||
    (tx.attachedToClass !== undefined &&
      hierarchy.classHierarchyMixin(tx.attachedToClass, activity.mixin.IgnoreActivity) !== undefined)
  ) {
    return res
  }

  // Check if we have override control over transaction => activity mappings
  const controlRules = client.model.findAllSync<ActivityMessageControl>(activity.class.ActivityMessageControl, {
    objectClass: { $in: hierarchy.getAncestors(tx.objectClass) }
  })
  if (controlRules.length > 0) {
    for (const r of controlRules) {
      for (const s of r.skip) {
        if (matchQuery([tx], s, core.class.TxCUD, hierarchy).length > 0) {
          // Match found, we need to skip
          return res
        }
      }
    }
  }

  if (tx.attachedTo !== undefined && tx.attachedToClass !== undefined && !skipAttachedTo) {
    res = await generateDocUpdateMessages(ctx, client, cache, tx, res, true)
    if ([core.class.TxCreateDoc, core.class.TxRemoveDoc].includes(tx._class)) {
      if (!isActivityDoc(tx.attachedToClass, client.hierarchy)) {
        return res
      }

      const doc = await cache.getDoc(tx.attachedTo, tx.attachedToClass)

      if (doc !== undefined) {
        return await ctx.with(
          'pushDocUpdateMessages',
          {},
          async (ctx) =>
            await pushDocUpdateMessages(ctx, client, cache, res, doc ?? undefined, tx, undefined, controlRules)
        )
      }
    }
    return res
  }

  switch (tx._class) {
    case core.class.TxCreateDoc: {
      const doc = TxProcessor.createDoc2Doc(tx as TxCreateDoc<Doc>)
      return await ctx.with('pushDocUpdateMessages', {}, (ctx) =>
        pushDocUpdateMessages(ctx, client, cache, res, doc, tx, undefined, controlRules)
      )
    }
    case core.class.TxMixin:
    case core.class.TxUpdateDoc: {
      if (isActivityDoc(tx.objectClass, client.hierarchy)) {
        const doc = await cache.getDoc(tx.objectId, tx.objectClass)
        if (doc == null) return res
        return await ctx.with(
          'pushDocUpdateMessages',
          {},
          async (ctx) => await pushDocUpdateMessages(ctx, client, cache, res, doc, tx, undefined, controlRules)
        )
      }
    }
  }

  return res
}

async function pushDocUpdateMessages (
  ctx: MeasureContext,
  client: Client,
  cache: Cache,
  res: TxCUD<DocUpdateMessage>[],
  doc: Doc,
  tx: TxCUD<Doc>,
  modifiedBy?: PersonId,
  controlRules?: ActivityMessageControl[]
): Promise<TxCUD<DocUpdateMessage>[]> {
  if (!isActivityDoc(doc._class, client.hierarchy)) return res

  const raw: Data<DocUpdateMessage> = {
    txId: tx._id,
    attachedTo: doc._id,
    attachedToClass: doc._class,
    objectId: tx.objectId,
    objectClass: tx.objectClass,
    action: getDocUpdateAction(client.hierarchy, tx),
    collection: 'docUpdateMessages',
    updateCollection: tx.collection,
    attachedToTitle: await getDocTitle(client, doc),
    attachedToIdentifier: await getDocIdentifier(client, doc),
    attachedToUrl: await getDocUrl(client, doc),
    history: []
  }

  if (tx.collection != null && tx._class === core.class.TxCreateDoc) {
    const collectionDoc = TxProcessor.createDoc2Doc(tx as TxCreateDoc<Doc>)
    raw.objectTitle = await getDocTitle(client, collectionDoc)
    raw.objectAttributes = raw.objectTitle != null ? undefined : (tx as TxCreateDoc<Doc>).attributes
  } else if (tx.collection != null && tx._class === core.class.TxRemoveDoc) {
    const collectionDoc = (tx as TxRemoveDoc<Doc>).removedDoc

    if (collectionDoc != null) {
      raw.objectTitle = await getDocTitle(client, collectionDoc)
      raw.objectAttributes = raw.objectTitle != null ? undefined : collectionDoc
    }
  }

  const attributesUpdates = await getTxAttributesUpdates(ctx, client, cache, tx, doc, controlRules)
  const createTxes: TxCreateDoc<DocUpdateMessage>[] = []
  for (const attributeUpdates of attributesUpdates) {
    createTxes.push(
      await getDocUpdateMessageTx(
        client,
        tx,
        doc,
        {
          ...raw,
          attributeUpdates
        },
        modifiedBy
      )
    )
  }

  if (attributesUpdates.length === 0 && raw.action !== 'update') {
    const ttx = await getDocUpdateMessageTx(client, tx, doc, raw, modifiedBy)
    createTxes.push(ttx)
  }

  const combined = combineMessages(createTxes, cache.getRecentMessages(doc._id), client.txFactory, client.hierarchy)

  for (const ttx of combined.create) {
    res.push(ttx)
    cache.addRecentMessage(TxProcessor.createDoc2Doc(ttx))
  }

  for (const ttx of combined.remove) {
    res.push(ttx)
    cache.tx(ttx)
  }

  for (const ttx of combined.update) {
    res.push(ttx)
    cache.tx(ttx)
  }

  return res
}

function combineMessages (
  txes: TxCreateDoc<DocUpdateMessage>[],
  recent: DocUpdateMessage[],
  factory: TxFactory,
  hierarchy: Hierarchy
): {
    create: TxCreateDoc<DocUpdateMessage>[]
    remove: TxRemoveDoc<DocUpdateMessage>[]
    update: TxUpdateDoc<DocUpdateMessage>[]
  } {
  const created = txes.map((it) => {
    const message = TxProcessor.createDoc2Doc(it)
    return {
      tx: it,
      message,
      key: getDocUpdateMessageKey(message)
    }
  })

  const createTx: TxCreateDoc<DocUpdateMessage>[] = []
  const removeTx: TxRemoveDoc<DocUpdateMessage>[] = []
  const updateTx: TxUpdateDoc<DocUpdateMessage>[] = []

  const recentGroupedByType = groupByArray(recent, getDocUpdateMessageKey)

  for (const { key, message, tx } of created) {
    const createMessage = recent.find(
      (it) => it.createdBy === message.createdBy && it.action === 'create' && it.attachedTo === it.objectId
    )

    const createDiff =
      (message.createdOn ?? message.modifiedOn) - (createMessage?.createdOn ?? createMessage?.modifiedOn ?? 0)

    if (createMessage != null && createDiff <= CREATE_COMBINE_THRESHOLD) {
      const innerUpdateTx = factory.createTxUpdateDoc(createMessage._class, createMessage.space, createMessage._id, {
        $push: {
          history: {
            action: message.action,
            createdOn: message.createdOn ?? message.modifiedOn ?? 0,
            update: message.attributeUpdates,
            objectId: message.objectId,
            objectClass: message.objectClass,
            objectTitle: message.objectTitle,
            objectAttributes: message.objectAttributes
          }
        }
      })
      updateTx.push(
        factory.createTxCollectionCUD(
          tx.attachedToClass ?? message.objectClass,
          tx.attachedTo ?? message.objectId,
          createMessage.space,
          'docUpdateMessages',
          innerUpdateTx
        ) as TxUpdateDoc<DocUpdateMessage>
      )
      continue
    }

    const combinedWith = (recentGroupedByType.get(key) ?? []).filter(canCombineMessage).filter((it) => {
      const timeDiff = (message.createdOn ?? message.modifiedOn) - (it.createdOn ?? it.modifiedOn)

      return timeDiff >= 0 && timeDiff < UPDATE_COMBINE_THRESHOLD
    })

    if (combinedWith.length === 0) {
      createTx.push(tx)
      continue
    }

    if (message.action === 'update') {
      const attributeUpdates = mergeDocUpdateAttributes(combinedWith, message)
      if (attributeUpdates == null) {
        removeTx.push(...getRemoveTx(combinedWith, factory))
        continue
      }

      tx.attributes.attributeUpdates = attributeUpdates
      tx.attributes.history = combinedWith.map(mapToHistory)

      removeTx.push(...getRemoveTx(combinedWith.slice(1), factory))
      updateTx.push(...getUpdateTx(combinedWith[0], factory, tx))
      continue
    } else {
      const merged = mergeCollectionHistory(combinedWith, message, hierarchy)
      if (merged === undefined || merged.length === 0) {
        removeTx.push(...getRemoveTx(combinedWith, factory))
        continue
      }

      const creates = merged.filter((m) => m.action === 'create')
      const removes = merged.filter((m) => m.action === 'remove')

      const availableTargets = [...combinedWith]

      const processSubset = (subset: DocUpdateMessageHistory[]): void => {
        if (subset.length === 0) return

        const last = subset[subset.length - 1]

        const attrs = { ...tx.attributes }
        if (last != null) {
          attrs.action = last.action
          attrs.objectId = last.objectId
          attrs.objectClass = last.objectClass
          attrs.objectTitle = last.objectTitle
          attrs.objectAttributes = last.objectAttributes
          attrs.attributeUpdates = last.update
        }
        attrs.history = subset

        const target = availableTargets.shift()
        if (target != null) {
          const innerUpdateTx = factory.createTxUpdateDoc(
            target._class,
            target.space,
            target._id,
            attrs,
            undefined,
            tx.modifiedOn,
            tx.modifiedBy
          )

          updateTx.push(
            factory.createTxCollectionCUD(
              target.attachedToClass,
              target.attachedTo,
              target.space,
              tx.collection ?? 'docUpdateMessages',
              innerUpdateTx
            ) as TxUpdateDoc<DocUpdateMessage>
          )
        } else {
          const newInnerTx = factory.createTxCreateDoc(
            tx.objectClass,
            tx.objectSpace,
            attrs,
            undefined,
            tx.modifiedOn,
            tx.modifiedBy
          )

          if (tx.attachedTo != null && tx.attachedToClass != null) {
            createTx.push(
              factory.createTxCollectionCUD(
                tx.attachedToClass,
                tx.attachedTo,
                tx.objectSpace,
                tx.collection ?? 'docUpdateMessages',
                newInnerTx,
                tx.modifiedOn,
                tx.modifiedBy
              ) as TxCreateDoc<DocUpdateMessage>
            )
          } else {
            createTx.push(newInnerTx)
          }
        }
      }

      const createLastIndex = merged.map((m) => m.action).lastIndexOf('create')
      const removeLastIndex = merged.map((m) => m.action).lastIndexOf('remove')

      if (createLastIndex < removeLastIndex) {
        processSubset(creates)
        processSubset(removes)
      } else {
        processSubset(removes)
        processSubset(creates)
      }

      removeTx.push(...getRemoveTx(availableTargets, factory))
      continue
    }
  }

  return {
    create: createTx,
    remove: removeTx,
    update: updateTx
  }
}

const getRemoveTx = (items: DocUpdateMessage[], factory: TxFactory): TxRemoveDoc<DocUpdateMessage>[] => {
  return items.map((it) => {
    const innerTx = factory.createTxRemoveDoc(it._class, it.space, it._id)
    return factory.createTxCollectionCUD(it.attachedToClass, it.attachedTo, it.space, 'docUpdateMessages', innerTx)
  })
}

const getUpdateTx = (
  targetMsg: DocUpdateMessage,
  factory: TxFactory,
  tx: TxCreateDoc<DocUpdateMessage>
): TxUpdateDoc<DocUpdateMessage>[] => {
  const innerUpdateTx = factory.createTxUpdateDoc(
    targetMsg._class,
    targetMsg.space,
    targetMsg._id,
    tx.attributes,
    undefined,
    tx.modifiedOn,
    tx.modifiedBy
  )

  return [
    factory.createTxCollectionCUD(
      targetMsg.attachedToClass,
      targetMsg.attachedTo,
      targetMsg.space,
      'docUpdateMessages',
      innerUpdateTx
    ) as TxUpdateDoc<DocUpdateMessage>
  ]
}

const mapToHistory = (it: DocUpdateMessage): DocUpdateMessageHistory => ({
  action: it.action,
  createdOn: it.createdOn ?? it.modifiedOn ?? 0,
  update: it.attributeUpdates,
  objectId: it.objectId,
  objectClass: it.objectClass,
  objectTitle: it.objectTitle,
  objectAttributes: it.objectAttributes
})

async function getDocUpdateMessageTx (
  client: Client,
  originTx: TxCUD<Doc>,
  doc: Doc,
  rawMessage: Data<DocUpdateMessage>,
  modifiedBy?: PersonId
): Promise<TxCreateDoc<DocUpdateMessage>> {
  const { hierarchy } = client
  const space = isSpace(doc, hierarchy) ? doc._id : doc.space
  const innerTx = client.txFactory.createTxCreateDoc(
    activity.class.DocUpdateMessage,
    space,
    rawMessage,
    undefined,
    originTx.modifiedOn,
    modifiedBy ?? originTx.modifiedBy
  )

  const { messageIntl, intlParams, intlParamsNotLocalized } = await getDocUpdateMessageIntl(
    client,
    originTx,
    doc,
    TxProcessor.createDoc2Doc(innerTx)
  )

  innerTx.attributes.messageIntl = messageIntl
  innerTx.attributes.intlParams = intlParams
  innerTx.attributes.intlParamsNotLocalized = intlParamsNotLocalized

  return client.txFactory.createTxCollectionCUD(
    rawMessage.attachedToClass,
    rawMessage.attachedTo,
    space,
    rawMessage.collection,
    innerTx,
    originTx.modifiedOn,
    modifiedBy ?? originTx.modifiedBy
  ) as TxCreateDoc<DocUpdateMessage>
}

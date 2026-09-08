//
// Copyright © 2022 Hardcore Engineering Inc.
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

import {
  type ActivityMessage,
  type DocAttributeUpdates,
  type DocUpdateMessage,
  type DocUpdateMessageHistory,
  type Reaction
} from '@hcengineering/activity'
import contact, { type Person } from '@hcengineering/contact'
import core, {
  type AccountUuid,
  type Class,
  type Collaborator,
  type Doc,
  type Domain,
  DOMAIN_COLLABORATOR,
  generateId,
  groupByArray,
  notEmpty,
  type PersonId,
  type Ref,
  SortingOrder,
  type Space
} from '@hcengineering/core'
import {
  type MigrateOperation,
  type MigrateUpdate,
  type MigrationClient,
  type MigrationDocumentQuery,
  type MigrationIterator,
  type MigrationUpgradeClient,
  tryMigrate
} from '@hcengineering/model'
import { htmlToMarkup } from '@hcengineering/text'
import {
  getAccountUuidByOldAccount,
  getSocialIdFromOldAccount,
  getSocialKeyByOldAccount
} from '@hcengineering/model-core'
import notification, {
  type ActivityInboxNotification,
  type DocNotifyContext,
  DOMAIN_DOC_NOTIFY,
  DOMAIN_NOTIFICATION,
  type MentionInboxNotification,
  type ReactionInboxNotification
} from '@hcengineering/notification'

import { activityId, DOMAIN_ACTIVITY, DOMAIN_REACTION, DOMAIN_USER_MENTION } from './index'
import activity from './plugin'

const DOMAIN_CHUNTER = 'chunter' as Domain
const DOMAIN_CONTACT = 'contact' as Domain

async function migrateReactions (client: MigrationClient): Promise<void> {
  await client.update(
    DOMAIN_CHUNTER,
    { _class: 'chunter:class:Reaction' as Ref<Class<Doc>> },
    { _class: activity.class.Reaction }
  )
  await client.move(DOMAIN_CHUNTER, { _class: activity.class.Reaction }, DOMAIN_ACTIVITY)
}

async function migrateMarkup (client: MigrationClient): Promise<void> {
  const iterator = await client.traverse<DocUpdateMessage>(
    DOMAIN_ACTIVITY,
    {
      _class: activity.class.DocUpdateMessage,
      'attributeUpdates.attrClass': core.class.TypeMarkup
    },
    {
      projection: {
        _id: 1,
        attributeUpdates: 1
      }
    }
  )

  try {
    await processMigrateMarkupFor(client, iterator)
  } finally {
    await iterator.close()
  }
}

async function processMigrateMarkupFor (
  client: MigrationClient,
  iterator: MigrationIterator<DocUpdateMessage>
): Promise<void> {
  while (true) {
    const docs = await iterator.next(1000)
    if (docs === null || docs.length === 0) {
      break
    }

    const ops: { filter: MigrationDocumentQuery<DocUpdateMessage>, update: MigrateUpdate<DocUpdateMessage> }[] = []

    for (const doc of docs) {
      if (doc.attributeUpdates == null) continue
      if (doc.attributeUpdates.set == null) continue
      if (doc.attributeUpdates.set.length === 0) continue

      const update: MigrateUpdate<DocUpdateMessage> = {}

      const attributeUpdatesSet = [...doc.attributeUpdates.set]
      for (let i = 0; i < attributeUpdatesSet.length; i++) {
        const value = attributeUpdatesSet[i]
        if (value != null && typeof value === 'string') {
          attributeUpdatesSet[i] = htmlToMarkup(value)
        }

        update['attributeUpdates.set'] = attributeUpdatesSet
      }

      const prevValue = doc.attributeUpdates.prevValue
      if (prevValue != null && typeof prevValue === 'string') {
        update['attributeUpdates.prevValue'] = htmlToMarkup(prevValue)
      }

      ops.push({ filter: { _id: doc._id }, update })
    }

    if (ops.length > 0) {
      await client.bulk(DOMAIN_ACTIVITY, ops)
    }
  }
}

export async function migrateMessagesSpace (
  client: MigrationClient,
  _class: Ref<Class<ActivityMessage>>,
  getSpaceId: (message: ActivityMessage) => Ref<Doc>,
  getSpaceClass: (message: ActivityMessage) => Ref<Class<Doc>>
): Promise<void> {
  const skipped: Ref<ActivityMessage>[] = []
  while (true) {
    const messages = await client.find<ActivityMessage>(
      DOMAIN_ACTIVITY,
      {
        _class,
        space: core.space.Space,
        _id: { $nin: skipped }
      },
      { limit: 500 }
    )

    if (messages.length === 0) {
      break
    }

    const map = groupByArray(messages, getSpaceId)

    for (const [spaceId, msgs] of map) {
      const spaceClass = getSpaceClass(msgs[0])

      if (!client.hierarchy.isDerived(spaceClass, core.class.Space)) {
        skipped.push(...msgs.map(({ _id }) => _id))
        continue
      }

      const space = spaceId as Ref<Space>

      await client.update(
        DOMAIN_ACTIVITY,
        {
          _class,
          _id: { $in: msgs.map(({ _id }) => _id) }
        },
        { space }
      )

      await client.update<Reaction>(
        DOMAIN_ACTIVITY,
        {
          _class: activity.class.Reaction,
          attachedTo: { $in: msgs.map(({ _id }) => _id) }
        },
        { space }
      )

      await client.update<DocUpdateMessage>(
        DOMAIN_ACTIVITY,
        {
          _class: activity.class.DocUpdateMessage,
          objectClass: activity.class.Reaction,
          attachedTo: { $in: msgs.map(({ _id }) => _id) }
        },
        { space }
      )
    }
  }
}

async function migrateActivityMarkup (client: MigrationClient): Promise<void> {
  await client.update(
    DOMAIN_ACTIVITY,
    {
      _class: activity.class.DocUpdateMessage,
      'attributeUpdates.attrClass': 'core:class:TypeCollaborativeMarkup'
    },
    { 'attributeUpdates.attrClass': core.class.TypeMarkup }
  )
}

async function migrateAccountsToSocialIds (client: MigrationClient): Promise<void> {
  const socialKeyByAccount = await getSocialKeyByOldAccount(client)
  const socialIdBySocialKey = new Map<string, PersonId | null>()
  const socialIdByOldAccount = new Map<string, PersonId | null>()

  client.logger.log('processing activity reactions ', {})
  const iterator = await client.traverse(DOMAIN_REACTION, { _class: activity.class.Reaction })

  try {
    let processed = 0
    while (true) {
      const docs = await iterator.next(200)
      if (docs === null || docs.length === 0) {
        break
      }

      const operations: { filter: MigrationDocumentQuery<Doc>, update: MigrateUpdate<Doc> }[] = []

      for (const doc of docs) {
        const reaction = doc as Reaction
        const socialId = await getSocialIdFromOldAccount(
          client,
          reaction.createBy,
          socialKeyByAccount,
          socialIdBySocialKey,
          socialIdByOldAccount
        )
        const newCreateBy = socialId ?? reaction.createBy

        if (newCreateBy === reaction.createBy) continue

        operations.push({
          filter: { _id: doc._id },
          update: {
            createBy: newCreateBy
          }
        })
      }

      if (operations.length > 0) {
        await client.bulk(DOMAIN_REACTION, operations)
      }

      processed += docs.length
      client.logger.log('...processed', { count: processed })
    }
  } finally {
    await iterator.close()
  }
  client.logger.log('finished processing activity reactions ', {})
}

/**
 * Migrates old accounts to new accounts/social ids.
 * Should be applied to prodcution directly without applying migrateSocialIdsInDocUpdates
 * @param client
 * @returns
 */
async function migrateAccountsInDocUpdates (client: MigrationClient): Promise<void> {
  const socialKeyByAccount = await getSocialKeyByOldAccount(client)
  const accountUuidBySocialKey = new Map<string, AccountUuid | null>()
  client.logger.log('processing activity doc updates ', {})

  function getUpdatedClass (attrKey: string): string {
    return ['members', 'owners', 'user'].includes(attrKey) ? core.class.TypeAccountUuid : core.class.TypePersonId
  }

  async function getUpdatedVal (oldVal: string, attrKey: string): Promise<any> {
    if (['members', 'owners', 'user'].includes(attrKey)) {
      return (await getAccountUuidByOldAccount(client, oldVal, socialKeyByAccount, accountUuidBySocialKey)) ?? oldVal
    } else {
      return socialKeyByAccount[oldVal] ?? oldVal
    }
  }

  async function migrateField<P extends keyof DocAttributeUpdates> (
    au: DocAttributeUpdates,
    update: MigrateUpdate<DocUpdateMessage>['attributeUpdates'],
    field: P
  ): Promise<void> {
    const oldValue = au?.[field]
    if (oldValue == null) return

    let changed = false
    let newValue: any
    if (Array.isArray(oldValue)) {
      newValue = []
      for (const a of oldValue as any[]) {
        const newA = a != null ? await getUpdatedVal(a, au.attrKey) : a
        if (newA !== a) {
          changed = true
        }
        newValue.push(newA)
      }
    } else {
      newValue = await getUpdatedVal(oldValue, au.attrKey)
      if (newValue !== oldValue) {
        changed = true
      }
    }

    if (changed) {
      if (update == null) throw new Error('update is null')

      update[field] = newValue
    }
  }

  const iterator = await client.traverse(DOMAIN_ACTIVITY, {
    _class: activity.class.DocUpdateMessage,
    action: 'update',
    'attributeUpdates.attrClass': 'core:class:Account'
  })

  try {
    let processed = 0
    while (true) {
      const docs = await iterator.next(200)
      if (docs === null || docs.length === 0) {
        break
      }

      const operations: {
        filter: MigrationDocumentQuery<DocUpdateMessage>
        update: MigrateUpdate<DocUpdateMessage>
      }[] = []

      for (const doc of docs) {
        const dum = doc as DocUpdateMessage
        if (dum.attributeUpdates == null) continue
        const update: any = { attributeUpdates: { ...dum.attributeUpdates } }

        await migrateField(dum.attributeUpdates, update.attributeUpdates, 'added')
        await migrateField(dum.attributeUpdates, update.attributeUpdates, 'prevValue')
        await migrateField(dum.attributeUpdates, update.attributeUpdates, 'removed')
        await migrateField(dum.attributeUpdates, update.attributeUpdates, 'set')

        update.attributeUpdates.attrClass = getUpdatedClass(dum.attributeUpdates.attrKey)

        operations.push({
          filter: { _id: dum._id },
          update
        })
      }

      if (operations.length > 0) {
        await client.bulk(DOMAIN_ACTIVITY, operations)
      }

      processed += docs.length
      client.logger.log('...processed', { count: processed })
    }
  } finally {
    await iterator.close()
  }

  client.logger.log('finished processing activity doc updates ', {})
}

async function migrateActivityAttributes (client: MigrationClient): Promise<void> {
  await client.update<DocUpdateMessage>(
    DOMAIN_ACTIVITY,
    {
      _class: activity.class.DocUpdateMessage,
      attributes: { $exists: true }
    },
    {
      $rename: { attributes: 'objectAttributes' }
    }
  )

  await client.update<DocUpdateMessage>(
    DOMAIN_ACTIVITY,
    {
      _class: activity.class.DocUpdateMessage,
      title: { $exists: true }
    },
    {
      $rename: { title: 'objectTitle' }
    }
  )
}

async function migrateCollaboratorsActivity (client: MigrationClient): Promise<void> {
  const accounts = (
    await client.find<Person>(DOMAIN_CONTACT, {
      personUuid: { $exists: true },
      'contact:mixin:Employee': { $exists: true }
    })
  )
    .map((it) => it.personUuid)
    .filter(notEmpty)
  const iterator = await client.traverse<DocUpdateMessage>(DOMAIN_ACTIVITY, {
    _class: activity.class.DocUpdateMessage,
    'attributeUpdates.attrClass': 'notification:mixin:Collaborators'
  })

  while (true) {
    const docs = (await iterator.next(500)) ?? []
    if (docs.length === 0) break

    const attachedTo = Array.from(new Set(docs.map((it) => it.attachedTo)))
    const createDocs: DocUpdateMessage[] = []
    const collaborators: Collaborator[] = await client.find<Collaborator>(DOMAIN_COLLABORATOR, {
      _class: core.class.Collaborator,
      attachedTo: { $in: attachedTo }
    })

    for (const doc of docs) {
      const added = doc.attributeUpdates?.added ?? []
      const removed = doc.attributeUpdates?.removed ?? []

      for (const add of added) {
        if (add == null || !accounts.includes(add as any)) continue
        const collaboratorId =
          collaborators.find((it) => it.collaborator === add && it.attachedTo === doc.attachedTo)?._id ??
          generateId<Collaborator>()

        if (collaboratorId == null) continue
        createDocs.push({
          _id: generateId<DocUpdateMessage>(),
          _class: activity.class.DocUpdateMessage,
          space: doc.space,
          isPinned: doc.isPinned,
          createdBy: doc.createdBy,
          modifiedBy: doc.modifiedBy,
          createdOn: doc.createdOn,
          modifiedOn: doc.modifiedOn,
          attachedTo: doc.attachedTo,
          attachedToClass: doc.attachedToClass,
          action: 'create',
          updateCollection: 'collaborators',
          objectId: collaboratorId,
          objectClass: core.class.Collaborator,
          objectAttributes: {
            collaborator: add
          },
          history: [],
          collection: doc.collection
        })
      }

      for (const remove of removed) {
        if (remove == null || !accounts.includes(remove as any)) continue
        createDocs.push({
          _id: generateId<DocUpdateMessage>(),
          _class: activity.class.DocUpdateMessage,
          space: doc.space,
          isPinned: doc.isPinned,
          createdBy: doc.createdBy,
          modifiedBy: doc.modifiedBy,
          createdOn: doc.createdOn,
          modifiedOn: doc.modifiedOn,
          attachedTo: doc.attachedTo,
          attachedToClass: doc.attachedToClass,
          action: 'remove',
          updateCollection: 'collaborators',
          objectId: generateId<Collaborator>(),
          objectClass: core.class.Collaborator,
          objectAttributes: {
            collaborator: remove
          },
          history: [],
          collection: doc.collection
        })
      }
    }

    await client.create(DOMAIN_ACTIVITY, createDocs)
    await client.deleteMany(DOMAIN_DOC_NOTIFY, {
      _class: notification.class.DocNotifyContext,
      objectId: { $in: docs.map((it) => it._id) }
    })
    await client.deleteMany<ActivityInboxNotification>(DOMAIN_NOTIFICATION, {
      _class: notification.class.ActivityInboxNotification,
      attachedTo: { $in: docs.map((it) => it._id) }
    })
    await client.deleteMany<ReactionInboxNotification>(DOMAIN_NOTIFICATION, {
      _class: notification.class.ReactionInboxNotification,
      attachedTo: { $in: docs.map((it) => it._id) }
    })
    await client.deleteMany(DOMAIN_ACTIVITY, { _id: { $in: docs.map((it) => it._id) } })
  }
}

async function migrateAggregateDocUpdateMessages (client: MigrationClient): Promise<void> {
  const CREATE_COMBINE_THRESHOLD = 100
  const UPDATE_COMBINE_THRESHOLD = 5 * 60 * 1000

  const canCombineMessage = (message: ActivityMessage): boolean => {
    const hasReactions = message.reactions !== undefined && message.reactions > 0
    const isPinned = message.isPinned === true
    const hasReplies = message.replies !== undefined && message.replies > 0
    return !hasReactions && !isPinned && !hasReplies
  }

  const getAttributeUpdatesKey = (message: DocUpdateMessage): string => {
    if (message.attributeUpdates === undefined) return ''
    const { attrKey, attrClass, isMixin } = message.attributeUpdates
    return [attrKey, attrClass, isMixin].join('-')
  }

  const getDocUpdateMessageKey = (message: DocUpdateMessage): string => {
    if (message.action === 'update') {
      return [message.createdBy, getAttributeUpdatesKey(message)].join('_')
    }
    return [message.createdBy, message.updateCollection, message.objectId === message.attachedTo].join('_')
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

  const mergeAttributeUpdates = (
    attributeUpdates: DocAttributeUpdates,
    prevAttributeUpdates?: DocAttributeUpdates
  ): DocAttributeUpdates => {
    if (prevAttributeUpdates === undefined) return attributeUpdates
    if (attributeUpdates.attrKey !== prevAttributeUpdates.attrKey) return attributeUpdates

    const added = attributeUpdates.added
      .filter((item) => !prevAttributeUpdates.removed.includes(item))
      .concat(prevAttributeUpdates.added.filter((item) => !attributeUpdates.removed.includes(item)))
    const removed = attributeUpdates.removed
      .filter((item) => !prevAttributeUpdates.added.includes(item))
      .concat(prevAttributeUpdates.removed.filter((item) => !attributeUpdates.added.includes(item)))

    const { prevValue } = prevAttributeUpdates
    const { set, attrClass, attrKey, isMixin } = attributeUpdates

    return {
      attrKey,
      attrClass,
      prevValue,
      set: prevValue !== undefined ? set.filter((value) => value !== prevValue) : set,
      added: prevValue !== undefined ? added.filter((value) => value !== prevValue) : added,
      removed,
      isMixin
    }
  }

  const mergeDocUpdateAttributes = (
    recent: DocUpdateMessage[],
    message: DocUpdateMessage
  ): DocAttributeUpdates | undefined => {
    const firstMessage = recent[0]
    const messages = [...recent, message]

    let mergedAttributeUpdates = firstMessage.attributeUpdates

    messages.forEach((it) => {
      if (it._id !== firstMessage._id && it.attributeUpdates !== undefined) {
        mergedAttributeUpdates = mergeAttributeUpdates(it.attributeUpdates, mergedAttributeUpdates)
      }
    })

    if (mergedAttributeUpdates === undefined) return undefined

    const hasChanges =
      mergedAttributeUpdates.set.length > 0 ||
      mergedAttributeUpdates.added.length > 0 ||
      mergedAttributeUpdates.removed.length > 0

    if (!hasChanges) return undefined
    return mergedAttributeUpdates
  }

  const mergeCollectionHistory = (
    recent: DocUpdateMessage[],
    message: DocUpdateMessage
  ): DocUpdateMessageHistory[] | undefined => {
    const operations: DocUpdateMessageHistory[] = []

    const collect = (it: DocUpdateMessage | DocUpdateMessageHistory): void => {
      const update = (it as any).update ?? (it as any).attributeUpdates
      if (update != null && (update.added.length > 0 || update.removed.length > 0)) {
        update.added.forEach((id: Ref<Doc>) => {
          operations.push({
            action: 'create',
            createdOn: it.createdOn ?? (it as any).modifiedOn ?? 0,
            objectId: id,
            objectClass: it.objectClass,
            objectTitle: it.objectTitle,
            objectAttributes: it.objectAttributes,
            update: undefined
          })
        })
        update.removed.forEach((id: Ref<Doc>) => {
          operations.push({
            action: 'remove',
            createdOn: it.createdOn ?? (it as any).modifiedOn ?? 0,
            objectId: id,
            objectClass: it.objectClass,
            objectTitle: it.objectTitle,
            objectAttributes: it.objectAttributes,
            update: undefined
          })
        })
      } else {
        operations.push({
          action: it.action,
          createdOn: it.createdOn ?? (it as any).modifiedOn ?? (it as any).createdOn ?? 0,
          objectId: it.objectId,
          objectClass: it.objectClass,
          objectTitle: it.objectTitle,
          objectAttributes: it.objectAttributes,
          update: (it as any).update ?? (it as any).attributeUpdates
        })
      }
    }

    recent.forEach((r) => {
      if (r.history !== undefined && r.history.length > 0) {
        r.history.forEach(collect)
      } else {
        collect(r)
      }
    })

    collect(message)

    const state = new Map<Ref<Doc>, DocUpdateMessageHistory>()

    const getIdentityId = (op: DocUpdateMessageHistory): Ref<Doc> => {
      if (client.hierarchy.isDerived(op.objectClass, core.class.Collaborator)) {
        return op.objectAttributes?.collaborator ?? op.objectId
      }

      return op.objectId
    }

    operations.forEach((op) => {
      const id = getIdentityId(op)
      const existing = state.get(id)
      if (existing != null && existing.action !== op.action) {
        state.delete(id)
      } else {
        state.set(id, op)
      }
    })

    const merged = Array.from(state.values())
    if (merged.length === 0) return undefined
    return merged
  }

  const attachedToSet = new Set<Ref<Doc>>()
  const iterator = await client.traverse<DocUpdateMessage>(
    DOMAIN_ACTIVITY,
    {
      _class: activity.class.DocUpdateMessage
    },
    { projection: { attachedTo: 1 } }
  )

  while (true) {
    const docs = await iterator.next(1000)
    if (docs == null || docs.length === 0) break
    for (const d of docs) attachedToSet.add(d.attachedTo)
  }

  client.logger.log(`Found ${attachedToSet.size} unique attachedTo objects. Aggregating...`, {})
  let processedFiles = 0

  for (const attachedTo of Array.from(attachedToSet)) {
    const msgs = await client.find<DocUpdateMessage>(
      DOMAIN_ACTIVITY,
      { _class: activity.class.DocUpdateMessage, attachedTo },
      { sort: { createdOn: SortingOrder.Ascending } }
    )

    const grouped = new Map<string, DocUpdateMessage[]>()
    const toDelete = new Set<Ref<DocUpdateMessage>>()
    const toUpdate = new Map<Ref<DocUpdateMessage>, MigrateUpdate<DocUpdateMessage>>()

    for (const msg of msgs) {
      if (!canCombineMessage(msg)) continue

      const createMessage = Array.from(grouped.values())
        .map((it) => it[0])
        .find((it) => it.createdBy === msg.createdBy && it.action === 'create' && it.attachedTo === it.objectId)

      if (createMessage != null) {
        const createDiff =
          (msg.createdOn ?? msg.modifiedOn ?? 0) - (createMessage.createdOn ?? createMessage.modifiedOn ?? 0)

        if (createDiff >= 0 && createDiff <= CREATE_COMBINE_THRESHOLD) {
          const historyItem = mapToHistory(msg)

          createMessage.history = [...(createMessage.history ?? []), historyItem]

          const existingUpdate = toUpdate.get(createMessage._id) ?? {}

          toUpdate.set(createMessage._id, {
            ...existingUpdate,
            history: createMessage.history
          })

          toDelete.add(msg._id)
          continue
        }
      }

      const key = getDocUpdateMessageKey(msg)
      const combinedWith = grouped.get(key) ?? []

      const validCombinedWith = combinedWith.filter((it) => {
        const timeDiff = (msg.createdOn ?? msg.modifiedOn ?? 0) - (it.createdOn ?? it.modifiedOn ?? 0)
        return timeDiff >= 0 && timeDiff < UPDATE_COMBINE_THRESHOLD
      })

      if (validCombinedWith.length === 0) {
        grouped.set(key, [msg])
        continue
      }

      const anchor = validCombinedWith[0]
      const others = validCombinedWith.slice(1)

      if (msg.action === 'update') {
        const attributeUpdates = mergeDocUpdateAttributes(validCombinedWith, msg)
        if (attributeUpdates == null) {
          toDelete.add(msg._id)
          toDelete.add(anchor._id)
          for (const o of others) toDelete.add(o._id)
          grouped.delete(key)
          continue
        }

        const history = validCombinedWith.map(mapToHistory)

        anchor.attributeUpdates = attributeUpdates
        anchor.history = history

        toUpdate.set(anchor._id, {
          attributeUpdates,
          history
        })

        toDelete.add(msg._id)
        for (const o of others) toDelete.add(o._id)
        grouped.set(key, [anchor])
      } else {
        const merged = mergeCollectionHistory(validCombinedWith, msg)
        if (merged === undefined || merged.length === 0) {
          toDelete.add(msg._id)
          toDelete.add(anchor._id)
          for (const o of others) toDelete.add(o._id)
          grouped.delete(key)
          continue
        }

        const last = merged.pop()
        if (last == null) {
          toDelete.add(msg._id)
          toDelete.add(anchor._id)
          for (const o of others) toDelete.add(o._id)
          grouped.delete(key)
          continue
        }

        anchor.action = last.action
        anchor.objectId = last.objectId
        anchor.objectClass = last.objectClass
        anchor.objectTitle = last.objectTitle
        anchor.objectAttributes = last.objectAttributes
        anchor.attributeUpdates = last.update
        anchor.history = merged

        toUpdate.set(anchor._id, {
          action: last.action,
          objectId: last.objectId,
          objectClass: last.objectClass,
          objectTitle: last.objectTitle,
          objectAttributes: last.objectAttributes,
          attributeUpdates: last.update,
          history: merged
        })
        toDelete.add(msg._id)
        for (const o of others) toDelete.add(o._id)
        grouped.set(key, [anchor])
      }
    }

    if (toDelete.size > 0) {
      const arr = Array.from(toDelete)
      await client.deleteMany<DocNotifyContext>(DOMAIN_DOC_NOTIFY, {
        _class: notification.class.DocNotifyContext,
        objectId: { $in: arr }
      })
      await client.deleteMany<ActivityInboxNotification>(DOMAIN_NOTIFICATION, {
        _class: notification.class.ActivityInboxNotification,
        attachedTo: { $in: arr }
      })
      await client.deleteMany<ReactionInboxNotification>(DOMAIN_NOTIFICATION, {
        _class: notification.class.ReactionInboxNotification,
        attachedTo: { $in: arr }
      })
      await client.deleteMany<MentionInboxNotification>(DOMAIN_NOTIFICATION, {
        _class: notification.class.MentionInboxNotification,
        mentionedIn: { $in: arr }
      })
      await client.deleteMany(DOMAIN_ACTIVITY, { _id: { $in: arr } })
    }

    if (toUpdate.size > 0) {
      const groupedUpdates = new Map<
        string,
        { filter: MigrationDocumentQuery<DocUpdateMessage>, update: MigrateUpdate<DocUpdateMessage> }[]
      >()

      for (const [id, up] of toUpdate.entries()) {
        const query: MigrationDocumentQuery<DocUpdateMessage> = { _id: id }
        const keyList = Object.keys(up).sort().join(',')

        const group = groupedUpdates.get(keyList) ?? []
        group.push({ filter: query, update: up })
        groupedUpdates.set(keyList, group)
      }

      for (const dbUpdates of groupedUpdates.values()) {
        for (let i = 0; i < dbUpdates.length; i += 100) {
          await client.bulk(DOMAIN_ACTIVITY, dbUpdates.slice(i, i + 100))
        }
      }
    }

    processedFiles++
    if (processedFiles % 100 === 0) {
      client.logger.log(`...aggregated streams for ${processedFiles} objects`, {})
    }
  }
}

export const activityOperation: MigrateOperation = {
  async migrate (client: MigrationClient, mode): Promise<void> {
    await tryMigrate(mode, client, activityId, [
      {
        state: 'reactions',
        mode: 'upgrade',
        func: migrateReactions
      },
      {
        state: 'markup',
        mode: 'upgrade',
        func: migrateMarkup
      },
      {
        state: 'migrate-doc-update-messages-space',
        mode: 'upgrade',
        func: async (client) => {
          await migrateMessagesSpace(
            client,
            activity.class.DocUpdateMessage,
            ({ attachedTo }) => attachedTo,
            ({ attachedToClass }) => attachedToClass
          )
        }
      },
      {
        state: 'migrate-employee-space-v1',
        mode: 'upgrade',
        func: async () => {
          await client.update<ActivityMessage>(
            DOMAIN_ACTIVITY,
            { space: 'contact:space:Employee' as Ref<Space> },
            { space: contact.space.Contacts }
          )
        }
      },
      {
        state: 'migrate-activity-markup',
        mode: 'upgrade',
        func: migrateActivityMarkup
      },
      {
        state: 'move-reactions',
        mode: 'upgrade',
        func: async (client: MigrationClient): Promise<void> => {
          await client.move(DOMAIN_ACTIVITY, { _class: activity.class.Reaction }, DOMAIN_REACTION)
          await client.move(DOMAIN_ACTIVITY, { _class: activity.class.UserMentionInfo }, DOMAIN_USER_MENTION)
        }
      },
      {
        state: 'migrate-employee-space-v1',
        mode: 'upgrade',
        func: async () => {
          await client.update<ActivityMessage>(
            DOMAIN_ACTIVITY,
            { space: 'contact:space:Employee' as Ref<Space> },
            { space: contact.space.Contacts }
          )
        }
      },
      {
        state: 'migrate-activity-markup',
        mode: 'upgrade',
        func: migrateActivityMarkup
      },
      {
        state: 'move-reactions',
        mode: 'upgrade',
        func: async (client: MigrationClient): Promise<void> => {
          await client.move(DOMAIN_ACTIVITY, { _class: activity.class.Reaction }, DOMAIN_REACTION)
          await client.move(DOMAIN_ACTIVITY, { _class: activity.class.UserMentionInfo }, DOMAIN_USER_MENTION)
        }
      },
      {
        state: 'accounts-to-social-ids-v2',
        mode: 'upgrade',
        func: migrateAccountsToSocialIds
      },
      {
        state: 'accounts-in-doc-updates-v2',
        mode: 'upgrade',
        func: migrateAccountsInDocUpdates
      },
      {
        state: 'migrate-collaborators-dum-v2',
        mode: 'upgrade',
        func: migrateCollaboratorsActivity
      },
      {
        state: 'migrate-activity-attributes-v1',
        mode: 'upgrade',
        func: migrateActivityAttributes
      },
      {
        state: 'aggregate-doc-update-messages-v1',
        mode: 'upgrade',
        func: migrateAggregateDocUpdateMessages
      }
    ])
  },
  async upgrade (state: Map<string, Set<string>>, client: () => Promise<MigrationUpgradeClient>): Promise<void> {}
}

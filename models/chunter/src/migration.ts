//
// Copyright © 2022 Hardcore Engineering Inc.
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

import { type Chat, chunterId, type DirectMessage, type ThreadMessage } from '@hcengineering/chunter'
import core, {
  TxOperations,
  type Class,
  type Doc,
  type Domain,
  type Ref,
  type Space,
  DOMAIN_TX,
  DOMAIN_SPACE,
  type AccountUuid,
  DOMAIN_COLLABORATOR,
  type Collaborator
} from '@hcengineering/core'
import {
  tryMigrate,
  tryUpgrade,
  type MigrateOperation,
  type MigrationClient,
  type MigrationUpgradeClient,
  type MigrationDocumentQuery,
  type MigrateUpdate
} from '@hcengineering/model'
import activity, { migrateMessagesSpace, DOMAIN_ACTIVITY, DOMAIN_REACTION } from '@hcengineering/model-activity'
import { getAllAccounts } from '@hcengineering/contact'
import { DOMAIN_DOC_NOTIFY, DOMAIN_NOTIFICATION } from '@hcengineering/model-notification'
import { type ActivityMessage, type DocUpdateMessage, type Reaction } from '@hcengineering/activity'

import { DOMAIN_CHUNTER, DOMAIN_CHUNTER_DOC } from './index'
import chunter from './plugin'
import { createHash } from 'crypto'
import { type Attachment } from '@hcengineering/attachment'
import { DOMAIN_ATTACHMENT } from '@hcengineering/model-attachment'
import { type DocNotifyContext, type InboxNotification } from '@hcengineering/notification'

export const DOMAIN_COMMENT = 'comment' as Domain

export async function createGeneral (client: MigrationUpgradeClient, tx: TxOperations): Promise<void> {
  const current = await tx.findOne(chunter.class.Channel, { _id: chunter.space.General })
  if (current !== undefined) {
    if (current.autoJoin === undefined) {
      await tx.update(current, {
        autoJoin: true
      })
      await joinEmployees(current, tx)
    }
  } else {
    const createTx = await tx.findOne(core.class.TxCreateDoc, {
      objectId: chunter.space.General
    })

    if (createTx === undefined) {
      await tx.createDoc(
        chunter.class.Channel,
        core.space.Space,
        {
          name: 'general',
          description: 'General Channel',
          topic: 'General Channel',
          private: false,
          archived: false,
          members: await getAllAccounts(tx),
          autoJoin: true
        },
        chunter.space.General
      )
    }
  }
}

async function joinEmployees (current: Space, tx: TxOperations): Promise<void> {
  const allAccounts = await getAllAccounts(tx)
  const newMembers = [...current.members]

  for (const account of allAccounts) {
    if (!newMembers.includes(account)) {
      newMembers.push(account)
    }
  }

  await tx.update(current, {
    members: newMembers
  })
}

export async function createRandom (client: MigrationUpgradeClient, tx: TxOperations): Promise<void> {
  const current = await tx.findOne(chunter.class.Channel, { _id: chunter.space.Random })
  if (current !== undefined) {
    if (current.autoJoin === undefined) {
      await tx.update(current, {
        autoJoin: true
      })
      await joinEmployees(current, tx)
    }
  } else {
    const createTx = await tx.findOne(core.class.TxCreateDoc, {
      objectId: chunter.space.Random
    })

    if (createTx === undefined) {
      await tx.createDoc(
        chunter.class.Channel,
        core.space.Space,
        {
          name: 'random',
          description: 'Random Talks',
          topic: 'Random Talks',
          private: false,
          archived: false,
          members: await getAllAccounts(tx),
          autoJoin: true
        },
        chunter.space.Random
      )
    }
  }
}

async function convertCommentsToChatMessages (client: MigrationClient): Promise<void> {
  await client.update(
    DOMAIN_COMMENT,
    { _class: 'chunter:class:Comment' as Ref<Class<Doc>> },
    { _class: chunter.class.ChatMessage }
  )
  await client.move(DOMAIN_COMMENT, { _class: chunter.class.ChatMessage }, DOMAIN_ACTIVITY)
}

async function removeBacklinks (client: MigrationClient): Promise<void> {
  await client.deleteMany(DOMAIN_COMMENT, { _class: 'chunter:class:Backlink' as Ref<Class<Doc>> })
  await client.deleteMany(DOMAIN_ACTIVITY, {
    _class: activity.class.DocUpdateMessage,
    objectClass: 'chunter:class:Backlink'
  })
}

async function removeOldClasses (client: MigrationClient): Promise<void> {
  const classes = [
    'chunter:class:ChunterMessage',
    'chunter:class:Message',
    'chunter:class:Comment',
    'chunter:class:Backlink'
  ] as Ref<Class<Doc>>[]

  for (const _class of classes) {
    await client.deleteMany(DOMAIN_CHUNTER, { _class })
    await client.deleteMany(DOMAIN_ACTIVITY, { attachedToClass: _class })
    await client.deleteMany(DOMAIN_ACTIVITY, { objectClass: _class })
    await client.deleteMany(DOMAIN_NOTIFICATION, { attachedToClass: _class })
    await client.deleteMany(DOMAIN_TX, { objectClass: _class })
    await client.deleteMany(DOMAIN_TX, { 'tx.objectClass': _class })
  }
}

async function removeWrongActivity (client: MigrationClient): Promise<void> {
  await client.deleteMany<DocUpdateMessage>(DOMAIN_ACTIVITY, {
    _class: activity.class.DocUpdateMessage,
    attachedToClass: chunter.class.Channel,
    action: 'update',
    'attributeUpdates.attrKey': { $ne: 'members' }
  })

  await client.deleteMany<DocUpdateMessage>(DOMAIN_ACTIVITY, {
    _class: activity.class.DocUpdateMessage,
    attachedToClass: chunter.class.Channel,
    action: 'create',
    objectClass: { $ne: chunter.class.Channel }
  })

  await client.deleteMany<DocUpdateMessage>(DOMAIN_ACTIVITY, {
    _class: activity.class.DocUpdateMessage,
    attachedToClass: chunter.class.Channel,
    action: 'remove'
  })

  await client.deleteMany<DocUpdateMessage>(DOMAIN_ACTIVITY, {
    _class: activity.class.DocUpdateMessage,
    attachedToClass: chunter.class.DirectMessage,
    action: 'update',
    'attributeUpdates.attrKey': { $ne: 'members' }
  })

  await client.deleteMany<DocUpdateMessage>(DOMAIN_ACTIVITY, {
    _class: activity.class.DocUpdateMessage,
    attachedToClass: chunter.class.DirectMessage,
    action: 'create'
  })

  await client.deleteMany<DocUpdateMessage>(DOMAIN_ACTIVITY, {
    _class: activity.class.DocUpdateMessage,
    attachedToClass: chunter.class.DirectMessage,
    action: 'remove'
  })
}

async function removeChatSync (client: MigrationClient): Promise<void> {
  await client.deleteMany<DocUpdateMessage>(DOMAIN_CHUNTER, {
    _class: chunter.class.ChatSyncInfo
  })
}

async function migrateDuplicatedDirects (client: MigrationClient): Promise<void> {
  const iterator = await client.traverse<DirectMessage>(DOMAIN_SPACE, { _class: chunter.class.DirectMessage })

  const directsMap = new Map<string, Ref<DirectMessage>[]>()
  const updates: { filter: MigrationDocumentQuery<DirectMessage>, update: MigrateUpdate<DirectMessage> }[] = []
  const migrateFromTo = new Map<Ref<DirectMessage>, Ref<DirectMessage>>()

  function getMembersHash (uuids: AccountUuid[]): string | undefined {
    if (uuids.length === 0) return undefined

    return createHash('sha256').update(uuids.slice().sort().join('|')).digest().toString('base64url')
  }

  while (true) {
    const directs = (await iterator.next(500)) ?? []
    if (directs.length === 0) break

    for (const direct of directs) {
      const accounts = Array.from(new Set(direct.members))
      if (accounts.length > 2) {
        updates.push({
          filter: { _id: direct._id },
          update: { type: 'group' }
        })
        continue
      }

      updates.push({
        filter: { _id: direct._id },
        update: { type: 'person' }
      })

      if (direct.referenceId != null) continue

      const referenceId = getMembersHash(accounts)
      if (referenceId === undefined) continue

      directsMap.set(referenceId, [...(directsMap.get(referenceId) ?? []), direct._id])
    }
  }

  for (const [referenceId, directs] of directsMap) {
    if (directs.length === 0) continue
    if (directs.length === 1) {
      const direct = directs[0]
      updates.push({
        filter: { _id: direct },
        update: { referenceId }
      })
    } else {
      const toDirect = directs[0]
      updates.push({
        filter: { _id: toDirect },
        update: { referenceId }
      })
      for (const from of directs.slice(1)) {
        migrateFromTo.set(from, toDirect)
      }
    }
  }

  if (updates.length > 0) {
    await client.bulk(DOMAIN_SPACE, updates)
  }

  for (const [from, to] of migrateFromTo) {
    await client.update<ActivityMessage>(DOMAIN_ACTIVITY, { attachedTo: from }, { attachedTo: to, space: to })
    await client.update<Reaction>(DOMAIN_REACTION, { space: from }, { space: to })
    await client.update<Attachment>(DOMAIN_ATTACHMENT, { space: from }, { space: to })

    const toContexts = await client.find<DocNotifyContext>(DOMAIN_DOC_NOTIFY, { objectId: to })
    for (const context of toContexts) {
      await client.update<InboxNotification>(
        DOMAIN_NOTIFICATION,
        { objectId: from, user: context.user },
        { objectId: to, docNotifyContext: context._id }
      )
    }

    await client.deleteMany(DOMAIN_SPACE, { _id: from })
    await client.deleteMany(DOMAIN_CHUNTER_DOC, { attacheTo: from })
    await client.deleteMany<DocNotifyContext>(DOMAIN_DOC_NOTIFY, { objectId: from })
  }
}

async function removeUnavailableChats (client: MigrationClient): Promise<void> {
  const iterator = await client.traverse<Chat>(DOMAIN_CHUNTER_DOC, {
    _class: chunter.class.Chat,
    attachedToClass: { $in: [chunter.class.DirectMessage, chunter.class.Channel] }
  })

  try {
    while (true) {
      const chats = (await iterator.next(500)) ?? []
      if (chats.length === 0) break

      const spaceIds = Array.from(new Set(chats.map((c) => c.attachedTo as Ref<Space>)))
      const spaces = await client.find<Space>(DOMAIN_SPACE, { _id: { $in: spaceIds } })
      const spaceMap = new Map<Ref<Space>, Space>()
      for (const space of spaces) {
        spaceMap.set(space._id, space)
      }

      const chatsToDelete: Ref<Chat>[] = []
      const collaboratorsToDelete: Pick<Collaborator, 'attachedTo' | 'collaborator'>[] = []

      for (const chat of chats) {
        const space = spaceMap.get(chat.attachedTo as Ref<Space>)
        if (space != null && !space.members.includes(chat.account)) {
          chatsToDelete.push(chat._id)
          collaboratorsToDelete.push({ attachedTo: space._id, collaborator: chat.account })
        }
      }

      if (chatsToDelete.length > 0) {
        await client.deleteMany(DOMAIN_CHUNTER_DOC, { _id: { $in: chatsToDelete } })
      }
      if (collaboratorsToDelete.length > 0) {
        await client.deleteMany<Collaborator>(DOMAIN_COLLABORATOR, { $or: collaboratorsToDelete })
      }
    }
  } finally {
    await iterator.close()
  }
}

export const chunterOperation: MigrateOperation = {
  async migrate (client: MigrationClient, mode): Promise<void> {
    await tryMigrate(mode, client, chunterId, [
      {
        state: 'create-chat-messages',
        mode: 'upgrade',
        func: convertCommentsToChatMessages
      },
      {
        state: 'remove-backlinks',
        mode: 'upgrade',
        func: removeBacklinks
      },
      {
        state: 'migrate-chat-messages-space',
        mode: 'upgrade',
        func: async (client) => {
          await migrateMessagesSpace(
            client,
            chunter.class.ChatMessage,
            ({ attachedTo }) => attachedTo,
            ({ attachedToClass }) => attachedToClass
          )
        }
      },
      {
        state: 'migrate-thread-messages-space',
        mode: 'upgrade',
        func: async (client) => {
          await migrateMessagesSpace(
            client,
            chunter.class.ThreadMessage,
            (msg) => (msg as ThreadMessage).objectId,
            (msg) => (msg as ThreadMessage).objectClass
          )
        }
      },
      {
        state: 'remove-old-classes-v1',
        mode: 'upgrade',
        func: async (client) => {
          await removeOldClasses(client)
        }
      },
      {
        state: 'remove-wrong-activity-v1',
        mode: 'upgrade',
        func: async (client) => {
          await removeWrongActivity(client)
        }
      },
      {
        state: 'remove-chat-info-v1',
        mode: 'upgrade',
        func: async (client) => {
          await client.deleteMany(DOMAIN_CHUNTER, { _class: 'chunter:class:ChatInfo' as Ref<Class<Doc>> })
          await client.deleteMany(DOMAIN_TX, { objectClass: 'chunter:class:ChatInfo' })
          await client.update(
            DOMAIN_DOC_NOTIFY,
            { 'chunter:mixin:ChannelInfo': { $exists: true } },
            { $unset: { 'chunter:mixin:ChannelInfo': true } }
          )
          await client.deleteMany(DOMAIN_TX, { mixin: 'chunter:mixin:ChannelInfo' })
        }
      },
      {
        state: 'remove-direct-doc-update-messages',
        mode: 'upgrade',
        func: async (client) => {
          await client.deleteMany<DocUpdateMessage>(DOMAIN_ACTIVITY, {
            _class: activity.class.DocUpdateMessage,
            attachedToClass: chunter.class.DirectMessage
          })
        }
      },
      {
        state: 'remove-chat-sync-v2',
        mode: 'upgrade',
        func: removeChatSync
      },
      {
        state: 'migrate-duplicated-directs-v1',
        mode: 'upgrade',
        func: migrateDuplicatedDirects
      },
      {
        state: 'remove-unavailable-chats-v1',
        mode: 'upgrade',
        func: removeUnavailableChats
      }
    ])
  },
  async upgrade (state: Map<string, Set<string>>, client: () => Promise<MigrationUpgradeClient>, mode): Promise<void> {
    await tryUpgrade(mode, state, client, chunterId, [
      {
        state: 'create-defaults-v2',
        func: async (client) => {
          const tx = new TxOperations(client, core.account.System)
          await createGeneral(client, tx)
          await createRandom(client, tx)
        }
      }
    ])
  }
}

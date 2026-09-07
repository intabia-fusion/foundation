//
// Copyright © 2022, 2023 Hardcore Engineering Inc.
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

import activity, { ActivityMessage } from '@hcengineering/activity'
import chunter, { ChatMessage, ThreadMessage } from '@hcengineering/chunter'
import contact, { formatName, type Person } from '@hcengineering/contact'
import core, {
  Class,
  Doc,
  DocumentQuery,
  FindOptions,
  FindResult,
  Hierarchy,
  Ref,
  Timestamp,
  Tx,
  TxCreateDoc,
  TxCUD,
  TxProcessor,
  TxUpdateDoc,
  UserStatus,
  type MeasureContext,
  Collaborator,
  TxRemoveDoc,
  getClassCollaborators,
  AccountUuid,
  RateLimiter,
  WorkspaceUuid
} from '@hcengineering/core'
import notification, { DocNotifyContext, isUnreadMessageChunk, ReadState } from '@hcengineering/notification'
import {
  getAccountBySocialId,
  getAddCollaboratorsTxes,
  getPerson,
  getPersonSpaces
} from '@hcengineering/server-contact'
import { TriggerControl } from '@hcengineering/server-core'

import {
  ChannelIconPresenter,
  ChannelTitlePresenter,
  ChannelUrlPresenter,
  DirectIconPresenter,
  DirectLabelPresenter,
  DirectTitlePresenter,
  JoinChannelTypeMatch
} from './utils'
import { ChatSearchTitleProvider } from './search'

const updateChatInfoDelay = 24 * 60 * 60 * 1000 // 24 hours
const hideDelay = 14 * 24 * 60 * 60 * 1000 // 2 weeks

// UserStatus is DOMAIN_TRANSIENT: a transactor restart re-creates every user's status,
// firing N syncChat at once. Bound concurrency + coalesce so it drains behind reconnects
// (persisted 24h ChatSyncInfo is the real debounce; this only de-dups redundant runs).
const syncChatLimiter = new RateLimiter(4)
const syncChatCoalesceMs = 60 * 1000
const syncChatRecent = new Map<string, number>() // `${workspace}:${user}` -> last-run ms

export async function CommentRemove (
  doc: Doc,
  hiearachy: Hierarchy,
  findAll: <T extends Doc>(
    clazz: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<FindResult<T>>
): Promise<Doc[]> {
  if (!hiearachy.isDerived(doc._class, chunter.class.ChatMessage)) {
    return []
  }

  const chatMessage = doc as ChatMessage

  return await findAll(activity.class.ActivityReference, {
    srcDocId: chatMessage.attachedTo,
    srcDocClass: chatMessage.attachedToClass,
    attachedDocId: chatMessage._id
  })
}

async function OnThreadMessageCreated (
  ctx: MeasureContext,
  originTx: TxCUD<Doc>,
  control: TriggerControl
): Promise<Tx[]> {
  const tx = originTx as TxCreateDoc<ThreadMessage>

  const threadMessage = TxProcessor.createDoc2Doc(tx)
  const message = await ctx.with(
    'load-message',
    {},
    async () => (await control.findAll(ctx, activity.class.ActivityMessage, { _id: threadMessage.attachedTo }))[0]
  )

  if (message === undefined) {
    return []
  }

  const lastReplyTx = control.txFactory.createTxUpdateDoc<ActivityMessage>(
    threadMessage.attachedToClass,
    threadMessage.space,
    threadMessage.attachedTo,
    {
      lastReply: originTx.modifiedOn
    }
  )

  const person = await ctx.with('load-message', {}, () => getPerson(control, originTx.modifiedBy))
  if (person === undefined) {
    return [lastReplyTx]
  }

  if ((message.repliedPersons ?? []).includes(person._id)) {
    return [lastReplyTx]
  }

  const repliedPersonTx = control.txFactory.createTxUpdateDoc<ActivityMessage>(
    threadMessage.attachedToClass,
    threadMessage.space,
    threadMessage.attachedTo,
    {
      $push: { repliedPersons: person._id }
    }
  )

  return [lastReplyTx, repliedPersonTx]
}

async function OnThreadMessageDeleted (tx: Tx, control: TriggerControl): Promise<Tx[]> {
  // TODO: FIXME
  return []
  // const removeTx = tx as TxRemoveDoc<ThreadMessage>

  // const message = control.removedMap.get(removeTx.objectId) as ThreadMessage

  // if (message === undefined) {
  //   return []
  // }

  // const messages = await control.findAll(control.ctx, chunter.class.ThreadMessage, {
  //   attachedTo: message.attachedTo
  // })

  // const repliedPersons = await getPersons(control, messages.map((m) => m.createdBy).filter((pid) => pid !== undefined))

  // const updateTx = control.txFactory.createTxUpdateDoc<ActivityMessage>(
  //   message.attachedToClass,
  //   message.space,
  //   message.attachedTo,
  //   {
  //     repliedPersons: repliedPersons.map((p) => p._id),
  //     lastReply:
  //       messages.length > 0
  //         ? Math.max(...messages.map(({ createdOn, modifiedOn }) => createdOn ?? modifiedOn))
  //         : undefined
  //   }
  // )

  // return [updateTx]
}

async function OnChatMessageCreated (
  ctx: MeasureContext,
  tx: TxCreateDoc<ChatMessage>,
  control: TriggerControl
): Promise<Tx[]> {
  const hierarchy = control.hierarchy

  const message = TxProcessor.createDoc2Doc(tx)
  if (message.modifiedBy === core.account.System) return []

  const mixin = getClassCollaborators(control.modelDb, hierarchy, message.attachedToClass)
  if (mixin === undefined || mixin.provideSecurity === true) return []

  const account = await getAccountBySocialId(control, message.modifiedBy)
  if (account == null) return []

  const collaborator = (
    await control.findAll(ctx, core.class.Collaborator, {
      attachedTo: message.attachedTo,
      collaborator: account
    })
  )[0]

  if (collaborator != null) return []

  const targetDoc = (await control.findAll(ctx, message.attachedToClass, { _id: message.attachedTo }, { limit: 1 }))[0]
  if (targetDoc === undefined) return []

  const res: Tx[] = []

  res.push(...getAddCollaboratorsTxes(targetDoc._id, targetDoc._class, targetDoc.space, control, [account]))

  return res
}

async function ChunterTrigger (txes: TxCUD<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []
  for (const tx of txes) {
    if (
      tx._class === core.class.TxCreateDoc &&
      control.hierarchy.isDerived(tx.objectClass, chunter.class.ThreadMessage)
    ) {
      res.push(
        ...(await control.ctx.with('OnThreadMessageCreated', {}, (ctx) => OnThreadMessageCreated(ctx, tx, control)))
      )
    }
    if (
      tx._class === core.class.TxRemoveDoc &&
      control.hierarchy.isDerived(tx.objectClass, chunter.class.ThreadMessage)
    ) {
      res.push(...(await control.ctx.with('OnThreadMessageDeleted', {}, (ctx) => OnThreadMessageDeleted(tx, control))))
    }
    if (
      tx._class === core.class.TxCreateDoc &&
      control.hierarchy.isDerived(tx.objectClass, chunter.class.ChatMessage)
    ) {
      res.push(
        ...(await control.ctx.with('OnChatMessageCreated', {}, (ctx) =>
          OnChatMessageCreated(ctx, tx as TxCreateDoc<ChatMessage>, control)
        ))
      )
    }
  }
  return res
}

export async function syncChat (control: TriggerControl, status: UserStatus, date: Timestamp): Promise<Tx[]> {
  const syncInfo = (
    await control.ctx.with('syncChat:findSyncInfo', {}, () =>
      control.findAll(control.ctx, chunter.class.ChatSyncInfo, { user: status.user })
    )
  ).shift()
  const shouldSync = syncInfo === undefined || date - syncInfo.timestamp > updateChatInfoDelay

  if (!shouldSync) return []

  const chats = (
    await control.ctx.with('syncChat:findChats', {}, () =>
      control.findAll(control.ctx, chunter.class.Chat, {
        user: status.user,
        hidden: false,
        isPinned: false
      })
    )
  ).filter((chat) => !hierarchy.isDerived(chat.attachedToClass, chunter.class.Channel))

  const { hierarchy } = control
  const res: Tx[] = []

  const batchSize = 200

  for (let i = 0; i < chats.length; i += batchSize) {
    const batch = chats.slice(i, i + batchSize)
    const attachedToIds = batch.map((c) => c.attachedTo)

    const [contexts, readStates] = await Promise.all([
      control.findAll(control.ctx, notification.class.DocNotifyContext, {
        user: status.user,
        objectId: { $in: attachedToIds },
        unreadCount: { $gt: 0 }
      }),
      control.findAll(control.ctx, notification.class.ReadState, {
        attachedTo: { $in: attachedToIds }
      })
    ])

    const contextMap = new Map<Ref<Doc>, DocNotifyContext>()
    for (const ctx of contexts) {
      contextMap.set(ctx.objectId, ctx)
    }

    const readStateMap = new Map<Ref<Doc>, ReadState>()
    for (const state of readStates) {
      readStateMap.set(state.attachedTo, state)
    }

    for (const chat of batch) {
      const readState = readStateMap.get(chat.attachedTo)
      const lastMessageTime = readState?.latestMessageTimestamp ?? 0
      const hasRecentMessage = date - lastMessageTime <= hideDelay

      if (hasRecentMessage) continue

      const context = contextMap.get(chat.attachedTo)
      const hasNotifiedUnread =
        (context?.unreadMessages?.some((msg) => {
          if (isUnreadMessageChunk(msg)) {
            return (msg.notifiedCount ?? 0) > 0
          }
          return msg.notified === true
        }) ??
          false) ||
        (context?.unreadReactions?.length ?? 0) > 0

      if (hasNotifiedUnread) continue

      const updateTx = control.txFactory.createTxUpdateDoc(chat._class, chat.space, chat._id, {
        hidden: true
      })
      res.push(
        control.txFactory.createTxCollectionCUD(chat.attachedToClass, chat.attachedTo, chat.space, 'chats', updateTx)
      )
    }
  }

  control.ctx.info(`Hidden ${res.length} chats for ${status.user}`)

  if (syncInfo === undefined) {
    const personSpace = (await getPersonSpaces(control)).find((it) => it.account === status.user)
    if (personSpace !== undefined) {
      res.push(
        control.txFactory.createTxCreateDoc(chunter.class.ChatSyncInfo, personSpace._id, {
          user: status.user,
          timestamp: date
        })
      )
    }
  } else {
    res.push(
      control.txFactory.createTxUpdateDoc(syncInfo._class, syncInfo.space, syncInfo._id, {
        timestamp: date
      })
    )
  }

  return res
}

// Skip if the same (workspace, user) ran within the coalesce window. Opportunistic prune.
function shouldRunSyncChat (workspace: WorkspaceUuid, user: AccountUuid, now: number): boolean {
  const key = `${workspace}:${user}`
  const last = syncChatRecent.get(key) ?? 0
  if (now - last < syncChatCoalesceMs) return false
  syncChatRecent.set(key, now)
  if (syncChatRecent.size > 5000) {
    for (const [k, t] of syncChatRecent) {
      if (now - t > syncChatCoalesceMs) syncChatRecent.delete(k)
    }
  }
  return true
}

async function OnUserStatus (txes: TxCUD<UserStatus>[], control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []
  const now = Date.now()

  for (const tx of txes) {
    if (tx.objectClass !== core.class.UserStatus) continue

    let status: UserStatus | undefined

    if (tx._class === core.class.TxCreateDoc) {
      const createTx = tx as TxCreateDoc<UserStatus>
      if (createTx.attributes.online) {
        status = TxProcessor.createDoc2Doc(createTx)
      }
    } else if (tx._class === core.class.TxUpdateDoc) {
      const updateTx = tx as TxUpdateDoc<UserStatus>
      if (updateTx.operations.online === true) {
        status = (await control.findAll(control.ctx, core.class.UserStatus, { _id: updateTx.objectId }))[0]
      }
    }

    if (status === undefined) continue
    if (!shouldRunSyncChat(control.workspace.uuid, status.user, now)) continue

    // Bound concurrency so a reconnect storm's N syncChats don't saturate the event loop.
    const st = status
    const date = tx.modifiedOn
    res.push(...(await syncChatLimiter.exec(() => syncChat(control, st, date))))
  }

  await control.apply(control.ctx, res, true)
  return []
}

async function OnCollaboratorAdded (txes: TxCreateDoc<Collaborator>[], control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []
  const spaces = await getPersonSpaces(control)
  for (const tx of txes) {
    const collaborator = TxProcessor.createDoc2Doc(tx)
    const space = spaces.find((s) => s.account === collaborator.collaborator)
    if (space == null) continue
    if (control.hierarchy.classHierarchyMixin(collaborator.attachedToClass, activity.mixin.ActivityDoc) == null) {
      continue
    }

    const createTx = control.txFactory.createTxCreateDoc(chunter.class.Chat, space._id, {
      attachedTo: collaborator.attachedTo,
      attachedToClass: collaborator.attachedToClass,
      account: collaborator.collaborator,
      pinned: false,
      hidden: false,
      collection: 'chats'
    })
    res.push(
      control.txFactory.createTxCollectionCUD(
        collaborator.attachedToClass,
        collaborator.attachedTo,
        space._id,
        'chats',
        createTx
      )
    )
  }

  return res
}

async function OnCollaboratorRemoved (txes: TxRemoveDoc<Collaborator>[], control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []
  for (const tx of txes) {
    const collaborator = control.removedMap.get(tx.objectId) as Collaborator | undefined
    if (collaborator == null) continue
    if (control.hierarchy.classHierarchyMixin(collaborator.attachedToClass, activity.mixin.ActivityDoc) == null) {
      continue
    }
    const chats = await control.findAll(control.ctx, chunter.class.Chat, {
      account: collaborator.collaborator,
      attachedTo: collaborator.attachedTo
    })
    if (chats.length === 0) continue
    res.push(
      ...chats.map((chat) =>
        control.txFactory.createTxCollectionCUD(
          chat.attachedToClass,
          chat.attachedTo,
          chat.space,
          'chats',
          control.txFactory.createTxRemoveDoc(chat._class, chat.space, chat._id)
        )
      )
    )
  }

  return res
}

async function OnPersonNameChanged (txes: TxUpdateDoc<Person>[], control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []
  for (const tx of txes) {
    if (tx.objectClass !== contact.class.Person) continue
    if (tx._class !== core.class.TxUpdateDoc) continue

    const { name } = tx.operations
    if (name == null) continue
    const person = (await control.findAll(control.ctx, contact.class.Person, { _id: tx.objectId }))[0]
    if (person?.personUuid == null) continue
    const directs = await control.findAll(control.ctx, chunter.class.DirectMessage, {
      members: person.personUuid as AccountUuid
    })
    for (const direct of directs) {
      const persons = await control.findAll(control.ctx, contact.class.Person, { personUuid: { $in: direct.members } })
      const directName = persons.map((p) => formatName(p.name, control.branding?.lastNameFirst)).join(', ')
      res.push(control.txFactory.createTxUpdateDoc(direct._class, direct.space, direct._id, { name: directName }))
    }
  }
  return res
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    ChunterTrigger,
    OnUserStatus,
    OnCollaboratorAdded,
    OnCollaboratorRemoved,
    OnPersonNameChanged
  },
  function: {
    CommentRemove,
    ChannelUrlPresenter,
    ChannelTitlePresenter,
    DirectTitlePresenter,
    DirectLabelPresenter,
    JoinChannelTypeMatch,
    ChatSearchTitleProvider,
    ChannelIconPresenter,
    DirectIconPresenter
  }
})

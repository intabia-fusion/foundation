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

import core, { Doc, DocumentUpdate, Ref, TxCreateDoc, TxCUD, TxProcessor } from '@hcengineering/core'
import notification, {
  CreateNotificationAction,
  DocNotifyContext,
  ReadNotificationAction,
  NotificationIntl,
  CommonNotification,
  CommonNotificationLite,
  NotificationType,
  NotificationProvider,
  isUnreadMessageChunk,
  isUnreadMessageId,
  UnreadMessageId,
  UnreadMessageChunk
} from '@hcengineering/notification'
import activity, { ActivityMessage } from '@hcengineering/activity'
import { truncateMessage, Sender } from '@hcengineering/server-notification'
import { markupToText } from '@hcengineering/text-core'

import { Client, NotifyProviders, Result, TxCache } from '../types'
import Cache from '../cache'
import { pushNotification } from './notification'
import { getAllowedProviders, getBaseDisplayParams, getEmptyTxCache, getObjectDisplayData } from '../utils/utils'

export async function handleReadNotificationAction (
  client: Client,
  cache: Cache,
  result: Result,
  _tx: TxCUD<ReadNotificationAction>
): Promise<void> {
  if (_tx._class !== core.class.TxCreateDoc) return

  const tx = _tx as TxCreateDoc<ReadNotificationAction>
  const action = TxProcessor.createDoc2Doc(tx)

  const context = await cache.getContext(action.attachedTo, action.account)
  if (context == null) {
    client.ctx.warn('Context not found for read notification action', {
      attachedTo: action.attachedTo,
      account: action.account
    })
    return
  }

  const { reactionIds = [], messageIds = [], commonIds = [], mentionIds = [] } = action

  const ops: DocumentUpdate<DocNotifyContext> = { $pull: {} }
  let decrease = 0

  if (reactionIds.length > 0) {
    const toRead = (context.unreadReactions ?? []).filter((r) => reactionIds.includes(r.id))
    if (toRead.length > 0) {
      ops.$pull = {
        ...ops.$pull,
        unreadReactions: { id: { $in: toRead.map((r) => r.id) } }
      }
      decrease += toRead.length
    }
  }

  if (commonIds.length > 0) {
    const toRead = (context.unreadCommons ?? []).filter((c) => commonIds.includes(c.id))
    if (toRead.length > 0) {
      ops.$pull = {
        ...ops.$pull,
        unreadCommons: { id: { $in: toRead.map((c) => c.id) } }
      }
      decrease += toRead.length
    }
  }

  if (mentionIds.length > 0) {
    const toRead = (context.unreadMentions ?? []).filter((m) => mentionIds.includes(m.id))
    if (toRead.length > 0) {
      ops.$pull = {
        ...ops.$pull,
        unreadMentions: { id: { $in: toRead.map((m) => m.id) } }
      }
      decrease += toRead.length
    }
  }

  const unreadMessagesToRead: UnreadMessageId[] = []
  const unreadChunksToRead: UnreadMessageChunk[] = []

  let maxTs = 0
  if (messageIds.length > 0) {
    const hasChunks = (context.unreadMessages ?? []).some(isUnreadMessageChunk)
    if (hasChunks) {
      const messages: Pick<ActivityMessage, '_id' | 'createdOn'>[] = await client.findAll(
        activity.class.ActivityMessage,
        { _id: { $in: messageIds }, attachedTo: action.attachedTo },
        { projection: { _id: 1, createdOn: 1 } }
      )
      maxTs = messages.reduce((max, msg) => (msg.createdOn != null && msg.createdOn > max ? msg.createdOn : max), 0)
    }
  }

  for (const unread of context.unreadMessages ?? []) {
    if (isUnreadMessageId(unread)) {
      if (messageIds.includes(unread.id) || (maxTs > 0 && unread.createdOn <= maxTs)) {
        unreadMessagesToRead.push(unread)
      }
    } else if (isUnreadMessageChunk(unread)) {
      if (maxTs > 0 && unread.to <= maxTs) {
        unreadChunksToRead.push(unread)
      }
    }
  }

  if (unreadMessagesToRead.length > 0) {
    ops.$pull = {
      ...ops.$pull,
      unreadMessages: { id: { $in: unreadMessagesToRead.map((it) => it.id) } }
    }
    decrease += unreadMessagesToRead.filter((it) => it.notified === true).length
  }

  if (decrease > 0) {
    ops.$inc = { unreadCount: -decrease }
  }

  if (Object.keys(ops.$pull ?? {}).length > 0 || ops.$inc != null) {
    result.updateContextTx.push(client.txFactory.createTxUpdateDoc(context._class, context.space, context._id, ops))
  }

  if (unreadChunksToRead.length > 0) {
    const chunkDecrease = unreadChunksToRead.reduce((acc, it) => acc + (it.notifiedCount ?? 0), 0)
    const chunkOps: DocumentUpdate<DocNotifyContext> = {
      $pull: {
        unreadMessages: { to: { $in: unreadChunksToRead.map((it) => it.to) } }
      },
      ...(chunkDecrease > 0 ? { $inc: { unreadCount: -chunkDecrease } } : {})
    }
    result.updateContextTx.push(
      client.txFactory.createTxUpdateDoc(context._class, context.space, context._id, chunkOps)
    )
  }
}

export async function handleCreateNotificationAction (
  client: Client,
  cache: Cache,
  txCache: TxCache,
  result: Result,
  _tx: TxCUD<CreateNotificationAction>
): Promise<void> {
  if (_tx._class !== core.class.TxCreateDoc) return

  const tx = _tx as TxCreateDoc<CreateNotificationAction>
  const action = TxProcessor.createDoc2Doc(tx)

  const doc = await cache.getDoc(action.attachedTo, action.attachedToClass)
  if (doc === undefined) {
    client.ctx.warn('Document not found for create notification action', {
      docId: action.attachedTo,
      docClass: action.attachedToClass
    })
    return
  }

  const receivers = await cache.getReceivers([action.account])
  const receiver = receivers[0]
  if (receiver === undefined) {
    client.ctx.warn('Receiver not found for create notification action', { receiverAccount: action.account })
    return
  }

  const settings = await cache.getSettings()
  const type =
    action.type != null ? await client.findOne(notification.class.NotificationType, { _id: action.type }) : undefined

  const providers: Ref<NotificationProvider>[] =
    type != null ? getAllowedProviders(client, settings, receiver.socialIds, type) : []
  if (
    type != null &&
    (providers.length === 0 || !providers.includes(notification.providers.InboxNotificationProvider))
  ) {
    return
  }

  const context = await cache.getContext(doc._id, action.account)

  const objectDisplayData = await getObjectDisplayData(client, cache, getEmptyTxCache(), doc, action.account)
  const pushSubscriptions = await cache.getPushSubscriptions(action.account)
  const sender = await cache.getSender(action.createdBy ?? action.modifiedBy)

  const intl: NotificationIntl = await getIntl(
    client,
    txCache,
    action.notification,
    action.intl,
    type,
    doc,
    sender,
    receiver.language
  )
  const commonNotification: CommonNotification = {
    ...action.notification,
    intlParams: intl.intlParams,
    intlParamsNotLocalized: intl.intlParamsNotLocalized,
    id: tx._id,
    type: 'common',
    createdOn: tx.createdOn ?? tx.modifiedOn,
    createdBy: tx.createdBy ?? tx.modifiedBy
  }

  const notifyProviders: NotifyProviders = type != null ? Object.fromEntries(providers.map((p) => [p, [type]])) : {}
  await pushNotification(client, getEmptyTxCache(), result, context, {
    receiver,
    objectId: doc._id,
    objectClass: doc._class,
    objectSpace: doc.space,
    objectDisplayData,
    notification: commonNotification,
    pushSubscriptions,
    notifyProviders,
    intl,
    unreadCommon: commonNotification
  })
}

async function getIntl (
  client: Client,
  txCache: TxCache,
  commonNotification: CommonNotificationLite,
  intl: Partial<NotificationIntl> | undefined,
  type: NotificationType | undefined,
  doc: Doc,
  sender: Sender,
  receiverLang: string
): Promise<NotificationIntl> {
  const { intlParams, intlParamsNotLocalized = {} } = await getBaseDisplayParams(
    client,
    txCache,
    type,
    doc,
    sender,
    receiverLang
  )
  for (const [k, v] of Object.entries(intl?.intlParams ?? {})) {
    intlParams[k] = v
  }
  for (const [k, v] of Object.entries(intl?.intlParamsNotLocalized ?? {})) {
    intlParamsNotLocalized[k] = v
  }

  if (commonNotification.markup != null) {
    intlParams.message = truncateMessage(markupToText(commonNotification.markup))
  } else if (commonNotification.messageIntl != null) {
    intlParamsNotLocalized.message = commonNotification.messageIntl
  }

  if (commonNotification.header != null) {
    intlParamsNotLocalized.title = commonNotification.header.titleIntl
  }

  const message = intlParams.message ?? intlParamsNotLocalized.message
  return {
    titleIntl:
      intlParams.identifier != null
        ? notification.string.CommonNotificationTitleWithIdentifier
        : notification.string.CommonNotificationTitle,
    bodyIntl:
      message != null ? notification.string.MessageNotificationBody : notification.string.UpdateNotificationBody,
    intlParams,
    intlParamsNotLocalized
  }
}

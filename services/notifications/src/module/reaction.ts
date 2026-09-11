//
// Copyright © 2026 Intabia Fusion Inc.
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

import core, { Doc, DocumentUpdate, Ref, TxCreateDoc, TxCUD, TxProcessor, TxRemoveDoc } from '@hcengineering/core'
import activity, { ActivityMessage, Reaction } from '@hcengineering/activity'
import { truncateMessage, Sender } from '@hcengineering/server-notification'
import { isEmptyMarkup, markupToText } from '@hcengineering/text-core'
import notification, {
  DocNotifyContext,
  NotificationIntl,
  NotificationProvider,
  TxNotificationType
} from '@hcengineering/notification'

import { Client, NotifyProviders, Result, TxCache } from '../types'
import Cache from '../cache'
import {
  getAllowedProviders,
  getAttachments,
  getBaseDisplayParams,
  getLastNotify,
  getObjectDisplayData,
  hasReactionNotification,
  hasUnreadReaction,
  toNotificationMessage
} from '../utils/utils'
import { pushNotification } from './notification'

export async function handleReaction (
  client: Client,
  cache: Cache,
  txCache: TxCache,
  result: Result,
  tx: TxCUD<Reaction>
): Promise<void> {
  if (tx._class === core.class.TxCreateDoc) {
    await handleCreateReaction(client, cache, txCache, result, tx as TxCreateDoc<Reaction>)
  } else if (tx._class === core.class.TxRemoveDoc) {
    await handleRemoveReaction(client, cache, result, tx as TxRemoveDoc<Reaction>)
  }
}

async function handleCreateReaction (
  client: Client,
  cache: Cache,
  txCache: TxCache,
  result: Result,
  tx: TxCreateDoc<Reaction>
): Promise<void> {
  if (tx.attachedTo === undefined) {
    client.ctx.error('Cannot create reaction notification for null attachedTo', tx)
    return
  }

  const reaction = TxProcessor.createDoc2Doc(tx)

  const message = await client.findOne(activity.class.ActivityMessage, { _id: reaction.attachedTo })
  if (message === undefined) {
    client.ctx.warn('Message not found for reaction creation', { reaction: tx.objectId, message: tx.attachedTo })
    return
  }

  const socialId = message.createdBy ?? message.modifiedBy
  if (socialId === core.account.System || socialId === tx.modifiedBy) return

  const doc = await cache.getDoc(message.attachedTo, message.attachedToClass)
  if (doc === undefined) {
    client.ctx.warn('Document not found for reaction creation', {
      message: message._id,
      reaction: tx.objectId,
      docId: message.attachedTo,
      docClass: message.attachedToClass
    })
    return
  }

  const account = await cache.getAccountBySocialId(socialId)
  if (account == null) {
    client.ctx.warn('Account not found for reaction creation', { socialId })
    return
  }

  const receiver = (await cache.getReceivers([account]))[0]
  if (receiver === undefined) return

  const settings = await cache.getSettings()

  const type: TxNotificationType = client.model.findAllSync(notification.class.TxNotificationType, {
    _id: activity.ids.AddReactionNotification
  })[0]

  const providers: Ref<NotificationProvider>[] = getAllowedProviders(client, settings, receiver.socialIds, type)
  if (providers.length === 0 || !providers.includes(notification.providers.InboxNotificationProvider)) return

  const context = (await cache.getContexts(doc._id)).find((it) => it.user === receiver.account)
  const sender = await cache.getSender(reaction.modifiedBy)
  const notifyProviders: NotifyProviders = Object.fromEntries(providers.map((p) => [p, [type]]))

  const objectDisplayData = await getObjectDisplayData(client, cache, txCache, doc, receiver.account)
  const attachments = await getAttachments(message, client)
  const pushSubscriptions = await cache.getPushSubscriptions(receiver.account)

  await pushNotification(client, txCache, result, context, {
    unreadReaction: {
      attachedTo: message._id,
      id: reaction._id
    },
    receiver,
    objectId: doc._id,
    objectClass: doc._class,
    objectSpace: doc.space,
    objectDisplayData,
    notification: {
      id: reaction._id,
      type: 'reaction',
      messageId: message._id,
      message: toNotificationMessage(message),
      attachments,
      reaction,
      createdOn: reaction.createdOn ?? reaction.modifiedOn,
      createdBy: reaction.createdBy ?? reaction.modifiedBy
    },
    intl: await getReactionNotificationContent(
      client,
      txCache,
      type,
      doc,
      message,
      reaction,
      sender,
      receiver.language
    ),
    notifyProviders,
    pushSubscriptions
  })
}

async function handleRemoveReaction (
  client: Client,
  cache: Cache,
  result: Result,
  tx: TxRemoveDoc<Reaction>
): Promise<void> {
  if (tx.attachedTo === undefined) {
    client.ctx.error('Cannot remove reaction notification for null attachedTo', tx)
    return
  }

  const message = await client.findOne(activity.class.ActivityMessage, { _id: tx.attachedTo as Ref<ActivityMessage> })
  if (message === undefined) {
    client.ctx.warn('Message not found for reaction removal', { reaction: tx.objectId, message: tx.attachedTo })
    return
  }

  const account = await cache.getAccountBySocialId(message.createdBy ?? message.modifiedBy)
  if (account == null) {
    client.ctx.warn('Account not found for reaction removal', { socialId: message.createdBy ?? message.modifiedBy })
    return
  }

  const contexts = await client.findAll(notification.class.DocNotifyContext, {
    user: account,
    objectId: message.attachedTo
  })

  for (const context of contexts) {
    const ops: DocumentUpdate<DocNotifyContext> = {}

    if (hasUnreadReaction(context, tx.objectId)) {
      ops.$pull = { unreadReactions: { id: tx.objectId } }
      ops.$inc = { unreadCount: -1 }
    }
    if (hasReactionNotification(context, tx.objectId)) {
      ops.$pull = {
        ...ops.$pull,
        latestNotifications: { id: tx.objectId }
      }
    }

    if (Object.keys(ops).length > 0) {
      const updateTx = client.txFactory.createTxUpdateDoc(context._class, context.space, context._id, ops)
      const updatedContext = TxProcessor.updateDoc2Doc(context, updateTx)
      const lastNotify = getLastNotify(updatedContext)

      if (lastNotify !== context.lastNotify) {
        updateTx.operations.lastNotify = lastNotify
      }
      result.updateContextTx.push(updateTx)
    }
  }
}

async function getReactionNotificationContent (
  client: Client,
  txCache: TxCache,
  type: TxNotificationType,
  doc: Doc,
  message: ActivityMessage,
  reaction: Reaction,
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

  if (message.message != null && !isEmptyMarkup(message.message)) {
    intlParams.title = truncateMessage(markupToText(message.message), 100)
  } else {
    intlParamsNotLocalized.title = activity.string.Message
  }

  intlParams.reaction = reaction.emoji

  return {
    titleIntl: activity.string.ReactionNotificationTitle,
    bodyIntl: activity.string.ReactionNotificationBody,
    intlParams,
    intlParamsNotLocalized
  }
}

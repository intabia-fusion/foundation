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

import core, {
  AccountUuid,
  TxCreateDoc,
  TxCUD,
  TxRemoveDoc,
  TxUpdateDoc,
  TxProcessor,
  DocumentUpdate,
  Doc,
  Ref,
  generateId
} from '@hcengineering/core'
import activity, { ActivityMessage, DocUpdateMessage } from '@hcengineering/activity'
import notification, {
  DocNotifyContext,
  NotificationIntl,
  NotificationType,
  UnreadMessage,
  UnreadMessageChunk,
  isUnreadMessageId,
  isUnreadMessageChunk,
  ContextNotification
} from '@hcengineering/notification'
import { truncateMessage, Sender, Receiver } from '@hcengineering/server-notification'
import { isEmptyMarkup, markupToText } from '@hcengineering/text-core'
import chunter, { ChatMessage } from '@hcengineering/chunter'

import {
  getBaseDisplayParams,
  getCollaboratorAccounts,
  getObjectDisplayData,
  getNotificationsByMessage,
  getMessageNotifyProviders,
  getMode,
  getNotifiedUsers,
  hasMessageNotification,
  isMuted,
  toNotificationMessage,
  hasReactionNotificationByMessage,
  getLastNotify,
  hasMentionNotificationByMessage,
  getAttachments,
  getCreateContextTx
} from '../utils/utils'
import { Client, Result, TxCache, NotifyProviders } from '../types'
import Cache from '../cache'
import { pushNotification as _pushNotification } from './notification'
import { appendAndCollapseUnreadMessages } from '../utils/collapse'
import config from '../config'
import { translate } from '@hcengineering/platform'

export async function handleMessage (
  client: Client,
  cache: Cache,
  txCache: TxCache,
  result: Result,
  tx: TxCUD<ActivityMessage>
): Promise<void> {
  if (tx._class === core.class.TxCreateDoc) {
    await handleCreateMessage(client, cache, txCache, result, tx as TxCreateDoc<ActivityMessage>)
  } else if (tx._class === core.class.TxRemoveDoc) {
    await handleRemoveMessage(client, cache, result, tx as TxRemoveDoc<ActivityMessage>)
  } else if (tx._class === core.class.TxUpdateDoc) {
    await handleUpdateMessage(client, cache, txCache, result, tx as TxUpdateDoc<ActivityMessage>)
  }
}

async function handleCreateMessage (
  client: Client,
  cache: Cache,
  txCache: TxCache,
  result: Result,
  tx: TxCreateDoc<ActivityMessage>
): Promise<void> {
  const message = TxProcessor.createDoc2Doc(tx)

  const doc = await cache.getDoc(message.attachedTo, message.attachedToClass)
  if (doc === undefined) {
    client.ctx.warn('Document not found for message creation', {
      messageId: message._id,
      docId: message.attachedTo,
      docClass: message.attachedToClass
    })
    return
  }

  const space = await cache.getDocSpace(doc)
  if (space === undefined) {
    client.ctx.warn('Space not found for message creation', {
      messageId: message._id,
      docId: doc._id,
      docClass: doc._class
    })
    return
  }

  const notified = getNotifiedUsers(result)
  const collaborators = await getCollaboratorAccounts(client, cache, doc, space, notified)

  if (client.hierarchy.isDerived(message._class, activity.class.DocUpdateMessage)) {
    const dum = message as DocUpdateMessage

    if (dum.objectClass === core.class.Collaborator) {
      const acc = dum.objectAttributes?.collaborator as AccountUuid | undefined
      if (acc != null && !collaborators.includes(acc)) collaborators.push(acc)
    }
  }

  if (collaborators.length === 0) return

  const receivers = await cache.getReceivers(collaborators)
  if (receivers.length === 0) {
    client.ctx.warn('No receivers resolved for message creation collaborators', {
      messageId: message._id,
      collaborators
    })
    return
  }

  const settings = await cache.getSettings()
  const contexts = await cache.getContexts(doc._id)
  const docSettings = await cache.getDocSettings(doc._id)
  const sender = await cache.getSender(message.modifiedBy)
  const readState = await cache.getDocReadState(doc._id)

  const unreadMessage: UnreadMessage = {
    id: message._id,
    createdOn: message.createdOn ?? message.modifiedOn
  }
  const messageTimestamp = message.createdOn ?? message.modifiedOn

  const attachments = await getAttachments(message, client)

  for (const receiver of receivers) {
    if (receiver.account === sender.account) continue

    const readPosition = readState?.[receiver.account]
    const alreadyRead = readPosition != null && readPosition.timestamp >= messageTimestamp

    const mode = getMode(docSettings, receiver.account)

    const context = contexts.find((it) => it.user === receiver.account)
    const notifyResult = !isMuted(mode)
      ? await getMessageNotifyProviders(client, message, doc, receiver, settings, mode)
      : {}
    const type = (notifyResult[notification.providers.InboxNotificationProvider] ?? [])[0]

    if (type != null) {
      await pushNotification(
        client,
        cache,
        receiver,
        doc,
        message,
        sender,
        alreadyRead ? undefined : unreadMessage,
        context,
        result,
        txCache,
        type,
        notifyResult,
        attachments
      )
    } else if (!alreadyRead) {
      await addUnreadMessage(client, receiver, doc, unreadMessage, context, result, txCache, cache)
    }
  }
}

async function handleRemoveMessage (
  client: Client,
  cache: Cache,
  result: Result,
  tx: TxRemoveDoc<ActivityMessage>
): Promise<void> {
  if (tx.attachedTo == null) {
    client.ctx.error('Cannot remove message notification for null attachedTo', tx)
    return
  }
  if (tx.removedDoc == null) {
    client.ctx.error('Cannot process TxRemoveDoc for ActivityMessage, removedDoc is undefined', tx)
    return
  }

  const contexts = await cache.getContexts(tx.attachedTo)

  for (const context of contexts) {
    let operations: DocumentUpdate<DocNotifyContext> = {}
    const idsToRemove: string[] = getNotificationsByMessage(context, tx.objectId).map((it) => it.id)

    if (idsToRemove.length > 0) {
      operations = {
        ...(await restoreLatestNotifications(client, context, idsToRemove))
      }
    }
    const unread = context.unreadMessages?.find((it) => isUnreadMessageId(it) && String(it.id) === String(tx.objectId))
    if (unread != null) {
      operations.$pull = {
        ...operations.$pull,
        unreadMessages: { id: tx.objectId }
      }
      if (isUnreadMessageId(unread) && unread.notified === true) {
        operations.$inc = {
          ...operations.$inc,
          unreadCount: (operations.$inc?.unreadCount ?? 0) - 1
        }
      }
    } else {
      const createdOn = tx.removedDoc?.createdOn
      if (createdOn !== undefined) {
        const unreadMessages = context.unreadMessages ?? []
        const chunkIndex = unreadMessages.findIndex(
          (it) => isUnreadMessageChunk(it) && it.from <= createdOn && createdOn <= it.to
        )
        if (chunkIndex !== -1) {
          const chunk = { ...unreadMessages[chunkIndex] } as any as UnreadMessageChunk
          let decrease = 0
          if (chunk.count > 1) {
            chunk.count -= 1
            if (chunk.notifiedCount !== undefined && chunk.notifiedCount > 0) {
              chunk.notifiedCount -= 1
              decrease = 1
              if (chunk.notifiedCount === 0) {
                delete chunk.notifiedCount
              }
            }
            unreadMessages[chunkIndex] = chunk as any
          } else {
            if (chunk.notifiedCount === 1) {
              decrease = 1
            }
            unreadMessages.splice(chunkIndex, 1)
          }

          operations.unreadMessages = unreadMessages
          if (decrease > 0) {
            operations.$inc = {
              ...operations.$inc,
              unreadCount: (operations.$inc?.unreadCount ?? 0) - decrease
            }
          }
        }
      }
    }

    const matchingReactionsCount = context.unreadReactions?.filter((it) => it.attachedTo === tx.objectId).length ?? 0
    if (matchingReactionsCount > 0) {
      operations.$pull = {
        ...operations.$pull,
        unreadReactions: { attachedTo: tx.objectId }
      }
      operations.$inc = {
        ...operations.$inc,
        unreadCount: (operations.$inc?.unreadCount ?? 0) - matchingReactionsCount
      }
    }

    if (Object.keys(operations).length === 0) continue

    const updateTx = client.txFactory.createTxUpdateDoc(context._class, context.space, context._id, operations)
    const updatedContext = TxProcessor.updateDoc2Doc(context, updateTx)
    const lastNotify = getLastNotify(updatedContext)

    if (lastNotify !== context.lastNotify) {
      updateTx.operations.lastNotify = lastNotify
    }
    result.updateContextTx.push(updateTx)
  }
}

async function handleUpdateMessage (
  client: Client,
  cache: Cache,
  txCache: TxCache,
  result: Result,
  tx: TxUpdateDoc<ActivityMessage>
): Promise<void> {
  const isDUM = client.hierarchy.isDerived(tx.objectClass, activity.class.DocUpdateMessage)
  if (isDUM) {
    await handleUpdateDUM(client, cache, txCache, result, tx as TxUpdateDoc<DocUpdateMessage>)
  }

  if (tx.operations.message == null && (tx.operations as any).attachments === null && !isDUM) return

  const _message = await cache.getDoc(tx.objectId, tx.objectClass)
  if (_message === undefined) {
    client.ctx.warn('Message not found for update', { messageId: tx.objectId, messageClass: tx.objectClass })
    return
  }

  const message = TxProcessor.updateDoc2Doc(_message, tx)

  const doc = await cache.getDoc(message.attachedTo, message.attachedToClass)
  if (doc === undefined) {
    client.ctx.warn('Document not found for message update', {
      messageId: message._id,
      docId: message.attachedTo,
      docClass: message.attachedToClass
    })
    return
  }

  const contexts = await cache.getContexts(doc._id)
  const attachments = await getAttachments(message, client)
  for (const context of contexts) {
    // Check if the notification exists in this context before emitting update
    const ops: DocumentUpdate<DocNotifyContext> = {}

    if (hasMessageNotification(context, tx.objectId) || hasReactionNotificationByMessage(context, tx.objectId)) {
      ops.$update = {
        ...ops.$update,
        latestNotifications: {
          $query: { messageId: tx.objectId },
          $update: {
            message: toNotificationMessage(message),
            attachments
          }
        }
      }
    } else if (hasMentionNotificationByMessage(context, tx.objectId)) {
      ops.$update = {
        ...ops.$update,
        latestNotifications: {
          $query: { type: 'mention', messageId: tx.objectId },
          $update: {
            markup: message.message,
            attachments
          }
        }
      }
    }

    if (Object.keys(ops).length > 0) {
      result.updateContextTx.push(client.txFactory.createTxUpdateDoc(context._class, context.space, context._id, ops))
    }
  }

  const threadContexts = await cache.getContexts(message._id)

  for (const context of threadContexts) {
    result.updateContextTx.push(
      client.txFactory.createTxUpdateDoc(context._class, context.space, context._id, {
        object: toNotificationMessage(message)
      })
    )
  }
}

async function handleUpdateDUM (
  client: Client,
  cache: Cache,
  txCache: TxCache,
  result: Result,
  tx: TxUpdateDoc<DocUpdateMessage>
): Promise<void> {
  const ops = tx.operations ?? {}
  const historyChanged =
    ops.history !== undefined || ops.$push?.history !== undefined || ops.$pull?.history !== undefined

  const isCombine = ops.$push?.history !== undefined && Object.keys(ops).length === 1

  if (!historyChanged || isCombine) {
    return
  }

  const _message = await cache.getDoc(tx.objectId, tx.objectClass)
  if (_message === undefined) return

  const message = TxProcessor.updateDoc2Doc(_message, tx)

  const doc = await cache.getDoc(message.attachedTo, message.attachedToClass)
  if (doc === undefined) return

  const space = await cache.getDocSpace(doc)
  if (space === undefined) return

  const notified = getNotifiedUsers(result)
  const collaborators = await getCollaboratorAccounts(client, cache, doc, space, notified)

  if (message.objectClass === core.class.Collaborator) {
    const acc = message.objectAttributes?.collaborator as AccountUuid | undefined
    if (acc != null && !collaborators.includes(acc)) collaborators.push(acc)
  }

  if (collaborators.length === 0) return

  const receivers = await cache.getReceivers(collaborators)
  if (receivers.length === 0) return

  const sender = await cache.getSender(tx.modifiedBy)
  const settings = await cache.getSettings()
  const docSettings = await cache.getDocSettings(doc._id)
  const contexts = await cache.getContexts(doc._id)
  const readState = await cache.getDocReadState(doc._id)

  const unreadMessage: UnreadMessage = {
    id: message._id,
    createdOn: message.createdOn ?? message.modifiedOn
  }
  const messageTimestamp = message.createdOn ?? message.modifiedOn

  for (const receiver of receivers) {
    if (receiver.account === sender.account) continue

    const readPosition = readState?.[receiver.account]
    const alreadyRead = readPosition != null && readPosition.timestamp >= messageTimestamp

    const mode = getMode(docSettings, receiver.account)

    const context = contexts.find((it) => it.user === receiver.account)

    if (context != null) {
      pullDUMFromContext(client, context, tx.objectId, result)
    }

    const notifyResult = !isMuted(mode)
      ? await getMessageNotifyProviders(client, message, doc, receiver, settings, mode)
      : {}
    const type = (notifyResult[notification.providers.InboxNotificationProvider] ?? [])[0]

    if (type != null) {
      await pushNotification(
        client,
        cache,
        receiver,
        doc,
        message,
        sender,
        alreadyRead ? undefined : unreadMessage,
        context,
        result,
        txCache,
        type,
        notifyResult,
        []
      )
    } else if (!alreadyRead) {
      await addUnreadMessage(client, receiver, doc, unreadMessage, context, result, txCache, cache)
    }
  }
}

async function getMessageIntl (
  client: Client,
  txCache: TxCache,
  type: NotificationType,
  doc: Doc,
  message: ActivityMessage,
  sender: Sender,
  receiverLang: string
): Promise<NotificationIntl> {
  const { hierarchy } = client
  const { intlParams, intlParamsNotLocalized = {} } = await getBaseDisplayParams(
    client,
    txCache,
    type,
    doc,
    sender,
    receiverLang
  )

  if (type.notificationMessage != null) {
    intlParamsNotLocalized.message = type.notificationMessage
  } else if (
    hierarchy.isDerived(message._class, activity.class.DocUpdateMessage) &&
    (message as DocUpdateMessage).messageIntl != null
  ) {
    const dum = message as DocUpdateMessage
    if (dum.messageIntl != null) {
      const params = { ...dum.intlParams }
      for (const [key, value] of Object.entries(dum.intlParamsNotLocalized ?? {})) {
        if (typeof value === 'string' && value.includes(':')) {
          params[key] = await translate(value, params, receiverLang)
        } else {
          params[key] = value
        }
      }
      intlParams.message = await translate(dum.messageIntl, params, receiverLang)
    }
  } else if (message.message != null && !isEmptyMarkup(message.message)) {
    intlParams.message = truncateMessage(markupToText(message.message))
  } else if (
    hierarchy.isDerived(message._class, chunter.class.ChatMessage) &&
    ((message as ChatMessage).attachments ?? 0) > 0
  ) {
    intlParamsNotLocalized.message = activity.string.SentAttachments
  } else if (
    message.forwardedMessage != null &&
    message.forwardContent?.message != null &&
    !isEmptyMarkup(message.forwardContent.message)
  ) {
    intlParams.message = truncateMessage(markupToText(message.forwardContent.message))
  } else if (message.forwardedMessage != null && (message.forwardContent?.attachments.length ?? 0) > 0) {
    intlParamsNotLocalized.message = activity.string.SentAttachments
  } else {
    intlParamsNotLocalized.object = hierarchy.getClass(doc._class).label
    intlParamsNotLocalized.message = activity.string.UpdatedObject
  }

  return {
    titleIntl:
      intlParams.identifier != null
        ? notification.string.CommonNotificationTitleWithIdentifier
        : notification.string.CommonNotificationTitle,
    bodyIntl: notification.string.MessageNotificationBody,
    intlParams,
    intlParamsNotLocalized
  }
}

export async function addUnreadMessage (
  client: Client,
  receiver: Receiver,
  doc: Doc,
  unreadMessage: UnreadMessage,
  context: DocNotifyContext | undefined,
  result: Result,
  txCache: TxCache,
  cache: Cache
): Promise<void> {
  if (context != null) {
    const { collapsed, didCollapse } = appendAndCollapseUnreadMessages(context.unreadMessages ?? [], unreadMessage)
    const operations: DocumentUpdate<DocNotifyContext> = {}
    if (didCollapse) {
      operations.unreadMessages = collapsed
    } else {
      operations.$push = {
        unreadMessages: unreadMessage
      }
    }
    const updateTx = client.txFactory.createTxUpdateDoc(context._class, context.space, context._id, operations)
    result.updateContextTx.push(updateTx)
  } else {
    const objectDisplayData = await getObjectDisplayData(client, cache, txCache, doc, receiver.account)
    const createTx = getCreateContextTx(
      generateId(),
      doc._id,
      doc._class,
      doc.space,
      receiver,
      result,
      client.txFactory,
      objectDisplayData
    )
    createTx.attributes.unreadMessages = [unreadMessage]
    createTx.attributes.unreadCount = isUnreadMessageChunk(unreadMessage)
      ? (unreadMessage.notifiedCount ?? 0)
      : unreadMessage.notified === true
        ? 1
        : 0
  }
}

async function pushNotification (
  client: Client,
  cache: Cache,
  receiver: Receiver,
  doc: Doc,
  message: ActivityMessage,
  sender: Sender,
  unreadMessage: UnreadMessage | undefined,
  context: DocNotifyContext | undefined,
  result: Result,
  txCache: TxCache,
  type: NotificationType,
  notifyResult: NotifyProviders,
  attachments: any[]
): Promise<void> {
  const content = await getMessageIntl(client, txCache, type, doc, message, sender, receiver.language)
  const objectDisplayData = await getObjectDisplayData(client, cache, txCache, doc, receiver.account)
  const pushSubscriptions = await cache.getPushSubscriptions(receiver.account)
  await _pushNotification(client, txCache, result, context, {
    unreadMessage:
      unreadMessage == null
        ? undefined
        : {
            ...unreadMessage,
            notified: true
          },
    receiver,
    objectId: doc._id,
    objectClass: doc._class,
    objectSpace: doc.space,
    objectDisplayData,
    notification: {
      id: message._id,
      type: 'message',
      messageId: message._id,
      intlMessage: type.notificationMessage,
      message: toNotificationMessage(message),
      attachments,
      createdOn: message.createdOn ?? message.modifiedOn,
      createdBy: message.createdBy ?? message.modifiedBy
    },
    intl: content,
    notifyProviders: notifyResult,
    pushSubscriptions
  })
}

function pullDUMFromContext (
  client: Client,
  context: DocNotifyContext,
  objectId: Ref<ActivityMessage>,
  result: Result
): void {
  const exists = hasMessageNotification(context, objectId)
  const unread = (context.unreadMessages ?? []).find(
    (it) => isUnreadMessageId(it) && String(it.id) === String(objectId)
  )

  if (exists || unread != null) {
    const updateOps: DocumentUpdate<DocNotifyContext> = { $pull: {} }
    if (exists) {
      updateOps.$pull = {
        ...updateOps.$pull,
        latestNotifications: { id: objectId }
      }
    }
    if (unread != null) {
      updateOps.$pull = {
        ...updateOps.$pull,
        unreadMessages: { id: objectId }
      }
      if (isUnreadMessageId(unread) && unread.notified === true) {
        updateOps.$inc = {
          ...updateOps.$inc,
          unreadCount: -1
        }
      }
    }

    result.updateContextTx.push(
      client.txFactory.createTxUpdateDoc(context._class, context.space, context._id, updateOps)
    )
  }
}

async function restoreLatestNotifications (
  client: Client,
  context: DocNotifyContext,
  idsToRemove: string[]
): Promise<DocumentUpdate<DocNotifyContext>> {
  const remaining = (context.latestNotifications ?? []).filter((n) => !idsToRemove.includes(n.id))
  const targetSize = config.LatestNotificationsSliceSize
  const needed = targetSize - remaining.length

  const operations: DocumentUpdate<DocNotifyContext> = {}

  if (needed <= 0) {
    if (idsToRemove.length > 0) {
      operations.$pull = {
        latestNotifications: { id: { $in: idsToRemove } }
      }
    }
    return operations
  }

  const candidates = (context.unreadMessages ?? []).filter(isUnreadMessageId).filter((it) => {
    return (
      it.notified === true &&
      !idsToRemove.includes(it.id) &&
      !remaining.some((n) => n.type === 'message' && n.id === it.id)
    )
  })

  if (candidates.length === 0) {
    if (idsToRemove.length > 0) {
      operations.$pull = {
        latestNotifications: { id: { $in: idsToRemove } }
      }
    }
    return operations
  }

  candidates.sort((a, b) => b.createdOn - a.createdOn)

  const restoreCandidates = candidates.slice(0, needed)
  const restoredNotifications: ContextNotification[] = []

  for (const candidate of restoreCandidates) {
    const message = await client.findOne(activity.class.ActivityMessage, { _id: candidate.id })
    if (message != null) {
      const attachments = await getAttachments(message, client)
      restoredNotifications.push({
        id: message._id,
        type: 'message',
        messageId: message._id,
        message: toNotificationMessage(message),
        attachments,
        createdOn: message.createdOn ?? message.modifiedOn,
        createdBy: message.createdBy ?? message.modifiedBy
      })
    }
  }

  if (restoredNotifications.length > 0) {
    const combined = [...remaining, ...restoredNotifications].sort((a, b) => b.createdOn - a.createdOn)
    operations.latestNotifications = combined.slice(0, targetSize)
  } else if (idsToRemove.length > 0) {
    operations.$pull = {
      latestNotifications: { id: { $in: idsToRemove } }
    }
  }

  return operations
}

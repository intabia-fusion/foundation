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

import core, { Doc, TxCreateDoc, TxCUD, TxProcessor } from '@hcengineering/core'
import activity, { Reaction } from '@hcengineering/activity'
import notification, {
  CommonNotification,
  NotificationIntl,
  NotificationType,
  TxNotificationType
} from '@hcengineering/notification'
import serverNotification, {
  CreateNotificationResult,
  truncateMessage,
  Sender,
  TypeMatch
} from '@hcengineering/server-notification'
import { getResource } from '@hcengineering/platform'
import { markupToText } from '@hcengineering/text-core'

import { Client, Result, TxCache } from '../types'
import Cache from '../cache'
import { handleReaction } from './reaction'
import {
  getBaseDisplayParams,
  getCollaboratorAccounts,
  getMode,
  getNotifiedUsers,
  getObjectDisplayData,
  getTxNotifyProviders,
  getTypeMatchClient,
  isMatchedTxType,
  isMuted
} from '../utils/utils'
import { pushNotification } from './notification'
import { handleMention } from './mention'

export async function handleTxNotification (
  client: Client,
  cache: Cache,
  txCache: TxCache,
  result: Result,
  tx: TxCUD<Doc>,
  txTypes: TxNotificationType[]
): Promise<void> {
  const { hierarchy } = client

  if (hierarchy.isDerived(tx.objectClass, activity.class.Reaction)) {
    await handleReaction(client, cache, txCache, result, tx as TxCUD<Reaction>)
    return
  }

  let matched = txTypes.filter((type) => isMatchedTxType(client, tx, type))
  if (matched.length === 0) return

  const txAttachedToDoc =
    tx.attachedTo != null && tx.attachedToClass != null
      ? await cache.getDoc(tx.attachedTo, tx.attachedToClass)
      : undefined
  const txObject =
    tx._class === core.class.TxCreateDoc
      ? TxProcessor.createDoc2Doc(tx as TxCreateDoc<Doc>)
      : await cache.getDoc(tx.objectId, tx.objectClass)
  if (txObject === undefined) {
    client.ctx.warn('txObject not found for tx notification', {
      txId: tx._id,
      objectId: tx.objectId,
      objectClass: tx.objectClass
    })
    return
  }

  const sender = await cache.getSender(tx.modifiedBy)
  const settings = await cache.getSettings()
  const mentionType = matched.find((it) => it._id === notification.ids.MentionNotificationType)

  if (mentionType != null) {
    const doc = hierarchy.isDerived(txObject._class, activity.class.ActivityMessage)
      ? (txAttachedToDoc ?? txObject)
      : txObject
    await handleMention(client, cache, txCache, result, tx, doc, txObject, mentionType)
    matched = matched.filter((it) => it._id !== notification.ids.MentionNotificationType)
  }

  if (matched.length === 0) return

  for (const matchedType of matched) {
    const doc =
      hierarchy.isDerived(txObject._class, activity.class.ActivityMessage) || matchedType.attachToParent === true
        ? (txAttachedToDoc ?? txObject)
        : txObject

    const space = await cache.getDocSpace(doc)
    if (space == null) {
      client.ctx.warn('Space not found for tx notification doc', { txId: tx._id, docId: doc._id, docClass: doc._class })
      continue
    }

    const notified = getNotifiedUsers(result)
    const collaborators = await getCollaboratorAccounts(client, cache, doc, space, notified)
    if (collaborators.length === 0) continue

    const receivers = await cache.getReceivers(collaborators)
    if (receivers.length === 0) continue

    const contexts = await cache.getContexts(doc._id)
    const docSettings = await cache.getDocSettings(doc._id)

    for (const receiver of receivers) {
      const mode = getMode(docSettings, receiver.account)
      if (isMuted(mode)) continue

      const context = contexts.find((it) => it.user === receiver.account)
      const notifyProviders = await getTxNotifyProviders(client, tx, doc, receiver, settings, [matchedType], mode)

      const types = notifyProviders[notification.providers.InboxNotificationProvider] ?? []
      const type = types[0] as TxNotificationType
      if (type == null) continue

      if (!client.hierarchy.hasMixin(type, serverNotification.mixin.TypeMatch)) continue
      const mixin = client.hierarchy.as<NotificationType, TypeMatch>(type, serverNotification.mixin.TypeMatch)
      if (mixin.create == null) continue
      const createFn = await getResource(mixin.create)
      const data = await createFn(getTypeMatchClient(client), tx, txAttachedToDoc, txObject, receiver)
      if (data == null) continue
      const intl: NotificationIntl = await getIntl(
        client,
        txCache,
        data,
        mixin,
        type,
        tx,
        doc,
        txObject,
        sender,
        receiver.language
      )

      const commonNotification: CommonNotification = {
        ...data.notification,
        intlParams: intl.intlParams,
        intlParamsNotLocalized: intl.intlParamsNotLocalized,
        id: tx._id,
        type: 'common',
        createdOn: tx.createdOn ?? tx.modifiedOn,
        createdBy: tx.createdBy ?? tx.modifiedBy
      }

      const objectDisplayData = await getObjectDisplayData(client, cache, txCache, doc, receiver.account)
      const pushSubscriptions = await cache.getPushSubscriptions(receiver.account)
      await pushNotification(client, txCache, result, context, {
        unreadCommon: commonNotification,
        receiver,
        objectId: doc._id,
        objectClass: doc._class,
        objectSpace: doc.space,
        notification: commonNotification,
        intl,
        notifyProviders,
        objectDisplayData,
        pushSubscriptions
      })
    }
  }
}

async function getIntl (
  client: Client,
  txCache: TxCache,
  data: CreateNotificationResult,
  mixin: TypeMatch,
  type: TxNotificationType,
  tx: TxCUD<Doc>,
  doc: Doc,
  txObject: Doc,
  sender: Sender,
  receiverLang: string
): Promise<NotificationIntl> {
  if (mixin.intlProvider != null) {
    const f = await getResource(mixin.intlProvider)
    return await f(getTypeMatchClient(client), type, tx, doc, txObject, sender)
  } else {
    const { intlParams, intlParamsNotLocalized = {} } = await getBaseDisplayParams(
      client,
      txCache,
      type,
      doc,
      sender,
      receiverLang
    )
    for (const [k, v] of Object.entries(data.intl?.intlParams ?? {})) {
      intlParams[k] = v
    }
    for (const [k, v] of Object.entries(data.intl?.intlParamsNotLocalized ?? {})) {
      intlParamsNotLocalized[k] = v
    }

    if (data.notification.markup != null) {
      intlParams.message = truncateMessage(markupToText(data.notification.markup))
    } else if (data.notification.messageIntl != null) {
      intlParamsNotLocalized.message = data.notification.messageIntl
    }

    if (data.notification.header != null) {
      intlParamsNotLocalized.title = data.notification.header.titleIntl
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
}

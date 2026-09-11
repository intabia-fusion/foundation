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
  AnyAttribute,
  Class,
  Doc,
  DocumentUpdate,
  generateId,
  getTxOperations,
  Markup,
  Ref,
  Space,
  TxCUD,
  Blob
} from '@hcengineering/core'
import activity, { ActivityMessage, UserMentionInfo } from '@hcengineering/activity'
import notification, {
  DocNotifyContext,
  MentionNotification,
  NotificationIntl,
  TxNotificationType,
  isUnreadMessageId,
  UnreadMessage,
  UnreadMention
} from '@hcengineering/notification'
import { MentionRef, truncateMessage, Receiver, Sender } from '@hcengineering/server-notification'
import { areEqualJson, extractReferences, jsonToMarkup, markupToJSON, markupToText } from '@hcengineering/text-core'
import contact, { Employee, Person } from '@hcengineering/contact'

import { Client, MentionResult, NotifyProviders, Result, TxCache } from '../types'
import Cache from '../cache'
import {
  getBaseDisplayParams,
  getObjectDisplayData,
  getMode,
  getTxNotifyProviders,
  isMuted,
  getMentionNotification,
  hasMessageNotification,
  getAttachments
} from '../utils/utils'
import { pushNotification } from './notification'

export async function handleMention (
  client: Client,
  cache: Cache,
  txCache: TxCache,
  result: Result,
  tx: TxCUD<Doc>,
  doc: Doc,
  txObject: Doc,
  type: TxNotificationType
): Promise<void> {
  const { hierarchy } = client

  const sender = await cache.getSender(tx.modifiedBy)
  const mentions = await createMentionsData(client, cache, tx, result, doc, txObject, type)

  const message = hierarchy.isDerived(txObject._class, activity.class.ActivityMessage)
    ? (txObject as ActivityMessage)
    : undefined
  for (const mention of mentions) {
    const mentionNotification: MentionNotification = {
      id: generateId(),
      type: 'mention',
      createdOn: tx.createdOn ?? tx.modifiedOn,
      createdBy: tx.createdBy ?? tx.modifiedBy,
      ...mention.notification
    }

    const objectDisplayData = await getObjectDisplayData(client, cache, txCache, doc, mention.receiver.account)
    const pushSubscriptions = await cache.getPushSubscriptions(mention.receiver.account)
    const messageId = mentionNotification.messageId
    let unreadMsg: UnreadMessage | undefined
    let unreadMnt: UnreadMention | undefined
    if (messageId != null) {
      unreadMsg = {
        id: messageId,
        createdOn: mentionNotification.createdOn,
        notified: true,
        mentioned: true
      }
    } else {
      unreadMnt = {
        id: mentionNotification.id
      }
    }
    await pushNotification(client, txCache, result, mention.context, {
      unreadMessage: unreadMsg,
      unreadMention: unreadMnt,
      receiver: mention.receiver,
      objectId: doc._id,
      objectClass: doc._class,
      objectSpace: doc.space,
      notification: mentionNotification,
      intl: await getMentionIntl(client, txCache, type, doc, message, mention, sender, mention.receiver.language),
      notifyProviders: mention.notifyProviders,
      objectDisplayData,
      pushSubscriptions
    })
  }
}

async function createMentionsData (
  client: Client,
  cache: Cache,
  tx: TxCUD<Doc>,
  result: Result,
  doc: Doc,
  object: Doc,
  type: TxNotificationType
): Promise<MentionResult[]> {
  if (tx._class === core.class.TxRemoveDoc) return []

  const contexts = await cache.getContexts(doc._id)
  const settings = await cache.getSettings()

  const { hierarchy } = client

  const message = hierarchy.isDerived(object._class, activity.class.ActivityMessage)
    ? (object as ActivityMessage)
    : undefined

  const references: MentionRef[] = await getMentionRefs(client, tx, doc, message)
  if (references.length === 0) return []

  const mentions =
    tx._class === core.class.TxCreateDoc
      ? []
      : await client.findAll(activity.class.UserMentionInfo, { attachedTo: tx.objectId })

  for (const mention of mentions) {
    const refIndex = references.findIndex(
      (r) => mention.user === r.mentionId && mention.attachedTo === (r.messageId ?? r.docId)
    )
    const ref = references[refIndex]

    if (refIndex !== -1) {
      const alreadyProcessed = areEqualJson(JSON.parse(mention.content), JSON.parse(ref.markup))

      if (alreadyProcessed) {
        references.splice(refIndex, 1)
      }
    } else {
      await removeMentions(client, mention, tx, result, doc._id)
    }
  }

  if (references.length === 0) return []

  const space = await cache.getDocSpace(message ?? doc)
  if (space == null) {
    client.ctx.warn('Space not found for mentions', { docId: doc._id, docClass: doc._class })
    return []
  }

  const notified = new Set<AccountUuid>()
  const res: MentionResult[] = []

  const docSettings = await cache.getDocSettings(doc._id)

  for (const reference of references) {
    const receivers = await getReceivers(client, cache, reference, space)

    for (const receiver of receivers) {
      if (notified.has(receiver.account)) continue
      notified.add(receiver.account)

      const mode = getMode(docSettings, receiver.account)
      if (isMuted(mode)) continue

      const notifyProviders = await getTxNotifyProviders(client, tx, doc, receiver, settings, [type], mode)
      if ((notifyProviders[notification.providers.InboxNotificationProvider]?.length ?? 0) === 0) continue

      const context = contexts.find((it) => it.user === receiver.account)
      const mention = mentions.find((it) => it.user === receiver.employeeRef)

      createOrUpdateMention(client, result, receiver.employeeRef, reference, space._id, mention)

      if (mention != null) {
        if (message == null && context != null) {
          const mentionNotification = getMentionNotification(context, null)
          if (mentionNotification == null) continue

          result.updateContextTx.push(
            client.txFactory.createTxUpdateDoc(context._class, context.space, context._id, {
              $update: {
                latestNotifications: {
                  $query: { id: mentionNotification.id },
                  $update: {
                    markup: reference.markup
                  }
                }
              }
            })
          )
        }
      } else {
        if (message != null && context != null && hasMessageNotification(context, message._id)) continue

        res.push(await getMentionResult(client, context, receiver, message, notifyProviders, reference))
      }
    }
  }

  return res
}
async function getMentionResult (
  client: Client,
  context: DocNotifyContext | undefined,
  receiver: Receiver,
  message: ActivityMessage | undefined,
  notifyProviders: NotifyProviders,
  reference: MentionRef
): Promise<MentionResult> {
  const attachments = message != null ? await getAttachments(message, client) : []
  return {
    notification: {
      markup: message?.message ?? reference.markup,
      messageId: message?._id,
      attachments
    },
    intl: {
      titleIntl: activity.string.MentionedYouIn
    },
    context,
    receiver,
    notifyProviders
  }
}

async function getReceivers (client: Client, cache: Cache, reference: MentionRef, space: Space): Promise<Receiver[]> {
  if (reference.mentionId === contact.mention.Everyone) {
    const collaborators = (await cache.getCollaborators(reference.docId, reference.docClass)).filter(
      (it) => !space.private || space.members.includes(it.collaborator)
    )
    return await cache.getReceivers(collaborators.map((it) => it.collaborator))
  } else if (reference.mentionId === contact.mention.Here) {
    const collaborators = (await cache.getCollaborators(reference.docId, reference.docClass)).filter(
      (it) => !space.private || space.members.includes(it.collaborator)
    )
    const statuses = await cache.getUserStatuses()

    return await cache.getReceivers(
      collaborators
        .filter((it) => statuses.some((s) => s.user === it.collaborator && s.online))
        .map((it) => it.collaborator)
    )
  } else {
    const employee = await client.findOne(contact.mixin.Employee, {
      _id: reference.mentionId as Ref<Employee>,
      active: true
    })

    if (employee?.personUuid != null && (!space.private || space.members.includes(employee.personUuid))) {
      return await cache.getReceivers([employee.personUuid])
    }
  }

  return []
}

async function getMentionRefs (
  client: Client,
  tx: TxCUD<Doc>,
  doc: Doc,
  message?: ActivityMessage
): Promise<MentionRef[]> {
  const { hierarchy, storage, workspace, ctx } = client

  const refs: MentionRef[] = []

  const attributes: Map<string, AnyAttribute> = hierarchy.getAllAttributes(tx.objectClass)
  const txOperations = getTxOperations(tx)

  for (const attr of attributes.values()) {
    if (attr.type._class === core.class.TypeMarkup) {
      const content: string = txOperations[attr.name]?.toString() ?? ''
      const attrMentionRefs = getMentionRefsData(client, doc._id, doc._class, message?._id, message?._class, content)

      refs.push(...attrMentionRefs)
    } else if (attr.type._class === core.class.TypeCollaborativeDoc) {
      const blobId = txOperations[attr.name] as Ref<Blob>
      if (blobId != null && blobId !== '') {
        try {
          const buffer = await storage.read(
            ctx,
            {
              uuid: workspace.uuid,
              url: workspace.url
            },
            blobId
          )
          const markup = Buffer.concat(buffer as any).toString()
          const attrMentionRefs = getMentionRefsData(client, doc._id, doc._class, message?._id, message?._class, markup)
          refs.push(...attrMentionRefs)
        } catch {
          // do nothing, the collaborative doc does not seem to exist yet
        }
      }
    }
  }

  return refs
}

function getMentionRefsData (
  client: Client,
  docId: Ref<Doc>,
  docClass: Ref<Class<Doc>>,
  messageId: Ref<ActivityMessage> | undefined,
  messageClass: Ref<Class<ActivityMessage>> | undefined,
  content: Markup
): MentionRef[] {
  const { hierarchy } = client
  const references: MentionRef[] = []

  const node = markupToJSON(content)
  const rawMentionRefs = extractReferences(node)

  for (const raw of rawMentionRefs) {
    if (!hierarchy.isDerived(raw.objectClass, contact.class.Person)) continue
    if (raw.objectId !== messageId && raw.objectId !== docId) {
      references.push({
        mentionId: raw.objectId as Ref<Person>,
        mentionClass: raw.objectClass as Ref<Class<Person>>,
        docId,
        docClass,
        messageId,
        messageClass,
        markup: raw.parentNode !== null ? jsonToMarkup(raw.parentNode) : ''
      })
    }
  }

  return references
}

async function removeMentions (
  client: Client,
  mention: UserMentionInfo,
  tx: TxCUD<Doc>,
  result: Result,
  objectId: Ref<Doc>
): Promise<void> {
  const { txFactory, hierarchy } = client

  result.removeUserMentionInfoTx.push(txFactory.createTxRemoveDoc(mention._class, mention.space, mention._id))

  const messageId = hierarchy.isDerived(tx.objectClass, activity.class.ActivityMessage)
    ? (tx.objectId as Ref<ActivityMessage>)
    : undefined

  const person = await client.findOne(contact.class.Person, { _id: mention.user })
  if (person?.personUuid == null) return

  const account = person.personUuid as AccountUuid
  const contexts = await client.findAll(notification.class.DocNotifyContext, { user: account, objectId })

  for (const context of contexts) {
    const op: DocumentUpdate<DocNotifyContext> = {}
    const hasNotification = context.latestNotifications.some(
      (it) => it.type === 'mention' && it.messageId === messageId
    )

    if (hasNotification) {
      op.$pull = { latestNotifications: { type: 'mention', messageId } }
    }

    if (messageId != null) {
      const unreadMsg = context.unreadMessages?.find(
        (it) => isUnreadMessageId(it) && it.id === messageId && it.mentioned === true
      )
      if (unreadMsg != null && isUnreadMessageId(unreadMsg)) {
        op.$update = {
          unreadMessages: {
            $query: { id: messageId },
            $update: {
              mentioned: false
            }
          }
        }
      }
    }

    if (Object.keys(op).length > 0) {
      result.updateContextTx.push(client.txFactory.createTxUpdateDoc(context._class, context.space, context._id, op))
    }
  }
}

function createOrUpdateMention (
  client: Client,
  result: Result,
  person: Ref<Person>,
  reference: MentionRef,
  space: Ref<Space>,
  mention: UserMentionInfo | undefined
): void {
  const { txFactory } = client
  if (mention == null) {
    result.createUserMentionInfoTx.push(
      txFactory.createTxCreateDoc(activity.class.UserMentionInfo, space, {
        attachedTo: reference.messageId ?? reference.docId,
        attachedToClass: reference.messageClass ?? reference.docClass,
        user: person,
        content: reference.markup,
        collection: 'mentions'
      })
    )
  } else {
    result.updateUserMentionInfoTx.push(
      txFactory.createTxUpdateDoc(mention._class, mention.space, mention._id, {
        content: reference.markup
      })
    )
  }
}

async function getMentionIntl (
  client: Client,
  txCache: TxCache,
  type: TxNotificationType,
  doc: Doc,
  message: ActivityMessage | undefined,
  mention: MentionResult,
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

  intlParams.message = truncateMessage(markupToText(message?.message ?? mention.notification.markup ?? ''))

  return {
    titleIntl:
      mention.intl.titleIntl ??
      (intlParams.identifier != null
        ? notification.string.CommonNotificationTitleWithIdentifier
        : notification.string.CommonNotificationTitle),
    bodyIntl: mention.intl.bodyIntl ?? notification.string.MessageNotificationBody,
    intlParams: {
      ...intlParams,
      ...mention.intl.intlParams
    },
    intlParamsNotLocalized: {
      ...intlParamsNotLocalized,
      ...mention.intl.intlParamsNotLocalized
    }
  }
}

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

import notificationPlugin, {
  ContextNotification,
  DocNotifyContext,
  NotificationProvider,
  NotificationType,
  UnreadMessage,
  UnreadReaction,
  NotificationIntl,
  CommonNotification,
  UnreadMention,
  PushSubscription,
  getNotificationMessageId,
  translateNotification,
  NotificationTemplate,
  QueueNotificationMessage
} from '@hcengineering/notification'
import { Class, Doc, generateId, Ref, Space, Markup } from '@hcengineering/core'
import { Receiver } from '@hcengineering/server-notification'
import { ActivityMessage } from '@hcengineering/activity'
import { translate, IntlString } from '@hcengineering/platform'
import { isEmptyMarkup, markupToText } from '@hcengineering/text-core'
import { markupToHtml } from '@hcengineering/text-html'

import { Client, ObjectDisplayData, NotifyProviders, Result, TxCache } from '../types'
import config from '../config'
import { getCreateContextTx, getNotificationUrl, getDomain, getNotificationLocation } from '../utils/utils'
import { appendAndCollapseUnreadMessages } from '../utils/collapse'

interface CreateNotificationData {
  objectId: Ref<Doc>
  objectClass: Ref<Class<Doc>>
  objectSpace: Ref<Space>

  objectDisplayData: ObjectDisplayData

  notifyProviders: NotifyProviders
  notification: ContextNotification
  intl: NotificationIntl

  unreadMessage?: UnreadMessage
  unreadReaction?: UnreadReaction
  unreadMention?: UnreadMention
  unreadCommon?: CommonNotification

  receiver: Receiver
  pushSubscriptions: PushSubscription[]
}

export async function pushNotification (
  client: Client,
  txCache: TxCache,
  result: Result,
  context: DocNotifyContext | undefined,
  data: CreateNotificationData
): Promise<void> {
  const {
    notification,
    unreadMessage,
    unreadReaction,
    unreadCommon,
    unreadMention,
    receiver,
    objectId,
    objectClass,
    objectSpace,
    notifyProviders,
    intl,
    objectDisplayData,
    pushSubscriptions
  } = data

  const isUnread = unreadMessage != null || unreadReaction != null || unreadMention != null || unreadCommon != null

  const { txFactory } = client
  const modifiedOn = Math.max(context?.lastNotify ?? 0, data.notification.createdOn)
  const providers: Record<Ref<NotificationProvider>, Ref<NotificationType>[]> = Object.fromEntries(
    Object.entries(notifyProviders).map(([provider, types]) => [provider, types.map((it) => it._id)])
  ) as Record<Ref<NotificationProvider>, Ref<NotificationType>[]>

  const { title, body } = await translateNotification(intl, receiver.language)
  const domain = getDomain(client)
  const contextId = context?._id ?? generateId<DocNotifyContext>()
  const url = getNotificationUrl(client, contextId, notification, objectId, objectClass)

  result.queueMessages.push({
    id: notification.id,
    title,
    body,
    url,
    domain,
    pushSubscriptions,
    language: receiver.language,
    account: receiver.account,
    providers,
    objectId,
    objectClass,
    objectSpace,
    createdOn: data.notification.createdOn,
    template: await getTemplate(client, txCache, notification, notifyProviders, intl, receiver, url)
  })
  if (context != null) {
    const updateTx = txFactory.createTxUpdateDoc(context._class, context.space, context._id, {})

    updateTx.operations.lastNotify = Math.max(modifiedOn, updateTx.operations.lastNotify ?? 0)
    updateTx.operations.$push = {
      latestNotifications: { $each: [notification], $position: 0, $slice: config.LatestNotificationsSliceSize }
    }
    if (isUnread) {
      updateTx.operations.$inc = { unreadCount: 1 }

      if (unreadMessage != null) {
        const { collapsed, didCollapse } = appendAndCollapseUnreadMessages(context.unreadMessages ?? [], unreadMessage)
        if (didCollapse) {
          updateTx.operations.unreadMessages = collapsed
        } else {
          updateTx.operations.$push = {
            ...updateTx.operations.$push,
            unreadMessages: unreadMessage
          }
        }
      } else if (unreadReaction != null) {
        updateTx.operations.$push = {
          ...updateTx.operations.$push,
          unreadReactions: unreadReaction
        }
      } else if (unreadMention != null) {
        updateTx.operations.$push = {
          ...updateTx.operations.$push,
          unreadMentions: unreadMention
        }
      } else if (unreadCommon != null) {
        updateTx.operations.$push = {
          ...updateTx.operations.$push,
          unreadCommons: unreadCommon
        }
      }
    }

    result.updateContextTx.push(updateTx)
  } else {
    const createTx = getCreateContextTx(
      contextId,
      objectId,
      objectClass,
      objectSpace,
      receiver,
      result,
      client.txFactory,
      objectDisplayData
    )

    createTx.attributes.lastNotify = Math.max(createTx.attributes.lastNotify ?? 0, modifiedOn)
    createTx.attributes.latestNotifications = [notification, ...createTx.attributes.latestNotifications].slice(
      0,
      config.LatestNotificationsSliceSize
    )
    createTx.attributes.unreadCount = isUnread
      ? (createTx.attributes.unreadCount ?? 0) + 1
      : (createTx.attributes.unreadCount ?? 0)
    if (isUnread) {
      if (unreadMessage != null) {
        const currentUnread = createTx.attributes.unreadMessages ?? []
        createTx.attributes.unreadMessages = [...currentUnread, unreadMessage]
      } else if (unreadReaction != null) {
        createTx.attributes.unreadReactions = [...(createTx.attributes.unreadReactions ?? []), unreadReaction]
      } else if (unreadMention != null) {
        createTx.attributes.unreadMentions = [...(createTx.attributes.unreadMentions ?? []), unreadMention]
      } else if (unreadCommon != null) {
        createTx.attributes.unreadCommons = [...(createTx.attributes.unreadCommons ?? []), unreadCommon]
      }
    }
  }

  createAppPushNotification(client, result, data, contextId)
}

function createAppPushNotification (
  client: Client,
  result: Result,
  data: CreateNotificationData,
  contextId: Ref<DocNotifyContext>
): void {
  const { txFactory } = client
  const { notification, notifyProviders, objectId, objectClass, receiver, intl } = data
  const shouldPush = (notifyProviders[notificationPlugin.providers.PushNotificationProvider]?.length ?? 0) > 0

  if (shouldPush) {
    const messageId: Ref<ActivityMessage> | undefined = getNotificationMessageId(notification)
    const { path, query } = getNotificationLocation(client, contextId, notification, objectId, objectClass)

    const soundAlert = (notifyProviders[notificationPlugin.providers.SoundNotificationProvider]?.length ?? 0) > 0

    const appNotificationTx = txFactory.createTxCreateDoc(
      notificationPlugin.class.AppPushNotification,
      receiver.space,
      {
        ...intl,
        account: receiver.account,
        sender: notification.createdBy,
        tag: notification.id,
        objectId,
        objectClass,
        messageId,
        onClickLocation: {
          path,
          query
        },
        soundAlert
      }
    )

    result.createAppPushNotificationTx.push(appNotificationTx)
  }
}

async function getTemplate (
  client: Client,
  txCache: TxCache,
  notification: ContextNotification,
  providers: NotifyProviders,
  intl: NotificationIntl,
  receiver: Receiver,
  inboxUrl: string
): Promise<QueueNotificationMessage['template']> {
  const types = (providers[notificationPlugin.providers.InboxNotificationProvider] ?? []).filter(
    (it) => it.templates != null
  )

  if (types.length === 0) return undefined
  const type = types[0]

  const cacheKey = `${type._id}:${receiver.language}`
  const templateCached = txCache.templates.get(cacheKey)

  if (templateCached != null) {
    return templateCached
  }

  try {
    const content = await translateTemplate(client, type, intl, receiver, inboxUrl, notification)
    if (content != null) {
      const subject = content.subject
      const text = content.text
      const html = content.html

      const template = { subject, text, html }
      txCache.templates.set(cacheKey, template)
      return template
    }
  } catch (e) {
    client.ctx.error('Failed to generate template', { e, notificationId: notification.id })
  }
}

function getNotificationMarkup (notification: ContextNotification): Markup | undefined {
  if (notification.type === 'message' || notification.type === 'reaction') {
    return notification.message?.message
  }
  return notification.markup
}

async function translateTemplate (
  client: Client,
  type: NotificationType,
  intl: NotificationIntl,
  receiver: Receiver,
  inboxUrl: string,
  notification: ContextNotification
): Promise<QueueNotificationMessage['template']> {
  const templates: NotificationTemplate = type?.templates ?? {
    text: notificationPlugin.emailTemplate.GeneratedNotificationText,
    html: notificationPlugin.emailTemplate.GeneratedNotificationHtml,
    subject: notificationPlugin.emailTemplate.GeneratedNotificationSubject
  }

  const language = receiver.language

  const params: Record<string, any> = { ...intl.intlParams }

  if (intl.intlParamsNotLocalized != null) {
    for (const [k, v] of Object.entries(intl.intlParamsNotLocalized)) {
      if (v != null) {
        params[k] = await translate(v, params, language)
      }
    }
  }

  params.sender = intl.intlParams.senderName

  const title = intl.intlParams?.title ?? intl.intlParams.doc ?? ''
  const url = intl.intlParams.url
  const identifier = intl.intlParams?.identifier

  const textTitle = identifier != null ? `${identifier}: ${title}` : title.toString()
  const htmlTitle = url !== '' ? `<a href='${url}'>${textTitle}</a>` : textTitle.toString()

  const app = client.branding?.title ?? 'Platform'
  const inboxLinkText = await translate(notificationPlugin.string.ViewIn, { app }, language)

  params.link = `<a href='${inboxUrl}'>${inboxLinkText}</a>`

  let bodyText: string
  let bodyHtml: string

  const markup = getNotificationMarkup(notification)
  if (markup != null && markup !== '' && !isEmptyMarkup(markup)) {
    const textMessage = markupToText(markup)
    let htmlMessage = textMessage
    try {
      htmlMessage = markupToHtml(JSON.parse(markup))
    } catch (e) {
      // Fallback to plain text if markup JSON parsing fails
    }

    params.message = textMessage
    bodyText = await translate(intl.bodyIntl, params, language)

    params.message = htmlMessage
    bodyHtml = await translate(intl.bodyIntl, params, language)
  } else {
    bodyText = await translate(intl.bodyIntl, params, language)
    bodyHtml = bodyText
  }

  const text = await fillTemplate(templates.text, textTitle, { ...params, body: bodyText }, language)
  const html = await fillTemplate(templates.html, htmlTitle, { ...params, body: bodyHtml }, language)
  const subject = await fillTemplate(templates.subject, textTitle, { ...params, body: bodyText }, language)

  return {
    text,
    html,
    subject
  }
}

async function fillTemplate (
  template: IntlString,
  doc: string,
  params: Record<string, string | number>,
  lang: string
): Promise<string> {
  return await translate(
    template,
    {
      ...params,
      doc
    },
    lang
  )
}

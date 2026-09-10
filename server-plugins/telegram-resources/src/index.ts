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
import activity, { ActivityMessage, DocUpdateMessage } from '@hcengineering/activity'
import chunter, { ChatMessage } from '@hcengineering/chunter'
import contact, { Channel } from '@hcengineering/contact'
import core, {
  PersonId,
  Class,
  Doc,
  DocumentQuery,
  FindOptions,
  FindResult,
  Hierarchy,
  Ref,
  Tx,
  TxCreateDoc,
  TxProcessor,
  TxCUD,
  TxUpdateDoc
} from '@hcengineering/core'
import notification, {
  InboxNotification,
  MentionInboxNotification,
  NotificationProviderSetting,
  NotificationType
} from '@hcengineering/notification'
import { getAccountBySocialId } from '@hcengineering/server-contact'
import { PlatformQueueProducer, QueueTopic, TriggerControl } from '@hcengineering/server-core'
import {
  getNotificationInboxLink,
  getTranslatedNotificationContent,
  getNotificationMessages
} from '@hcengineering/server-notification-resources'
import {
  type TelegramNotificationQueueMessage,
  TelegramQueueMessageType,
  TelegramQueueMessage
} from '@hcengineering/server-telegram'
import telegram, { TelegramMessage } from '@hcengineering/telegram'
import { jsonToHTML, markupToJSON } from '@hcengineering/text'
import { Receiver, TypeMatchClient, TypeMatchFunc } from '@hcengineering/server-notification'

/**
 * @public
 */
export async function FindMessages (
  doc: Doc,
  hiearachy: Hierarchy,
  findAll: <T extends Doc>(
    clazz: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<FindResult<T>>
): Promise<Doc[]> {
  const channel = doc as Channel
  if (channel.provider !== contact.channelProvider.Telegram) {
    return []
  }
  const messages = await findAll(telegram.class.Message, { attachedTo: channel._id })
  const newMessages = await findAll(telegram.class.NewMessage, { attachedTo: channel._id })
  return [...messages, ...newMessages]
}

/**
 * @public
 */
export async function OnMessageCreate (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    const message = TxProcessor.createDoc2Doc<TelegramMessage>(tx as TxCreateDoc<TelegramMessage>)
    const channel = (
      await control.findAll(control.ctx, contact.class.Channel, { _id: message.attachedTo }, { limit: 1 })
    )[0]
    if (channel !== undefined) {
      if (channel.lastMessage === undefined || channel.lastMessage < message.sendOn) {
        const tx = control.txFactory.createTxUpdateDoc(channel._class, channel.space, channel._id, {
          lastMessage: message.sendOn
        })
        result.push(tx)
      }
    }
  }

  return result
}

/**
 * @public
 */
export const IsIncomingMessageTypeMatch: TypeMatchFunc = async (
  client: TypeMatchClient,
  _type: NotificationType,
  _typeObject: Doc,
  doc: Doc,
  _receiver: Receiver
): Promise<boolean> => {
  const { hierarchy } = client
  const message = _typeObject as DocUpdateMessage
  if (!hierarchy.isDerived(message.objectClass, telegram.class.Message)) return false
  if (message.action !== 'create') return false

  const tgMessage = (
    await client.findAll(
      client.ctx,
      telegram.class.Message,
      { _id: message.objectId as Ref<TelegramMessage> },
      { limit: 1 }
    )
  )[0]
  if (tgMessage == null) return false
  return tgMessage.incoming && tgMessage.sendOn > (doc.createdOn ?? doc.modifiedOn)
}

export async function GetCurrentEmployeeTG (
  control: TriggerControl,
  context: Record<string, Doc>
): Promise<string | undefined> {
  // TODO: FIXME
  // const account = await control.modelDb.findOne(contact.class.PersonAccount, {
  //   _id: control.txFactory.account as PersonId
  // })
  // if (account === undefined) return
  // const employee = (
  //   await control.findAll(control.ctx, contact.mixin.Employee, { _id: account.person as Ref<Employee> })
  // )[0]
  // if (employee !== undefined) {
  //   return await getContactChannel(control, employee, contact.channelProvider.Telegram)
  // }

  return undefined
}

export async function GetIntegrationOwnerTG (
  control: TriggerControl,
  context: Record<string, Doc>
): Promise<string | undefined> {
  // TODO: FIXME
  // const value = context[setting.class.Integration] as Integration
  // if (value === undefined) return
  // const account = await control.modelDb.findOne(contact.class.PersonAccount, {
  //   _id: value.modifiedBy as PersonId
  // })
  // if (account === undefined) return
  // const employee = (
  //   await control.findAll(control.ctx, contact.mixin.Employee, { _id: account.person as Ref<Employee> })
  // )[0]
  // if (employee !== undefined) {
  //   return await getContactChannel(control, employee, contact.channelProvider.Telegram)
  // }

  return undefined
}

// async function getContactChannel (
//   control: TriggerControl,
//   value: Contact,
//   provider: Ref<ChannelProvider>
// ): Promise<string | undefined> {
//   if (value === undefined) return
//   const res = (
//     await control.findAll(control.ctx, contact.class.Channel, {
//       attachedTo: value._id,
//       provider
//     })
//   )[0]
//   return res?.value ?? ''
// }

function activityMessageToHtml (message: ActivityMessage): string | undefined {
  if (message.message === undefined) return undefined
  return jsonToHTML(markupToJSON(message.message))
}

async function getTranslatedData (
  control: TriggerControl,
  doc: Doc,
  inboxNotification: InboxNotification,
  message?: ActivityMessage
): Promise<{
  title: string
  quote: string | undefined
  body: string
  link: string
}> {
  const { hierarchy } = control

  let { title, body } = await getTranslatedNotificationContent(
    inboxNotification,
    control.branding?.defaultLanguage ?? 'en'
  )
  let quote: string | undefined

  if (hierarchy.isDerived(inboxNotification._class, notification.class.MentionInboxNotification)) {
    const markup = message?.message ?? (inboxNotification as MentionInboxNotification).markup
    body = markup !== undefined ? jsonToHTML(markupToJSON(markup)) : body
  } else if (message !== undefined) {
    const html = activityMessageToHtml(message)
    if (html !== undefined) {
      body = html
    }
  }

  if (hierarchy.isDerived(doc._class, activity.class.ActivityMessage)) {
    const html = activityMessageToHtml(doc as ActivityMessage)
    if (html !== undefined) {
      quote = html
    }
  }

  return {
    title,
    quote,
    body,
    link: await getNotificationInboxLink(control, doc, message?._id)
  }
}

function hasAttachments (doc: ActivityMessage | undefined, hierarchy: Hierarchy): boolean {
  if (doc === undefined) {
    return false
  }

  if (hierarchy.isDerived(doc._class, chunter.class.ChatMessage)) {
    const chatMessage = doc as ChatMessage
    return (chatMessage.attachments ?? 0) > 0
  }

  return false
}

const telegramNotificationCacheKey = 'telegram.notification.cache'

async function NotificationsHandler (txes: TxCreateDoc<InboxNotification>[], control: TriggerControl): Promise<Tx[]> {
  if (control.queue === undefined) return []

  const all: InboxNotification[] = txes
    .map((tx) => TxProcessor.createDoc2Doc(tx))
    .filter((it) => (it.allowedProviders[telegram.providers.TelegramNotificationProvider]?.length ?? 0) > 0)

  if (all.length === 0) return []

  const producer = control.queue.getProducer<TelegramQueueMessage>(control.ctx, QueueTopic.TelegramBot)
  for (const inboxNotification of all) {
    try {
      await processNotification(control, producer, inboxNotification)
    } catch (e) {
      control.ctx.error('Could not send telegram notification', { inboxNotification, e })
    }
  }

  return []
}

async function processNotification (
  control: TriggerControl,
  producer: PlatformQueueProducer<TelegramQueueMessage>,
  n: InboxNotification
): Promise<void> {
  const cache: Map<Ref<Doc>, Doc> = control.contextCache.get(telegramNotificationCacheKey) ?? new Map()
  control.contextCache.set(telegramNotificationCacheKey, cache)

  const doc = cache.get(n.objectId) ?? (await control.findAll(control.ctx, n.objectClass, { _id: n.objectId }))[0]
  if (doc === undefined) return

  cache.set(n.objectId, doc)

  const messageByNotificationId = await getNotificationMessages(control, [n])
  const message = messageByNotificationId.get(n._id)

  const { title, body, quote, link } = await getTranslatedData(control, doc, n, message)
  const record: TelegramNotificationQueueMessage = {
    type: TelegramQueueMessageType.Notification,
    notificationId: n._id,
    messageId: message?._id,
    account: n.user,
    sender: n.intlParams?.senderName?.toString() ?? 'System',
    attachments: hasAttachments(message, control.hierarchy),
    title,
    quote,
    body,
    link
  }

  await producer.send(control.ctx, control.workspace.uuid, [record])
}

async function updateWorkspaceSubscription (
  producer: PlatformQueueProducer<TelegramQueueMessage>,
  enabled: boolean,
  socialId: PersonId,
  control: TriggerControl
): Promise<void> {
  const account = await getAccountBySocialId(control, socialId)
  if (account == null) {
    return
  }
  await producer.send(control.ctx, control.workspace.uuid, [
    {
      type: TelegramQueueMessageType.WorkspaceSubscription,
      account,
      subscribe: enabled
    }
  ])
}

async function ProviderSettingsHandler (
  txes: TxCUD<NotificationProviderSetting>[],
  control: TriggerControl
): Promise<Tx[]> {
  if (control.queue === undefined) return []
  const producer = control.queue.getProducer<TelegramQueueMessage>(control.ctx, QueueTopic.TelegramBot)

  for (const tx of txes) {
    if (tx._class === core.class.TxCreateDoc) {
      const createTx = tx as TxCreateDoc<NotificationProviderSetting>
      const setting = TxProcessor.createDoc2Doc(createTx)

      if (setting.attachedTo === telegram.providers.TelegramNotificationProvider) {
        await updateWorkspaceSubscription(producer, setting.enabled, setting.createdBy ?? setting.modifiedBy, control)
      }
    } else if (tx._class === core.class.TxUpdateDoc) {
      const updateTx = tx as TxUpdateDoc<NotificationProviderSetting>
      if (updateTx.operations.enabled !== undefined) {
        const setting = (
          await control.findAll(control.ctx, notification.class.NotificationProviderSetting, {
            _id: updateTx.objectId
          })
        )[0]

        if (setting?.attachedTo === telegram.providers.TelegramNotificationProvider) {
          await updateWorkspaceSubscription(
            producer,
            updateTx.operations.enabled,
            setting.createdBy ?? setting.modifiedBy,
            control
          )
        }
      }
    }
  }

  return []
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    OnMessageCreate,
    NotificationsHandler,
    ProviderSettingsHandler
  },
  function: {
    IsIncomingMessageTypeMatch,
    FindMessages,
    GetCurrentEmployeeTG,
    GetIntegrationOwnerTG
  }
})

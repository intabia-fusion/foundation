//
// Copyright © 2023 Hardcore Engineering Inc.
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
  AnyAttribute,
  AttachedDoc,
  Class,
  Collection,
  concatLink,
  Data,
  Doc,
  includesAny,
  Markup,
  notEmpty,
  Ref,
  Space,
  Tx
} from '@hcengineering/core'
import notification, {
  ActivityInboxNotification,
  InboxNotification,
  MentionInboxNotification,
  MessageNotificationType,
  NotificationGroup,
  notificationId,
  NotificationTemplate,
  NotificationType
} from '@hcengineering/notification'
import serverCore, { TriggerControl } from '@hcengineering/server-core'
import { Receiver, TypeMatchClient, TypeMatchFunc } from '@hcengineering/server-notification'
import activity, { ActivityMessage, DocUpdateMessage } from '@hcengineering/activity'
import { getMetadata, getResource, IntlString, translate } from '@hcengineering/platform'
import { workbenchId } from '@hcengineering/workbench'
import { encodeObjectURI } from '@hcengineering/view'
import serverView from '@hcengineering/server-view'
import { getDocIdentifier, getDocTitle, getDocUrl } from '@hcengineering/server-activity-resources'
import { markupToText } from '@hcengineering/text-core'

import { TemplateContent } from './types'

export const IsUserFieldValueTypeMatch: TypeMatchFunc = (
  _client: TypeMatchClient,
  _type: NotificationType,
  _message: Doc,
  doc: Doc,
  receiver: Receiver
): boolean => {
  const type = _type as MessageNotificationType
  if (type.field === undefined) return false
  const value = (doc as any)[type.field]
  if (value == null) return false
  if (value === receiver.employeeRef) return true

  if (Array.isArray(value)) {
    return includesAny(value, receiver.socialIds)
  } else {
    return receiver.socialIds.includes(value)
  }
}

export const MeAddedInCollaboratorsNotificationTypeMatch: TypeMatchFunc = async (
  _client: TypeMatchClient,
  _type: NotificationType,
  _message: Doc,
  _doc: Doc,
  receiver: Receiver
): Promise<boolean> => {
  const message = _message as DocUpdateMessage
  if (message.objectClass !== core.class.Collaborator || message.action !== 'create') return false
  return message.objectAttributes?.collaborator === receiver.account
}

export const MeRemovedFromCollaboratorsNotificationTypeMatch: TypeMatchFunc = async (
  _client: TypeMatchClient,
  _type: NotificationType,
  _message: Doc,
  _doc: Doc,
  receiver: Receiver
): Promise<boolean> => {
  const message = _message as DocUpdateMessage
  if (message.objectClass !== core.class.Collaborator || message.action !== 'remove') return false
  return message.objectAttributes?.collaborator === receiver.account
}

export async function getObjectSpace (control: TriggerControl, doc: Doc, cache: Map<Ref<Doc>, Doc>): Promise<Space> {
  return control.hierarchy.isDerived(doc._class, core.class.Space)
    ? (doc as Space)
    : ((cache.get(doc.space) as Space) ??
        (await control.findAll<Space>(control.ctx, core.class.Space, { _id: doc.space }, { limit: 1 }))[0])
}

export async function getClassNotificationGroup (
  control: TriggerControl,
  _class: Ref<Class<Doc>>
): Promise<NotificationGroup | undefined> {
  const group = (await control.findAll(control.ctx, notification.class.NotificationGroup, { objectClass: _class }))[0]

  if (group != null) return group

  const groups = await control.findAll(control.ctx, notification.class.NotificationGroup, {
    objectClass: { $exists: true }
  })

  for (const g of groups) {
    if (g.objectClass != null && control.hierarchy.isDerived(_class, g.objectClass)) {
      return g
    }
  }
}

export function generateAttributeNotificationType (
  control: TriggerControl,
  attribute: AnyAttribute,
  group: NotificationGroup,
  defaultEnabled = false
): Tx[] {
  const res: Tx[] = []

  const isCollection: boolean = core.class.Collection === attribute.type._class
  const objectClass = !isCollection ? attribute.attributeOf : (attribute.type as Collection<AttachedDoc>).of
  const messageClass = control.hierarchy.isDerived(objectClass, activity.class.ActivityMessage)
    ? objectClass
    : activity.class.DocUpdateMessage

  const data: Data<MessageNotificationType> = {
    attribute: attribute._id,
    group: group.parent ?? group._id,
    subGroup: group.parent != null ? group._id : undefined,
    field: attribute.name,
    generated: true,
    objectClass,
    messageClass,
    hidden: false,
    defaultEnabled,
    attachedToClass: attribute.attributeOf,
    templates: {
      text: notification.emailTemplate.GeneratedNotificationText,
      html: notification.emailTemplate.GeneratedNotificationHtml,
      subject: notification.emailTemplate.GeneratedNotificationSubject
    },
    label: attribute.label
  }
  const id =
    `${notification.class.MessageNotificationType}_${attribute.attributeOf}_${attribute.name}` as Ref<NotificationType>
  res.push(control.txFactory.createTxCreateDoc(notification.class.MessageNotificationType, core.space.Model, data, id))
  return res
}

export async function getNotificationMessages (
  control: TriggerControl,
  notifications: InboxNotification[]
): Promise<Map<Ref<InboxNotification>, ActivityMessage | undefined>> {
  const { hierarchy } = control

  const ids: Ref<ActivityMessage>[] = []
  const map = new Map<Ref<InboxNotification>, Ref<ActivityMessage> | undefined>()

  for (const n of notifications) {
    if (hierarchy.isDerived(n._class, notification.class.ActivityInboxNotification)) {
      const activityNotification = n as ActivityInboxNotification
      ids.push(activityNotification.attachedTo)
      map.set(n._id, activityNotification.attachedTo)
    } else if (hierarchy.isDerived(n._class, notification.class.MentionInboxNotification)) {
      const mentionNotification = n as MentionInboxNotification
      if (hierarchy.isDerived(mentionNotification.mentionedInClass, activity.class.ActivityMessage)) {
        ids.push(mentionNotification.mentionedIn as Ref<ActivityMessage>)
        map.set(n._id, mentionNotification.mentionedIn as Ref<ActivityMessage>)
      }
    }
  }

  if (ids.length === 0) return new Map()

  const messages = await control.findAll(control.ctx, activity.class.ActivityMessage, { _id: { $in: ids } })

  return new Map(
    map.entries().map(([notificationId, messageId]) => [notificationId, messages.find((msg) => msg._id === messageId)])
  )
}

export async function getTranslatedNotificationContent (
  data: Data<InboxNotification>,
  language: string
): Promise<{ title: string, body: string, [key: string]: string }> {
  const params = { ...data.intlParams }

  for (const [k, v] of Object.entries(data.intlParamsNotLocalized ?? {})) {
    params[k] = await translate(v, params, language)
  }

  const title = await translate(data.title ?? notification.string.CommonNotificationTitle, params, language)
  const body = await translate(data.body ?? notification.string.UpdateNotificationBody, params, language)

  return { ...params, title, body }
}

export async function getContentByTemplate (
  control: TriggerControl,
  doc: Doc,
  _types: Ref<NotificationType>[],
  inboxNotification: InboxNotification,
  message: ActivityMessage | undefined
): Promise<TemplateContent | undefined> {
  const { hierarchy, modelDb } = control
  const language = control.branding?.defaultLanguage ?? 'en'
  const types = _types.map((it) => modelDb.getObject(it)).filter(notEmpty)

  const type = types.find((it) => it.templates != null)
  const templates: NotificationTemplate = type?.templates ?? {
    text: notification.emailTemplate.GeneratedNotificationText,
    html: notification.emailTemplate.GeneratedNotificationHtml,
    subject: notification.emailTemplate.GeneratedNotificationSubject
  }

  const params: Record<string, string> = await getTranslatedNotificationContent(inboxNotification, language)

  const title = (await getDocTitle(control, doc)) ?? ''
  const url = await getUrlWithMessage(control, doc, inboxNotification, message?._id)

  const identifier = (inboxNotification.intlParams?.identifier ?? (await getDocIdentifier(control, doc)))?.toString()

  const titleWithIdentifier = identifier != null ? `${identifier}: ${title}` : title
  const htmlTitle = url != null ? `<a href='${url}'>${titleWithIdentifier}</a>` : titleWithIdentifier

  if (url != null) {
    params.url = url
  }
  if (identifier != null) {
    params.identifier = identifier
  }

  if (hierarchy.isDerived(inboxNotification._class, notification.class.MentionInboxNotification)) {
    const markup: Markup | undefined = message?.message ?? (inboxNotification as MentionInboxNotification).markup
    const text = markup !== undefined ? markupToText(markup) : undefined
    params.body = text ?? params.body
    params.message = text ?? params.message
  } else if (message !== undefined) {
    params.message = message.message !== undefined ? markupToText(message.message) : (params.message ?? '')
  } else {
    params.message ??= params.body ?? ''
  }

  const inboxLink = await getNotificationInboxLink(control, doc, message?._id)
  const app = control.branding?.title ?? 'Platform'

  const inboxLinkText = await translate(notification.string.ViewIn, { app }, language)

  params.link = `<a href='${inboxLink}'>${inboxLinkText}</a>`
  const senderName = (inboxNotification?.intlParams?.senderName ?? 'System').toString()

  const text = await fillTemplate(templates.text, senderName, titleWithIdentifier, params, language)
  const html = await fillTemplate(templates.html, senderName, htmlTitle, params, language)
  const subject = await fillTemplate(templates.subject, senderName, titleWithIdentifier, params, language)

  if (subject === '') return

  return {
    text,
    html,
    subject
  }
}

export async function getNotificationInboxLink (
  control: TriggerControl,
  doc: Doc,
  message?: Ref<ActivityMessage>
): Promise<string> {
  const linkProviders = control.modelDb.findAllSync(serverView.mixin.ServerLinkIdProvider, {})
  const provider = linkProviders.find(({ _id }) => _id === doc._class)

  let id: string = doc._id

  if (provider !== undefined) {
    const encodeFn = await getResource(provider.encode)

    id = await encodeFn(doc, control)
  }

  let thread: string | undefined

  if (control.hierarchy.isDerived(doc._class, activity.class.ActivityMessage)) {
    const id = (doc as ActivityMessage)._id

    if (message === undefined) {
      message = id
    } else {
      thread = id
    }
  }

  const front = control.branding?.front ?? getMetadata(serverCore.metadata.FrontUrl) ?? ''
  const path = [workbenchId, control.workspace.url, notificationId, encodeObjectURI(id, doc._class), thread]
    .filter((x): x is string => x !== undefined)
    .map((p) => encodeURIComponent(p))
    .join('/')

  const link = concatLink(front, path)

  return message !== undefined ? `${link}?message=${message}` : link
}

async function fillTemplate (
  template: IntlString,
  sender: string,
  doc: string,
  params: Record<string, string>,
  lang: string
): Promise<string> {
  return await translate(
    template,
    {
      ...params,
      sender,
      doc
    },
    lang
  )
}

async function getUrlWithMessage (
  control: TriggerControl,
  doc: Doc,
  inboxNotification: InboxNotification,
  messageId?: Ref<ActivityMessage>
): Promise<string | undefined> {
  const baseUrl = inboxNotification.intlParams?.url?.toString() ?? (await getDocUrl(control, doc))?.toString()
  if (baseUrl == null || baseUrl === '') return

  const front = control.branding?.front ?? getMetadata(serverCore.metadata.FrontUrl) ?? ''

  try {
    const url = front !== '' ? new URL(baseUrl, front) : new URL(baseUrl)

    if (messageId != null) {
      url.searchParams.set('message', messageId)
    }

    return url.toString()
  } catch (e) {
    control.ctx.error('Invalid url', { baseUrl, front, e })
    return baseUrl
  }
}

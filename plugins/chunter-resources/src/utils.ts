//
// Copyright © 2023 Hardcore Engineering Inc.
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
import { type ActivityMessage, type ForwardContent, type ForwardedAttachment } from '@hcengineering/activity'
import aiBot from '@hcengineering/ai-bot'
import {
  summarizeMessages as aiSummarizeMessages,
  translate as aiTranslate,
  getBotAccount
} from '@hcengineering/ai-bot-resources'
import {
  type Channel,
  type ChatMessage,
  chunterId,
  createDirect,
  type DirectMessage,
  type ThreadMessage
} from '@hcengineering/chunter'
import contact, { type Employee, getCurrentEmployee, getName, type Person } from '@hcengineering/contact'
import { employeeByAccountStore, PersonIcon } from '@hcengineering/contact-resources'
import core, {
  AccountRole,
  type AccountUuid,
  type Class,
  type Client,
  type Doc,
  generateId,
  getCurrentAccount,
  hasAccountRole,
  type Markup,
  notEmpty,
  type Ref,
  type Space,
  type Timestamp,
  type WithLookup
} from '@hcengineering/core'
import { type AttributeApplierResult } from '@hcengineering/view'
import { type Asset, getMetadata, getResource, type IntlString, translate } from '@hcengineering/platform'
import { getClient } from '@hcengineering/presentation'
import {
  type AnySvelteComponent,
  closePopup,
  closeTooltip,
  getCurrentLocation,
  type IconSize,
  languageStore,
  showPopup
} from '@hcengineering/ui'
import { classIcon, getDocIdentifier, getDocLabel, getDocTitle } from '@hcengineering/view-resources'
import { get, type Unsubscriber } from 'svelte/store'
import love, { type MeetingMinutes } from '@hcengineering/love'
import attachment, { type Attachment } from '@hcengineering/attachment'
import { isEmptyMarkup } from '@hcengineering/text'
import notification, { notificationId } from '@hcengineering/notification'

import ChannelIcon from './components/ChannelIcon.svelte'
import DirectIcon from './components/DirectIcon.svelte'
import { openChannel, openChannelInSidebar, resetChunterLocIfEqual } from './navigation'
import chunter from './plugin'
import {
  replyingToMessageStore,
  shownTranslatedMessagesStore,
  translatedMessagesStore,
  translatingMessagesStore
} from './stores'
import ForwardMessageDialog from './components/ForwardMessageDialog.svelte'
import view, { decodeObjectURI } from '@hcengineering/view'

export async function getDmName (client: Client, space?: DirectMessage): Promise<string> {
  if (space === undefined) {
    return ''
  }

  return await buildDmName(client, space.name, space.members)
}

export async function buildDmName (client: Client, name: string, accounts: AccountUuid[]): Promise<string> {
  if (accounts.length === 0) {
    return name
  }

  if (accounts.length > 2 && name.trim().length > 0) {
    return name
  }

  let unsub: Unsubscriber | undefined
  const employeeByAccountPromise = new Promise<Map<AccountUuid, Employee | undefined>>((resolve) => {
    unsub = employeeByAccountStore.subscribe((p) => {
      resolve(p)
    })
  })

  const me = getCurrentEmployee()
  const employeeByAccount = await employeeByAccountPromise

  unsub?.()

  const names: string[] = []
  const processedPersons: Array<Ref<Person>> = []

  let myName = ''

  for (const acc of accounts) {
    const employee = employeeByAccount.get(acc) ?? (await client.findOne(contact.class.Person, { personUuid: acc }))

    if (employee === undefined) {
      continue
    }

    if (processedPersons.includes(employee._id)) {
      continue
    }

    if (me === employee._id) {
      myName = getName(client.getHierarchy(), employee)
      processedPersons.push(employee._id)
      continue
    }

    names.push(getName(client.getHierarchy(), employee))
    processedPersons.push(employee._id)
  }

  return names.length > 0 ? names.join(', ') : myName
}

export async function canDeleteMessage (doc?: ChatMessage): Promise<boolean> {
  if (doc === undefined) {
    return false
  }

  const me = getCurrentAccount()

  if (hasAccountRole(me, AccountRole.Maintainer)) {
    return true
  }

  return doc.createdBy !== undefined && me.socialIds.includes(doc.createdBy)
}

export function canReplyToThread (doc?: ActivityMessage): boolean {
  if (doc === undefined) {
    return false
  }

  return doc._class !== chunter.class.ThreadMessage
}

export async function canCopyMessageLink (doc?: ActivityMessage | ActivityMessage[]): Promise<boolean> {
  const message = Array.isArray(doc) ? doc[0] : doc

  return message !== undefined
}

export async function getDmPersons (client: Client, members: AccountUuid[]): Promise<Person[]> {
  if (members.length === 0) {
    return []
  }
  const myAcc = getCurrentAccount().uuid
  const accounts = members.length > 1 ? members.filter((m) => m !== myAcc) : members

  return await client.findAll(contact.class.Person, {
    personUuid: { $in: accounts }
  })
}

export async function DirectTitleProvider (
  client: Client,
  id: Ref<DirectMessage>,
  doc?: DirectMessage
): Promise<string> {
  const direct = doc ?? (await client.findOne(chunter.class.DirectMessage, { _id: id }))

  if (direct === undefined) {
    return ''
  }

  return await getDmName(client, direct)
}

export async function DirectLabelProvider (
  client: Client,
  id: Ref<DirectMessage>,
  doc?: DirectMessage
): Promise<IntlString> {
  const direct = doc ?? (await client.findOne(chunter.class.DirectMessage, { _id: id }))

  if (direct === undefined) {
    return chunter.string.Direct
  }

  return direct.type === 'group' ? chunter.string.GroupChat : chunter.string.Direct
}

export async function ChannelTitleProvider (client: Client, id: Ref<Channel>, doc?: Channel): Promise<string> {
  const channel = doc ?? (await client.findOne(chunter.class.Channel, { _id: id }))

  if (channel === undefined) {
    return ''
  }

  return channel.name
}

export enum SearchType {
  Messages,
  Files
}

export async function getTitle (doc: Doc): Promise<string> {
  const client = getClient()
  const hierarchy = client.getHierarchy()
  let clazz = hierarchy.getClass(doc._class)
  let label = clazz.shortLabel
  while (label === undefined && clazz.extends !== undefined) {
    clazz = hierarchy.getClass(clazz.extends)
    label = clazz.shortLabel
  }
  label = label ?? doc._class
  return `${label}-${doc._id}`
}

export function getObjectIcon (_class: Ref<Class<Doc>>): Asset | AnySvelteComponent | undefined {
  const client = getClient()
  const hierarchy = client.getHierarchy()

  if (_class === chunter.class.Channel) {
    return ChannelIcon
  }

  if (_class === chunter.class.DirectMessage) {
    return DirectIcon
  }

  if (hierarchy.isDerived(_class, contact.class.Person)) {
    return PersonIcon
  }

  return classIcon(client, _class)
}

export async function getChannelName (
  _id: Ref<Doc>,
  _class: Ref<Class<Doc>>,
  object: Doc | undefined,
  lang: string
): Promise<string | undefined> {
  const client = getClient()

  return (await getDocTitle(client, _id, _class, object)) ?? (await getDocLabel(client, _id, _class, object, lang))
}

export async function getUnreadThreadsCount (): Promise<number> {
  const client = getClient()
  const contexts = await client.findAll(
    notification.class.DocNotifyContext,
    {
      objectClass: chunter.class.ChatMessage,
      unreadCount: { $gt: 0 },
      unreadMessages: { $size: { $gt: 0 } }
    },
    { limit: 1, total: true }
  )

  return contexts.total ?? 0
}

export function getClosestDate (selectedDate: Timestamp, dates: Timestamp[]): Timestamp | undefined {
  if (dates.length === 0) {
    return
  }

  let closestDate: Timestamp | undefined = dates[dates.length - 1]
  const reversedDates = [...dates].reverse()

  for (const date of reversedDates) {
    if (date < selectedDate) {
      break
    } else if (date - selectedDate < closestDate - selectedDate) {
      closestDate = date
    }
  }

  return closestDate
}

export async function joinChannel (channel: Channel, value: AccountUuid | AccountUuid[]): Promise<void> {
  const client = getClient()

  if (Array.isArray(value)) {
    if (value.length > 0) {
      await client.update(channel, { $push: { members: { $each: value, $position: 0 } } })
    }
  } else {
    await client.update(channel, { $push: { members: value } })
  }
}

export async function leaveChannel (channel: Space | undefined, value: AccountUuid | AccountUuid[]): Promise<void> {
  if (channel === undefined) return

  const client = getClient()

  if (Array.isArray(value)) {
    if (value.length > 0) {
      await client.update(channel, { $pull: { members: { $in: value } } })
    }
  } else {
    await client.update(channel, { $pull: { members: value } })
    await resetChunterLocIfEqual(channel._id, channel._class, channel)
  }
}

export function isThreadMessage (message: ActivityMessage): message is ThreadMessage {
  return message._class === chunter.class.ThreadMessage
}

export function getChannelSpace (_class: Ref<Class<Doc>>, _id: Ref<Doc>, space: Ref<Space>): Ref<Space> {
  return getClient().getHierarchy().isDerived(_class, core.class.Space) ? (_id as Ref<Space>) : space
}

export async function translateMessage (message: ChatMessage): Promise<void> {
  if (get(translatingMessagesStore).has(message._id)) {
    return
  }

  if (get(translatedMessagesStore).has(message._id)) {
    shownTranslatedMessagesStore.update((store) => store.add(message._id))
    return
  }

  translatingMessagesStore.update((store) => store.add(message._id))
  const response = await aiTranslate(message.message, get(languageStore))

  if (response !== undefined) {
    translatedMessagesStore.update((store) => store.set(message._id, response.text))
    shownTranslatedMessagesStore.update((store) => store.add(message._id))
  }

  translatingMessagesStore.update((store) => {
    store.delete(message._id)
    return store
  })
}

export async function showOriginalMessage (message: ChatMessage): Promise<void> {
  shownTranslatedMessagesStore.update((store) => {
    store.delete(message._id)
    return store
  })
}

export async function canTranslateMessage (): Promise<boolean> {
  const url = getMetadata(aiBot.metadata.EndpointURL) ?? ''
  return url !== ''
}

export async function summarizeMessages (doc: Doc): Promise<void> {
  await aiSummarizeMessages(get(languageStore), doc._id, doc._class)
}

export async function canSummarizeMessages (doc: Doc): Promise<boolean> {
  if (doc?._id === undefined) return false

  const url = getMetadata(aiBot.metadata.EndpointURL) ?? ''
  if (url === '') return false

  const client = getClient()
  const hierarchy = client.getHierarchy()

  if (!hierarchy.isDerived(doc._class, love.class.MeetingMinutes)) return false

  return ((doc as MeetingMinutes).transcription ?? 0) > 0
}

export async function startConversationAction (docs?: Employee | Employee[]): Promise<void> {
  if (docs === undefined) return
  const employees = Array.isArray(docs) ? docs : [docs]
  const accounts = employees.map(({ personUuid }) => personUuid).filter(notEmpty)
  const client = getClient()
  const dm = await createDirect(client, accounts)
  if (dm == null) return

  await openChannelInSidebar(dm, chunter.class.DirectMessage)
}

export async function openDirectForPerson (person: Person, forceSidebar = false): Promise<void> {
  const client = getClient()
  if (!client.getHierarchy().hasMixin(person, contact.mixin.Employee)) return
  if (!(person as Employee).active || person.personUuid == null) return

  const dm = await createDirect(client, [getCurrentAccount().uuid, person.personUuid as AccountUuid])
  if (dm == null) return

  const loc = getCurrentLocation()
  const [openedId] = decodeObjectURI(loc.path[3]) ?? []
  if (openedId === dm) return

  // Chat apps show the direct inline; elsewhere the sidebar keeps the user where they were.
  const app = loc.path[2]
  if (!forceSidebar && (app === chunterId || app === notificationId)) {
    openChannel(dm, chunter.class.DirectMessage, undefined, true)
  } else {
    await openChannelInSidebar(dm, chunter.class.DirectMessage)
  }
}

export async function openBotDirect (): Promise<void> {
  const botAccount = await getBotAccount()
  if (botAccount === undefined) return
  const client = getClient()
  const dm = await createDirect(client, [getCurrentAccount().uuid, botAccount])
  if (dm == null) return
  openChannel(dm, chunter.class.DirectMessage, undefined, true)
}

export async function toggleChannelIcon (channel: Channel, icon?: Asset, emoji?: number | number[]): Promise<void> {
  const client = getClient()
  const normalizeEmoji = (e?: number | number[]): string => {
    if (e == null) return ''
    return Array.isArray(e) ? e.join('') : String(e)
  }
  const currentEmoji = normalizeEmoji(channel.emoji)
  const nextEmoji = normalizeEmoji(emoji)

  if (channel.icon === icon && currentEmoji === nextEmoji) {
    await client.update(channel, { $unset: { icon: true, emoji: true } })
  } else {
    await client.update(channel, { icon, emoji })
  }
}

async function getForwardedAttachments (message: WithLookup<ChatMessage>): Promise<ForwardedAttachment[]> {
  if ((message.attachments ?? 0) === 0) return []

  const client = getClient()
  const attachments = (
    (message.$lookup?.attachments as Attachment[]) ??
    (await client.findAll(attachment.class.Attachment, { attachedTo: message._id }))
  ).filter((it) => it.type !== 'application/link-preview')

  if (attachments.length === 0) return []

  return attachments.map((it) => ({
    originId: it._id,
    name: it.name,
    file: it.file,
    size: it.size,
    type: it.type,
    createdOn: it.createdOn ?? it.modifiedOn,
    metadata: it.metadata
  }))
}

async function getForwardContent (message: WithLookup<ChatMessage>): Promise<ForwardContent | undefined> {
  return {
    author: message.createdBy ?? message.modifiedBy,
    message: message.message,
    createdOn: message.createdOn ?? message.modifiedOn,
    attachments: await getForwardedAttachments(message)
  }
}

export async function getForwardData (message: WithLookup<ChatMessage>): Promise<{
  forwardedMessage?: Ref<ActivityMessage>
  forwardFromId?: Ref<Doc>
  forwardFromClass?: Ref<Class<Doc>>
  forwardContent?: ForwardContent
}> {
  const hasContent = (message.attachments ?? 0) > 0 || !isEmptyMarkup(message.message)
  if (hasContent) {
    return {
      forwardedMessage: message._id,
      forwardFromId: message.attachedTo,
      forwardFromClass: message.attachedToClass,
      forwardContent: await getForwardContent(message)
    }
  } else if (message.forwardedMessage != null) {
    return {
      forwardedMessage: message.forwardedMessage,
      forwardFromId: message.forwardFromId,
      forwardFromClass: message.forwardFromClass,
      forwardContent: message.forwardContent
    }
  }

  return {}
}

export async function replyToMessage (message: ChatMessage): Promise<void> {
  replyingToMessageStore.set(message)
  closePopup()
  closeTooltip()
}

export async function forwardMessage (message: ChatMessage): Promise<void> {
  showPopup(ForwardMessageDialog, { message }, 'top')
}

export async function getChatDocIcon (doc: Doc): Promise<{
  icon: Asset | AnySvelteComponent
  iconSize: IconSize
  iconProps: Record<string, any>
  withIconBackground: boolean
}> {
  const { _class } = doc
  const client = getClient()
  const hierarchy = client.getHierarchy()
  const iconMixin = hierarchy.classHierarchyMixin(_class, view.mixin.ObjectIcon)

  const isPerson = hierarchy.isDerived(_class, contact.class.Person)
  const isDirect = hierarchy.isDerived(_class, chunter.class.DirectMessage)

  const iconSize: IconSize = isDirect || isPerson ? 'x-small' : 'small'

  let icon: AnySvelteComponent | undefined

  if (iconMixin?.component != null) {
    icon = await getResource(iconMixin.component)
  }

  return {
    icon: icon ?? getObjectIcon(_class) ?? chunter.icon.Hashtag,
    iconProps: { showStatus: true, visiblePersons: 2 },
    iconSize,
    withIconBackground: !isDirect && !isPerson
  }
}

export async function getChatDocTitle (
  doc: Doc,
  lang: string
): Promise<{
  identifier?: string
  title: string
}> {
  const { _class } = doc
  const client = getClient()
  const hierarchy = client.getHierarchy()
  const titleIntl = client.getHierarchy().getClass(_class).label

  const isPerson = hierarchy.isDerived(_class, contact.class.Person)
  const isDirect = hierarchy.isDerived(_class, chunter.class.DirectMessage)

  const identifier = isPerson || isDirect ? undefined : await getDocIdentifier(client, doc._id, doc._class, doc)
  const title = (await getChannelName(doc._id, doc._class, doc, lang)) ?? (await translate(titleIntl, {}, lang))

  return {
    identifier,
    title
  }
}

export async function CommentsApplier (
  object: Doc,
  _value: { message: Markup } | undefined | null
): Promise<AttributeApplierResult> {
  const value = _value?.message
  if (value == null || (typeof value === 'string' && value.trim().length === 0) || isEmptyMarkup(value)) {
    return {}
  }
  const client = getClient()
  const txFactory = client.txFactory
  const id = generateId<ChatMessage>()
  const modifiedOn = Date.now()
  const modifiedBy = getCurrentAccount().primarySocialId

  const createDocTx = txFactory.createTxCreateDoc<ChatMessage>(
    chunter.class.ChatMessage,
    object.space,
    {
      attachedTo: object._id,
      attachedToClass: object._class,
      collection: 'comments',
      message: value
    },
    id,
    modifiedOn,
    modifiedBy
  )

  const collectionTx = txFactory.createTxCollectionCUD(
    object._class,
    object._id,
    object.space,
    'comments',
    createDocTx,
    modifiedOn,
    modifiedBy
  )

  return { txes: [collectionTx] }
}

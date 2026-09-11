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

import chunter, { type Channel, type ChatMessage, type DirectMessage } from '@hcengineering/chunter'
import contact, { type Channel as ContactChannel, type Contact, formatName, type Person } from '@hcengineering/contact'
import {
  type AccountUuid,
  type BlobType,
  type Class,
  type Doc,
  type Domain,
  type Hierarchy,
  type Ref,
  toIdMap
} from '@hcengineering/core'
import { type MigrateUpdate, type MigrationClient, type MigrationDocumentQuery } from '@hcengineering/model'
import notification, {
  type CommonNotification,
  type ContextNotification,
  type DocNotifyContext,
  type NotificationMessage,
  type UnreadMention,
  type UnreadMessage,
  type UnreadReaction
} from '@hcengineering/notification'
import { type Asset, type IntlString, translate } from '@hcengineering/platform'
import activity, { type ActivityMessage, type Reaction } from '@hcengineering/activity'
import { isEmptyMarkup, markupToText } from '@hcengineering/text'
import { DOMAIN_ACTIVITY, DOMAIN_REACTION } from '@hcengineering/model-activity'
import { type Attachment } from '@hcengineering/attachment'
import { DOMAIN_ATTACHMENT } from '@hcengineering/model-attachment'

import { DOMAIN_DOC_NOTIFY } from '../index'
import {
  type ActivityInboxNotification,
  type CommonInboxNotification,
  type DocNotifyContextOld,
  DOMAIN_CONTACT,
  DOMAIN_NOTIFICATION,
  type InboxNotification,
  type MentionInboxNotification,
  type ReactionInboxNotification
} from './types'

export function getDocLabelFallback (doc: Doc, hierarchy: Hierarchy): DocNotifyContext['objectLabel'] {
  if (hierarchy.isDerived(doc._class, chunter.class.DirectMessage)) {
    const direct = doc as DirectMessage
    return direct.type === 'person' ? chunter.string.Direct : chunter.string.GroupChat
  }
  const clazz = hierarchy.getClass(doc._class)
  return clazz?.label
}

export function getDocIconFallback (
  client: MigrationClient,
  doc: Doc,
  accountUuid?: AccountUuid
): DocNotifyContext['objectIcon'] | undefined {
  const { hierarchy } = client

  if (hierarchy.isDerived(doc._class, chunter.class.Channel)) {
    const channel = doc as Channel
    return {
      emoji: channel.emoji,
      asset: channel.icon ?? (channel.private ? chunter.icon.Lock : chunter.icon.Hashtag)
    }
  }

  if (hierarchy.isDerived(doc._class, chunter.class.DirectMessage)) {
    const clazz = hierarchy.getClass(doc._class)
    const direct = doc as DirectMessage
    let members = direct.members
    if (accountUuid !== undefined) {
      members = members.length > 1 ? members.filter((it) => it !== accountUuid) : members
    }
    return {
      asset: clazz?.icon,
      props: { members }
    }
  }

  if (doc._class === 'tracker:class:Issue' || hierarchy.isDerived(doc._class, 'tracker:class:Issue' as any)) {
    const d = doc as any
    return {
      asset: 'tracker:icon:Issue' as any,
      props: {
        space: d.space,
        kind: d.kind,
        status: d.status
      }
    }
  }

  return { props: { _id: doc._id } }
}

async function getPersonByAccountUuid (
  client: MigrationClient,
  accountUuid: AccountUuid,
  personByAccount: Map<AccountUuid, Person>
): Promise<Person | undefined> {
  const current = personByAccount.get(accountUuid)
  if (current != null) {
    return current
  }
  const person = (await client.find<Person>(DOMAIN_CONTACT, { personUuid: accountUuid }))[0]
  if (person != null) {
    personByAccount.set(accountUuid, person)
  }
  return person
}

async function getDoc<T extends Doc = Doc> (
  client: MigrationClient,
  _id: Ref<Doc>,
  _class: Ref<Class<Doc>>,
  cache: Map<Ref<Doc>, Doc>
): Promise<T | undefined> {
  if (_id == null) {
    return undefined
  }
  const current = cache.get(_id)
  if (current != null) {
    return current as T
  }

  const domain = client.hierarchy.findDomain(_class)
  if (domain == null) return
  const doc = (await client.find<Doc>(domain, { _id }))[0]
  if (doc != null) {
    cache.set(_id, doc)
  }
  return doc as any as T
}

async function getDocTitleFallback (
  client: MigrationClient,
  doc: Doc,
  personByAccount: Map<AccountUuid, Person>,
  cache: Map<Ref<Doc>, Doc>,
  accountUuid?: AccountUuid
): Promise<string> {
  const { hierarchy } = client
  const _class = doc._class

  // 1. ActivityMessage
  if (hierarchy.isDerived(_class, activity.class.ActivityMessage)) {
    const message = doc as ActivityMessage
    if (message.message != null && !isEmptyMarkup(message.message)) {
      const text = markupToText(message.message).trim()
      const normalized = text.length > 100 ? text.slice(0, 100).trim() + '...' : text
      if (text.length > 0) {
        return normalized
      }
    }
    return ''
  }

  // 2. Chunter & Contact Channels
  if (hierarchy.isDerived(_class, chunter.class.Channel)) {
    return `#${(doc as Channel).name}`
  }

  if (hierarchy.isDerived(_class, contact.class.Channel)) {
    return (doc as ContactChannel).value
  }

  // 3. DirectMessage (personalized name format excluding "me")
  if (hierarchy.isDerived(doc._class, chunter.class.DirectMessage)) {
    const direct = doc as DirectMessage
    if (direct.type === 'person') {
      const companion = direct.members.find((it) => it !== accountUuid) ?? direct.members[0]
      if (companion != null) {
        const companionPerson = await getPersonByAccountUuid(client, companion, personByAccount)
        if (companionPerson?.name != null) {
          return formatName(companionPerson.name) ?? ''
        }
      }
      return ''
    }

    // fallback building name list
    const names: string[] = []
    let myName = ''
    const processedPersons = new Set<Ref<Person>>()

    for (const companion of direct.members) {
      const person = await getPersonByAccountUuid(client, companion, personByAccount)
      if (person == null) continue
      if (processedPersons.has(person._id)) continue

      processedPersons.add(person._id)

      const personName = formatName(person.name)

      if (accountUuid !== undefined && person.personUuid === accountUuid) {
        myName = personName
        continue
      }

      names.push(personName)
    }

    return names.length > 0 ? names.join(', ') : myName
  }

  // 4. Contact
  if (contact.class.Contact != null && hierarchy.isDerived(doc._class, contact.class.Contact)) {
    return formatName((doc as Contact).name)
  }

  // 5. ControlledDocument (documents.class.ControlledDocument)
  if (
    _class === 'documents:class:ControlledDocument' ||
    hierarchy.isDerived(doc._class, 'documents:class:ControlledDocument' as any)
  ) {
    const d = doc as any
    const title = d.title ?? ''
    const major = d.major !== undefined ? d.major : 1
    const minor = d.minor !== undefined ? d.minor : 0
    return `${title} (v${major}.${minor})`
  }

  // 6. DocumentMeta (documents.class.DocumentMeta)
  if (
    _class === 'documents:class:DocumentMeta' ||
    hierarchy.isDerived(doc._class, 'documents:class:DocumentMeta' as any)
  ) {
    const d = doc as any
    const title = d.title ?? ''
    return `${title} (Latest)`
  }

  // 7. Lead
  if (_class === 'lead:class:Lead' || hierarchy.isDerived(doc._class, 'lead:class:Lead' as any)) {
    const d = doc as any
    return `LEAD-${d.number ?? ''}`
  }

  // 8. Gmail Message
  if (_class === 'gmail:class:Message' || hierarchy.isDerived(doc._class, 'gmail:class:Message' as any)) {
    const d = doc as any
    return typeof d.subject === 'string' ? d.subject : ''
  }

  // 9. MeetingMinutes
  if (_class === 'love:class:MeetingMinutes' || hierarchy.isDerived(doc._class, 'love:class:MeetingMinutes' as any)) {
    const d = doc as any
    return d.name ?? ''
  }

  // 10. UserMeetingInvite
  if (
    _class === 'love:class:UserMeetingInvite' ||
    hierarchy.isDerived(doc._class, 'love:class:UserMeetingInvite' as any)
  ) {
    const d = doc as any
    const fromId = d.from
    if (fromId != null) {
      const sender = await getDoc<Person>(client, fromId, contact.class.Person, cache)
      if (sender != null) {
        return `${formatName(sender.name)} (Meeting Invitation)`
      }
    }
    return 'Meeting Invitation'
  }

  // 11. Recruiter Applicant / Vacancy / Review
  if (_class === 'recruit:class:Vacancy' || hierarchy.isDerived(doc._class, 'recruit:class:Vacancy' as any)) {
    const d = doc as any
    return d.name ?? ''
  }
  if (_class === 'recruit:class:Review' || hierarchy.isDerived(doc._class, 'recruit:class:Review' as any)) {
    const d = doc as any
    return d.title ?? ''
  }
  if (_class === 'recruit:class:Applicant' || hierarchy.isDerived(doc._class, 'recruit:class:Applicant' as any)) {
    const d = doc as any
    const candidateId = d.attachedTo as Ref<Person> | undefined
    if (candidateId != null) {
      const candidate = await getDoc<Person>(client, candidateId, contact.class.Person, cache)
      if (candidate != null) {
        return formatName(candidate.name)
      }
    }
    return d.name ?? ''
  }

  // 12. Request (both hr:class:Request and request:class:Request)
  if (
    _class === 'request:class:Request' ||
    hierarchy.isDerived(_class, 'request:class:Request' as any) ||
    _class === 'hr:class:Request' ||
    hierarchy.isDerived(_class, 'hr:class:Request' as any)
  ) {
    const d = doc as any
    const labelVal = getDocLabelFallback(d, hierarchy)
    const title = labelVal != null ? await translate(labelVal, {}) : 'Request'
    if (d.attachedTo != null && d.attachedToClass != null) {
      const target = await getDoc(client, d.attachedTo, d.attachedToClass, cache)
      if (target != null) {
        const attachedTitle = await getDocTitleFallback(client, target, personByAccount, cache, accountUuid)
        if (attachedTitle !== '') {
          return `${title} — ${attachedTitle}`
        }
      }
    }
    return title
  }

  // Fallbacks:
  // First check titleKey defined in class metadata
  const clazz = hierarchy.getClass(doc._class)
  if (clazz?.titleKey != null && clazz.titleKey !== '') {
    const titleVal = (doc as any)[clazz.titleKey]
    if (titleVal != null) {
      return titleVal
    }
  }

  const d = doc as any
  if (typeof d.title === 'string') return d.title
  if (typeof d.name === 'string') return d.name
  if (typeof d.label === 'string') return d.label
  if (typeof d.subject === 'string') return d.subject
  if (typeof d.summary === 'string') return d.summary
  return ''
}

async function getDocIdentifierFallback (
  client: MigrationClient,
  doc: Doc,
  cache: Map<Ref<Doc>, Doc>
): Promise<string | undefined> {
  const _class = doc._class
  const { hierarchy } = client

  // 1. Lead
  if (_class === 'lead:class:Lead' || hierarchy.isDerived(doc._class, 'lead:class:Lead' as any)) {
    const d = doc as any
    if (typeof d.number === 'number' || typeof d.number === 'string') {
      return `LEAD-${d.number}`
    }
  }

  // 2. Recruit (Vacancy, Applicant)
  if (
    _class === 'recruit:class:Vacancy' ||
    hierarchy.isDerived(doc._class, 'recruit:class:Vacancy' as any) ||
    _class === 'recruit:class:Applicant' ||
    hierarchy.isDerived(doc._class, 'recruit:class:Applicant' as any)
  ) {
    const d = doc as any
    if (typeof d.number === 'number' || typeof d.number === 'string') {
      let clazz = hierarchy.getClass(doc._class)
      let label = clazz?.shortLabel
      while (label === undefined && clazz?.extends !== undefined) {
        clazz = hierarchy.getClass(clazz.extends)
        label = clazz?.shortLabel
      }
      return label !== undefined ? `${label}-${d.number}` : d.number.toString()
    }
  }

  // 3. Issue
  if (_class === 'tracker:class:Issue' || hierarchy.isDerived(doc._class, 'tracker:class:Issue' as any)) {
    const d = doc as any
    if (typeof d.number === 'number' || typeof d.number === 'string') {
      const project = (await getDoc(client, doc.space, 'tracker:class:Project' as any, cache)) as any
      if (project != null && typeof project.identifier === 'string') {
        return `${project.identifier}-${d.number}`
      }
    }
  }

  // 5. Default: check identifier property
  if (typeof (doc as any).identifier === 'string') return (doc as any).identifier

  return undefined
}

function toNotificationMessage (message: ActivityMessage): NotificationMessage {
  const { editedOn, replies, repliedPersons, reactions, isPinned, lastReply, ...notificationMessage } = message
  return notificationMessage
}

function getTimestamp (doc: InboxNotification): number {
  return doc.createdOn ?? doc.modifiedOn ?? 0
}

async function mapToContextNotification (
  client: MigrationClient,
  inboxNotification: InboxNotification,
  reactionMap: Map<Ref<Reaction>, Reaction>,
  cache: Map<Ref<Doc>, Doc>,
  attachmentsByMessage: Map<Ref<ActivityMessage>, BlobType[]>
): Promise<ContextNotification | null> {
  const createdOn = getTimestamp(inboxNotification)
  const createdBy = inboxNotification.createdBy ?? inboxNotification.modifiedBy

  const _class = inboxNotification._class

  if (_class === 'notification:class:ActivityInboxNotification') {
    const activityNotif = inboxNotification as ActivityInboxNotification
    const message = await getDoc<ActivityMessage>(
      client,
      activityNotif.attachedTo,
      activityNotif.attachedToClass,
      cache
    )
    if (message == null) return null

    const attachments = attachmentsByMessage.get(activityNotif.attachedTo) ?? []

    return {
      type: 'message',
      id: activityNotif.attachedTo,
      messageId: activityNotif.attachedTo,
      message: toNotificationMessage(message),
      attachments,
      createdBy,
      createdOn
    }
  } else if (_class === 'notification:class:ReactionInboxNotification') {
    const reactNotif = inboxNotification as ReactionInboxNotification
    const reaction = reactionMap.get(reactNotif.ref)
    if (reaction == null) return null
    const message = await getDoc<ActivityMessage>(client, reactNotif.attachedTo, reactNotif.attachedToClass, cache)
    if (message == null) return null

    const attachments = attachmentsByMessage.get(reactNotif.attachedTo) ?? []

    return {
      type: 'reaction',
      id: reactNotif.ref,
      messageId: reactNotif.attachedTo,
      message: toNotificationMessage(message),
      attachments,
      reaction,
      createdBy,
      createdOn
    }
  } else if (_class === 'notification:class:MentionInboxNotification') {
    const mentionNotif = inboxNotification as MentionInboxNotification
    const message =
      mentionNotif.mentionedIn != null &&
      mentionNotif.mentionedInClass != null &&
      client.hierarchy.isDerived(mentionNotif.mentionedInClass, activity.class.ActivityMessage)
        ? await getDoc<ActivityMessage>(client, mentionNotif.mentionedIn, mentionNotif.mentionedInClass, cache)
        : undefined
    const markup = message?.message ?? mentionNotif.markup ?? ''

    const attachments = message != null ? (attachmentsByMessage.get(message._id) ?? []) : []

    return {
      type: 'mention',
      id: inboxNotification._id,
      messageId: message?._id,
      markup,
      attachments,
      createdBy,
      createdOn
    }
  } else if (_class === 'notification:class:CommonInboxNotification') {
    return mapToCommonNotification(inboxNotification as CommonInboxNotification)
  }

  return null
}

function mapToCommonNotification (inboxNotification: CommonInboxNotification): CommonNotification {
  const createdOn = getTimestamp(inboxNotification)
  const createdBy = inboxNotification.createdBy ?? inboxNotification.modifiedBy

  const messageIntl = inboxNotification.message
  const markup = inboxNotification.markup

  let icon: Asset | undefined
  let header: CommonNotification['header']

  if (inboxNotification.icon != null) {
    icon = inboxNotification.icon
  }

  if (inboxNotification.header !== undefined) {
    header = {
      objectId: inboxNotification.headerObjectId,
      objectClass: inboxNotification.headerObjectClass,
      titleIntl: inboxNotification.header,
      icon: inboxNotification.headerIcon
    }
  }

  return {
    type: 'common',
    id: inboxNotification._id,
    header,
    messageIntl,
    intlParams: {
      ...inboxNotification.intlParams,
      ...inboxNotification.props
    },
    intlParamsNotLocalized: inboxNotification.intlParamsNotLocalized,
    markup,
    icon,
    iconProps: inboxNotification.iconProps,
    createdBy,
    createdOn
  }
}

export async function migrateNotificationsToEmbedded (client: MigrationClient): Promise<void> {
  let processed = 0

  const iterator = await client.traverse<DocNotifyContextOld>(DOMAIN_DOC_NOTIFY, {
    _class: notification.class.DocNotifyContext,
    latestNotifications: { $exists: false }
  })

  const personByAccountUuid = new Map<AccountUuid, Person>()

  try {
    while (true) {
      const contextsBatch = (await iterator.next(500)) ?? []

      if (contextsBatch.length === 0) break

      const chunkSize = 100
      for (let i = 0; i < contextsBatch.length; i += chunkSize) {
        const chunk = contextsBatch.slice(i, i + chunkSize)
        const chunkIds = chunk.map((c) => c._id).filter((id) => id != null)
        const toRemove = new Set<Ref<DocNotifyContextOld>>()
        const chunkNotifications = await client.find<InboxNotification>(DOMAIN_NOTIFICATION, {
          docNotifyContext: { $in: chunkIds }
        })

        const reactionIds = new Set<Ref<Reaction>>()
        for (const n of chunkNotifications) {
          if (n._class === 'notification:class:ReactionInboxNotification') {
            const ref = (n as ReactionInboxNotification).ref
            if (ref != null) {
              reactionIds.add(ref)
            }
          }
        }

        const cleanReactionIds = Array.from(reactionIds).filter((id) => id != null)
        const reactions =
          cleanReactionIds.length > 0
            ? await client.find<Reaction>(DOMAIN_REACTION, { _id: { $in: cleanReactionIds } })
            : []

        const reactionMap = toIdMap(reactions)

        const objectIdsByDomain = new Map<Domain, Ref<Doc>[]>()
        for (const context of chunk) {
          const objectId = context.objectId
          const objectClass = context.objectClass

          if (objectId != null && objectClass != null) {
            const domain = client.hierarchy.findDomain(objectClass)
            if (domain !== undefined) {
              let list = objectIdsByDomain.get(domain)
              if (list === undefined) {
                list = []
                objectIdsByDomain.set(domain, list)
              }
              list.push(objectId)
            }
          }
        }

        const objectsMap = new Map<Ref<Doc>, Doc>()
        for (const [domain, ids] of objectIdsByDomain.entries()) {
          const cleanIds = ids.filter((id) => id != null)
          if (cleanIds.length === 0) continue
          const docs = await client.find<Doc>(domain, { _id: { $in: cleanIds } })
          for (const doc of docs) {
            objectsMap.set(doc._id, doc)
          }
        }

        const parentIdsByDomain = new Map<Domain, Ref<Doc>[]>()
        for (const doc of objectsMap.values()) {
          if (client.hierarchy.isDerived(doc._class, activity.class.ActivityMessage)) {
            const message = doc as ActivityMessage
            const parentId = message.attachedTo
            const parentClass = message.attachedToClass
            if (parentId != null && parentClass != null) {
              const parentDomain = client.hierarchy.findDomain(parentClass)
              if (parentDomain !== undefined) {
                let list = parentIdsByDomain.get(parentDomain)
                if (list === undefined) {
                  list = []
                  parentIdsByDomain.set(parentDomain, list)
                }
                list.push(parentId)
              }
            }
          }
        }

        const parentObjectMap = new Map<Ref<Doc>, Doc>()
        for (const [domain, ids] of parentIdsByDomain.entries()) {
          const cleanIds = ids.filter((id) => id != null)
          if (cleanIds.length === 0) continue
          const docs = await client.find<Doc>(domain, { _id: { $in: cleanIds } })
          for (const doc of docs) {
            parentObjectMap.set(doc._id, doc)
          }
        }

        // Combine both maps for reference lookups
        const cache = new Map<Ref<Doc>, Doc>([...objectsMap, ...parentObjectMap])

        // Fetch all ActivityMessage documents referenced by chunkNotifications in the chunk
        const activityIds = new Set<Ref<ActivityMessage>>()
        for (const n of chunkNotifications) {
          if (n._class === 'notification:class:ActivityInboxNotification') {
            const attachedTo = (n as ActivityInboxNotification).attachedTo
            if (attachedTo != null) {
              activityIds.add(attachedTo)
            }
          } else if (n._class === 'notification:class:ReactionInboxNotification') {
            const attachedTo = (n as ReactionInboxNotification).attachedTo
            if (attachedTo != null) {
              activityIds.add(attachedTo)
            }
          } else if (n._class === 'notification:class:MentionInboxNotification') {
            const mentionNotif = n as MentionInboxNotification
            if (
              mentionNotif.mentionedIn != null &&
              client.hierarchy.isDerived(mentionNotif.mentionedInClass, activity.class.ActivityMessage)
            ) {
              activityIds.add(mentionNotif.mentionedIn as Ref<ActivityMessage>)
            }
          }
        }

        const cleanActivityIds = Array.from(activityIds).filter((id) => id != null)
        const loadAttachments = new Set<Ref<ActivityMessage>>()
        if (cleanActivityIds.length > 0) {
          const activityMessages = await client.find<ActivityMessage>(DOMAIN_ACTIVITY, {
            _id: { $in: cleanActivityIds }
          })
          for (const msg of activityMessages) {
            cache.set(msg._id, msg)

            if (((msg as ChatMessage)?.attachments ?? 0) > 0) {
              loadAttachments.add(msg._id)
            }
          }
        }

        const attachmentsByMessage = new Map<Ref<ActivityMessage>, BlobType[]>()

        const cleanLoadAttachments = Array.from(loadAttachments).filter((id) => id != null)
        if (cleanLoadAttachments.length > 0) {
          const attachments = await client.find<Attachment>(DOMAIN_ATTACHMENT, {
            attachedTo: { $in: cleanLoadAttachments }
          })
          for (const att of attachments) {
            let list = attachmentsByMessage.get(att.attachedTo as Ref<ActivityMessage>)
            if (list === undefined) {
              list = []
              attachmentsByMessage.set(att.attachedTo as Ref<ActivityMessage>, list)
            }
            list.push({
              file: att.file,
              type: att.type,
              name: att.name,
              size: att.size,
              metadata: att.metadata
            })
          }
        }

        const updates: {
          filter: MigrationDocumentQuery<DocNotifyContextOld>
          update: MigrateUpdate<DocNotifyContext>
        }[] = []

        for (const context of chunk) {
          const inboxNotifications = chunkNotifications.filter((n) => n.docNotifyContext === context._id)
          const targetDoc = await getDoc(client, context.objectId, context.objectClass, cache)

          if (targetDoc == null) {
            toRemove.add(context._id)
            continue
          }

          const objectTitle = await getDocTitleFallback(client, targetDoc, personByAccountUuid, cache, context.user)
          const objectIdentifier: string | undefined = await getDocIdentifierFallback(client, targetDoc, cache)
          const objectLabel = getDocLabelFallback(targetDoc, client.hierarchy)
          const objectIcon = getDocIconFallback(client, targetDoc, context.user)

          let object: Partial<Doc> | undefined

          let parentObjectId: Ref<Doc> | undefined
          let parentObjectClass: Ref<Class<Doc>> | undefined
          let parentObjectTitle: string | undefined
          let parentObjectIdentifier: string | undefined
          let parentObjectLabel: IntlString | undefined
          let parentObjectIcon: { asset?: Asset, emoji?: number | number[], props?: Record<string, any> } | undefined

          if (client.hierarchy.isDerived(targetDoc._class, activity.class.ActivityMessage)) {
            const message = targetDoc as ActivityMessage
            object = toNotificationMessage(message)

            const parentId = message.attachedTo
            const parentClass = message.attachedToClass
            const parentDoc = await getDoc(client, parentId, parentClass, cache)
            if (parentDoc != null) {
              parentObjectId = parentId
              parentObjectClass = parentClass
              parentObjectTitle = await getDocTitleFallback(client, parentDoc, personByAccountUuid, cache, context.user)
              parentObjectIdentifier = await getDocIdentifierFallback(client, parentDoc, cache)
              parentObjectLabel = getDocLabelFallback(parentDoc, client.hierarchy)
              parentObjectIcon = getDocIconFallback(client, parentDoc, context.user)
            }
          }

          // Sort notifications by createdOn ascending (oldest first)
          inboxNotifications.sort((a, b) => getTimestamp(a) - getTimestamp(b))

          const unreadMessages: UnreadMessage[] = []
          const unreadReactions: UnreadReaction[] = []
          const unreadMentions: UnreadMention[] = []
          const unreadCommons: CommonNotification[] = []

          for (const inboxNotification of inboxNotifications) {
            const isViewed = inboxNotification.isViewed
            if (!isViewed) {
              const notifClass = inboxNotification._class
              if (notifClass === 'notification:class:ActivityInboxNotification') {
                const activityNotif = inboxNotification as ActivityInboxNotification
                unreadMessages.push({
                  id: activityNotif.attachedTo,
                  createdOn: getTimestamp(activityNotif),
                  notified: true
                })
              } else if (notifClass === 'notification:class:ReactionInboxNotification') {
                const reactNotif = inboxNotification as ReactionInboxNotification
                unreadReactions.push({
                  id: reactNotif.ref,
                  attachedTo: reactNotif.attachedTo
                })
              } else if (notifClass === 'notification:class:MentionInboxNotification') {
                const mentionNotif = inboxNotification as MentionInboxNotification
                if (
                  mentionNotif.mentionedInClass != null &&
                  client.hierarchy.isDerived(mentionNotif.mentionedInClass, activity.class.ActivityMessage)
                ) {
                  unreadMessages.push({
                    id: mentionNotif.mentionedIn as Ref<ActivityMessage>,
                    createdOn: getTimestamp(mentionNotif),
                    notified: true,
                    mentioned: true
                  })
                } else {
                  unreadMentions.push({
                    id: inboxNotification._id
                  })
                }
              } else if (notifClass === 'notification:class:CommonInboxNotification') {
                unreadCommons.push(mapToCommonNotification(inboxNotification as CommonInboxNotification))
              }
            }
          }

          // Keep up to 5 latest context notifications
          const latestNotifications: ContextNotification[] = []

          for (const n of [...inboxNotifications].reverse()) {
            if (latestNotifications.length === 5) break
            const t = await mapToContextNotification(client, n, reactionMap, cache, attachmentsByMessage)
            if (t == null) continue
            latestNotifications.push(t)
          }

          const unreadCount =
            unreadMessages.length + unreadMentions.length + unreadCommons.length + unreadReactions.length
          const lastNotify =
            inboxNotifications.length > 0 ? getTimestamp(inboxNotifications[inboxNotifications.length - 1]) : 0

          updates.push({
            filter: { _id: context._id },
            update: {
              latestNotifications,
              unreadReactions,
              unreadMentions,
              unreadMessages,
              unreadCommons,
              unreadCount,
              lastNotify,
              objectTitle,
              objectIdentifier,
              objectLabel,
              objectIcon,
              object,
              parentObjectId,
              parentObjectClass,
              parentObjectTitle,
              parentObjectIdentifier,
              parentObjectLabel,
              parentObjectIcon
            }
          })
        }

        if (updates.length > 0) {
          await client.bulk(DOMAIN_DOC_NOTIFY, updates)
        }

        if (toRemove.size > 0) {
          const toRemoveArray = Array.from(toRemove).filter((id) => id != null)
          if (toRemoveArray.length > 0) {
            await client.deleteMany(DOMAIN_DOC_NOTIFY, {
              _id: { $in: toRemoveArray }
            })
            await client.deleteMany(DOMAIN_NOTIFICATION, {
              docNotifyContext: { $in: toRemoveArray }
            })
          }
        }

        // Delete the migrated notifications for this chunk of contexts
        if (chunkIds.length > 0) {
          await client.deleteMany(DOMAIN_NOTIFICATION, {
            docNotifyContext: { $in: chunkIds }
          })
        }

        processed += chunk.length
        client.logger.log('...processed embedded notification chunk by contexts', { count: processed })
      }
    }
  } finally {
    await iterator.close()
  }
}

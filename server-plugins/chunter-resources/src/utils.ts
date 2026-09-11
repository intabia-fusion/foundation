import { Receiver, TypeMatchClient, TypeMatchFunc } from '@hcengineering/server-notification'
import { NotificationType } from '@hcengineering/notification'
import { AccountUuid, concatLink, Doc } from '@hcengineering/core'
import { DocUpdateMessage } from '@hcengineering/activity'
import chunter, { Channel, ChunterSpace, chunterId, DirectMessage } from '@hcengineering/chunter'
import {
  StringPresenterFn,
  PresenterControl,
  PresenterOptions,
  IconPresenterFn,
  Icon,
  IntlStringPresenterFn
} from '@hcengineering/server-activity'
import { encodeObjectURI } from '@hcengineering/view'
import serverCore from '@hcengineering/server-core'
import { getMetadata, IntlString, translate } from '@hcengineering/platform'
import { workbenchId } from '@hcengineering/workbench'
import contact, { formatName, Person } from '@hcengineering/contact'

export const JoinChannelTypeMatch: TypeMatchFunc = (
  _client: TypeMatchClient,
  _type: NotificationType,
  _object: Doc,
  doc: Doc,
  receiver: Receiver
) => {
  const message = _object as DocUpdateMessage
  const author = message.createdBy ?? message.modifiedBy

  if (receiver.socialIds.includes(author)) {
    return false
  }

  if (message.action === 'update') {
    const added = message.attributeUpdates?.added ?? []
    const set = message.attributeUpdates?.set ?? []

    const historyAdded = message.history?.flatMap((h) => h.update?.added ?? []) ?? []
    const historySet = message.history?.flatMap((h) => h.update?.set ?? []) ?? []

    const currentlyAdded = added.filter((a) => !historyAdded.includes(a))
    const currentlySet = set.filter((s) => !historySet.includes(s))

    return currentlyAdded.includes(receiver.account) || currentlySet.includes(receiver.account)
  }

  if (message.action === 'create') {
    return (doc as Channel).members.includes(receiver.account)
  }

  return false
}

export const ChannelTitlePresenter: StringPresenterFn<Channel> = async (doc: Channel): Promise<string> => {
  return `#${doc.name}`
}

export const DirectTitlePresenter: StringPresenterFn<DirectMessage> = async (
  doc: DirectMessage,
  control: PresenterControl,
  options?: PresenterOptions
): Promise<string | undefined> => {
  const { account } = options ?? {}
  return account == null
    ? await translate(
      doc.type === 'person' ? chunter.string.Direct : chunter.string.GroupChat,
      {},
      control.branding?.defaultLanguage
    )
    : await buildDirectName(doc, control, account)
}

export const DirectLabelPresenter: IntlStringPresenterFn<DirectMessage> = async (
  doc: DirectMessage
): Promise<IntlString> => {
  return doc.type === 'person' ? chunter.string.Direct : chunter.string.GroupChat
}

export const ChannelUrlPresenter: StringPresenterFn<ChunterSpace> = async (
  doc: ChunterSpace,
  control: PresenterControl
): Promise<string> => {
  const front = control.branding?.front ?? getMetadata(serverCore.metadata.FrontUrl) ?? ''
  const path = `${workbenchId}/${control.workspace.url}/${chunterId}/${encodeObjectURI(doc._id, doc._class)}`
  return concatLink(front, path)
}

export const ChannelIconPresenter: IconPresenterFn<Channel> = async (doc: Channel): Promise<Icon> => {
  return { emoji: doc.emoji, asset: doc.icon ?? (doc.private ? chunter.icon.Lock : chunter.icon.Hashtag) }
}

export const DirectIconPresenter: IconPresenterFn<DirectMessage> = async (
  doc: DirectMessage,
  control: PresenterControl,
  options?: PresenterOptions
): Promise<Icon> => {
  const clazz = control.hierarchy.findClass(doc._class)
  const { account } = options ?? {}

  const members = doc.members.length > 1 ? doc.members.filter((m) => m !== account) : doc.members

  return { asset: clazz?.icon, props: { members } }
}

async function buildDirectName (
  direct: DirectMessage,
  control: PresenterControl,
  account: AccountUuid
): Promise<string> {
  const members = direct.members ?? []

  if (direct.type === 'person') {
    const companion = members.find((m) => m !== account) ?? members[0]
    const companionPerson = (await control.findAll(control.ctx, contact.class.Person, { personUuid: companion }))[0]
    return formatName(companionPerson.name, control.branding?.lastNameFirst) ?? ''
  } else {
    if (direct.name.trim().length > 0) {
      return direct.name
    }
    const persons = await control.findAll<Person>(control.ctx, contact.class.Person, {
      personUuid: { $in: members.filter((m) => m !== account) }
    })

    return persons.map((p) => formatName(p.name, control.branding?.lastNameFirst)).join(', ')
  }
}

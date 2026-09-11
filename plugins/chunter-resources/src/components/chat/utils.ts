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

import { type Chat, createDirect, type DirectMessage } from '@hcengineering/chunter'
import contact, { type Employee } from '@hcengineering/contact'
import core, {
  AccountRole,
  getCurrentAccount,
  hasAccountRole,
  type UserStatus,
  type AccountUuid,
  type Ref,
  type Class,
  type Doc,
  type Space,
  type WithLookup
} from '@hcengineering/core'
import notification, { isUnreadMessageChunk, isUnreadMessageId } from '@hcengineering/notification'
import { readNotifyContext } from '@hcengineering/notification-resources'
import { getClient } from '@hcengineering/presentation'
import { type Action, showPopup } from '@hcengineering/ui'
import view from '@hcengineering/view'
import { type SpecialNavModel } from '@hcengineering/workbench'
import activity from '@hcengineering/activity'

import chunter from '../../plugin'
import { type ChatGroupID, type ChatNavGroupModel, type ChatNavItemModel, type SortFnOptions } from './types'

type SectionID = Ref<Class<Doc>> | 'starred'

const createChannelAction: Action = {
  icon: chunter.icon.Hashtag,
  label: chunter.string.CreateChannel,
  action: async (): Promise<void> => {
    showPopup(chunter.component.CreateChannel, {}, 'top')
  }
}

const createDirectAction: Action = {
  label: chunter.string.NewDirectChat,
  icon: chunter.icon.Thread,
  action: async (): Promise<void> => {
    showPopup(chunter.component.CreateDirectChat, {}, 'top')
  }
}

export const chatSpecials: SpecialNavModel[] = [
  {
    id: 'threads',
    label: chunter.string.Threads,
    icon: chunter.icon.Thread,
    component: chunter.component.Threads,
    position: 'top',
    notificationsCountProvider: chunter.function.GetUnreadThreadsCount
  },
  {
    id: 'saved',
    label: chunter.string.Saved,
    icon: chunter.icon.Bookmarks,
    position: 'top',
    component: chunter.component.SavedMessages
  },
  {
    id: 'browser',
    label: chunter.string.ChunterBrowser,
    icon: chunter.icon.ChunterBrowser,
    component: chunter.component.ChunterBrowser,
    position: 'top'
  },
  {
    id: 'lists',
    label: chunter.string.ChannelsAndDMs,
    icon: chunter.icon.ChannelBrowser,
    component: chunter.component.ChannelsAndDMs,
    position: 'top'
  }
]

export const chatNavGroupModels: ChatNavGroupModel[] = [
  {
    id: 'starred',
    label: chunter.string.Starred,
    sortFn: sortAlphabetically,
    wrap: false,
    actionsFn: getPinnedActions,
    showEmpty: false,
    query: {
      pinned: true
    },
    _class: core.class.Doc
  },
  {
    id: 'channels',
    sortFn: sortAlphabetically,
    wrap: true,
    actionsFn: getChannelsActions,
    createAction: createChannelAction,
    showEmpty: true,
    query: {
      pinned: false
    },
    _class: chunter.class.Channel
  },
  {
    id: 'direct',
    sortFn: sortDirects,
    wrap: true,
    actionsFn: getDirectActions,
    createAction: createDirectAction,
    showEmpty: true,
    query: {
      pinned: false
    },
    _class: chunter.class.DirectMessage
  },
  {
    id: 'activity',
    sortFn: sortActivityChannels,
    wrap: true,
    actionsFn: () => getActivityActions({ readAll: true, hideAll: true }),
    maxSectionItems: 5,
    showEmpty: false,
    query: {
      pinned: false
    },
    skipClasses: [chunter.class.DirectMessage, chunter.class.Channel, contact.class.Channel]
  }
]

function sortAlphabetically (items: ChatNavItemModel[]): ChatNavItemModel[] {
  return items.sort((i1, i2) => i1.title.localeCompare(i2.title))
}

function getDirectCompanion (direct: DirectMessage, myAcc: AccountUuid): AccountUuid | undefined {
  return direct.members.find((member) => member !== myAcc)
}

function isOnline (user: AccountUuid | undefined, userStatusByAccount: Map<AccountUuid, UserStatus>): boolean {
  if (user === undefined) {
    return false
  }

  return userStatusByAccount.get(user)?.online ?? false
}

function isGroupChat (direct: DirectMessage): boolean {
  return direct.members.length > 2
}

function sortDirects (items: ChatNavItemModel[], option: SortFnOptions): ChatNavItemModel[] {
  const { userStatusByAccount } = option
  const account = getCurrentAccount().uuid

  return items.sort((i1, i2) => {
    const direct1 = i1.object as DirectMessage
    const direct2 = i2.object as DirectMessage

    const isGroupChat1 = isGroupChat(direct1)
    const isGroupChat2 = isGroupChat(direct2)

    if (isGroupChat1 && isGroupChat2) {
      return i1.title.localeCompare(i2.title)
    }

    if (isGroupChat1 && !isGroupChat2) {
      const isOnline2 = isOnline(getDirectCompanion(direct2, account), userStatusByAccount)
      return isOnline2 ? 1 : -1
    }

    if (!isGroupChat1 && isGroupChat2) {
      const isOnline1 = isOnline(getDirectCompanion(direct1, account), userStatusByAccount)
      return isOnline1 ? -1 : 1
    }

    const user1 = getDirectCompanion(direct1, account)
    const user2 = getDirectCompanion(direct2, account)

    if (user1 === undefined) {
      return 1
    }

    if (user2 === undefined) {
      return -1
    }

    const isOnline1 = isOnline(user1, userStatusByAccount)
    const isOnline2 = isOnline(user2, userStatusByAccount)

    if (isOnline1 === isOnline2) {
      return i1.title.localeCompare(i2.title)
    }

    if (isOnline1 && !isOnline2) {
      return -1
    }

    return 1
  })
}

function sortActivityChannels (items: ChatNavItemModel[], option: SortFnOptions): ChatNavItemModel[] {
  const { contextByDoc } = option

  return items.sort((i1, i2) => {
    const context1 = contextByDoc.get(i1.id) ?? undefined
    const context2 = contextByDoc.get(i2.id) ?? undefined

    const hasUnreadMessages1 = (context1?.unreadMessages?.length ?? 0) > 0
    const hasUnreadMessages2 = (context2?.unreadMessages?.length ?? 0) > 0

    if (hasUnreadMessages1 && hasUnreadMessages2) {
      const unreadMessages1 = context1?.unreadMessages ?? []
      const unreadMessages2 = context2?.unreadMessages ?? []
      const lastUnreadMessage1 = unreadMessages1[unreadMessages1.length - 1]
      const lastUnreadMessage2 = unreadMessages2[unreadMessages2.length - 1]
      const lastUnreadMessageTs1 = isUnreadMessageId(lastUnreadMessage1)
        ? lastUnreadMessage1.createdOn
        : isUnreadMessageChunk(lastUnreadMessage1)
          ? lastUnreadMessage1.to
          : 0
      const lastUnreadMessageTs2 = isUnreadMessageId(lastUnreadMessage2)
        ? lastUnreadMessage2.createdOn
        : isUnreadMessageChunk(lastUnreadMessage2)
          ? lastUnreadMessage2.to
          : 0

      return lastUnreadMessageTs2 - lastUnreadMessageTs1
    }
    if (hasUnreadMessages1 && !hasUnreadMessages2) return -1
    if (hasUnreadMessages2 && !hasUnreadMessages1) return 1

    return i2.object.modifiedOn - i1.object.modifiedOn
  })
}

function getPinnedActions (): Action[] {
  return [
    ...getActivityActions({ readAll: true }),
    {
      icon: view.icon.Delete,
      label: chunter.string.DeleteStarred,
      group: 'remove',
      action: async () => {
        await unpinAllChannels()
      }
    }
  ]
}

async function unpinAllChannels (): Promise<void> {
  const client = getClient()
  const pinned = await client.findAll(chunter.class.Chat, { pinned: true })
  if (pinned.length === 0) return

  const ops = client.apply(undefined, 'unpinAllChannels')
  try {
    for (const p of pinned) {
      await ops.updateCollection(p._class, p.space, p._id, p.attachedTo, p.attachedToClass, 'chats', {
        pinned: false
      })
    }
  } finally {
    await ops.commit()
  }
}

function getChannelsActions (): Action[] {
  return hasAccountRole(getCurrentAccount(), AccountRole.User)
    ? [createChannelAction, ...getActivityActions({ readAll: true, hideAll: true })]
    : []
}

function getDirectActions (): Action[] {
  return hasAccountRole(getCurrentAccount(), AccountRole.User)
    ? [createDirectAction, ...getActivityActions({ readAll: true, hideAll: true })]
    : []
}

function getActivityActions ({ readAll, hideAll }: { readAll?: boolean, hideAll?: boolean }): Action[] {
  return hasAccountRole(getCurrentAccount(), AccountRole.User)
    ? [
        ...(readAll === true
          ? [
              {
                icon: view.icon.Eye,
                label: notification.string.MarkReadAll,
                group: 'edit',
                action: async ({ _id }: { _id: SectionID }) => {
                  await readDocs(_id)
                }
              }
            ]
          : []),
        ...(hideAll === true
          ? [
              {
                icon: view.icon.EyeCrossed,
                label: chunter.string.HideAll,
                group: 'remove',
                action: async ({ _id }: { _id: SectionID }) => {
                  await hideDocs(_id)
                }
              }
            ]
          : [])
      ]
    : []
}

async function hideDocs (id: SectionID): Promise<void> {
  if (id === 'starred') return
  const client = getClient()
  const chats = await client.findAll(chunter.class.Chat, {
    attachedToClass: id,
    account: getCurrentAccount().uuid,
    hidden: false
  })

  try {
    for (const chat of chats) {
      await client.updateCollection(chat._class, chat.space, chat._id, chat.attachedTo, chat.attachedToClass, 'chats', {
        hidden: true
      })
    }
  } catch (e) {
    console.error(e)
  }
}

async function readDocs (id: SectionID): Promise<void> {
  const client = getClient()
  const me = getCurrentAccount()
  if (id === 'starred') {
    const starred = await client.findAll(chunter.class.Chat, { pinned: true })
    const contexts = await client.findAll(notification.class.DocNotifyContext, {
      objectId: { $in: starred.map((it) => it.attachedTo) },
      user: me.uuid
    })
    try {
      for (const context of contexts) {
        await readNotifyContext(context)
      }
    } catch (e) {
      console.error(e)
    }
  } else {
    const contexts = await client.findAll(notification.class.DocNotifyContext, {
      objectClass: id,
      user: me.uuid
    })
    try {
      for (const context of contexts) {
        await readNotifyContext(context)
      }
    } catch (e) {
      console.error(e)
    }
  }
}

export function getActivityDocClasses (): Array<Ref<Class<Doc>>> {
  const client = getClient()
  const hierarchy = client.getHierarchy()
  const allClasses = hierarchy.getMixinClasses(activity.mixin.ActivityDoc)

  return filterClasses(allClasses)
}
function filterClasses (classes: Array<Ref<Class<Doc>>>): Array<Ref<Class<Doc>>> {
  const client = getClient()
  const hierarchy = client.getHierarchy()

  const res: Array<Ref<Class<Doc>>> = []
  for (const _class of classes) {
    const de = res.some((it) => hierarchy.isDerived(_class, it))
    if (!de) res.push(_class)
  }
  return res
}

export function getNavGroupClasses (model: ChatNavGroupModel, pinned: Chat[]): Array<Ref<Class<Doc>>> {
  if (model.id === 'starred') {
    return Array.from(new Set(pinned.map((it) => it.attachedToClass)))
  }
  if (model._class != null) return [model._class]

  const client = getClient()
  const hierarchy = client.getHierarchy()

  const allClasses = hierarchy
    .getMixinClasses(activity.mixin.ActivityDoc)
    .filter((c) => !(model.skipClasses ?? []).includes(c))

  return filterClasses(allClasses)
}

export function isArchived (object: Doc): boolean {
  const client = getClient()
  const hierarchy = client.getHierarchy()
  return hierarchy.isDerived(object._class, core.class.Space) ? (object as Space).archived : false
}

function getObjectChatGroup (object: Doc): ChatGroupID {
  const client = getClient()
  const hierarchy = client.getHierarchy()
  if (hierarchy.isDerived(object._class, chunter.class.Channel)) {
    return 'channels'
  }

  if (hierarchy.isDerived(object._class, chunter.class.DirectMessage)) {
    return 'direct'
  }

  return 'activity'
}

export function shouldPushObjectInNavigator (
  model: ChatNavGroupModel,
  object: Doc | undefined,
  chat: Chat | undefined,
  classes: Array<Ref<Class<Doc>>>
): boolean {
  if (object == null) return false
  if (getObjectChatGroup(object) !== model.id) return false

  if (chat?.pinned === true) return false

  if (isArchived(object)) return true

  const client = getClient()
  const hierarchy = client.getHierarchy()

  return !classes.some((c) => hierarchy.isDerived(object._class, c))
}

export function createFakeDirectFromEmployee (employee: WithLookup<Employee>): WithLookup<DirectMessage> | undefined {
  if (employee.personUuid == null) return
  const me = getCurrentAccount()
  return {
    _id: `@fake-${employee._id}` as Ref<DirectMessage>,
    _class: chunter.class.DirectMessage,
    space: core.space.Space,
    members: Array.from(new Set([employee.personUuid, me.uuid])),
    type: 'person',
    name: '',
    private: true,
    description: '',
    archived: false,
    modifiedBy: me.primarySocialId,
    modifiedOn: Date.now(),
    $source: employee.$source
  }
}

export function isFakeDirect (direct: Doc): direct is DirectMessage {
  return direct._class === chunter.class.DirectMessage && direct._id.startsWith('@fake-')
}

export async function createRealDirectFromFake (fake: DirectMessage): Promise<DirectMessage | undefined> {
  const client = getClient()
  const _id = await createDirect(client, fake.members)
  if (_id == null) return

  return await client.findOne(chunter.class.DirectMessage, { _id })
}

export function getDirectByAccountMap (directs: DirectMessage[]): Map<AccountUuid, DirectMessage> {
  const me = getCurrentAccount()
  const map = new Map<AccountUuid, DirectMessage>()

  for (const it of directs) {
    if (it.type !== 'person') continue

    const other = it.members.find((m) => m !== me.uuid)

    if (other == null) {
      if (it.members.includes(me.uuid)) {
        map.set(me.uuid, it)
      }
      continue
    }

    map.set(other, it)
  }

  return map
}

export function getChatNavItemKey (item: ChatNavItemModel): string {
  const doc = item.object
  if (doc._class === chunter.class.DirectMessage) {
    const direct = doc as DirectMessage
    if (direct.type === 'person') {
      const me = getCurrentAccount()
      const other = direct.members.find((m) => m !== me?.uuid) ?? me?.uuid
      if (other != null) return `direct-${other}`
    }
  }
  return item.id
}

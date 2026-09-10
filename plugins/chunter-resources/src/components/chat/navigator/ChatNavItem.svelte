<!--
// Copyright © 2024 Hardcore Engineering Inc.
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
-->
<script lang="ts">
  import notification, {
    DocNotificationSetting,
    DocNotifyContext,
    getUnreadMessageCount
  } from '@hcengineering/notification'
  import { translate } from '@hcengineering/platform'
  import { getClient } from '@hcengineering/presentation'
  import { Action, languageStore, lowercaseFirstLetter, Menu, showPopup } from '@hcengineering/ui'
  import { getObjectLinkId, canLeaveSpace, IconPicker } from '@hcengineering/view-resources'
  import { NotificationClientImpl, MutePopup } from '@hcengineering/notification-resources'
  import { createEventDispatcher } from 'svelte'
  import view from '@hcengineering/view'
  import { Doc, getCurrentAccount, Space } from '@hcengineering/core'
  import { Channel, Chat } from '@hcengineering/chunter'
  import workbench from '@hcengineering/workbench'

  import NavItem from './NavItem.svelte'
  import { ChatNavItemModel } from '../types'
  import { openChannel, openChannelInSidebar, resetChunterLocIfEqual } from '../../../navigation'
  import chunter from '../../../plugin'
  import { leaveChannel, toggleChannelIcon } from '../../../utils'
  import ChannelIcon from '../../ChannelIcon.svelte'

  export let context: DocNotifyContext | undefined
  export let item: ChatNavItemModel
  export let isSelected = false
  export let type: 'type-link' | 'type-tag' | 'type-anchor-link' | 'type-object' = 'type-link'

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const dispatch = createEventDispatcher()
  const notificationClient = NotificationClientImpl.getClient()
  const settingByDocStore = notificationClient.docSettingByDoc

  let setting: DocNotificationSetting | undefined = undefined
  let count: number = 0
  let actions: Action[] = []

  $: void notificationClient.loadDocSetting(item.object._id)
  $: setting = $settingByDocStore.get(item.object._id) ?? undefined
  $: count = context != null ? getUnreadMessageCount(context) : 0

  $: void getActions(item.object, item.chat).then((res) => {
    actions = res
  })

  const linkProviders = client.getModel().findAllSync(view.mixin.LinkIdProvider, {})

  async function getActions (object: Doc, chat?: Chat): Promise<Action[]> {
    const result: Action[] = []

    result.push({
      icon: view.icon.Open,
      label: view.string.Open,
      group: 'edit',
      action: async () => {
        const id = await getObjectLinkId(linkProviders, object._id, object._class, object)
        openChannel(id, object._class, undefined, true)
      }
    })

    result.push({
      label: workbench.string.OpenInSidebar,
      icon: view.icon.DetailsFilled,
      group: 'edit',
      action: async () => {
        await openChannelInSidebar(object._id, object._class, object)
      }
    })

    const label = lowercaseFirstLetter(await translate(hierarchy.getClass(object._class).label, {}, $languageStore))

    if (chat != null && !chat.pinned) {
      result.push({
        icon: view.icon.Star,
        label: chunter.string.Star,
        labelParams: { label },
        group: 'edit',
        action: async () => {
          await client.updateCollection(
            chat._class,
            chat.space,
            chat._id,
            chat.attachedTo,
            chat.attachedToClass,
            'chats',
            { pinned: true }
          )
        }
      })
    } else if (chat?.pinned === true) {
      result.push({
        icon: view.icon.Star,
        label: chunter.string.Unstar,
        group: 'edit',
        action: async () => {
          await client.updateCollection(
            chat._class,
            chat.space,
            chat._id,
            chat.attachedTo,
            chat.attachedToClass,
            'chats',
            { pinned: false }
          )
        }
      })
    }

    if (hierarchy.isDerived(object._class, chunter.class.Channel)) {
      const channel = object as Channel
      result.push({
        icon: ChannelIcon,
        iconProps: { value: object },
        label: chunter.string.ChangeIcon,
        group: 'tools',
        component: IconPicker,
        props: { icon: channel.icon, color: channel.emoji },
        action: async () => {},
        onSubmenuResult: async (result) => {
          if (result == null) return
          await toggleChannelIcon(channel, result.icon, result.color)
        }
      })
    }

    result.push({
      icon: notification.icon.Notifications,
      label: notification.string.EditNotifications,
      group: 'associate',
      component: MutePopup,
      props: { value: object },
      action: async () => {}
    })

    const canLeave = await canLeaveSpace(object)

    if (!hierarchy.isDerived(object._class, chunter.class.DirectMessage) && canLeave) {
      result.push({
        icon: view.icon.Delete,
        label: chunter.string.Leave,
        labelParams: { label },
        group: 'remove',
        action: async () => {
          await leaveChannel(object as Space, getCurrentAccount().uuid)
        }
      })
    } else if (chat != null && !chat.hidden) {
      result.push({
        icon: view.icon.EyeCrossed,
        label: chunter.string.HideFromChatList,
        group: 'remove',
        action: async () => {
          await client.updateCollection(
            chat._class,
            chat.space,
            chat._id,
            chat.attachedTo,
            chat.attachedToClass,
            'chats',
            { hidden: true }
          )
          await resetChunterLocIfEqual(object._id, object._class, object)
        }
      })
    }

    return result
  }

  let pressed = false

  function handleContextMenu (event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()

    if (actions.length === 0) return
    pressed = true
    showPopup(Menu, { actions, ctx: { _id: item.id } }, event.target as HTMLElement, () => {
      pressed = false
    })
  }
</script>

<NavItem
  _id={item.id}
  icon={item.icon}
  withIconBackground={item.withIconBackground}
  iconSize={item.iconSize}
  {isSelected}
  iconProps={{ ...item.iconProps, value: item.object }}
  {count}
  countColor={(context?.unreadCount ?? 0) === 0 ? 'gray' : 'red'}
  title={item.title}
  subTitle={item.subTitle}
  identifier={item.identifier}
  {actions}
  {type}
  muted={setting?.mode === 'mute'}
  {pressed}
  on:click={() => {
    const select = { chat: item.chat, object: item.object }
    dispatch('select', select)
  }}
  on:contextmenu={handleContextMenu}
/>

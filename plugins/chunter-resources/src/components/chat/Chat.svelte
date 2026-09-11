<!--
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
-->
<script lang="ts">
  import { Doc, Ref, Class } from '@hcengineering/core'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import {
    Component,
    defineSeparators,
    getCurrentLocation,
    location,
    navigate,
    Separator,
    Location,
    restoreLocation,
    deviceOptionsStore as deviceInfo
  } from '@hcengineering/ui'
  import { NavigatorModel, SpecialNavModel } from '@hcengineering/workbench'
  import { onMount, onDestroy } from 'svelte'
  import { Chat, chunterId } from '@hcengineering/chunter'
  import view, { decodeObjectURI } from '@hcengineering/view'
  import { parseLinkId, getObjectLinkId } from '@hcengineering/view-resources'
  import { ActivityMessage } from '@hcengineering/activity'
  import { loadSavedAttachments } from '@hcengineering/attachment-resources'

  import ChatNavigator from './navigator/ChatNavigator.svelte'
  import ChannelView from '../ChannelView.svelte'
  import { chatSpecials, createRealDirectFromFake, isFakeDirect } from './utils'
  import { SelectChannelEvent } from './types'
  import { openChannel, openThreadInSidebar } from '../../navigation'
  import chunter from '../../plugin'

  const objectQuery = createQuery()
  const client = getClient()

  const navigatorModel: NavigatorModel = {
    spaces: [],
    specials: chatSpecials
  }

  const linkProviders = client.getModel().findAllSync(view.mixin.LinkIdProvider, {})

  let selectedData: { id: string, _class: Ref<Class<Doc>> } | undefined = undefined

  let currentSpecial: SpecialNavModel | undefined

  let object: Doc | undefined = undefined
  let chat: Chat | undefined

  let replacedPanel: HTMLElement
  let needRestoreLoc = true

  const unsubcribe = location.subscribe((loc) => {
    syncLocation(loc)
  })
  onDestroy(() => {
    unsubcribe()
  })

  $: void loadObject(selectedData?.id, selectedData?._class)

  async function loadObject (id?: string, _class?: Ref<Class<Doc>>): Promise<void> {
    if (id == null || _class == null || _class === '') {
      object = undefined
      chat = undefined
      objectQuery.unsubscribe()
      return
    }

    const _id: Ref<Doc> | undefined = await parseLinkId(linkProviders, id, _class)

    if (_id === undefined) {
      object = undefined
      chat = undefined
      objectQuery.unsubscribe()
      return
    }

    objectQuery.query(
      _class,
      { _id },
      (res) => {
        object = res[0]
        chat = (res[0] as any)?.$lookup?.chats?.[0]
      },
      {
        limit: 1,
        lookup: { _id: { chats: chunter.class.Chat } }
      }
    )
  }

  function syncLocation (loc: Location): void {
    if (loc.path[2] !== chunterId) {
      return
    }

    const id = loc.path[3]

    if (id == null || id === '') {
      currentSpecial = undefined
      selectedData = undefined
      object = undefined
      chat = undefined
      if (needRestoreLoc) {
        needRestoreLoc = false
        restoreLocation(loc, chunterId)
      }
      return
    }

    needRestoreLoc = false
    currentSpecial = navigatorModel?.specials?.find((special) => special.id === id)

    if (currentSpecial !== undefined) {
      selectedData = undefined
      object = undefined
      chat = undefined
    } else {
      const [id, _class] = decodeObjectURI(loc.path[3])
      selectedData = { id, _class }
    }

    const thread = loc.path[4] as Ref<ActivityMessage> | undefined

    if (thread !== undefined) {
      void openThreadInSidebar(thread, undefined, undefined, undefined, undefined, false)
    }
  }

  async function handleChannelSelected (event: CustomEvent): Promise<void> {
    if (event.detail === null) {
      selectedData = undefined
      return
    }

    const detail = (event.detail ?? {}) as SelectChannelEvent

    let selectedObject = detail.object
    const selectedChat = detail.chat

    if (isFakeDirect(selectedObject)) {
      const direct = await createRealDirectFromFake(selectedObject)
      if (direct != null) {
        selectedObject = direct
      } else {
        selectedData = undefined
        return
      }
    }

    const _class = selectedObject._class
    const _id = selectedObject._id

    if (_id !== object?._id) {
      object = selectedObject
      chat = selectedChat
    }

    const id = await getObjectLinkId(linkProviders, _id, _class, selectedObject)

    selectedData = { id, _class }

    openChannel(selectedData.id, selectedData._class, undefined, true)
  }

  defineSeparators('chat', [
    { minSize: 12.5, maxSize: 40, size: 17.5, float: 'navigator' },
    { size: 'auto', minSize: 20, maxSize: 'auto' },
    { size: 20, minSize: 20, maxSize: 50, float: 'aside' }
  ])

  onMount(() => {
    loadSavedAttachments()
  })
  $: $deviceInfo.replacedPanel = replacedPanel
  onDestroy(() => ($deviceInfo.replacedPanel = undefined))
</script>

<div class="hulyPanels-container">
  {#if $deviceInfo.navigator.visible}
    <div
      class="antiPanel-navigator {$deviceInfo.navigator.direction === 'horizontal'
        ? 'portrait'
        : 'landscape'} border-left"
      class:fly={$deviceInfo.navigator.float}
    >
      <div class="antiPanel-wrap__content hulyNavPanel-container">
        <ChatNavigator {object} {chat} {currentSpecial} on:select={handleChannelSelected} />
      </div>
      {#if !($deviceInfo.isMobile && $deviceInfo.isPortrait && $deviceInfo.minWidth)}
        <Separator name="chat" float={$deviceInfo.navigator.float ? 'navigator' : true} index={0} />
      {/if}
    </div>
    <Separator
      name="chat"
      float={$deviceInfo.navigator.float}
      index={0}
      color={'transparent'}
      separatorSize={0}
      short
    />
  {/if}
  <div bind:this={replacedPanel} class="hulyComponent">
    {#if currentSpecial}
      <Component
        is={currentSpecial.component}
        props={{
          model: navigatorModel,
          ...currentSpecial.componentProps
        }}
        on:action={(e) => {
          if (e?.detail != null) {
            const loc = getCurrentLocation()
            loc.query = { ...loc.query, ...e.detail }
            navigate(loc)
          }
        }}
      />
    {:else if object}
      <ChannelView {object} />
    {/if}
  </div>
</div>

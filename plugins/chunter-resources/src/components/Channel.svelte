<!--
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
-->
<script lang="ts">
  import { Doc, Ref } from '@hcengineering/core'
  import { ActivityMessage } from '@hcengineering/activity'
  import { getClient } from '@hcengineering/presentation'
  import { getMessageFromLoc, messageInFocus } from '@hcengineering/activity-resources'
  import { location as locationStore } from '@hcengineering/ui'
  import { onDestroy, onMount } from 'svelte'
  import { NotificationClientImpl } from '@hcengineering/notification-resources'

  import chunter from '../plugin'
  import { ChatViewport } from '../chatViewport'
  import ReverseChannelScrollView from './ReverseChannelScrollView.svelte'

  export let object: Doc
  export let syncLocation = true
  export let autofocus = true
  export let freeze = false
  export let readonly = false
  export let selectedMessageId: Ref<ActivityMessage> | undefined = undefined
  export let collection: string | undefined = undefined
  export let withInput: boolean = true
  export let onReply: ((message: ActivityMessage) => void) | undefined = undefined

  const client = getClient()
  const hierarchy = client.getHierarchy()

  let chatViewport: ChatViewport | undefined

  const unsubscribe = messageInFocus.subscribe((id) => {
    if (!syncLocation) return
    if (id !== undefined && id !== selectedMessageId) {
      selectedMessageId = id
    }
  })

  const unsubscribeLocation = locationStore.subscribe((newLocation) => {
    if (!syncLocation) return
    const id = getMessageFromLoc(newLocation)
    selectedMessageId = id
    messageInFocus.set(id)
  })

  onDestroy(() => {
    unsubscribe()
    unsubscribeLocation()
    chatViewport?.release()
    chatViewport = undefined
  })

  onMount(() => {
    void updateViewport(object._id, selectedMessageId)
  })
  $: isDocChannel = !hierarchy.isDerived(object._class, chunter.class.ChunterSpace)

  $: void updateViewport(object._id, selectedMessageId)

  async function updateViewport (attachedTo: Ref<Doc>, selectedMessageId?: Ref<ActivityMessage>): Promise<void> {
    if (chatViewport === undefined) {
      const read = await NotificationClientImpl.getClient().getReadState(attachedTo)
      chatViewport = ChatViewport.getOrCreate(read, attachedTo, selectedMessageId, 50, false)
    }
  }
</script>

{#if chatViewport}
  <ReverseChannelScrollView
    channel={object}
    bind:selectedMessageId
    {object}
    collection={collection ?? (isDocChannel ? 'comments' : 'messages')}
    viewport={chatViewport}
    {freeze}
    {autofocus}
    {withInput}
    {readonly}
    {onReply}
  />
{/if}

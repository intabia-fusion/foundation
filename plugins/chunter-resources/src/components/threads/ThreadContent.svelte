<!--
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
  import { onDestroy, onMount } from 'svelte'
  import activity, { ActivityMessage } from '@hcengineering/activity'
  import { Label } from '@hcengineering/ui'
  import core, { Doc, Ref, Space } from '@hcengineering/core'
  import { NotificationClientImpl } from '@hcengineering/notification-resources'
  import { createQuery, getClient } from '@hcengineering/presentation'

  import ThreadParentMessage from './ThreadParentPresenter.svelte'
  import ReverseChannelScrollView from '../ReverseChannelScrollView.svelte'
  import { ChatViewport } from '../../chatViewport'

  export let selectedMessageId: Ref<ActivityMessage> | undefined = undefined
  export let message: ActivityMessage
  export let autofocus = true
  export let readonly: boolean = false
  export let onReply: ((message: ActivityMessage) => void) | undefined = undefined

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const query = createQuery()
  const inboxClient = NotificationClientImpl.getClient()

  let channel: Doc | undefined = undefined
  let chatViewport: ChatViewport | undefined = undefined

  $: query.query(
    message.attachedToClass,
    { _id: message.attachedTo },
    (res) => {
      channel = res[0]
    },
    { limit: 1 }
  )

  $: void updateViewport(message._id)

  async function updateViewport (messageId: Ref<ActivityMessage>): Promise<void> {
    if (chatViewport !== undefined) return

    const readState = (await inboxClient.getReadState(messageId)) ?? undefined
    chatViewport = ChatViewport.getOrCreate(readState, messageId, selectedMessageId, 100, true)
  }

  onDestroy(() => {
    chatViewport?.release()
    chatViewport = undefined
  })

  onMount(() => {
    void updateViewport(message._id)
  })

  $: messagesStore = chatViewport?.messages
  $: readonly = hierarchy.isDerived(message.attachedToClass, core.class.Space)
    ? ((readonly || (channel as Space)?.archived) ?? false)
    : readonly
</script>

<div class="hulyComponent-content hulyComponent-content__container noShrink">
  {#if chatViewport !== undefined && channel !== undefined}
    <ReverseChannelScrollView
      bind:selectedMessageId
      object={message}
      {channel}
      viewport={chatViewport}
      {autofocus}
      fullHeight={false}
      fixedInput={false}
      {onReply}
    >
      <svelte:fragment slot="header">
        <div class="mt-3">
          <ThreadParentMessage {message} {readonly} {onReply} />
        </div>

        {#if (message.replies ?? $messagesStore?.length ?? 0) > 0}
          <div class="separator">
            <div class="label lower">
              <Label
                label={activity.string.RepliesCount}
                params={{ replies: message.replies ?? $messagesStore?.length ?? 1 }}
              />
            </div>
            <div class="line" />
          </div>
        {/if}
      </svelte:fragment>
    </ReverseChannelScrollView>
  {/if}
</div>

<style lang="scss">
  .separator {
    display: flex;
    align-items: center;
    margin: 0.5rem 0;

    .label {
      white-space: nowrap;
      margin: 0 0.5rem;
      color: var(--theme-halfcontent-color);
    }

    .line {
      background: var(--theme-refinput-border);
      height: 1px;
      width: 100%;
    }
  }
</style>

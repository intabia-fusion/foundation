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
  import activity, { ActivityMessage } from '@hcengineering/activity'
  import notification, {
    DocNotifyContext,
    NotificationClient,
    getUnreadMessageCount
  } from '@hcengineering/notification'
  import { getResource } from '@hcengineering/platform'
  import { getClient } from '@hcengineering/presentation'
  import { Readable } from 'svelte/store'
  import { Doc, Ref } from '@hcengineering/core'
  import { onMount } from 'svelte'

  import RepliedPersons from './RepliedPersons.svelte'
  import LastReply from './LastReply.svelte'
  import RepliesCount from './RepliesCount.svelte'

  export let object: ActivityMessage
  export let onReply: ((message: ActivityMessage) => void) | undefined = undefined

  const client = getClient()

  $: lastReply = object.lastReply ?? new Date().getTime()

  let inboxClient: NotificationClient
  let contextByDocStore: Readable<Map<Ref<Doc>, DocNotifyContext | null>> | undefined

  onMount(async () => {
    const getClientFn = await getResource(notification.function.GetNotificationsClient)

    inboxClient = getClientFn()
    contextByDocStore = inboxClient.contextByDoc

    void inboxClient.loadContextByDoc(object._id)
  })

  $: hasNew = hasNewReplies($contextByDocStore?.get(object._id) ?? undefined)

  function hasNewReplies (context?: DocNotifyContext): boolean {
    if (context == null) return false
    return getUnreadMessageCount(context) > 0
  }

  const replyProvider = client.getModel().findAllSync(activity.class.ReplyProvider, {})[0]

  async function handleReply (e: MouseEvent): Promise<void> {
    e.stopPropagation()
    e.preventDefault()

    if (onReply) {
      onReply(object)
    }

    if (replyProvider) {
      const fn = await getResource(replyProvider.function)
      await fn(object, e)
    }
  }
</script>

<div class="replies-container flex-grow">
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="replies" on:click={handleReply}>
    <RepliedPersons repliedPersons={object.repliedPersons} />

    {#if hasNew}
      <div class="notifyMarker" />
    {/if}

    <span class="text overflow-label">
      <RepliesCount count={object.replies ?? 0} />
      <LastReply {lastReply} />
    </span>
  </div>
</div>

<style lang="scss">
  .replies-container {
    display: flex;
    flex-shrink: 1;
    min-width: 0;
    min-height: 2.375rem;
    height: 2.375rem;
    margin-top: 0.5rem;
  }
  .replies {
    display: flex;
    padding: 0.5rem 0.5rem;
    align-items: center;
    gap: 0.5rem;
    border-radius: 0.5rem;
    font-size: 0.75rem;
    cursor: pointer;
    min-width: 0;
    border: 1px solid var(--global-ui-BorderColor);
    min-height: 2.375rem;
    height: 2.375rem;

    &:hover {
      background-color: var(--theme-bg-color);
    }
  }

  .text {
    flex: 1 1 auto;
  }

  .notifyMarker {
    margin-right: 0.25rem;
    width: 0.425rem;
    height: 0.425rem;
    border-radius: 50%;
    background-color: var(--highlight-red);
  }
</style>

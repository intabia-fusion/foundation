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
  import { Component, Icon, Label, tooltip } from '@hcengineering/ui'
  import notification, { DocNotifyContext } from '@hcengineering/notification'
  import { getClient, IconWithEmoji } from '@hcengineering/presentation'
  import { Class, Doc, Ref } from '@hcengineering/core'
  import { classIcon } from '@hcengineering/view-resources'
  import { ChatMessage, ThreadMessage } from '@hcengineering/chunter'
  import contact from '@hcengineering/contact'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { ActivityMessageLite } from '@hcengineering/activity'
  import view from '@hcengineering/view'

  import chunter from '../../plugin'
  import ChatMessagePreview from '../chat-message/ChatMessagePreview.svelte'
  import ThreadMessagePreview from '../threads/ThreadMessagePreview.svelte'

  export let context: DocNotifyContext<ChatMessage>

  const client = getClient()
  const hierarchy = client.getHierarchy()

  let message: ActivityMessageLite<ChatMessage> | undefined = undefined
  let channelTitle: string | undefined = undefined

  $: message = context.object as ActivityMessageLite<ChatMessage>

  $: isThread = hierarchy.isDerived(context.objectClass, chunter.class.ThreadMessage)
  $: channelTitle =
    context.parentObjectClass != null &&
    hierarchy.isDerived(context.parentObjectClass, chunter.class.Channel) &&
    (context.parentObjectTitle ?? '').startsWith('#')
      ? context.parentObjectTitle?.slice(1)
      : (context.parentObjectIdentifier ?? context.parentObjectTitle)

  function toThread (message: ChatMessage): ActivityMessageLite<ThreadMessage> {
    return message as ActivityMessageLite<ThreadMessage>
  }

  function isAvatarIcon (_class?: Ref<Class<Doc>>): boolean {
    if (_class == null) return false
    return hierarchy.isDerived(_class, contact.class.Person) || hierarchy.isDerived(_class, chunter.class.DirectMessage)
  }

  $: iconMixin =
    context.parentObjectClass != null
      ? hierarchy.classHierarchyMixin(context.parentObjectClass, view.mixin.ObjectIcon)
      : undefined
  $: iconSize = isAvatarIcon(context?.parentObjectClass) ? 'tiny' : 'small'
</script>

<span class="flex-presenter flex-gap-1 header">
  <Label label={chunter.string.Thread} />
  <span class="lower">
    <Label label={chunter.string.In} />
  </span>
  <span
    class="flex-presenter flex-gap-0-5"
    use:tooltip={channelTitle != null ? { label: getEmbeddedLabel(channelTitle) } : {}}
  >
    {#if iconMixin}
      <Component
        is={iconMixin.component}
        props={{
          ...context.parentObjectIcon?.props,
          asset: context.parentObjectIcon?.asset,
          emoji: context.parentObjectIcon?.emoji,
          size: iconSize
        }}
        showLoading={false}
      />
    {:else if context.parentObjectIcon?.emoji}
      <IconWithEmoji icon={context.parentObjectIcon.emoji} size="small" />
    {:else}
      <Icon
        icon={context.parentObjectIcon?.asset ??
          classIcon(client, context.parentObjectClass) ??
          notification.icon.Notifications}
        size="small"
      />
    {/if}
    <span class="overflow-label ml-0-5">
      {channelTitle}
    </span>
  </span>
</span>
<span class="font-normal mt-1">
  {#if message}
    {#if isThread}
      <ThreadMessagePreview value={toThread(message)} readonly type="content-only" />
    {:else}
      <ChatMessagePreview value={message} readonly type="content-only" />
    {/if}
  {/if}
</span>

<style lang="scss">
  .header {
    font-size: 0.875rem;
    font-weight: 600;
  }
</style>

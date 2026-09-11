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
  import activity, { ActivityMessage, ActivityMessageLite } from '@hcengineering/activity'
  import { getClient, IconWithEmoji } from '@hcengineering/presentation'
  import { classIcon } from '@hcengineering/view-resources'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import view from '@hcengineering/view'

  import ActivityMessagePreview from './ActivityMessagePreview.svelte'

  export let context: DocNotifyContext<ActivityMessage>

  const client = getClient()
  const hierarchy = client.getHierarchy()

  let message: ActivityMessageLite | undefined = undefined
  $: message = context.object as ActivityMessageLite

  let title: string | undefined = undefined
  $: title = context.parentObjectIdentifier ?? context.parentObjectTitle

  $: iconMixin =
    context.parentObjectClass != null
      ? hierarchy.classHierarchyMixin(context.parentObjectClass, view.mixin.ObjectIcon)
      : undefined
</script>

<span class="flex-presenter flex-gap-1 font-semi-bold">
  <Label label={activity.string.Thread} />
  {#if title}
    <span class="lower">
      <Label label={activity.string.In} />
    </span>
    <span
      class="flex-presenter flex-gap-0-5"
      use:tooltip={title != null ? { label: getEmbeddedLabel(title) } : undefined}
    >
      {#if iconMixin}
        <Component
          is={iconMixin.component}
          props={{
            ...context.parentObjectIcon?.props,
            asset: context.parentObjectIcon?.asset,
            emoji: context.parentObjectIcon?.emoji,
            size: 'small'
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
      {title}
    </span>
  {/if}
</span>
{#if message}
  <span class="font-normal">
    <ActivityMessagePreview value={message} readonly type="content-only" />
  </span>
{/if}

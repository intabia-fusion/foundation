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
  import { DocNotifyContext } from '@hcengineering/notification'
  import { Icon, Component, IconSize } from '@hcengineering/ui'
  import { getClient, IconWithEmoji } from '@hcengineering/presentation'
  import { classIcon } from '@hcengineering/view-resources'
  import view from '@hcengineering/view'
  import chunter from '@hcengineering/chunter'

  import NotifyMarker from './NotifyMarker.svelte'

  export let value: DocNotifyContext
  export let size: IconSize = 'medium'

  const client = getClient()
  const hierarchy = client.getHierarchy()

  $: iconMixin = hierarchy.classHierarchyMixin(value.objectClass, view.mixin.ObjectIcon)
</script>

<div class="container">
  {#if iconMixin}
    <Component
      is={iconMixin.component}
      props={{ ...value.objectIcon?.props, asset: value.objectIcon?.asset, emoji: value.objectIcon?.emoji, size }}
      showLoading={false}
    />
  {:else if value.objectIcon?.emoji}
    <IconWithEmoji icon={value.objectIcon.emoji} {size} />
  {:else}
    <Icon icon={value.objectIcon?.asset ?? classIcon(client, value.objectClass) ?? chunter.icon.Thread} {size} />
  {/if}

  <div class="notifyMarker">
    <NotifyMarker count={value.unreadCount} size="medium" />
  </div>
</div>

<style lang="scss">
  .container {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--global-secondary-TextColor);
    border-radius: var(--medium-BorderRadius);
    border: 1px solid var(--global-subtle-ui-BorderColor);
    background-color: var(--global-ui-BackgroundColor);
    width: 2.5rem;
    height: 2.5rem;
    min-width: 2.5rem;
    min-height: 2.5rem;
    position: relative;

    .notifyMarker {
      position: absolute;
      top: -0.375rem;
      right: -0.375rem;
      z-index: 100;
    }
  }
</style>

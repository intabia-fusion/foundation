<!--
// Copyright © 2026 Intabia Fusion.
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
  import { ActivityNotificationViewlet, DocNotifyContext } from '@hcengineering/notification'
  import { createEventDispatcher } from 'svelte'

  import NotificationPresenter from './inbox/NotificationPresenter.svelte'

  export let value: DocNotifyContext
  export let viewlets: ActivityNotificationViewlet[] = []

  const dispatch = createEventDispatcher()
</script>

<div class="content">
  <div class="notifications">
    {#each value.latestNotifications.slice(0, 3) as n (n.id)}
      <div class="notification">
        <div class="embeddedMarker" />
        <NotificationPresenter
          value={n}
          objectId={value.objectId}
          objectClass={value.objectClass}
          objectSpace={value.objectSpace}
          {viewlets}
          on:click={(e) => {
            e.preventDefault()
            e.stopPropagation()
            dispatch('click', { context: value, notification: n })
          }}
        />
      </div>
    {/each}
  </div>
</div>

<style lang="scss">
  .notifications {
    display: flex;
    width: 100%;
    min-width: 0;
    flex-direction: column;
    margin-top: var(--spacing-1);
    margin-left: var(--spacing-1);
  }

  .notification {
    position: relative;
    cursor: pointer;
    user-select: none;
    min-height: 2.125rem;

    .embeddedMarker {
      position: absolute;
      min-width: 0.25rem;
      width: 0.25rem;
      max-width: 0.25rem;
      border-radius: 0;
      height: 100%;
      background: var(--global-ui-highlight-BackgroundColor);
    }

    &:first-child {
      .embeddedMarker {
        border-top-left-radius: 0.5rem;
        border-top-right-radius: 0.5rem;
      }
    }

    &:hover {
      .embeddedMarker {
        border-radius: 0.5rem;
        background: var(--global-primary-LinkColor);
      }
    }

    &:last-child {
      .embeddedMarker {
        border-bottom-left-radius: 0.5rem;
        border-bottom-right-radius: 0.5rem;
      }
    }
  }

  .content {
    display: flex;
    width: 100%;
  }
</style>

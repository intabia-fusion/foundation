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
  import { ActivityNotificationViewlet, DocNotifyContext } from '@hcengineering/notification'
  import { createEventDispatcher } from 'svelte'

  import DocNotifyContextCardHeader from './DocNotifyContextCardHeader.svelte'
  import DocNotifyContextCardContent from './DocNotifyContextCardContent.svelte'

  export let value: DocNotifyContext
  export let viewlets: ActivityNotificationViewlet[] = []
  export let isClearing = false

  const dispatch = createEventDispatcher()
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
  class="card"
  on:click={() => {
    dispatch('click', { context: value })
  }}
>
  <DocNotifyContextCardHeader {value} {isClearing} on:clear />
  <DocNotifyContextCardContent {value} {viewlets} on:click />
</div>

<style lang="scss">
  .card {
    display: flex;
    position: relative;
    flex-direction: column;
    cursor: pointer;
    padding: var(--spacing-1_5) var(--spacing-1);
    padding-top: 0;
    border-bottom: 1px solid var(--global-ui-BorderColor);
    min-height: 5.625rem;
  }
</style>

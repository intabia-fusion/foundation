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
  import { IntlString } from '@hcengineering/platform'
  import { ActivityMessageLite, ActivityMessagePreviewType } from '@hcengineering/activity'

  import BasePreview from '../BasePreview.svelte'

  export let text: string | undefined = undefined
  export let intlLabel: IntlString | undefined = undefined
  export let readonly = false
  export let type: ActivityMessagePreviewType = 'full'
  export let message: ActivityMessageLite

  let isCompact = false
</script>

<BasePreview
  bind:isCompact
  {text}
  {intlLabel}
  {readonly}
  {type}
  timestamp={message.createdOn ?? message.modifiedOn}
  account={message.createdBy ?? message.modifiedBy}
  on:click
>
  <svelte:fragment slot="content">
    <slot />
  </svelte:fragment>
</BasePreview>

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
<!--
  Panel header of a permanent meeting. The document, attachments and chat below it are rendered by
  the generic panel from `descriptionRef` and the collections, the same way a session gets them.
-->
<script lang="ts">
  import { type PermanentMeeting } from '@hcengineering/love'
  import { getClient } from '@hcengineering/presentation'
  import { EditBox, ModernButton } from '@hcengineering/ui'
  import { createEventDispatcher, onMount } from 'svelte'
  import love from '../plugin'
  import { joinPermanentMeeting } from '../meetings'

  export let object: PermanentMeeting
  export let readonly: boolean = false

  const client = getClient()
  const dispatch = createEventDispatcher()

  let currentName = object.name
  let newName = object.name

  $: if (object.name !== currentName) {
    newName = object.name
    currentName = object.name
  }

  async function changeName (): Promise<void> {
    await client.diffUpdate(object, { name: newName })
  }

  onMount(() => {
    dispatch('open', { ignoreKeys: ['name'] })
  })
</script>

<div class="flex-row-center flex-between flex-gap-2 mb-4">
  <div class="title flex-grow">
    <EditBox
      disabled={readonly}
      placeholder={love.string.PermanentMeeting}
      bind:value={newName}
      on:change={changeName}
      focusIndex={1}
    />
  </div>
  <ModernButton
    label={love.string.JoinMeeting}
    size="large"
    kind={'primary'}
    on:click={() => {
      void joinPermanentMeeting(object._id)
    }}
  />
</div>

<style lang="scss">
  .title {
    font-weight: 500;
    font-size: 1.25rem;
    color: var(--theme-caption-color);
  }
</style>

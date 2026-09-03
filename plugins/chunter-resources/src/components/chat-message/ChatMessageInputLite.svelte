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
  import { AttachmentRefInput } from '@hcengineering/attachment-resources'
  import chunter from '@hcengineering/chunter'
  import core, { generateId, Markup } from '@hcengineering/core'
  import { createEventDispatcher } from 'svelte'

  export let focusIndex: number = -1
  export let boundary: HTMLElement | undefined = undefined
  export let loading = false
  export let autofocus = false
  export let disableSubmit = false
  export let clearOnSubmit = true

  const dispatch = createEventDispatcher<{
    update: { message: Markup, attachments: number }
  }>()

  let objectId = generateId()

  function onUpdate (event: CustomEvent<{ message: Markup, attachments: number }>): void {
    dispatch('update', event.detail)
  }
</script>

<AttachmentRefInput
  {focusIndex}
  bind:objectId
  _class={chunter.class.ChatMessage}
  space={core.space.Workspace}
  skipAttachmentsPreload={true}
  shouldSaveDraft={false}
  showSend={false}
  disableAttachments
  {boundary}
  {autofocus}
  {disableSubmit}
  {clearOnSubmit}
  on:update={onUpdate}
  on:message
  on:focus
  on:blur
  bind:loading
/>

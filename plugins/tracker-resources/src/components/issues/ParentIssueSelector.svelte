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
  import { Doc, Ref } from '@hcengineering/core'
  import { createQuery } from '@hcengineering/presentation'
  import { Issue } from '@hcengineering/tracker'
  import type { ButtonKind, ButtonShape, ButtonSize, LabelAndProps, PopupResult } from '@hcengineering/ui'
  import { Button, eventToHTMLElement, Label, showPopup } from '@hcengineering/ui'

  import tracker from '../../plugin'
  import SetParentIssueActionPopup from '../SetParentIssueActionPopup.svelte'

  export let value: Ref<Issue> | Issue | null | undefined = undefined
  export let object: Issue | Doc | undefined = undefined
  export let isEditable: boolean = true
  export let onChange: ((newIssueId: Ref<Issue> | undefined) => void) | undefined = undefined
  export let kind: ButtonKind = 'no-border'
  export let size: ButtonSize = 'small'
  export let shape: ButtonShape = undefined
  export let justify: 'left' | 'center' = 'center'
  export let width: string | undefined = '100%'
  export let focusIndex: number | undefined = undefined
  export let showTooltip: LabelAndProps | undefined = undefined
  export let maxLabelWidth: string | undefined = undefined
  export let short: boolean = false
  export let popupWidth: 'small' | 'medium' | 'large' | 'full' = 'medium'
  export let draft: boolean = false
  export let updateDoc: boolean = !draft

  $: targetObject = (object ??
    (value != null && typeof value === 'object' && '_class' in value ? value : undefined)) as Issue | undefined
  $: parentId = targetObject ? targetObject.attachedTo : typeof value === 'string' ? value : undefined

  let selectedIssue: Issue | undefined
  let popup: PopupResult | undefined

  const query = createQuery()

  $: if (parentId !== undefined && parentId !== null && parentId !== tracker.ids.NoParent) {
    query.query(tracker.class.Issue, { _id: parentId }, (res) => {
      selectedIssue = res[0]
    })
  } else {
    query.unsubscribe()
    selectedIssue = undefined
  }

  const handleOpenEditor = async (event: MouseEvent): Promise<void> => {
    event.stopPropagation()
    if (!isEditable) {
      return
    }

    const popupValue = targetObject ?? (selectedIssue ? [selectedIssue] : [])

    popup = showPopup(
      SetParentIssueActionPopup,
      {
        value: popupValue,
        width: popupWidth,
        updateDoc
      },
      eventToHTMLElement(event),
      (evt: Issue | null | undefined) => {
        if (evt === undefined) {
          popup = undefined
          return
        }
        const newValue = evt === null ? tracker.ids.NoParent : evt._id
        onChange?.(newValue)
        popup = undefined
      }
    )
  }
</script>

<Button
  id="parent-issue"
  {focusIndex}
  {kind}
  {size}
  {shape}
  {width}
  {justify}
  {showTooltip}
  {short}
  icon={tracker.icon.Parent}
  disabled={!isEditable}
  notSelected={!value || value === tracker.ids.NoParent}
  on:click={handleOpenEditor}
>
  <svelte:fragment slot="content">
    <span class="label text-md overflow-label pointer-events-none" style:max-width={maxLabelWidth}>
      {#if selectedIssue}
        {selectedIssue.identifier}: {selectedIssue.title}
      {:else}
        <Label label={tracker.string.SetParent} />
      {/if}
    </span>
  </svelte:fragment>
</Button>

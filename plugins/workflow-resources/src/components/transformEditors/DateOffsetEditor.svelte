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
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import presentation, { Card } from '@hcengineering/presentation'
  import ui, { DropdownIntlItem, DropdownLabelsIntl, NumberInput } from '@hcengineering/ui'
  import { WorkflowValueFunction } from '@hcengineering/workflow'

  export let func: WorkflowValueFunction
  export let props: Record<string, any> = {}

  let offset = props?.offset
  let offsetType = props?.offsetType ?? 'days'
  let direction = props?.direction ?? 'after'

  const items: DropdownIntlItem[] = [
    { id: 'days', label: ui.string.DaysWOValue },
    { id: 'weeks', label: ui.string.WeeksWOValue },
    { id: 'months', label: ui.string.MonthsWOValue }
  ]

  const directions: DropdownIntlItem[] = [
    { id: 'after', label: ui.string.After },
    { id: 'before', label: ui.string.Before }
  ]

  const dispatch = createEventDispatcher<{ close: { offset: any, offsetType: string, direction: string } }>()

  function save (): void {
    dispatch('close', {
      offset,
      offsetType,
      direction
    })
  }

  $: params = {
    days: offset,
    weeks: offset,
    months: offset
  }
</script>

<Card on:close width={'small'} label={func.label} canSave okAction={save} okLabel={presentation.string.Save}>
  <div class="flex-row-center flex-gap-2">
    <DropdownLabelsIntl items={directions} bind:selected={direction} />
    <NumberInput bind:value={offset} autoFocus minValue={0} focusable maxDigitsAfterPoint={0} />
    <DropdownLabelsIntl {items} bind:selected={offsetType} {params} />
  </div>
</Card>

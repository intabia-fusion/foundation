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
  import ui, { DropdownIntlItem, DropdownLabelsIntl } from '@hcengineering/ui'
  import { WorkflowValueFunction } from '@hcengineering/workflow'

  export let func: WorkflowValueFunction
  export let props: Record<string, any> = {}

  let unit = props?.unit ?? 'days'

  const items: DropdownIntlItem[] = [
    { id: 'hours', label: ui.string.Hours },
    { id: 'days', label: ui.string.Days },
    { id: 'weeks', label: ui.string.Weeks },
    { id: 'months', label: ui.string.Months },
    { id: 'years', label: ui.string.Years }
  ]

  const dispatch = createEventDispatcher<{ close: { unit: string } }>()

  function save (): void {
    dispatch('close', { unit })
  }
</script>

<Card on:close width={'small'} label={func.label} canSave okAction={save} okLabel={presentation.string.Save}>
  <div class="flex-row-center flex-gap-2">
    <DropdownLabelsIntl {items} bind:selected={unit} />
  </div>
</Card>

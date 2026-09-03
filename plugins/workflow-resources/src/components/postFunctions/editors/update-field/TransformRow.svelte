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
  import { Button, IconAdd } from '@hcengineering/ui'
  import type { WorkflowFieldValue, WorkflowTransformCall } from '@hcengineering/workflow'
  import { getClient } from '@hcengineering/presentation'

  import plugin from '../../../../plugin'
  import { FieldRow } from './types'
  import TransformPill from './TransformPill.svelte'
  import { hasTransformFunctions, isFieldValueEmpty } from './utils'

  export let row: FieldRow

  const dispatch = createEventDispatcher<{
    transform: MouseEvent
    editTransform: { fn: WorkflowTransformCall, event: MouseEvent }
    value: WorkflowFieldValue
  }>()

  const client = getClient()

  function isTransformFunction (fn: WorkflowTransformCall): boolean {
    const funcRef = fn?.func
    if (funcRef == null) return false
    const doc = client.getModel().getObject(funcRef)
    return doc?.type === 'transform'
  }

  function removeTransform (fnTarget: WorkflowTransformCall): void {
    if (row.value.functions == null) return
    const newFuncs = row.value.functions.filter((fn) => fn !== fnTarget)
    const updatedValue: WorkflowFieldValue = {
      ...row.value,
      functions: newFuncs
    }
    dispatch('value', updatedValue)
  }

  $: hasField = row.fieldKey !== '' && row.attribute != null
  $: hasTransforms = hasField ? hasTransformFunctions(client, row.attribute) : false
  $: valueEmpty = isFieldValueEmpty(row.value)

  $: isTransformDisabled = !hasField || !hasTransforms || valueEmpty

  $: transformTooltip = !hasField
    ? { label: plugin.string.SelectFieldFirst }
    : !hasTransforms
        ? { label: plugin.string.NoTransformationsForAttribute }
        : valueEmpty
          ? { label: plugin.string.SetValueFirst }
          : undefined
</script>

<div class="set-field-value--transform-row">
  {#if 'functions' in row.value && row.value.functions != null && row.value.functions.length > 0}
    {@const transformList = row.value.functions.filter(isTransformFunction)}
    {#if transformList.length > 0}
      <div class="transform-list">
        {#each transformList as fn, index}
          {#if index > 0}
            <span class="transform-arrow">→</span>
          {/if}
          <TransformPill
            {fn}
            {index}
            on:edit={(e) => {
              dispatch('editTransform', { fn, event: e.detail })
            }}
            on:remove={() => {
              removeTransform(fn)
            }}
          />
        {/each}
      </div>
    {/if}
  {/if}

  <Button
    label={plugin.string.Transform}
    icon={IconAdd}
    kind="ghost"
    size="small"
    disabled={isTransformDisabled}
    showTooltip={transformTooltip}
    on:click={(e) => {
      if (!isTransformDisabled) {
        dispatch('transform', e)
      }
    }}
  />
</div>

<style lang="scss">
  .set-field-value--transform-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
    padding-top: 0.25rem;
    border-top: 1px dashed var(--global-subtle-ui-BorderColor);

    .transform-list {
      display: flex;
      flex-direction: row;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.375rem;
      width: 100%;
    }

    .transform-arrow {
      color: var(--global-tertiary-TextColor, #8a8a8a);
      font-size: 0.8125rem;
      font-weight: 600;
      margin: 0 0.125rem;
      user-select: none;
      flex-shrink: 0;
    }
  }
</style>

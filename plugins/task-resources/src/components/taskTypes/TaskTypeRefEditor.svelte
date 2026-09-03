<!--
// Copyright © 2022 Hardcore Engineering Inc.
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
  import { Ref } from '@hcengineering/core'
  import { TaskType } from '@hcengineering/task'
  import { Button, DropdownTextItem, IconAdd, IconClose, Label, ModernDropdownLabels } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import task from '../../plugin'
  import TaskTypeIcon from './TaskTypeIcon.svelte'

  export let value: Ref<TaskType>[] = []
  export let onChange: (value: Ref<TaskType>[]) => void
  export let types: TaskType[]

  $: sortedTypes = [...types].sort((a, b) => a.name.localeCompare(b.name))
  $: selectedItems = sortedTypes.filter((p) => value?.includes(p._id))
  $: items = sortedTypes.map(
    (p): DropdownTextItem => ({
      id: p._id,
      label: p.name,
      icon: TaskTypeIcon,
      iconProps: { value: p }
    })
  )

  const dispatch = createEventDispatcher()

  function removeItem (id: Ref<TaskType>): void {
    value = value.filter((v) => v !== id)
    onChange(value)
    dispatch('selected', value)
  }

  function handleDropdownSelected (
    evt: CustomEvent<DropdownTextItem['id'] | DropdownTextItem['id'][] | undefined | null>
  ): void {
    if (evt.detail != null) {
      value = Array.isArray(evt.detail) ? (evt.detail as Ref<TaskType>[]) : ([evt.detail] as Ref<TaskType>[])
      onChange(value)
      dispatch('selected', value)
    }
  }
</script>

<div class="hulyModal-content__settingsSet-line" class:has-chips={selectedItems.length > 0}>
  <span class="label">
    <Label label={task.string.AllowedParentTaskTypes} />
  </span>
  <ModernDropdownLabels
    kind="secondary"
    size="small"
    iconSize="small"
    icon={IconAdd}
    showContent={false}
    {items}
    selected={value}
    enableSearch={false}
    autoSelect={false}
    multiselect={true}
    on:selected={handleDropdownSelected}
  />
</div>

{#if selectedItems.length > 0}
  <div class="parent-chips-container">
    {#each selectedItems as item (item._id)}
      <div class="parent-chip">
        {#if item.icon}
          <div class="chip-icon">
            <TaskTypeIcon value={item} size="x-small" />
          </div>
        {/if}
        <span class="chip-label">{item.name}</span>
        <Button
          icon={IconClose}
          kind="ghost"
          size="inline"
          on:click={(e) => {
            e.stopPropagation()
            removeItem(item._id)
          }}
        />
      </div>
    {/each}
  </div>
{/if}

<style lang="scss">
  .hulyModal-content__settingsSet-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;

    &.has-chips {
      border-bottom: none;
    }
  }

  .parent-chips-container {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0 var(--spacing-2) 0;
    border-bottom: 1px solid var(--theme-divider-color);
  }

  .parent-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1875rem 0.5rem;
    border-radius: 0.375rem;
    background-color: var(--global-surface-02-BackgroundColor);
    border: 1px solid var(--global-ui-BorderColor);
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--global-primary-TextColor);
    max-width: 100%;
    min-width: 0;

    .chip-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .chip-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex-shrink: 1;
      max-width: 10rem;
    }
  }
</style>

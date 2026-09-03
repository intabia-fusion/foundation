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
  import { Class, Doc, Ref, toIdMap } from '@hcengineering/core'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { getClient, MessageBox } from '@hcengineering/presentation'
  import task, { ProjectType, TaskType } from '@hcengineering/task'
  import {
    ButtonKind,
    ButtonSize,
    DropdownLabelsIntl,
    Label,
    type DropdownIntlItem,
    Button,
    showPopup
  } from '@hcengineering/ui'
  import plugin from '../../plugin'
  import { createEventDispatcher } from 'svelte'
  import { taskTypeStore } from '../..'
  import TaskTypeIcon from './TaskTypeIcon.svelte'

  export let value: Ref<TaskType> | undefined
  export let projectType: Ref<ProjectType> | undefined
  export let parentType: Ref<TaskType> | undefined = undefined
  export let focusIndex: number = -1
  export let baseClass: Ref<Class<Doc>> | undefined = undefined
  export let kind: ButtonKind = 'regular'
  export let size: ButtonSize = 'medium'
  export let justify: 'left' | 'center' = 'center'
  export let width: string | undefined = undefined
  export let showAlways: boolean = false

  const client = getClient()

  $: taskTypeDescriptors = toIdMap(client.getModel().findAllSync(task.class.TaskTypeDescriptor, {}))

  $: allItems = Array.from($taskTypeStore.values()).filter(
    (it) =>
      it.parent === projectType &&
      (taskTypeDescriptors.get(it.descriptor)?.allowCreate ?? false) &&
      (baseClass === undefined || client.getHierarchy().isDerived(it.targetClass, baseClass))
  )

  $: childItems = allItems.filter(
    (it) => parentType !== undefined && (it.allowAnyParent === true || (it.allowedAsChildOf ?? []).includes(parentType))
  )

  $: rootItems = allItems.filter((it) => it.isRootTaskType !== false)

  $: items = (parentType === undefined ? rootItems : childItems).map((it) => ({
    id: it._id,
    label: getEmbeddedLabel(it.name),
    icon: TaskTypeIcon,
    iconProps: { value: it }
  })) as DropdownIntlItem[]

  $: if (
    (value === undefined && items.length > 0) ||
    (items.length > 0 && items.find((it) => it.id === value) === undefined)
  ) {
    value = items[0].id as Ref<TaskType>
    change()
  }

  $: parentTypeName = parentType !== undefined ? ($taskTypeStore.get(parentType)?.name ?? '') : ''
  $: noChildTypes = parentType !== undefined && items.length === 0

  const dispatch = createEventDispatcher()

  function change () {
    dispatch('change', value)
  }
</script>

{#if projectType !== undefined && noChildTypes}
  <Button
    kind={'secondary'}
    {size}
    on:click={() => {
      showPopup(MessageBox, {
        label: plugin.string.NoSubtaskTypesShort,
        message: plugin.string.NoSubtaskTypesHint,
        params: { type: parentTypeName }
      })
    }}
  >
    <Label slot="content" label={plugin.string.NoSubtaskTypesShort} />
  </Button>
{:else if projectType !== undefined && (items.length > 1 || showAlways)}
  <DropdownLabelsIntl
    {focusIndex}
    {kind}
    {size}
    {items}
    {justify}
    {width}
    icon={TaskTypeIcon}
    iconProps={value !== undefined ? { value: $taskTypeStore.get(value) } : {}}
    dataId={'btnSelectTaskType'}
    bind:selected={value}
    on:selected={change}
  />
{/if}

<style lang="scss">
  .kind-empty-hint {
    font-size: 0.75rem;
    color: var(--theme-text-secondary, #64748b);
  }
</style>

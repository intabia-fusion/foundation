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
  import { type Ref } from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import task, { type TaskType } from '@hcengineering/task'
  import { taskTypeStore, TaskTypeIcon } from '@hcengineering/task-resources'
  import { type Issue } from '@hcengineering/tracker'
  import {
    Button,
    type ButtonKind,
    type ButtonSize,
    type IconSize,
    SelectPopup,
    eventToHTMLElement,
    showPopup
  } from '@hcengineering/ui'

  import tracker from '../../plugin'
  import { getTaskTypeChoices } from '../../taskTypeChange'
  import { activeProjects } from '../../utils'
  import ChangeTaskType from './ChangeTaskType.svelte'
  import TaskTypePresenter from './TaskTypePresenter.svelte'

  export let value: Issue
  export let isEditable: boolean = true
  export let kind: ButtonKind = 'link'
  export let size: ButtonSize = 'large'
  export let iconSize: IconSize = 'small'
  export let justify: 'left' | 'center' = 'left'
  export let width: string | undefined = undefined
  export let shouldShowLabel: boolean = true

  const client = getClient()
  const hierarchy = client.getHierarchy()

  $: taskType = $taskTypeStore.get(value.kind)
  $: project = $activeProjects.get(value.space)

  const descriptors = client.getModel().findAllSync(task.class.TaskTypeDescriptor, {})

  $: choices = getTaskTypeChoices(hierarchy, $taskTypeStore, project?.type, descriptors)

  // Changing the type is only on offer when the project has something else to offer.
  $: canChange = isEditable && choices.length > 1

  $: typesInfo = choices.map((it) => ({
    id: it._id,
    component: TaskTypePresenter,
    props: { value: it },
    isSelected: it._id === value.kind
  }))

  function selectType (event: MouseEvent): void {
    if (!canChange) return

    const props = { value: typesInfo, placeholder: tracker.string.NewTaskType }
    showPopup(SelectPopup, props, eventToHTMLElement(event), (res) => {
      if (res == null || res === value.kind) return
      showPopup(ChangeTaskType, { value, targetKind: res as Ref<TaskType> }, 'top')
    })
  }
</script>

{#if taskType !== undefined}
  <Button
    showTooltip={canChange ? { label: tracker.string.ChangeTaskType } : undefined}
    disabled={!canChange}
    {justify}
    {size}
    {kind}
    {width}
    on:click={selectType}
  >
    <svelte:fragment slot="icon">
      <TaskTypeIcon value={taskType} size={iconSize} />
    </svelte:fragment>
    <svelte:fragment slot="content">
      {#if shouldShowLabel}
        <span class="overflow-label disabled ml-1-5">{taskType.name}</span>
      {/if}
    </svelte:fragment>
  </Button>
{/if}

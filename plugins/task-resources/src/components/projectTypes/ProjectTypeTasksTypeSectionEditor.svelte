<!--
// Copyright © 2024 Hardcore Engineering Inc.
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
  import { onDestroy } from 'svelte'
  import { SortingOrder } from '@hcengineering/core'
  import { ButtonIcon, IconAdd, Label, getCurrentResolvedLocation, navigate, showPopup } from '@hcengineering/ui'
  import { createQuery } from '@hcengineering/presentation'
  import { ProjectType, ProjectTypeDescriptor, TaskType } from '@hcengineering/task'
  import { clearSettingsStore, settingsStore } from '@hcengineering/setting-resources'

  import IconLayers from '../icons/Layers.svelte'
  import TaskTypeIcon from '../taskTypes/TaskTypeIcon.svelte'
  import CreateTaskType from '../taskTypes/CreateTaskType.svelte'
  import TaskTypeDiagramPopup from '../taskTypes/TaskTypeDiagramPopup.svelte'
  import task from '../../plugin'

  export let type: ProjectType | undefined
  export let descriptor: ProjectTypeDescriptor | undefined
  export let disabled: boolean = true

  let taskTypes: TaskType[] = []
  const taskTypesQuery = createQuery()
  $: taskTypesQuery.query(
    task.class.TaskType,
    { _id: { $in: type?.tasks ?? [] } },
    (res) => {
      taskTypes = res
    },
    { sort: { name: SortingOrder.Ascending } }
  )

  $: sortedTaskTypes = [...taskTypes].sort((a, b) => a.name.localeCompare(b.name))

  function handleTaskTypeSelected (id: string | undefined): void {
    const loc = getCurrentResolvedLocation()
    if (id !== undefined) {
      loc.path[5] = 'taskTypes'
      loc.path[6] = id
      loc.path.length = 7
    } else {
      loc.path.length = 5
    }

    clearSettingsStore()
    navigate(loc)
  }

  onDestroy(() => {
    clearSettingsStore()
  })
</script>

{#if descriptor !== undefined}
  <div class="hulyTableAttr-header font-medium-12">
    <IconLayers size={'small'} />
    <span><Label label={task.string.TaskTypes} /></span>
    <div class="flex-row-center flex-gap-2">
      <ButtonIcon
        icon={task.icon.TypeHierarchy}
        tooltip={{ label: task.string.TaskTypesDiagram, direction: 'bottom' }}
        size="small"
        kind="tertiary"
        disabled={taskTypes.length === 0}
        on:click={() => {
          if (taskTypes.length === 0) return
          showPopup(TaskTypeDiagramPopup, { taskTypes }, 'centered')
        }}
      />
      <ButtonIcon
        kind="primary"
        icon={IconAdd}
        size="small"
        dataId={'btnAdd'}
        {disabled}
        on:click={() => {
          if (disabled) {
            return
          }
          $settingsStore = { id: 'createTaskType', component: CreateTaskType, props: { type, descriptor, taskTypes } }
        }}
      />
    </div>
  </div>
  {#if sortedTaskTypes.length}
    <div class="hulyTableAttr-content task">
      {#each sortedTaskTypes as taskType}
        <button
          class="hulyTableAttr-content__row"
          on:click|stopPropagation={() => {
            handleTaskTypeSelected(taskType._id)
          }}
        >
          <div class="hulyTableAttr-content__row-icon-wrapper">
            <TaskTypeIcon value={taskType} size={'small'} />
          </div>
          {#if taskType.name}
            <div class="hulyTableAttr-content__row-label grow font-medium-14">
              {taskType.name}
            </div>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
{/if}

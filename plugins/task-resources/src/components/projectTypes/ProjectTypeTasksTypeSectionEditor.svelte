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
  import {
    ButtonIcon,
    ButtonMenu,
    IconAdd,
    IconCopy,
    Label,
    getCurrentResolvedLocation,
    navigate,
    showPopup,
    type DropdownIntlItem
  } from '@hcengineering/ui'
  import { Severity, Status, setPlatformStatus } from '@hcengineering/platform'
  import { createQuery } from '@hcengineering/presentation'
  import { ProjectType, ProjectTypeDescriptor, TaskType, type TaskTypeExportConfig } from '@hcengineering/task'
  import { clearSettingsStore, settingsStore } from '@hcengineering/setting-resources'

  import IconLayers from '../icons/Layers.svelte'
  import TaskTypeIcon from '../taskTypes/TaskTypeIcon.svelte'
  import CreateTaskType from '../taskTypes/CreateTaskType.svelte'
  import TaskTypeDiagramPopup from '../taskTypes/TaskTypeDiagramPopup.svelte'
  import ImportTaskTypePopup from '../taskTypes/ImportTaskTypePopup.svelte'
  import task from '../../plugin'

  export let type: ProjectType | undefined
  export let descriptor: ProjectTypeDescriptor | undefined
  export let disabled: boolean = true

  let fileInput: HTMLInputElement | undefined
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

  const importActions: DropdownIntlItem[] = [
    {
      id: 'file',
      label: task.string.ImportFromFile,
      icon: task.icon.Import
    },
    {
      id: 'clipboard',
      label: task.string.ImportFromClipboard,
      icon: IconCopy
    }
  ]

  async function handleImportAction (event?: CustomEvent): Promise<void> {
    if (event == null || disabled || type === undefined) return
    const actionId = event.detail
    if (actionId === 'file') {
      fileInput?.click()
    } else if (actionId === 'clipboard') {
      try {
        if (typeof navigator?.clipboard?.readText !== 'function') {
          showPopup(
            ImportTaskTypePopup,
            {
              projectType: type,
              taskTypes
            },
            'center'
          )
          return
        }
        const text = await navigator.clipboard.readText()
        if (text.trim() === '') {
          showPopup(
            ImportTaskTypePopup,
            {
              projectType: type,
              taskTypes
            },
            'center'
          )
          return
        }
        let parsed: TaskTypeExportConfig | null = null
        try {
          const json = JSON.parse(text)
          if (json != null && typeof json === 'object' && Array.isArray(json.taskTypes) && json.taskTypes.length > 0) {
            parsed = json as TaskTypeExportConfig
          }
        } catch {
          parsed = null
        }
        showPopup(
          ImportTaskTypePopup,
          {
            projectType: type,
            taskTypes,
            initialText: text,
            initialConfig: parsed,
            initialFileName: parsed != null ? 'Clipboard' : ''
          },
          'center'
        )
      } catch {
        showPopup(
          ImportTaskTypePopup,
          {
            projectType: type,
            taskTypes
          },
          'center'
        )
      }
    }
  }

  async function handleFileInputChange (e: Event): Promise<void> {
    const target = e.target as HTMLInputElement
    const file = target?.files?.[0]
    if (file == null || disabled || type === undefined) return
    try {
      if (!file.name.toLowerCase().endsWith('.json')) {
        await setPlatformStatus(
          new Status(Severity.ERROR, task.status.InvalidFileType, {}, undefined, { timeout: 4000 })
        )
        return
      }

      const text = await file.text()
      let parsed: TaskTypeExportConfig
      try {
        parsed = JSON.parse(text) as TaskTypeExportConfig
      } catch {
        await setPlatformStatus(
          new Status(Severity.ERROR, task.status.InvalidTaskTypeFile, {}, undefined, { timeout: 4000 })
        )
        return
      }
      if (parsed.version == null || !Array.isArray(parsed.taskTypes) || parsed.taskTypes.length === 0) {
        await setPlatformStatus(
          new Status(Severity.ERROR, task.status.InvalidTaskTypeFile, {}, undefined, { timeout: 4000 })
        )
        return
      }
      showPopup(
        ImportTaskTypePopup,
        {
          projectType: type,
          taskTypes,
          initialConfig: parsed,
          initialFileName: file.name
        },
        'center'
      )
    } catch (err) {
      await setPlatformStatus(
        new Status(Severity.ERROR, task.status.InvalidTaskTypeFile, {}, undefined, { timeout: 4000 })
      )
    } finally {
      if (fileInput !== undefined) {
        fileInput.value = ''
      }
    }
  }

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
  <input type="file" accept=".json" bind:this={fileInput} style="display: none;" on:change={handleFileInputChange} />
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
      <ButtonMenu
        icon={task.icon.Import}
        tooltip={{ label: task.string.Import, direction: 'bottom' }}
        size="small"
        kind="tertiary"
        dataId={'btnImportTaskTypes'}
        {disabled}
        noSelection
        items={importActions}
        on:selected={handleImportAction}
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

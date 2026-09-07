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
  import { onDestroy } from 'svelte'
  import { Ref, SortingOrder } from '@hcengineering/core'
  import { Severity, Status as PlatformStatus, setPlatformStatus } from '@hcengineering/platform'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import { clearSettingsStore, settingsStore } from '@hcengineering/setting-resources'
  import task, { ProjectType, ProjectTypeDescriptor, TaskType } from '@hcengineering/task'
  import { taskTypeStore } from '@hcengineering/task-resources'
  import {
    ButtonIcon,
    ButtonMenu,
    type DropdownIntlItem,
    Icon,
    IconAdd,
    IconCopy,
    Label,
    showPopup
  } from '@hcengineering/ui'
  import type { Workflow, WorkflowConfig } from '@hcengineering/workflow'

  import { navigateToWorkflow } from '../location'
  import plugin from '../plugin'
  import CreateWorkflow from './CreateWorkflow.svelte'
  import ImportWorkflowPopup from './editor/ImportWorkflowPopup.svelte'
  import IconWorkflow from './icon/Workflow.svelte'

  export let type: ProjectType
  export let descriptor: ProjectTypeDescriptor | undefined = undefined
  export let disabled = true

  const client = getClient()
  const workflowsQuery = createQuery()

  let fileInput: HTMLInputElement | undefined
  let isWorkflowsLoading = true

  $: taskTypes = Array.from($taskTypeStore.values()).filter((tt) => tt.parent === type._id)

  let workflows: Workflow[] = []
  $: workflowsQuery.query(
    plugin.class.Workflow,
    { projectType: type._id },
    (res) => {
      workflows = res
      isWorkflowsLoading = false
    },
    { sort: { name: SortingOrder.Ascending } }
  )

  function getTaskTypeName (taskTypeId: Ref<TaskType>): string | undefined {
    return $taskTypeStore.get(taskTypeId)?.name
  }

  const importActions: DropdownIntlItem[] = [
    {
      id: 'file',
      label: plugin.string.ImportFromFile,
      icon: task.icon.Import
    },
    {
      id: 'clipboard',
      label: plugin.string.ImportFromClipboard,
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
            ImportWorkflowPopup,
            {
              projectType: type
            },
            'center'
          )
          return
        }
        const text = await navigator.clipboard.readText()
        if (text.trim() === '') {
          showPopup(
            ImportWorkflowPopup,
            {
              projectType: type
            },
            'center'
          )
          return
        }
        let parsed: WorkflowConfig | null = null
        try {
          const json = JSON.parse(text)
          if (json != null && typeof json === 'object' && Array.isArray(json.workflows) && json.workflows.length > 0) {
            parsed = json as WorkflowConfig
          }
        } catch {
          parsed = null
        }
        showPopup(
          ImportWorkflowPopup,
          {
            projectType: type,
            initialText: text,
            initialConfig: parsed,
            initialFileName: parsed != null ? 'Clipboard' : ''
          },
          'center'
        )
      } catch {
        showPopup(
          ImportWorkflowPopup,
          {
            projectType: type
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
          new PlatformStatus(Severity.ERROR, plugin.string.InvalidWorkflowFile, {}, undefined, { timeout: 4000 })
        )
        return
      }

      const text = await file.text()
      let parsed: WorkflowConfig
      try {
        parsed = JSON.parse(text) as WorkflowConfig
      } catch {
        await setPlatformStatus(
          new PlatformStatus(Severity.ERROR, plugin.string.InvalidWorkflowFile, {}, undefined, { timeout: 4000 })
        )
        return
      }
      if (parsed.version == null || !Array.isArray(parsed.workflows) || parsed.workflows.length === 0) {
        await setPlatformStatus(
          new PlatformStatus(Severity.ERROR, plugin.string.InvalidWorkflowFile, {}, undefined, { timeout: 4000 })
        )
        return
      }
      showPopup(
        ImportWorkflowPopup,
        {
          projectType: type,
          initialConfig: parsed,
          initialFileName: file.name
        },
        'center'
      )
    } catch (err) {
      await setPlatformStatus(
        new PlatformStatus(Severity.ERROR, plugin.string.InvalidWorkflowFile, {}, undefined, { timeout: 4000 })
      )
    } finally {
      if (fileInput !== undefined) {
        fileInput.value = ''
      }
    }
  }

  $: isLoading = isWorkflowsLoading
  $: addDisabled = disabled || taskTypes.length === 0

  onDestroy(() => {
    clearSettingsStore()
  })
</script>

<input type="file" accept=".json" bind:this={fileInput} style="display: none;" on:change={handleFileInputChange} />
<div class="hulyTableAttr-header font-medium-12">
  <Icon icon={plugin.icon.Workflows} size="small" />
  <span><Label label={plugin.string.Workflows} /></span>
  <div class="header-actions flex-row-center flex-gap-1">
    <ButtonMenu
      icon={task.icon.Import}
      tooltip={{ label: plugin.string.Import, direction: 'bottom' }}
      size="small"
      kind="tertiary"
      dataId="btnImportWorkflows"
      {disabled}
      noSelection
      items={importActions}
      on:selected={handleImportAction}
    />
    <ButtonIcon
      kind="primary"
      icon={IconAdd}
      size="small"
      dataId="btnAddWorkflow"
      disabled={addDisabled}
      loading={isLoading}
      tooltip={taskTypes.length === 0 ? { label: plugin.string.TaskTypeRequired } : undefined}
      on:click={() => {
        if (disabled) return
        if ($settingsStore.id !== 'createWorkflow') {
          clearSettingsStore()
        }
        $settingsStore = { id: 'createWorkflow', component: CreateWorkflow, props: { type, taskTypes } }
      }}
    />
  </div>
</div>

{#if workflows.length > 0 && !isLoading}
  <div class="hulyTableAttr-content workflow">
    {#each workflows as workflow (workflow._id)}
      {@const taskTypeName = getTaskTypeName(workflow.taskType)}
      <button
        type="button"
        class="hulyTableAttr-content__row"
        data-id="workflow-row"
        data-workflow-name={workflow.name}
        on:click|stopPropagation={() => {
          navigateToWorkflow(workflow._id)
        }}
      >
        <span class="hulyTableAttr-content__row-icon-wrapper">
          <IconWorkflow size="small" />
        </span>
        <span class="hulyTableAttr-content__row-label font-medium-14" title={workflow.name}>
          {workflow.name}
        </span>
        <span class="type-label">
          {#if taskTypeName}
            {taskTypeName}
          {:else}
            <Label label={plugin.string.UnknownTaskType} />
          {/if}
        </span>
      </button>
    {/each}
  </div>
{/if}

<style lang="scss">
  .header-actions {
    margin-left: auto;
  }

  .hulyTableAttr-content__row {
    width: 100%;
    justify-content: flex-start;
    align-items: center;
    text-align: left;
  }

  .type-label {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1rem;
    letter-spacing: 0.01em;
    padding: 0.1875rem 0.5rem;
    border-radius: 0.25rem;
    background-color: var(--text-editor-selected-node-background, rgba(76, 56, 189, 0.12));
    color: var(--primary-color-purple-02, #6452db);
    white-space: nowrap;
    margin-left: 0.5rem;
  }
</style>

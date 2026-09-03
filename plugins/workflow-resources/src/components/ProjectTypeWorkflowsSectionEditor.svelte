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
  import { createQuery } from '@hcengineering/presentation'
  import { clearSettingsStore, settingsStore } from '@hcengineering/setting-resources'
  import { ProjectType, ProjectTypeDescriptor, TaskType } from '@hcengineering/task'
  import { taskTypeStore } from '@hcengineering/task-resources'
  import { ButtonIcon, Icon, IconAdd, Label } from '@hcengineering/ui'
  import { Workflow } from '@hcengineering/workflow'

  import { navigateToWorkflow } from '../location'
  import plugin from '../plugin'
  import CreateWorkflow from './CreateWorkflow.svelte'
  import IconWorkflow from './icon/Workflow.svelte'

  export let type: ProjectType
  export let descriptor: ProjectTypeDescriptor | undefined = undefined
  export let disabled = true

  const workflowsQuery = createQuery()

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

  $: isLoading = isWorkflowsLoading
  $: addDisabled = disabled || taskTypes.length === 0

  onDestroy(() => {
    clearSettingsStore()
  })
</script>

<div class="hulyTableAttr-header font-medium-12">
  <Icon icon={plugin.icon.Workflows} size="small" />
  <span><Label label={plugin.string.Workflows} /></span>
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

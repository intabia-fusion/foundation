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
  import { Doc, notEmpty, Ref, Status } from '@hcengineering/core'
  import { getClient, IconWithEmoji } from '@hcengineering/presentation'
  import { TaskType } from '@hcengineering/task'
  import { taskTypeStore, typeStore } from '@hcengineering/task-resources'
  import {
    ButtonIcon,
    DropdownTextItem,
    IconClose,
    IconMaximize,
    IconMinimize,
    Modal,
    ModernDropdownLabels
  } from '@hcengineering/ui'
  import { statusStore } from '@hcengineering/view-resources'
  import tracker, { type Project } from '@hcengineering/tracker'
  import workflowPlugin, { ProjectWorkflow, Workflow, WorkflowTransition } from '@hcengineering/workflow'
  import view from '@hcengineering/view'

  import WorkflowDiagram from './WorkflowDiagram.svelte'

  export let space: Ref<Project> | undefined = undefined
  export let workflow: Workflow | undefined = undefined
  export let statuses: Status[] = []
  export let transitions: WorkflowTransition[] = []
  export let workflowsMap: Record<Ref<TaskType>, Ref<Workflow>> | undefined = undefined
  export let selectedTaskType: Ref<TaskType> | undefined = undefined
  export let fullSize = true

  const client = getClient()
  const hierarchy = client.getHierarchy()

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  const dispatch = createEventDispatcher<{ close: void, fullsize: boolean }>()

  let currentTaskTypeId: Ref<TaskType> | undefined = selectedTaskType
  let currentWorkflow: Workflow | undefined = workflow
  let currentTransitions: WorkflowTransition[] = transitions
  let currentStatuses: Status[] = statuses

  let availableTaskTypeIds: Ref<TaskType>[] = []
  let taskTypeWorkflowMap: Record<Ref<TaskType>, Ref<Workflow>> = {}

  let initSequence = 0
  let loadSequence = 0

  function handleClose (): void {
    dispatch('close')
  }

  function handleToggleFullSize (): void {
    fullSize = !fullSize
    dispatch('fullsize', fullSize)
  }

  function handleTaskTypeChange (newId: DropdownTextItem['id'] | DropdownTextItem['id'][] | undefined | null): void {
    const rawId = Array.isArray(newId) ? newId[0] : newId
    if (rawId != null) {
      currentTaskTypeId = String(rawId) as Ref<TaskType>
    }
  }

  async function initializeProjectWorkflows (): Promise<void> {
    const seq = ++initSequence
    let initialMap: Record<Ref<TaskType>, Ref<Workflow>> = { ...(workflowsMap ?? {}) }

    if (space != null) {
      const projectDoc = await client.findOne(tracker.class.Project, { _id: space })
      if (seq !== initSequence) return

      if (projectDoc != null && hierarchy.hasMixin(projectDoc, workflowPlugin.mixin.ProjectWorkflow)) {
        const projectWf = hierarchy.as<Doc, ProjectWorkflow>(projectDoc, workflowPlugin.mixin.ProjectWorkflow)
        if (projectWf?.workflows) {
          initialMap = { ...initialMap, ...projectWf.workflows }
        }
      }
    }

    if (seq !== initSequence) return

    const resolvedMap: Record<Ref<TaskType>, Ref<Workflow>> = {}
    for (const [ttId, wfId] of Object.entries(initialMap)) {
      if (wfId != null) {
        resolvedMap[ttId as Ref<TaskType>] = wfId
      }
    }

    taskTypeWorkflowMap = resolvedMap
    availableTaskTypeIds = Object.keys(resolvedMap) as Ref<TaskType>[]

    if (availableTaskTypeIds.length > 0) {
      if (selectedTaskType != null && resolvedMap[selectedTaskType] != null) {
        currentTaskTypeId = selectedTaskType
      } else if (currentTaskTypeId == null || !availableTaskTypeIds.includes(currentTaskTypeId)) {
        currentTaskTypeId = availableTaskTypeIds[0]
      }
    } else {
      currentTaskTypeId = undefined
      currentWorkflow = undefined
      currentStatuses = []
      currentTransitions = []
    }
  }

  async function loadWorkflow (wfId: Ref<Workflow>, taskTypeId?: Ref<TaskType>): Promise<void> {
    const seq = ++loadSequence
    const wfDoc = await client.findOne<Workflow>(
      workflowPlugin.class.Workflow,
      { _id: wfId },
      {
        lookup: {
          _id: { transitions: workflowPlugin.class.WorkflowTransition }
        }
      }
    )

    if (seq !== loadSequence || wfDoc == null) return

    currentWorkflow = wfDoc
    currentTransitions = (wfDoc.$lookup?.transitions ?? []) as WorkflowTransition[]

    const effectiveTaskTypeId = taskTypeId ?? currentTaskTypeId
    const taskType = effectiveTaskTypeId != null ? $taskTypeStore.get(effectiveTaskTypeId) : undefined

    if (taskType?.statuses && taskType.statuses.length > 0) {
      currentStatuses = taskType.statuses.map((sId) => $statusStore.byId.get(sId)).filter((s): s is Status => s != null)
    } else {
      const projectType = $typeStore.get(wfDoc.projectType)
      currentStatuses =
        projectType?.statuses?.map((s) => $statusStore.byId.get(s._id)).filter((s): s is Status => s != null) ?? []
    }
  }

  $: if (space != null || workflowsMap != null) {
    void initializeProjectWorkflows()
  }

  $: dropdownItems = availableTaskTypeIds
    .map<DropdownTextItem | null>((id) => {
    const taskType = $taskTypeStore.get(id)
    if (taskType == null) return null
    return {
      id,
      label: taskType.name,
      icon: taskType.icon === view.ids.IconWithEmoji ? IconWithEmoji : taskType.icon,
      iconProps: taskType.icon === view.ids.IconWithEmoji ? { icon: taskType.color } : {}
    }
  })
    .filter(notEmpty)

  $: if (currentTaskTypeId != null) {
    const wfId = taskTypeWorkflowMap[currentTaskTypeId] ?? (workflowsMap ? workflowsMap[currentTaskTypeId] : undefined)
    if (wfId != null) {
      void loadWorkflow(wfId, currentTaskTypeId)
    } else {
      currentWorkflow = undefined
      currentTransitions = []
      currentStatuses = []
    }
  } else if (workflow != null) {
    currentWorkflow = workflow
    currentTransitions = transitions
    currentStatuses = statuses
  }
</script>

<Modal type="type-component" scrollableContent={false} on:fullsize on:close>
  <svelte:fragment slot="beforeTitle">
    <ButtonIcon icon={IconClose} kind="tertiary" size="small" noPrint on:click={handleClose} />
    <div class="hulyHeader-divider short no-line no-print" />
    <ButtonIcon
      icon={!fullSize ? IconMaximize : IconMinimize}
      kind="tertiary"
      size="small"
      noPrint
      on:click={handleToggleFullSize}
    />
    <div class="hulyHeader-divider short no-print" />
    {#if dropdownItems.length > 0}
      <div class="task-type-selector-wrapper ml-2">
        <ModernDropdownLabels
          items={dropdownItems}
          selected={currentTaskTypeId ?? ''}
          kind="secondary"
          size="medium"
          showDropdownIcon={dropdownItems.length > 1}
          disabled={dropdownItems.length <= 1}
          on:selected={(evt) => {
            handleTaskTypeChange(evt.detail)
          }}
        />
      </div>
    {/if}
  </svelte:fragment>

  {#if currentWorkflow != null}
    <WorkflowDiagram workflow={currentWorkflow} statuses={currentStatuses} transitions={currentTransitions} />
  {/if}
</Modal>

<style lang="scss">
  .task-type-selector-wrapper {
    display: flex;
    align-items: center;

    :global(.modern-dropdown-labels-container) {
      min-width: 8rem;
    }
  }
</style>

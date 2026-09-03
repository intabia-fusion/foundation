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
  import { AttachedData, Ref, WithLookup } from '@hcengineering/core'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import { getTaskTypeStates } from '@hcengineering/task'
  import { taskTypeStore } from '@hcengineering/task-resources'
  import { Issue, IssueDraft, IssueStatus, Project, TrackerEvents } from '@hcengineering/tracker'
  import {
    Button,
    ButtonKind,
    ButtonSize,
    IconSize,
    SelectPopup,
    TooltipAlignment,
    eventToHTMLElement,
    showPopup
  } from '@hcengineering/ui'
  import { statusStore } from '@hcengineering/view-resources'
  import { Analytics } from '@hcengineering/analytics'
  import { createEventDispatcher } from 'svelte'
  import workflow, { ProjectWorkflow, Workflow, WorkflowTransition } from '@hcengineering/workflow'
  import { isInfoError, isOkError } from '@hcengineering/platform'

  import tracker from '../../plugin'
  import { activeProjects } from '../../utils'
  import IssueStatusIcon from './IssueStatusIcon.svelte'
  import StatusPresenter from './StatusPresenter.svelte'

  type ValueType = Issue | (AttachedData<Issue> & { space: Ref<Project> }) | IssueDraft

  export let value: ValueType

  let statuses: WithLookup<IssueStatus>[] | undefined = undefined

  export let isEditable: boolean = true
  export let shouldShowLabel: boolean = false
  export let tooltipAlignment: TooltipAlignment | undefined = undefined

  export let kind: ButtonKind = 'link'
  export let size: ButtonSize = 'large'
  export let iconSize: IconSize = 'inline'
  export let justify: 'left' | 'center' = 'left'
  export let width: string | undefined = undefined
  export let defaultIssueStatus: Ref<IssueStatus> | undefined = undefined
  export let focusIndex: number | undefined = undefined
  export let short: boolean = false
  export let isCreate: boolean = false

  const client = getClient()
  const dispatch = createEventDispatcher()

  const changeStatus = async (newStatus: Ref<IssueStatus> | undefined, refocus: boolean = true) => {
    if (!isEditable || newStatus == null || value.status === newStatus) {
      return
    }

    dispatch('change', newStatus)
    if (refocus) {
      dispatch('refocus')
    }

    if ('_class' in value) {
      try {
        await client.update(value, { status: newStatus })
        Analytics.handleEvent(TrackerEvents.IssueSetStatus, {
          issue: value.identifier,
          status: newStatus
        })
      } catch (e) {
        if (!isInfoError(e) && !isOkError(e)) {
          throw e
        }
      }
    }
  }

  const handleStatusEditorOpened = (event: MouseEvent) => {
    if (!isEditable) {
      return
    }

    showPopup(
      SelectPopup,
      { value: statusesInfo, placeholder: tracker.string.SetStatus },
      eventToHTMLElement(event),
      changeStatus
    )
  }

  const workflowQuery = createQuery()

  let currentWorkflow: Workflow | undefined = undefined
  let transitions: WorkflowTransition[] = []

  const h = client.getHierarchy()
  $: project = value?.space ? ($activeProjects.get(value.space) as ProjectWorkflow | undefined) : undefined
  $: workflowId =
    project && value?.kind ? h.as(project, workflow.mixin.ProjectWorkflow).workflows?.[value.kind] : undefined

  $: if (workflowId != null) {
    workflowQuery.query(
      workflow.class.Workflow,
      { _id: workflowId },
      (res) => {
        currentWorkflow = res[0]
        transitions = (res[0]?.$lookup?.transitions ?? []) as WorkflowTransition[]
      },
      {
        lookup: {
          _id: { transitions: workflow.class.WorkflowTransition }
        }
      }
    )
  } else {
    currentWorkflow = undefined
    transitions = []
  }

  $: allStatuses = getTaskTypeStates(value.kind, $taskTypeStore, $statusStore.byId) as
    | WithLookup<IssueStatus>[]
    | undefined

  function filterStatusesByWorkflow (
    all: WithLookup<IssueStatus>[] | undefined,
    wfId: Ref<any> | undefined,
    wf: Workflow | undefined,
    transitions: WorkflowTransition[],
    currentStatus: Ref<IssueStatus> | undefined,
    isCreate: boolean
  ): WithLookup<IssueStatus>[] | undefined {
    if (all == null) return undefined
    if (wfId == null) return all

    if (isCreate) {
      if (wf?.initialStatuses != null && wf.initialStatuses.length > 0) {
        return all.filter((s) => wf.initialStatuses?.includes(s._id))
      }
      return all
    }

    const allowed = new Set<string>()

    if (currentStatus != null) {
      allowed.add(currentStatus)
    }

    for (const t of transitions) {
      if (t.from == null || t.from.length === 0 || (currentStatus != null && t.from.includes(currentStatus))) {
        allowed.add(t.to)
      }
    }

    if (allowed.size === 0) {
      return all
    }

    return all.filter((s) => allowed.has(s._id))
  }

  $: statuses = filterStatusesByWorkflow(allStatuses, workflowId, currentWorkflow, transitions, value?.status, isCreate)

  function getSelectedStatus (
    statuses: WithLookup<IssueStatus>[] | undefined,
    value: ValueType,
    defaultStatus: Ref<IssueStatus> | undefined
  ): WithLookup<IssueStatus> | undefined {
    if (value.status !== undefined) {
      const current = statuses?.find((status) => status._id === value.status)
      if (current != null) {
        return current
      }
    }

    if (defaultIssueStatus !== undefined) {
      const res = statuses?.find((status) => status._id === defaultStatus)
      // Might not exist for projects with multiple task types with different statuses
      if (res != null) {
        void changeStatus(res?._id, false)
        return res
      }
    }

    // We need to choose first one, since it should not be case without status.
    void changeStatus(statuses?.[0]?._id, false)
  }

  $: selectedStatus = getSelectedStatus(statuses, value, defaultIssueStatus)
  $: selectedStatusLabel = shouldShowLabel ? selectedStatus?.name : undefined
  $: statusesInfo = statuses?.map((s) => {
    return {
      id: s._id,
      component: StatusPresenter,
      props: { value: s, size: 'small', space: value.space },
      isSelected: selectedStatus?._id === s._id
    }
  })
  $: smallgap = size === 'inline' || size === 'small'
</script>

{#if value && statuses}
  {#if kind === 'list' || kind === 'list-header'}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class="flex-row-center flex-no-shrink"
      class:fix-margin={kind === 'list'}
      class:cursor-pointer={isEditable}
      on:click={handleStatusEditorOpened}
    >
      <div class="flex-center flex-no-shrink square-4">
        {#if selectedStatus}<IssueStatusIcon
            value={selectedStatus}
            taskType={value.kind}
            size={kind === 'list' ? 'small' : 'medium'}
            space={value.space}
          />{/if}
      </div>
      {#if selectedStatusLabel}
        <span
          class="{kind === 'list' ? 'ml-1 text-md' : 'ml-2 text-base'} overflow-label disabled content-color"
          class:max-w-20={short}
        >
          {selectedStatusLabel}
        </span>
      {/if}
    </div>
  {:else}
    <Button
      showTooltip={isEditable ? { label: tracker.string.SetStatus, direction: tooltipAlignment } : undefined}
      disabled={!isEditable}
      {justify}
      {size}
      {kind}
      {width}
      {focusIndex}
      {short}
      on:click={handleStatusEditorOpened}
    >
      <svelte:fragment slot="icon">
        {#if selectedStatus}
          <IssueStatusIcon value={selectedStatus} taskType={value.kind} size={iconSize} space={value.space} />
        {/if}
      </svelte:fragment>
      <svelte:fragment slot="content">
        {#if selectedStatusLabel}
          <span
            class="overflow-label disabled"
            class:ml-1-5={selectedStatus && smallgap}
            class:ml-2={selectedStatus && !smallgap}
          >
            {selectedStatusLabel}
          </span>
        {/if}
      </svelte:fragment>
    </Button>
  {/if}
{/if}

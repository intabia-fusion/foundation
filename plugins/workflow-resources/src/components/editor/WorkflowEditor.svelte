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
  import { onDestroy, onMount } from 'svelte'
  import core, { notEmpty, Ref, Status, WithLookup } from '@hcengineering/core'
  import { Asset, Severity, Status as PlatformStatus, setPlatformStatus } from '@hcengineering/platform'
  import {
    copyTextToClipboard,
    createQuery,
    getClient,
    getCurrentWorkspaceUuid,
    MessageBox
  } from '@hcengineering/presentation'
  import { clearSettingsStore } from '@hcengineering/setting-resources'
  import task, { ProjectType, TaskType } from '@hcengineering/task'
  import { taskTypeStore } from '@hcengineering/task-resources'
  import {
    ButtonIcon,
    ButtonMenu,
    type DropdownIntlItem,
    EditBox,
    IconCopy,
    IconDelete,
    IconEdit,
    IconShare,
    IconTableOfContents,
    Loading,
    Modal,
    Scroller,
    showPopup,
    Switcher,
    TabItem
  } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { exportWorkflow, removeWorkflow, type Workflow, type WorkflowTransition } from '@hcengineering/workflow'

  import { navigateToWorkflow } from '../../location'
  import plugin from '../../plugin'
  import InitialStatusesEditor from './InitialStatusesEditor.svelte'
  import TaskTypeEditor from './TaskTypeEditor.svelte'
  import TransitionsEditor from './TransitionsEditor.svelte'
  import WorkflowDiagram from './WorkflowDiagram.svelte'
  import WorkflowUsedProjects from './WorkflowUsedProjects.svelte'

  export let spaceType: ProjectType
  export let objectId: Ref<Workflow>
  export let name: string | undefined = undefined
  export let icon: Asset | undefined = undefined
  export let readonly = false

  const client = getClient()

  type WorkflowViewMode = 'editor' | 'diagram' | 'split'

  let userViewMode: WorkflowViewMode = 'editor'
  let isNarrowScreen = false

  $: effectiveViewMode = isNarrowScreen && userViewMode === 'split' ? 'editor' : userViewMode

  function updateScreenSize (): void {
    if (typeof window !== 'undefined') {
      isNarrowScreen = window.innerWidth < 1100
    }
  }

  onMount(() => {
    updateScreenSize()
    window.addEventListener('resize', updateScreenSize)
    return () => {
      window.removeEventListener('resize', updateScreenSize)
    }
  })

  onDestroy(() => {
    clearSettingsStore()
  })

  const viewModeItems: TabItem[] = [
    { id: 'editor', icon: plugin.icon.Editor },
    { id: 'diagram', icon: plugin.icon.Chart },
    { id: 'split', icon: IconTableOfContents }
  ]

  const workflowQuery = createQuery()
  const statusesQuery = createQuery()

  // Load selected workflow with transitions lookup
  let workflow: WithLookup<Workflow> | undefined

  let isWorkflowLoading = true
  let isStatusesLoading = true

  $: workflowQuery.query(
    plugin.class.Workflow,
    { _id: objectId },
    (res) => {
      workflow = res.shift()
      isWorkflowLoading = false
    },
    {
      lookup: {
        _id: { transitions: plugin.class.WorkflowTransition }
      }
    }
  )

  $: taskType = workflow?.taskType != null ? $taskTypeStore.get(workflow.taskType) : undefined

  $: name = workflow?.name
  $: icon = plugin.icon.Workflow

  // Load TaskTypes for spaceType from reactive store
  $: taskTypes = Array.from($taskTypeStore.values()).filter((tt) => spaceType.tasks?.includes(tt._id))

  // Load Statuses for the selected workflow's task type
  let statuses: Status[] = []
  $: if (taskType !== undefined) {
    statusesQuery.query(core.class.Status, { _id: { $in: taskType.statuses } }, (res) => {
      statuses = res
      isStatusesLoading = false
    })
  } else if (!isWorkflowLoading) {
    isStatusesLoading = false
  }

  let transitions: WorkflowTransition[] = []
  $: transitions = (workflow?.$lookup?.transitions ?? []) as WorkflowTransition[]

  async function saveName (): Promise<void> {
    if (workflow !== undefined) {
      await client.update(workflow, { name: workflow.name.trim() })
    }
  }

  let isDeleteLoading = false

  async function handleRemove (): Promise<void> {
    if (isDeleteLoading) return
    isDeleteLoading = true
    try {
      const allProjects = await client.findAll(plugin.mixin.ProjectWorkflow, {})
      const usedProjects = allProjects.filter((p) => Object.values(p.workflows ?? {}).includes(objectId))

      showPopup(MessageBox, {
        label: plugin.string.DeleteWorkflow,
        message: plugin.string.DeleteWorkflowConfirm,
        component: usedProjects.length > 0 ? WorkflowUsedProjects : undefined,
        componentProps: { projects: usedProjects },
        dangerous: true,
        action: async () => {
          await removeWorkflow(client, objectId)
          navigateToWorkflow(undefined)
        }
      })
    } finally {
      isDeleteLoading = false
    }
  }

  async function handleTaskTypeChange (evt: CustomEvent<Ref<TaskType>>): Promise<void> {
    if (workflow === undefined) return

    // TODO: implement
    console.log('TODO: change task type', evt.detail)
  }

  function handleViewModeSelect (evt: CustomEvent<TabItem>): void {
    if (evt.detail?.id != null) {
      userViewMode = evt.detail.id as WorkflowViewMode
    }
  }

  const exportActions: DropdownIntlItem[] = [
    {
      id: 'file',
      label: plugin.string.ExportToFile,
      icon: task.icon.Export
    },
    {
      id: 'clipboard',
      label: plugin.string.CopyToClipboard,
      icon: IconCopy
    }
  ]

  async function handleExportAction (event?: CustomEvent): Promise<void> {
    if (event == null || workflow == null) return
    const actionId = event.detail
    if (actionId === 'file') {
      try {
        const config = await exportWorkflow(client, workflow._id, {
          workspace: getCurrentWorkspaceUuid(),
          projectTypeId: spaceType._id
        })
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${workflow.name}.workflow.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      } catch (err) {
        console.error('Failed to export workflow', err)
        await setPlatformStatus(
          new PlatformStatus(Severity.ERROR, plugin.string.InvalidWorkflowFile, {}, undefined, { timeout: 5000 })
        )
      }
    } else if (actionId === 'clipboard') {
      try {
        const config = await exportWorkflow(client, workflow._id, {
          workspace: getCurrentWorkspaceUuid(),
          projectTypeId: spaceType._id
        })
        await copyTextToClipboard(JSON.stringify(config, null, 2))
        await setPlatformStatus(
          new PlatformStatus(Severity.INFO, plugin.string.CopiedToClipboard, {}, undefined, { timeout: 3000 })
        )
      } catch (err) {
        console.error('Failed to copy workflow to clipboard', err)
        await setPlatformStatus(
          new PlatformStatus(Severity.ERROR, plugin.string.ClipboardReadError, {}, undefined, { timeout: 5000 })
        )
      }
    }
  }

  $: loading = isWorkflowLoading || isStatusesLoading
</script>

<div class="workflow-editor-root hulyComponent-content__container columns">
  <div class="hulyComponent-content__column content">
    {#if loading}
      <Loading />
    {:else if workflow != null}
      <Scroller
        align={effectiveViewMode === 'split' ? 'stretch' : 'center'}
        padding="var(--spacing-3)"
        bottomPadding="var(--spacing-3)"
      >
        <div
          class="hulyComponent-content gap"
          class:split-container={effectiveViewMode === 'split'}
          class:withoutMaxWidth={effectiveViewMode === 'split'}
        >
          <div class="header flex-between flex-wrap">
            <div class="flex-grow min-w-0">
              <EditBox
                bind:value={workflow.name}
                kind="modern-ghost-large"
                on:change={saveName}
                required
                fullSize
                placeholder={plugin.string.Untitled}
              />
            </div>
            <div class="flex-row-center flex-gap-2">
              {#if taskType != null}
                <TaskTypeEditor
                  selected={taskType?._id}
                  types={taskTypes.length > 0 ? taskTypes : [taskType].filter(notEmpty)}
                  readonly
                  on:change={handleTaskTypeChange}
                />
              {/if}
              <Switcher
                items={viewModeItems}
                selected={userViewMode}
                kind="subtle"
                name="workflowViewMode"
                onlyIcons={true}
                on:select={handleViewModeSelect}
              />
              <ButtonMenu
                icon={task.icon.Export}
                dataId="btnExportWorkflow"
                tooltip={{ label: plugin.string.Export, direction: 'bottom' }}
                size="small"
                kind="secondary"
                noSelection
                items={exportActions}
                on:selected={handleExportAction}
              />
              <ButtonIcon
                icon={IconDelete}
                dataId="btnDeleteWorkflow"
                tooltip={{ label: view.string.Delete, direction: 'bottom' }}
                size="small"
                kind="secondary"
                loading={isDeleteLoading}
                disabled={isDeleteLoading}
                on:click={handleRemove}
              />
            </div>
          </div>
          {#if taskType != null}
            {#if effectiveViewMode === 'editor'}
              <div class="hulyComponent-content flex-col-center flex-gap-4">
                <InitialStatusesEditor {readonly} {workflow} {statuses} />
                <TransitionsEditor {readonly} {workflow} {transitions} {statuses} {taskType} />
              </div>
            {:else if effectiveViewMode === 'diagram'}
              <div class="hulyComponent-content embedded-diagram">
                <WorkflowDiagram {workflow} {statuses} {transitions} embedded />
              </div>
            {:else if effectiveViewMode === 'split'}
              <div class="hulyComponent-content split-layout withoutMaxWidth">
                <div class="split-column left">
                  <InitialStatusesEditor {readonly} {workflow} {statuses} />
                  <TransitionsEditor {readonly} {workflow} {transitions} {statuses} {taskType} />
                </div>
                <div class="split-divider" />
                <div class="split-column right">
                  <WorkflowDiagram {workflow} {statuses} {transitions} embedded />
                </div>
              </div>
            {/if}
          {/if}
        </div>
      </Scroller>
    {/if}
  </div>
</div>

<style lang="scss">
  .workflow-editor-root {
    &.hulyComponent-content__container {
      max-width: 100% !important;
      width: 100% !important;
    }

    :global(.hulyComponent-content.split-container) {
      max-width: 100% !important;
      width: 100% !important;
    }

    :global(.hulyComponent-content__column) {
      max-width: 100% !important;
      width: 100% !important;
    }
  }

  .header {
    :global(.antiEditBox) {
      margin-left: -1rem;
    }
  }

  .embedded-diagram {
    width: 100%;
    height: calc(100vh - 12rem);
    max-height: calc(100vh - 12rem);
  }

  .split-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 0.0625rem minmax(0, 1fr);
    gap: var(--spacing-4, 1rem);
    width: 100% !important;
    max-width: 100% !important;
    align-items: stretch;

    .split-divider {
      width: 1px;
      height: 100%;
      background: var(--theme-border-color, rgba(0, 0, 0, 0.08));
      align-self: stretch;
    }

    .split-column {
      min-width: 0;

      &.left {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-4, 1rem);
        min-width: 0;
      }

      &.right {
        position: sticky;
        top: 0;
        height: calc(100vh - 12rem);
        max-height: calc(100vh - 12rem);
        min-height: 0;
        min-width: 0;
      }
    }
  }
</style>

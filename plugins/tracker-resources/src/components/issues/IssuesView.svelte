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
  import { Doc, DocumentQuery, Ref, Space, WithLookup } from '@hcengineering/core'
  import { Asset, IntlString, translateCB } from '@hcengineering/platform'
  import { ComponentExtensions, getClient } from '@hcengineering/presentation'
  import { Issue, Project, TrackerEvents } from '@hcengineering/tracker'
  import { ButtonMenu, type DropdownIntlItem, IconMoreH, IModeSelector, showPopup, themeStore } from '@hcengineering/ui'
  import view, { ViewOptions, Viewlet } from '@hcengineering/view'
  import {
    FilterBar,
    selectionStore,
    setViewOptions,
    SpaceHeader,
    ViewletContentView,
    ViewletSettingButton
  } from '@hcengineering/view-resources'
  import task, { type Project as TaskProject } from '@hcengineering/task'
  import { TaskTypeDiagramPopup, taskTypeStore } from '@hcengineering/task-resources'
  import workflow, { ProjectWorkflow } from '@hcengineering/workflow'

  import tracker from '../../plugin'
  import CreateIssue from '../CreateIssue.svelte'
  import { activeProjects, exportIssuesToCSV } from '../../utils'
  import IssueStatistics from '../milestones/IssueStatistics.svelte'

  export let space: Ref<Space> | undefined = undefined
  export let query: DocumentQuery<Issue> = {}
  export let title: IntlString | undefined = undefined
  export let label: string = ''
  export let icon: Asset | undefined = undefined
  export let modeSelectorProps: IModeSelector | undefined = undefined

  export let viewlet: WithLookup<Viewlet> | undefined = undefined
  const viewlets: WithLookup<Viewlet>[] | undefined = undefined
  let viewOptions: ViewOptions | undefined

  let search = ''
  let searchQuery: DocumentQuery<Issue> = { ...query }
  function updateSearchQuery (search: string): void {
    searchQuery = search === '' ? { ...query } : { ...query, $search: search }
  }
  $: if (query) updateSearchQuery(search)
  let resultQuery: DocumentQuery<Issue> = { ...searchQuery }

  $: if (title) {
    translateCB(title, {}, $themeStore.language, (res) => {
      label = res
    })
  }

  const client = getClient()
  const hierarchy = client.getHierarchy()
  $: currentProject = space ? ($activeProjects.get(space as Ref<Project>) as ProjectWorkflow | undefined) : undefined
  $: workflowsMap =
    currentProject && hierarchy.hasMixin(currentProject, workflow.mixin.ProjectWorkflow)
      ? hierarchy.as<TaskProject, ProjectWorkflow>(currentProject, workflow.mixin.ProjectWorkflow).workflows
      : undefined
  $: hasWorkflow = workflowsMap != null && Object.keys(workflowsMap).length > 0
  $: currentTaskTypes = currentProject?.type
    ? Array.from($taskTypeStore.values()).filter((t) => t.parent === currentProject.type)
    : []
  $: hasTaskTypes = currentTaskTypes.length > 0

  const WORKFLOW_ITEM_ID = 'workflow'
  const TASK_TYPES_ITEM_ID = 'task-types'
  const EXPORT_CSV_ITEM_ID = 'export-scv'

  $: menuItems = [
    ...(hasWorkflow
      ? [
          {
            id: WORKFLOW_ITEM_ID,
            label: workflow.string.WorkflowScheme,
            icon: workflow.icon.Workflow
          }
        ]
      : []),
    ...(hasTaskTypes
      ? [
          {
            id: TASK_TYPES_ITEM_ID,
            label: task.string.TaskTypesDiagram,
            icon: task.icon.TypeHierarchy
          }
        ]
      : []),
    ...[
      {
        id: EXPORT_CSV_ITEM_ID,
        label: tracker.string.ExportToCSV,
        icon: tracker.icon.Export
      }
    ]
  ] satisfies DropdownIntlItem[]

  function openWorkflowDiagram (): void {
    if (workflowsMap == null) return
    showPopup(
      workflow.component.WorkflowDiagramPopup,
      {
        space,
        workflowsMap,
        fullSize: false
      },
      'centered'
    )
  }

  function openTaskTypeDiagram (): void {
    if (currentTaskTypes.length === 0) return
    showPopup(
      TaskTypeDiagramPopup,
      {
        taskTypes: currentTaskTypes,
        fullSize: false
      },
      'centered'
    )
  }

  function handleMenuSelected (event?: CustomEvent<string>): void {
    const action = event?.detail
    if (action === WORKFLOW_ITEM_ID) {
      openWorkflowDiagram()
    } else if (action === TASK_TYPES_ITEM_ID) {
      openTaskTypeDiagram()
    } else if (action === EXPORT_CSV_ITEM_ID) {
      void exportIssuesToCSV(resultQuery)
    }
  }

  // Prevent groupBy and swimLaneBy from being the same field.
  $: if (viewlet != null && viewOptions != null) {
    const groupBy = (viewOptions.groupBy ?? [])[0]
    const swimLaneBy = (viewOptions as any).swimLaneBy as string | undefined
    if (swimLaneBy != null && swimLaneBy !== 'none' && groupBy === swimLaneBy) {
      const fixed = { ...(viewOptions as any), swimLaneBy: 'none' }
      setViewOptions(viewlet, fixed)
      viewOptions = fixed
    }
  }

  function filterIssues (docs: Doc[]): Issue[] {
    const h = getClient().getHierarchy()
    return (docs ?? []).filter(
      (it) =>
        h.isDerived(it._class, tracker.class.Issue) &&
        (it as Issue).estimation != null &&
        (it as Issue).reportedTime != null &&
        (it as Issue).remainingTime != null
    ) as Issue[]
  }
</script>

<SpaceHeader
  _class={tracker.class.Issue}
  {icon}
  bind:viewlet
  bind:search
  showLabelSelector={$$slots.label_selector}
  viewletQuery={{ attachTo: tracker.class.Issue, variant: { $exists: false } }}
  {viewlets}
  {label}
  {space}
  {resultQuery}
  {modeSelectorProps}
>
  <svelte:fragment slot="header-tools">
    <ViewletSettingButton bind:viewOptions bind:viewlet />
  </svelte:fragment>

  <svelte:fragment slot="label_selector">
    <slot name="label_selector" />
  </svelte:fragment>

  <svelte:fragment slot="type_selector">
    <slot name="type_selector" {viewlet} />
  </svelte:fragment>

  <svelte:fragment slot="actions">
    {#if menuItems.length > 0}
      <ButtonMenu
        icon={IconMoreH}
        kind="secondary"
        size="small"
        noSelection
        tooltip={{ label: view.string.MoreActions }}
        items={menuItems}
        on:selected={handleMenuSelected}
      />
    {/if}
    <ComponentExtensions
      extension={tracker.extensions.IssueListHeader}
      props={{ size: 'small', kind: 'tertiary', space }}
    />
  </svelte:fragment>
  <svelte:fragment slot="extra">
    {#if $selectionStore.docs.length > 0}
      {@const issues = filterIssues($selectionStore.docs)}
      {#if issues.length > 0}
        <IssueStatistics docs={issues} itemsProj={issues} />
      {/if}
    {/if}
  </svelte:fragment>
</SpaceHeader>
<FilterBar
  _class={tracker.class.Issue}
  {space}
  query={searchQuery}
  {viewOptions}
  on:change={(e) => (resultQuery = e.detail)}
/>
<slot name="afterHeader" />
{#if viewlet !== undefined && viewOptions !== undefined}
  <ViewletContentView
    _class={tracker.class.Issue}
    {viewlet}
    query={resultQuery}
    {space}
    {viewOptions}
    createItemDialog={CreateIssue}
    createItemLabel={tracker.string.AddIssueTooltip}
    createItemEvent={TrackerEvents.IssuePlusButtonClicked}
    createItemDialogProps={{ shouldSaveDraft: true }}
  />
{/if}

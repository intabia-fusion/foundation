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
  import { AttachmentsPresenter } from '@hcengineering/attachment-resources'
  import {
    CategoryType,
    Class,
    Doc,
    DocumentQuery,
    DocumentUpdate,
    FindOptions,
    generateId,
    getObjectValue,
    groupByArray,
    Lookup,
    mergeQueries,
    Ref,
    WithLookup
  } from '@hcengineering/core'
  import { Item, Kanban as KanbanUI, SwimLane } from '@hcengineering/kanban'
  import { employeeByIdStore } from '@hcengineering/contact-resources'
  import { Employee, getName } from '@hcengineering/contact'
  import { defaultPriorities, issuePriorities } from '../../types'
  import { IntlString, translate } from '@hcengineering/platform'
  import notification from '@hcengineering/notification'
  import { ActionContext, createQuery, getClient, reduceCalls } from '@hcengineering/presentation'
  import tags from '@hcengineering/tags'
  import task, { DocWithRank, getStates, TaskType, Project as TaskProject } from '@hcengineering/task'
  import {
    getTaskKanbanResultQuery,
    taskTypeStore,
    typeStore,
    updateTaskKanbanCategories
  } from '@hcengineering/task-resources'
  import {
    Component as TrackerComponent,
    Issue,
    IssuePriority,
    IssuesGrouping,
    IssuesOrdering,
    Project,
    reduceChildInfoTree
  } from '@hcengineering/tracker'
  import {
    Button,
    ColorDefinition,
    Component,
    defaultBackground,
    getPlatformAvatarColorForTextDef,
    getPlatformColorDef,
    IconAdd,
    Label,
    Loading,
    showPopup,
    themeStore
  } from '@hcengineering/ui'
  import view, { AttributeModel, BuildModelKey, Viewlet, ViewOptionModel, ViewOptions } from '@hcengineering/view'
  import {
    buildModel,
    enabledConfig,
    focusStore,
    getCategoryQueryNoLookup,
    getCategoryQueryNoLookupOptions,
    getCategoryQueryProjection,
    getGroupByValues,
    getPresenter,
    groupBy,
    ListPresenter,
    ListSelectionProvider,
    noCategory,
    openDoc,
    SelectDirection,
    setGroupByValues,
    showMenu,
    statusStore
  } from '@hcengineering/view-resources'
  import { ChatMessagesPresenter } from '@hcengineering/chunter-resources'
  import workflow, { ProjectWorkflow, Workflow, WorkflowTransition } from '@hcengineering/workflow'
  import { onMount } from 'svelte'

  import tracker from '../../plugin'
  import { componentStore } from '../../component'
  import { activeProjects, IssuePriorityColor } from '../../utils'
  import ComponentEditor from '../components/ComponentEditor.svelte'
  import CreateIssue from '../CreateIssue.svelte'
  import AssigneeEditor from './AssigneeEditor.svelte'
  import DueDatePresenter from './DueDatePresenter.svelte'
  import SubIssuesSelector from './edit/SubIssuesSelector.svelte'
  import IssuePresenter from './IssuePresenter.svelte'
  import ParentNamesPresenter from './ParentNamesPresenter.svelte'
  import PriorityEditor from './PriorityEditor.svelte'
  import StatusEditor from './StatusEditor.svelte'
  import EstimationEditor from './timereport/EstimationEditor.svelte'
  import MilestoneEditor from '../milestones/MilestoneEditor.svelte'

  const _class = tracker.class.Issue
  export let space: Ref<Project> | undefined = undefined
  export let baseMenuClass: Ref<Class<Doc>> | undefined = undefined
  export let query: DocumentQuery<Issue> = {}
  export let viewOptionsConfig: ViewOptionModel[] | undefined = undefined
  export let viewOptions: ViewOptions
  export let viewlet: Viewlet
  export let config: (string | BuildModelKey)[]
  export let options: FindOptions<DocWithRank> | undefined = undefined

  $: groupByKey = (viewOptions.groupBy[0] ?? noCategory) as IssuesGrouping
  $: orderBy = viewOptions.orderBy
  $: compactMode = viewOptions.compactMode === true

  let customAttrModels: AttributeModel[] = []
  const buildCustomAttrModels = reduceCalls(async function (cfg: (string | BuildModelKey)[]): Promise<void> {
    const customKeys = cfg.filter((c): c is BuildModelKey => typeof c !== 'string' && c.displayProps?.custom === true)
    if (customKeys.length === 0) {
      customAttrModels = []
      return
    }
    const groups = groupByArray(customKeys, (k) => k.displayProps?._class ?? _class)
    const models = (
      await Promise.all(
        Array.from(groups.entries()).map(([targetClass, keys]) =>
          buildModel({ client, _class: targetClass as Ref<Class<Doc>>, keys, ignoreMissing: true, lookup })
        )
      )
    ).flat()
    customAttrModels = models
  })
  $: void buildCustomAttrModels(config)

  let accentColors = new Map<string, ColorDefinition>()
  const setAccentColor = (n: number, ev: CustomEvent<ColorDefinition>) => {
    accentColors.set(`${n}${$themeStore.dark}${groupByKey}`, ev.detail)
    accentColors = accentColors
  }

  $: dontUpdateRank = orderBy ? orderBy[0] !== IssuesOrdering.Manual : false

  $: currentSpace = space ?? tracker.project.DefaultProject
  let currentProject: Project | undefined
  $: currentProject = $activeProjects.get(currentSpace) as Project

  let resultQuery: DocumentQuery<any> = { ...query }
  const client = getClient()

  $: void getTaskKanbanResultQuery(client.getHierarchy(), query, viewOptionsConfig, viewOptions).then((p) => {
    resultQuery = mergeQueries(p, query)
  })

  $: queryNoLookup = getCategoryQueryNoLookup(resultQuery)

  function toIssue (object: any): WithLookup<Issue> {
    return object as WithLookup<Issue>
  }

  const lookup: Lookup<Issue> = {
    ...(options?.lookup ?? {}),
    attachedTo: tracker.class.Issue,
    _id: {
      subIssues: tracker.class.Issue
    }
  }

  $: resultOptions = { ...options, lookup, ...(orderBy !== undefined ? { sort: { [orderBy[0]]: orderBy[1] } } : {}) }

  let kanbanUI: KanbanUI
  const listProvider = new ListSelectionProvider((offset: 1 | -1 | 0, of?: Doc, dir?: SelectDirection) => {
    kanbanUI?.select(offset, of, dir)
  })
  const selection = listProvider.selection

  onMount(() => {
    ;(document.activeElement as HTMLElement)?.blur()
  })

  // Category information only
  let tasks: DocWithRank[] = []

  // Optimistic overlay: pending field updates per doc id, applied to tasks on every rebuild
  // until live-query snapshots catch up to the target values.
  let pendingMoves = new Map<string, Record<string, unknown>>()

  function applyPendingMoves (docs: DocWithRank[]): DocWithRank[] {
    if (pendingMoves.size === 0) return docs
    let needsResort = false
    const result = docs.map((d) => {
      const overlay = pendingMoves.get(d._id)
      if (overlay === undefined) return d
      // Check if snapshot already matches all overlay fields — if so, drop the entry.
      let matches = true
      for (const k of Object.keys(overlay)) {
        if ((d as any)[k] !== overlay[k]) {
          matches = false
          break
        }
      }
      if (matches) {
        // Silently drop matched overlay — do NOT trigger a follow-up reactive
        // tick by reassigning pendingMoves. The snapshot already carries the
        // target values, so the next render is identical with or without the
        // entry. Reassigning here causes a visible re-render flash because
        // groupByDocs rebuilds twice in quick succession (once with overlay,
        // once without) before the DOM stabilizes.
        pendingMoves.delete(d._id)
        return d
      }
      if ('rank' in overlay) needsResort = true
      return { ...d, ...overlay } satisfies DocWithRank
    })
    if (needsResort && orderBy !== undefined) {
      const [field, dir] = orderBy
      result.sort((a, b) => {
        const av = (a as any)[field]
        const bv = (b as any)[field]
        if (av === bv) return 0
        return (av < bv ? -1 : 1) * dir
      })
    }
    return result
  }

  function registerPendingMove (id: string, fields: Record<string, unknown>): void {
    pendingMoves.set(id, { ...(pendingMoves.get(id) ?? {}), ...fields })
    pendingMoves = pendingMoves
  }

  function clearPendingMove (id: string): void {
    if (pendingMoves.has(id)) {
      pendingMoves.delete(id)
      pendingMoves = pendingMoves
    }
  }

  $: effectiveTasks = pendingMoves.size > 0 ? applyPendingMoves(tasks) : tasks

  // Memoize groupByDocs by a cheap content hash so that downstream Kanban
  // re-renders only when the partitioning actually changes. Without this,
  // every batched live-query snapshot — even one that doesn't affect this
  // view's grouping — triggers a full Kanban prop change and KanbanRow
  // re-mounts. We hash via a 32-bit FNV-style accumulator over keys+ids;
  // collision probability is negligible relative to user-visible reorderings.
  let groupByDocs: Record<string | number, DocWithRank[]> = {}
  let lastGroupHash = 0
  $: {
    const next = groupBy(effectiveTasks, groupByKey, categories)
    const keys = Object.keys(next).sort()
    let hash = 2166136261 >>> 0
    const mix = (s: string): void => {
      for (let i = 0; i < s.length; i++) {
        hash = Math.imul(hash ^ s.charCodeAt(i), 16777619) >>> 0
      }
    }
    // Mix swimLaneBy so that toggling swim lane (which changes per-doc projection
    // fields like `priority`) busts the memo and forces a fresh groupByDocs even
    // if ids/lengths inside categories did not change.
    mix(swimLaneBy)
    // Mix the swim-lane value of the first doc of each category so a projection
    // refresh that adds the swim field to existing docs invalidates the memo.
    for (const k of keys) {
      mix(k)
      const arr = (next as any)[k] ?? []
      hash = Math.imul(hash ^ arr.length, 16777619) >>> 0
      for (const item of arr) mix(item._id)
      if (swimLaneBy !== 'none' && swimLaneBy !== '' && arr.length > 0) {
        const v = arr[0][swimLaneBy]
        mix(String(v))
      }
    }
    if (hash !== lastGroupHash) {
      lastGroupHash = hash
      groupByDocs = next
    }
  }

  let fastDocs: DocWithRank[] = []
  let slowDocs: DocWithRank[] = []

  const docsQuery = createQuery()
  const docsQuerySlow = createQuery()

  let fastQueryIds = new Set<Ref<DocWithRank>>()

  $: swimLaneBy = (viewOptions.swimLaneBy as string) ?? 'none'

  let categoryQueryOptions: Partial<FindOptions<DocWithRank>>
  $: categoryQueryOptions = {
    ...getCategoryQueryNoLookupOptions(resultOptions),
    projection: {
      ...resultOptions.projection,
      _id: 1,
      _class: 1,
      rank: 1,
      ...getCategoryQueryProjection(client.getHierarchy(), _class, queryNoLookup, viewOptions.groupBy),
      ...(swimLaneBy !== 'none' && swimLaneBy !== '' ? { [swimLaneBy]: 1 } : {})
    }
  }

  $: docsQuery.query(
    _class,
    queryNoLookup,
    (res) => {
      fastDocs = res
      fastQueryIds = new Set(res.map((it) => it._id))
    },
    { ...categoryQueryOptions, limit: 1000 }
  )
  $: docsQuerySlow.query(
    _class,
    queryNoLookup,
    (res) => {
      slowDocs = res
    },
    categoryQueryOptions
  )

  $: tasks = [...fastDocs, ...slowDocs.filter((it) => !fastQueryIds.has(it._id))]

  $: listProvider.update(tasks)

  let categories: CategoryType[] = []
  let loadCategories = true

  const queryId = generateId()

  function update (): void {
    void updateTaskKanbanCategories(
      client,
      viewlet,
      _class,
      space,
      tasks,
      groupByKey,
      viewOptions,
      viewOptionsConfig,
      update,
      queryId
    ).then((res) => {
      categories = res
      loadCategories = false
    })
  }

  $: void updateTaskKanbanCategories(
    client,
    viewlet,
    _class,
    space,
    tasks,
    groupByKey,
    viewOptions,
    viewOptionsConfig,
    update,
    queryId
  ).then((res) => {
    categories = res
    loadCategories = false
  })

  const fullFilled: Record<string, boolean> = {}

  function getHeader (_class: Ref<Class<Doc>>, groupByKey: string): void {
    if (groupByKey === noCategory) {
      headerComponent = undefined
    } else {
      void getPresenter(client, _class, { key: groupByKey }, { key: groupByKey }).then((p) => {
        headerComponent = p
      })
    }
  }

  let headerComponent: AttributeModel | undefined
  $: getHeader(_class, groupByKey)

  const getUpdateProps = (doc: Doc, category: CategoryType): DocumentUpdate<Item> | undefined => {
    const groupValue =
      typeof category === 'object' ? category.values.find((it) => it.space === doc.space)?._id : category
    if (groupValue === undefined) {
      return undefined
    }
    return {
      [groupByKey]: groupValue,
      space: doc.space
    }
  }

  // SwimLane support (generic by attribute name).
  const UNASSIGNED_SWIM = '__swim_unassigned__'
  // Fields that must not be changed via drag (project immutable).
  const IMMUTABLE_SWIM_FIELDS = new Set<string>(['space'])

  let swimLanes: SwimLane[] = []
  let emptyLabel = ''
  const EMPTY_LABEL_BY_FIELD: Record<string, IntlString> = {
    assignee: tracker.string.NoAssignee,
    component: tracker.string.NoComponent,
    milestone: tracker.string.NoMilestone,
    attachedTo: tracker.string.NoParent
  }
  $: {
    const intl = EMPTY_LABEL_BY_FIELD[swimLaneBy] ?? tracker.string.NoAssignee
    void translate(intl, {}, $themeStore.language).then((v) => {
      emptyLabel = v
    })
  }

  function normalizeSwimValue (v: unknown): { key: string, value: unknown, empty: boolean, title?: string } {
    if (v == null) return { key: UNASSIGNED_SWIM, value: null, empty: true }
    if (swimLaneBy === 'attachedTo' && v === tracker.ids.NoParent) {
      return { key: UNASSIGNED_SWIM, value: tracker.ids.NoParent, empty: true }
    }
    // Components with the same label may exist in different projects — group
    // them under one swimlane keyed by the (case-folded, trimmed) label so the
    // user sees a single "Chat" lane instead of one per project.
    if (swimLaneBy === 'component') {
      const c = $componentStore.get(v as Ref<TrackerComponent>)
      if (c !== undefined) {
        const label = c.label
        return { key: 'component:' + label.toLowerCase().trim(), value: v, empty: false, title: label }
      }
    }
    return { key: String(v), value: v, empty: false }
  }

  function buildGenericLanes (field: string, tasks: DocWithRank[]): SwimLane[] {
    if (field === 'none' || field === '') return []
    const seen = new Map<string, { value: unknown, empty: boolean, title?: string }>()
    for (const t of tasks) {
      const raw = getObjectValue(field, t)
      const n = normalizeSwimValue(raw)
      if (!seen.has(n.key)) seen.set(n.key, { value: n.value, empty: n.empty, title: n.title })
    }
    // Priority has a fixed ordered set; preseed to keep empty lanes too.
    if (field === 'priority') {
      for (const p of defaultPriorities) {
        const k = String(p)
        if (!seen.has(k)) seen.set(k, { value: p, empty: false })
      }
    }
    const lanes: SwimLane[] = []
    let unassigned: SwimLane | undefined
    for (const [key, { value, empty, title }] of seen) {
      const lane: SwimLane = {
        _id: key,
        title: empty ? emptyLabel : (title ?? ''),
        value,
        icon: field === 'priority' && !empty ? issuePriorities[value as IssuePriority]?.icon : undefined
      }
      if (empty) unassigned = lane
      else lanes.push(lane)
    }
    if (field === 'priority') {
      lanes.sort(
        (a, b) =>
          defaultPriorities.indexOf(b.value as IssuePriority) - defaultPriorities.indexOf(a.value as IssuePriority)
      )
    } else {
      // Stable, deterministic order by lane id (ascending) — prevents lane jumps on task reorder.
      lanes.sort((a, b) => a._id.localeCompare(b._id))
    }
    if (unassigned !== undefined) lanes.unshift(unassigned)
    return lanes
  }

  $: swimLanes = buildGenericLanes(swimLaneBy, effectiveTasks)

  function getSwimLaneOfDoc (doc: Doc): string | undefined {
    if (swimLaneBy === 'none' || swimLaneBy === '') return undefined
    const raw = getObjectValue(swimLaneBy, doc)
    return normalizeSwimValue(raw).key
  }

  function getSwimLaneQuery (swimLane: SwimLane): DocumentQuery<any> {
    if (swimLaneBy === 'none' || swimLaneBy === '') return {}
    return { [swimLaneBy]: swimLane.value }
  }

  function getSwimLaneUpdateProps (doc: Doc, swimLane: SwimLane): DocumentUpdate<Item> | undefined {
    if (swimLaneBy === 'none' || swimLaneBy === '') return undefined
    if (IMMUTABLE_SWIM_FIELDS.has(swimLaneBy)) return undefined
    let value: unknown = swimLane.value
    // Components are aggregated by label across projects; pick the ref that
    // belongs to the dropped issue's project, or skip the update entirely if
    // this lane has no matching component for the issue's project.
    if (swimLaneBy === 'component') {
      const docSpace = (doc as any).space
      const lane = $componentStore.filter(
        (c) =>
          c.label.toLowerCase().trim() ===
            ($componentStore.get(swimLane.value as Ref<TrackerComponent>)?.label ?? '').toLowerCase().trim() &&
          c.space === docSpace
      )
      const match = lane.length > 0 ? lane[0]._id : undefined
      if (match === undefined) return undefined
      value = match
    }
    const update: DocumentUpdate<Item> = { [swimLaneBy]: value } as unknown as DocumentUpdate<Item>
    if (swimLaneBy === 'attachedTo') {
      ;(update as any).attachedToClass = tracker.class.Issue
    }
    return update
  }

  let swimLaneAccents = new Map<string, ColorDefinition>()
  function setSwimLaneAccent (id: string, ev: CustomEvent<ColorDefinition>): void {
    const prev = swimLaneAccents.get(id)
    if (prev?.name === ev.detail?.name && prev?.background === ev.detail?.background) return
    swimLaneAccents.set(id, ev.detail)
    swimLaneAccents = swimLaneAccents
  }

  $: showColors = (viewOptions as any).shouldShowColors !== false

  $: getSwimLaneHeaderStyle = (swimLane: SwimLane): { background?: string, color?: string } | undefined => {
    void swimLaneAccents
    if (!showColors) return undefined
    if (swimLaneBy === 'priority') {
      const color = getPlatformColorDef(
        IssuePriorityColor[(swimLane.value as IssuePriority) ?? IssuePriority.NoPriority],
        $themeStore.dark
      )
      return { background: color.background, color: color.title }
    }
    if (swimLaneBy === 'assignee') {
      const emp = $employeeByIdStore.get(swimLane._id as Ref<Employee>)
      if (emp != null) {
        const name = getName(client.getHierarchy(), emp)
        const color = getPlatformAvatarColorForTextDef(name, $themeStore.dark)
        return { background: color.background, color: color.title }
      }
    }
    const accent = swimLaneAccents.get(swimLane._id)
    if (accent !== undefined) {
      return { background: accent.background, color: accent.title }
    }
    return undefined
  }

  // Generic lane header presenter resolution.
  let swimLanePresenter: AttributeModel | undefined
  $: void resolveSwimLanePresenter(swimLaneBy)
  async function resolveSwimLanePresenter (field: string): Promise<void> {
    if (field === 'none' || field === '') {
      swimLanePresenter = undefined
      return
    }
    try {
      swimLanePresenter = await getPresenter(client, _class, { key: field }, { key: field })
    } catch {
      swimLanePresenter = undefined
    }
  }

  $: swimLaneStorageKey = viewlet?._id != null ? `${String(viewlet._id)}-${swimLaneBy}` : undefined

  async function shouldShowFooter (
    config: (string | BuildModelKey)[],
    reports: number,
    estimations: number,
    issue: WithLookup<Issue>
  ): Promise<boolean> {
    if (enabledConfig(config, 'estimation') && (reports > 0 || estimations > 0)) return true
    if (enabledConfig(config, 'comments')) {
      if ((issue.comments ?? 0) > 0) return true
      if ((issue.$lookup?.attachedTo?.comments ?? 0) > 0) return true
    }
    if (enabledConfig(config, 'attachments') && (issue.attachments ?? 0) > 0) return true
    return false
  }

  async function getWorkflowTransitions (
    spaceId: Ref<Project>,
    kind: Ref<TaskType>
  ): Promise<WorkflowTransition[] | null> {
    const space = await client.findOne(tracker.class.Project, { _id: spaceId })
    if (space == null) return null

    const hierarchy = client.getHierarchy()
    if (!hierarchy.hasMixin(space, workflow.mixin.ProjectWorkflow)) return null

    const projectWf = hierarchy.as<TaskProject, ProjectWorkflow>(space, workflow.mixin.ProjectWorkflow)
    const wfId = projectWf?.workflows?.[kind]
    if (wfId == null) return null

    const wfDoc = await client.findOne<Workflow>(
      workflow.class.Workflow,
      { _id: wfId },
      {
        lookup: {
          _id: { transitions: workflow.class.WorkflowTransition }
        }
      }
    )
    return (wfDoc?.$lookup?.transitions ?? []) as WorkflowTransition[]
  }

  const getAvailableCategories = async (doc: Doc): Promise<CategoryType[]> => {
    const issue = toIssue(doc)

    if ([IssuesGrouping.Component, IssuesGrouping.Milestone].includes(groupByKey)) {
      const availableCategories = []
      const clazz = client.getHierarchy().getAttribute(tracker.class.Issue, groupByKey)

      for (const category of categories) {
        if (!category || (issue as any)[groupByKey] === category) {
          availableCategories.push(category)
        } else if (clazz !== undefined && 'to' in clazz.type) {
          const categoryDoc = await client.findOne(clazz.type.to as Ref<Class<Doc>>, {
            _id: category as Ref<Doc>,
            space: issue.space
          })

          if (categoryDoc) {
            availableCategories.push(category)
          }
        }
      }

      return availableCategories
    }

    if (groupByKey === IssuesGrouping.Status) {
      if (issue.kind != null) {
        const taskType =
          $taskTypeStore.get(issue.kind) ?? (await client.findOne(task.class.TaskType, { _id: issue.kind }))
        if (taskType?.statuses != null && taskType.statuses.length > 0) {
          if (issue.space != null) {
            const transitions = await getWorkflowTransitions(issue.space, issue.kind)
            if (transitions != null) {
              const allowed = new Set<string>()
              if (issue.status != null) {
                allowed.add(issue.status)
              }
              for (const t of transitions) {
                if (t.from == null || t.from.length === 0 || (issue.status != null && t.from.includes(issue.status))) {
                  allowed.add(t.to)
                }
              }
              return taskType.statuses.filter((s) => allowed.has(s))
            }
          }
          return taskType.statuses
        }
      }

      if (issue.space != null) {
        const space = await client.findOne(tracker.class.Project, { _id: issue.space })
        if (space != null) {
          return getStates(space, $typeStore, $statusStore.byId).map(({ _id }) => _id)
        }
      }
    }

    return categories
  }
</script>

{#if loadCategories}
  <Loading />
{:else}
  <ActionContext
    context={{
      mode: 'browser'
    }}
  />
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <KanbanUI
    bind:this={kanbanUI}
    {categories}
    {dontUpdateRank}
    {orderBy}
    onMoveCommit={(id, fields) => {
      registerPendingMove(id, fields)
    }}
    onMoveRollback={(id) => {
      clearPendingMove(id)
    }}
    {_class}
    query={resultQuery}
    options={resultOptions}
    objects={tasks}
    getGroupByValues={(groupByDocs, category) =>
      groupByKey === noCategory ? tasks : getGroupByValues(groupByDocs, category)}
    {setGroupByValues}
    {getUpdateProps}
    {groupByDocs}
    {groupByKey}
    on:obj-focus={(evt) => {
      listProvider.updateFocus(evt.detail)
    }}
    {getAvailableCategories}
    {swimLanes}
    swimLaneKey={swimLaneBy !== 'none' ? swimLaneBy : undefined}
    {getSwimLaneOfDoc}
    {getSwimLaneQuery}
    {getSwimLaneUpdateProps}
    {getSwimLaneHeaderStyle}
    compact={compactMode}
    storageKey={swimLaneStorageKey}
    controlKey={viewlet?._id != null ? String(viewlet._id) : undefined}
    selection={listProvider.current($focusStore)}
    checked={$selection ?? []}
    on:check={(evt) => {
      listProvider.updateSelection(evt.detail.docs, evt.detail.value)
    }}
    on:contextmenu={(evt) => {
      showMenu(evt.detail.evt, { object: evt.detail.objects, baseMenuClass })
    }}
  >
    <svelte:fragment slot="swimLaneHeader" let:swimLane let:count let:collapsed let:toggle>
      <div class="swimlane-header-inner">
        {#if swimLane._id === UNASSIGNED_SWIM || swimLanePresenter === undefined}
          <span class="swimlane-title">{swimLane.title || emptyLabel}</span>
        {:else}
          <svelte:component
            this={swimLanePresenter.presenter}
            value={swimLane.value}
            kind={'list-header'}
            size={'small'}
            {space}
            accent
            colorInherit={!$themeStore.dark}
            on:accent-color={(ev) => {
              setSwimLaneAccent(swimLane._id, ev)
            }}
          />
        {/if}
        <span class="swimlane-count">{count}</span>
      </div>
    </svelte:fragment>
    <svelte:fragment slot="header" let:state let:count let:index>
      {@const color = accentColors.get(`${index}${$themeStore.dark}${groupByKey}`)}
      {@const headerBGColor = color?.background ?? defaultBackground($themeStore.dark)}
      <div style:background={headerBGColor} class="header flex-between">
        <div class="flex-row-center gap-1">
          <span
            class="clear-mins fs-bold overflow-label pointer-events-none"
            style:color={color?.title ?? 'var(--theme-caption-color)'}
          >
            {#if groupByKey === noCategory}
              <Label label={view.string.NoGrouping} />
            {:else if headerComponent}
              <svelte:component
                this={headerComponent.presenter}
                value={state}
                {space}
                size={'small'}
                kind={'list-header'}
                display={'kanban'}
                colorInherit={!$themeStore.dark}
                accent
                on:accent-color={(ev) => {
                  setAccentColor(index, ev)
                }}
              />
            {/if}
          </span>
          <span class="counter ml-1">
            {count}
          </span>
        </div>
        <div class="tools gap-1">
          <Button
            icon={IconAdd}
            kind={'ghost'}
            showTooltip={{ label: tracker.string.AddIssueTooltip, direction: 'left' }}
            on:click={() => {
              showPopup(CreateIssue, { space: currentSpace, [groupByKey]: state }, 'top')
            }}
          />
        </div>
      </div>
    </svelte:fragment>
    <svelte:fragment slot="card" let:object>
      {@const issue = toIssue(object)}
      {@const issueId = object._id}
      {@const treeResult = reduceChildInfoTree(issue.childInfo ?? [], issue.estimation, issue.reportedTime)}
      {@const reports = treeResult.totalReportedTime}
      {@const estimations = treeResult.totalEstimation}
      {#key issueId}
        <div
          class="tracker-card"
          class:compact={compactMode}
          on:click={() => {
            void openDoc(client.getHierarchy(), issue)
          }}
        >
          <div class="card-header flex-between">
            <div class="flex-row-center text-sm min-w-0">
              <div class="mr-1 flex-no-shrink">
                <StatusEditor value={issue} kind="list" isEditable={false} />
              </div>
              <div class="flex-no-shrink">
                <IssuePresenter value={issue} />
              </div>
              {#if !compactMode}
                <ParentNamesPresenter value={issue} />
              {/if}
            </div>
            <div class="flex-row-center gap-2 reverse flex-no-shrink">
              <Component is={notification.component.NotificationPresenter} props={{ value: object }} />
              <AssigneeEditor object={issue} avatarSize={'card'} shouldShowName={false} />
            </div>
          </div>
          <div
            class="card-content caption-color"
            class:text-md={!compactMode}
            class:text-sm={compactMode}
            class:lines-limit-2={!compactMode}
          >
            {object.title}
          </div>
          <div class="card-labels meta">
            {#if enabledConfig(config, 'priority') && (!compactMode || issue.priority !== IssuePriority.NoPriority)}
              <PriorityEditor
                value={issue}
                isEditable={true}
                kind={'link-bordered'}
                size={'small'}
                justify={'center'}
              />
            {/if}
            {#if enabledConfig(config, 'subIssues') && issue && issue.subIssues > 0}
              <SubIssuesSelector value={issue} {currentProject} size={'small'} />
            {/if}
            {#each customAttrModels as attrModel (attrModel.key)}
              <ListPresenter
                docObject={issue}
                attributeModel={attrModel}
                value={getObjectValue(attrModel.key, issue)}
                onChange={undefined}
                props={{}}
                hideDivider={true}
                compactMode={true}
                customStyle={'square'}
              />
            {/each}
            {#if enabledConfig(config, 'dueDate') && (!compactMode || issue.dueDate != null)}
              <DueDatePresenter value={issue} size={'small'} kind={'link-bordered'} />
            {/if}
            {#if compactMode}
              {#if enabledConfig(config, 'estimation') && (estimations > 0 || reports > 0)}
                <EstimationEditor kind={'link-bordered'} size={'small'} value={issue} />
              {/if}
              {#if enabledConfig(config, 'attachments') && (object.attachments ?? 0) > 0}
                <AttachmentsPresenter value={object.attachments} {object} kind={'link-bordered'} size={'small'} />
              {/if}
              {#if enabledConfig(config, 'comments') && (object.comments ?? 0) > 0}
                <ChatMessagesPresenter value={object.comments} {object} kind={'link-bordered'} size={'small'} />
              {/if}
              {#if enabledConfig(config, 'comments') && (object.$lookup?.attachedTo?.comments ?? 0) > 0}
                <ChatMessagesPresenter
                  object={object.$lookup?.attachedTo}
                  value={object.$lookup?.attachedTo?.comments}
                  withInput={false}
                  kind={'link-bordered'}
                  size={'small'}
                />
              {/if}
            {:else}
              {#if enabledConfig(config, 'component')}
                <div class:icon-only={issue.component == null}>
                  <ComponentEditor
                    value={issue}
                    {space}
                    isEditable={true}
                    kind={'link-bordered'}
                    size={'small'}
                    justify={'center'}
                  />
                </div>
              {/if}
              {#if enabledConfig(config, 'milestone')}
                <div class:icon-only={issue.milestone == null}>
                  <MilestoneEditor
                    value={issue}
                    {space}
                    isEditable={true}
                    kind={'link-bordered'}
                    size={'small'}
                    maxWidth={'7rem'}
                    justify={'center'}
                  />
                </div>
              {/if}
            {/if}
          </div>
          {#if !compactMode && enabledConfig(config, 'labels')}
            <div class="card-labels labels">
              <Component
                is={tags.component.LabelsPresenter}
                props={{
                  value: issue.labels,
                  object: issue,
                  checkFilled: fullFilled[issueId],
                  kind: 'link',
                  compression: true
                }}
                on:change={(res) => {
                  if (res.detail.full) fullFilled[issueId] = true
                }}
              />
            </div>
          {/if}
          {#if !compactMode}
            {#await shouldShowFooter(config, reports, estimations, object) then withFooter}
              {#if withFooter}
                <div class="card-footer flex-between">
                  {#if enabledConfig(config, 'estimation')}
                    <EstimationEditor kind={'list'} size={'small'} value={issue} />
                  {/if}
                  <div class="flex-row-center gap-3 reverse">
                    {#if enabledConfig(config, 'attachments') && (object.attachments ?? 0) > 0}
                      <AttachmentsPresenter value={object.attachments} {object} />
                    {/if}
                    <ChatMessagesPresenter value={object.comments} {object} />
                    <ChatMessagesPresenter
                      object={object.$lookup?.attachedTo}
                      value={object.$lookup?.attachedTo?.comments}
                      withInput={false}
                    />
                  </div>
                </div>
              {:else}
                <div class="min-h-4 max-h-4 h-4" />
              {/if}
            {/await}
          {/if}
        </div>
      {/key}
    </svelte:fragment>
  </KanbanUI>
{/if}

<style lang="scss">
  .swimlane-header-inner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }
  .swimlane-title {
    font-weight: 600;
    color: var(--swimlane-title-color, var(--theme-caption-color));
  }
  .swimlane-count {
    color: var(--theme-dark-color);
    font-size: 0.8125rem;
    padding: 0 0.375rem;
    background: var(--theme-button-hovered);
    border-radius: 0.5rem;
    line-height: 1.25rem;
  }
  .header {
    margin: 0 0.75rem 0.5rem;
    padding: 0 0.5rem 0 1.25rem;
    height: 2.5rem;
    min-height: 2.5rem;
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.25rem;

    .counter {
      color: var(--theme-dark-color);
    }
    .tools {
      opacity: 0;
    }
    &:hover .tools {
      opacity: 1;
    }
  }
  .tracker-card {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 6.5rem;
    border-radius: 0.25rem;

    &.compact {
      min-height: 0;

      .card-content {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .card-header {
        padding: 0.375rem 0.5rem 0;
      }
      .card-content {
        margin: 0.125rem 0.5rem;
        line-height: 1.15rem;
      }
      .card-labels {
        margin: 0.125rem 0.375rem 0.375rem 0.5rem;
        gap: 0.25rem;

        &.meta {
          flex-wrap: wrap;
        }
      }
    }

    .card-header {
      padding: 0.75rem 1rem 0;
    }
    .card-content {
      margin: 0.5rem 1rem;
    }
    /* Global styles in components.scss */
    .card-labels {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      margin: 0 0.75rem 0 1rem;
      min-width: 0;

      &.meta {
        flex-wrap: wrap;
        gap: 0.375rem;
      }

      :global(.icon-only span.label.nowrap),
      :global(.icon-only button.iconL > span.label) {
        display: none;
      }
      :global(.icon-only button) {
        padding: 0 0.375rem !important;
        width: auto !important;
      }
      :global(.icon-only .flex-presenter) {
        margin: 0;
      }
      :global(.icon-only .icon),
      :global(.icon-only .btn-icon) {
        margin: 0 !important;
      }

      &.labels {
        overflow: hidden;
        flex-shrink: 1;
        margin: 0 1rem;
        width: calc(100% - 2rem);
        border-radius: 0 0.24rem 0.24rem 0;
      }
    }
    .card-footer {
      margin-top: 1rem;
      padding: 0.75rem 1rem;
      background-color: var(--theme-kanban-card-footer);
      border-radius: 0 0 0.25rem 0.25rem;
    }
  }
</style>

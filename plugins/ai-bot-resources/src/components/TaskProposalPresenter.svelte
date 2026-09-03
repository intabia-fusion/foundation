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
  import { type AIContextMessage, type AITaskProposal, type AITaskProposalMessage } from '@hcengineering/ai-bot'
  import core, { type Doc, generateId, getCurrentAccount, type Ref, type Space } from '@hcengineering/core'
  import { getResource, translate } from '@hcengineering/platform'
  import { createQuery, getClient, MessageViewer, SpaceSelector } from '@hcengineering/presentation'
  import { onDestroy } from 'svelte'
  import { get } from 'svelte/store'

  import { issueDraftApplier } from '../stores'
  import { jsonToMarkup, markupToJSON, type MarkupNode, MarkupNodeType } from '@hcengineering/text'
  import { markdownToMarkup } from '@hcengineering/text-markdown'
  import tracker, {
    type CreatedIssue,
    type Issue,
    type IssuePriority,
    type IssueTemplateChild,
    type Project
  } from '@hcengineering/tracker'
  import { Button, Component, EditBox, Expandable, Label } from '@hcengineering/ui'
  import { ActivityMessageTemplate } from '@hcengineering/activity-resources'
  import { type Person } from '@hcengineering/contact'
  import { getPersonByPersonIdCb } from '@hcengineering/contact-resources'

  import plugin from '../plugin'
  import { aiBotNameStore } from '../utils'

  export let value: AITaskProposalMessage
  // Passed through by the activity feed; forwarded to the message template unchanged.
  export let showNotify: boolean = false
  export let isHighlighted: boolean = false
  export let isSelected: boolean = false
  export let shouldScroll: boolean = false
  export let embedded: boolean = false
  export let withActions: boolean = true
  export let hideFooter: boolean = false
  export let skipLabel: boolean = false

  const client = getClient()

  // The card is still a chat message: keep the standard header (avatar, name, time) and put the
  // proposal in the content slot, instead of replacing the whole message rendering.
  let person: Person | undefined
  $: if (value?.createdBy !== undefined) {
    getPersonByPersonIdCb(value.createdBy, (p) => {
      person = p ?? undefined
    })
  } else {
    person = undefined
  }

  const rootQuery = createQuery()

  // A proposal made while drafting an issue in the create dialog belongs to that dialog: the
  // issue is created there, from the form the user can still edit. Creating it from the card too
  // would produce a second, half-edited issue.
  let isDraftSession = false
  // Applied proposals fold; tracked by flip only, so a re-delivered `value` does not undo a manual unfold.
  let expanded = value.applied !== true
  let lastApplied = value.applied
  $: if (value.applied !== lastApplied) {
    lastApplied = value.applied
    expanded = value.applied !== true
  }

  // No title check here: the model often changes the description only, and the panel keeps
  // whatever the proposal leaves out.
  async function applyToDraft (): Promise<void> {
    const applier = get(issueDraftApplier)
    if (applier === undefined) return
    applier(value)
    await client.diffUpdate(value, { applied: true })
  }

  $: rootQuery.query(
    plugin.class.AIContextMessage,
    { _id: value.attachedTo as Ref<AIContextMessage> },
    (res) => {
      isDraftSession = res[0]?.purpose === 'issue-draft'
    },
    { limit: 1 }
  )

  // Bound to SpaceSelector, which auto-selects the first project; the pick is stored so a reload keeps it.
  let project: Ref<Space> | undefined = value.project
  $: if (project !== undefined && project !== value.project) void client.diffUpdate(value, { project })
  // Constant: SpaceSelect re-resolves on every new query object.
  const projectQuery = { archived: false, members: getCurrentAccount().uuid }
  // Splitting an existing task: only the sub-task block is shown, there is no new parent to name.
  $: isSplit = value.parent != null

  // Local copy: a re-delivered `value` must not wipe text typed but not yet blurred.
  let title = value.title
  let lastStoredTitle = value.title
  $: if (value.title !== lastStoredTitle) {
    lastStoredTitle = value.title
    title = value.title
  }

  const toMarkup = (md?: string): string =>
    md != null && md.trim() !== '' ? jsonToMarkup(markdownToMarkup(md, { refUrl: 'ref://', imageUrl: '' })) : ''

  // The proposal stores plain data; the shared tracker control edits IssueTemplateChild, so map
  // once into that shape (ids exist only to key/drag rows).
  let children: IssueTemplateChild[] = []
  let selected: Array<Ref<Issue>> = []
  // Row ids are local, so remapping would lose the selection: keep it by position.
  let selectedIdx = new Set<number>()
  let mappedFrom = ''
  $: remap(value.subtasks ?? [])

  function remap (subtasks: AITaskProposal[]): void {
    const key = JSON.stringify(subtasks)
    if (key === mappedFrom) return
    const firstMap = mappedFrom === ''
    mappedFrom = key
    children = subtasks.map((s) => ({
      id: generateId<Issue>(),
      title: s.title,
      description: toMarkup(s.description),
      priority: (s.priority ?? 0) as IssuePriority,
      estimation: s.estimation ?? 0,
      assignee: null,
      component: null,
      milestone: null
    }))
    // Everything is proposed as checked; the user unchecks what they do not want.
    if (firstMap) selectedIdx = new Set(children.map((_, i) => i))
    // A row that already produced an issue can never be picked again - that is what stops a
    // second click from creating duplicates.
    for (const [i, sub] of subtasks.entries()) {
      if (sub.createdId != null) selectedIdx.delete(i)
    }
    selected = children.filter((_, i) => selectedIdx.has(i)).map((c) => c.id)
  }

  // Rows already turned into issues: shown as done, not selectable.
  $: createdRows = new Set(children.filter((_, i) => value.subtasks?.[i]?.createdId != null).map((c) => c.id))

  // Edits inside the control are written back so they survive a reload. Debounced: the control
  // fires an event per edited field.
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  function persistChildren (): void {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(doPersist, 300)
  }
  // Flush, don't drop: closing the panel within the debounce window would otherwise lose the edit.
  onDestroy(() => {
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer)
      doPersist()
    }
  })

  // diffUpdate: an edit that changes nothing writes no transaction.
  function doPersist (): void {
    void client.diffUpdate(value, {
      subtasks: children.map((c, i) => ({
        title: c.title,
        description: c.description !== '' ? c.description : undefined,
        priority: c.priority,
        estimation: c.estimation,
        createdId: value.subtasks?.[i]?.createdId
      }))
    })
  }

  function onSelect (e: CustomEvent<Array<Ref<Issue>>>): void {
    selected = e.detail.filter((id) => !createdRows.has(id))
    selectedIdx = new Set(children.map((c, i) => (selected.includes(c.id) ? i : -1)).filter((i) => i >= 0))
  }

  let creating = false
  let failure: string | undefined
  // Everything picked has an issue -> the card is done. A partial failure leaves rows unmade, so
  // the button stays available and only the missing ones are retried.
  $: pendingRows = children.filter((c, i) => selected.includes(c.id) && value.subtasks?.[i]?.createdId == null)
  $: created = (value.createdIds?.length ?? 0) > 0 && pendingRows.length === 0

  async function create (): Promise<void> {
    if (project === undefined || creating) return
    const target = await client.findOne(tracker.class.Project, { _id: project as Ref<Project> })
    if (target === undefined) return
    creating = true
    failure = undefined
    try {
      await createAll(target)
    } catch (err: any) {
      failure = err?.message ?? String(err)
    } finally {
      creating = false
    }
  }

  async function createAll (target: Project): Promise<void> {
    // Via the platform registry: a direct import of tracker-resources would close the cycle
    // ai-bot-resources -> tracker-resources -> chunter-resources -> ai-bot-resources.
    const createIssue = await getResource(tracker.function.CreateIssue)
    const subtasks = [...(value.subtasks ?? [])]
    const fresh: CreatedIssue[] = []
    // Snapshot both before the loop: every flush below writes the document, and the resulting
    // live-query update re-runs remap, which rebuilds `children` with fresh ids and recomputes
    // `selected` from them. Reading either mid-loop would drop every row after the first flush.
    const priorCreatedIds = [...(value.createdIds ?? [])]
    const planned = children
      .map((child, i) => ({ child, i }))
      .filter(
        ({ child, i }) => selected.includes(child.id) && child.title.trim() !== '' && subtasks[i]?.createdId == null
      )

    // Persist after every issue: a failure midway must not lose what was already created.
    const flush = async (rootId?: Ref<Doc>): Promise<void> => {
      await client.diffUpdate(value, {
        subtasks,
        createdIds: [...priorCreatedIds, ...fresh.map((i) => i._id)],
        project: target._id,
        ...(rootId !== undefined ? { createdRootId: rootId } : {})
      })
    }

    let root =
      value.parent != null
        ? await client.findOne(tracker.class.Issue, { _id: value.parent as Ref<Issue> })
        : value.createdRootId != null
          ? await client.findOne(tracker.class.Issue, { _id: value.createdRootId as Ref<Issue> })
          : undefined

    if (root === undefined) {
      const rootIssue = await createIssue(client, target, {
        title,
        description: toMarkup(value.description),
        priority: value.priority as IssuePriority | undefined,
        estimation: value.estimation
      })
      fresh.push(rootIssue)
      root = await client.findOne(tracker.class.Issue, { _id: rootIssue._id })
      // dueDate is not part of NewIssue; set it on the created issue.
      if (root !== undefined && value.dueDate != null && value.dueDate !== '') {
        const due = Date.parse(value.dueDate)
        if (!isNaN(due)) await client.update(root, { dueDate: due })
      }
      await flush(rootIssue._id)
    }

    for (const { child, i } of planned) {
      const issue = await createIssue(client, target, {
        title: child.title,
        description: child.description,
        priority: child.priority,
        estimation: child.estimation,
        assignee: child.assignee,
        parent: root
      })
      fresh.push(issue)
      if (subtasks[i] !== undefined) subtasks[i] = { ...subtasks[i], createdId: issue._id }
      await flush()
    }

    await appendLinks(fresh)
  }

  // Append the links to THIS message rather than posting a new one: the card itself becomes the
  // record of what was created.
  async function appendLinks (issues: CreatedIssue[]): Promise<void> {
    if (issues.length === 0) return
    const label = await translate(plugin.string.TaskCreated, {})
    const refs = issues
      .map(
        (i) =>
          `[](ref://?_class=${encodeURIComponent(i._class)}&_id=${i._id}&label=${encodeURIComponent(i.identifier)})`
      )
      .join(' ')
    const links = markdownToMarkup(`${label}: ${refs}`, { refUrl: 'ref://', imageUrl: '' })
    const base: MarkupNode =
      value.message !== undefined && value.message !== ''
        ? markupToJSON(value.message)
        : { type: MarkupNodeType.doc, content: [] }
    base.content = [...(base.content ?? []), ...(links.content ?? [])]
    await client.diffUpdate(value, { message: jsonToMarkup(base) })
  }
</script>

<ActivityMessageTemplate
  message={value}
  {person}
  {showNotify}
  {isHighlighted}
  {isSelected}
  {shouldScroll}
  {embedded}
  {withActions}
  {hideFooter}
  {skipLabel}
>
  <svelte:fragment slot="content">
    {#if value.message !== undefined && value.message !== ''}
      <MessageViewer message={value.message} />
    {/if}

    <div class="proposal">
      <Expandable bind:expanded contentColor>
        <svelte:fragment slot="title">
          <span class="caption" data-id="aiTaskProposal">
            <Label label={plugin.string.ProposedTask} params={{ name: $aiBotNameStore }} />
            {#if value.applied === true}
              <span class="applied"><Label label={plugin.string.AssistIssueAppliedMark} /></span>
            {/if}
          </span>
        </svelte:fragment>

        <div class="body" data-id="aiTaskProposalBody">
          {#if !isSplit}
            <div class="title">
              <EditBox
                bind:value={title}
                placeholder={plugin.string.TaskTitle}
                disabled={created}
                fullSize
                on:blur={() => client.diffUpdate(value, { title })}
              />
            </div>
            {#if value.description != null && value.description !== ''}
              <div class="description"><MessageViewer message={toMarkup(value.description)} /></div>
            {/if}
            {#if value.estimation != null && value.estimation > 0}
              <div class="estimation">
                <Label label={plugin.string.ProposedEstimation} params={{ hours: value.estimation }} />
              </div>
            {/if}
          {/if}
          {#if project !== undefined && children.length > 0}
            <!-- The tracker sub-task control, rendered through the registry (no tracker-resources import). -->
            <Component
              is={tracker.component.SubtaskSection}
              props={{
                children,
                project,
                selectable: !created,
                selected,
                doneRows: createdRows,
                showDescription: true,
                listHeight: '40rem',
                readonly: created
              }}
              on:select={onSelect}
              on:update-issues={persistChildren}
              on:update-issue={persistChildren}
            />
          {/if}
        </div>
      </Expandable>

      {#if failure !== undefined}
        <div class="failure">
          <Label label={plugin.string.CreateTaskFailed} />
          <span class="reason">{failure}</span>
        </div>
      {/if}

      <div class="actions">
        {#if created}
          <Button label={plugin.string.TaskCreated} kind={'ghost'} disabled />
        {:else if isDraftSession}
          <!-- Nothing is created here: the create dialog owns the project, and applying belongs on
                 the card next to what is applied. The button shows up only where a form exists. -->
          {#if $issueDraftApplier !== undefined}
            <Button
              label={value.applied === true ? plugin.string.AssistIssueApplyAgain : plugin.string.AssistIssueApply}
              kind={value.applied === true ? 'regular' : 'primary'}
              on:click={applyToDraft}
            />
          {/if}
        {:else}
          <SpaceSelector
            _class={tracker.class.Project}
            query={projectQuery}
            label={core.string.Space}
            bind:space={project}
            focus={false}
            clearInvalidValue={true}
            kind={'regular'}
            size={'large'}
          ></SpaceSelector>
          <Button
            label={plugin.string.CreateTask}
            kind={'primary'}
            loading={creating}
            disabled={creating || project === undefined || (!isSplit && title.trim() === '')}
            on:click={create}
          />
        {/if}
      </div>
    </div>
  </svelte:fragment>
</ActivityMessageTemplate>

<style lang="scss">
  // A card, not a run of chat text: own surface, its own padding, clear bands inside.
  .proposal {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 0.5rem;
    padding: 0.5rem;
    background: var(--theme-comp-header-color);
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.75rem;
  }

  .caption {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .applied {
    color: var(--theme-halfcontent-color);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .title {
    font-size: 1rem;
    font-weight: 500;
    color: var(--theme-caption-color);
  }

  .description {
    color: var(--theme-content-color);
    font-size: 0.875rem;
  }

  .estimation {
    color: var(--theme-dark-color);
    font-size: 0.8125rem;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-top: 0.25rem;
  }

  .failure {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.5rem 0.75rem;
    color: var(--theme-error-color);
    background: var(--theme-bg-color);
    border: 1px solid var(--theme-error-color);
    border-radius: 0.5rem;
    font-size: 0.8125rem;

    .reason {
      color: var(--theme-darker-color);
      word-break: break-word;
    }
  }
</style>

<!--
// Copyright © 2022 Hardcore Engineering Inc.
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
  import { Ref } from '@hcengineering/core'
  import { ActionContext, createQuery, MessageViewer } from '@hcengineering/presentation'
  import { TaskKindSelector } from '@hcengineering/task-resources'
  import tracker, { Component, Issue, IssueTemplateChild, Milestone, Project } from '@hcengineering/tracker'
  import { IconCircles, eventToHTMLElement, showPopup, CheckBox } from '@hcengineering/ui'
  import { FixedColumn } from '@hcengineering/view-resources'
  import { createEventDispatcher } from 'svelte'
  import { flip } from 'svelte/animate'
  import AssigneeEditor from '../issues/AssigneeEditor.svelte'
  import PriorityEditor from '../issues/PriorityEditor.svelte'
  import EstimationEditor from '../templates/EstimationEditor.svelte'
  import SubtaskEditor from './SubtaskEditor.svelte'

  export let issues: IssueTemplateChild[]
  export let project: Ref<Project>
  export let milestone: Ref<Milestone> | null = null
  export let component: Ref<Component> | null = null
  // Optional pick-list mode: a checkbox per row, `selected` holds the ids that stay checked.
  // Used where the list is a proposal the user confirms (AI task card), not a template body.
  export let selectable: boolean = false
  export let selected: Array<Ref<Issue>> = []
  // Show the body under the title - a proposal has to be readable without opening each row.
  export let showDescription: boolean = false
  export let readonly: boolean = false
  export let doneRows = new Set<Ref<Issue>>()

  const dispatch = createEventDispatcher()

  let dragId: Ref<Issue> | null = null
  let dragIndex: number | null = null
  let hoveringIndex: number | null = null

  function openIssue (evt: MouseEvent, target: IssueTemplateChild): void {
    if (readonly) return
    showPopup(
      SubtaskEditor,
      {
        showBorder: true,
        projectId: project,
        milestone,
        component,
        childIssue: target
      },
      eventToHTMLElement(evt),
      (evt: ['update' | 'delete', IssueTemplateChild] | undefined | null) => {
        if (evt != null) {
          const pos = issues.findIndex((it) => it.id === target.id)
          if (pos !== -1) {
            if (evt[0] === 'delete') {
              issues.splice(pos, 1)
              issues = issues
              dispatch('update-issues', issues)
            } else {
              issues[pos] = evt[1]
              dispatch('update-issue', evt[1])
            }
          }
        }
      }
    )
  }

  function toggle (id: Ref<Issue>): void {
    if (doneRows.has(id)) return
    selected = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]
    dispatch('select', selected)
  }

  function resetDrag (): void {
    dragId = null
    dragIndex = null
    hoveringIndex = null
  }

  function handleDragStart (ev: DragEvent, index: number, item: IssueTemplateChild): void {
    if (ev.dataTransfer != null) {
      ev.dataTransfer.effectAllowed = 'move'
      ev.dataTransfer.dropEffect = 'move'
      dragIndex = index
      dragId = item.id
    }
  }

  function handleDrop (ev: DragEvent, toIndex: number): void {
    if (ev.dataTransfer != null && dragIndex !== null && toIndex !== dragIndex) {
      ev.dataTransfer.dropEffect = 'move'

      dispatch('move', { id: dragId, toIndex })
    }

    resetDrag()
  }

  const projectQuery = createQuery()
  $: projectQuery.query(
    tracker.class.Project,
    {
      _id: project
    },
    (res) => {
      ;[currentProject] = res
    }
  )
  let currentProject: Project | undefined = undefined

  function getIssueTemplateId (currentProject: Project | undefined, issue: IssueTemplateChild): string {
    return currentProject !== undefined
      ? `${currentProject.identifier}-${issues.findIndex((it) => it.id === issue.id)}`
      : `${issues.findIndex((it) => it.id === issue.id)}}`
  }
</script>

<ActionContext
  context={{
    mode: 'browser'
  }}
/>

{#each issues as issue, index (issue.id)}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <!-- One wrapper per row: `animate:flip` must be the sole child of a keyed each, and the
       optional description lives under the row. -->
  <div class="item" class:done={doneRows.has(issue.id)} animate:flip={{ duration: 400 }}>
    <div
      class="flex-between row"
      class:is-dragging={issue.id === dragId}
      class:is-dragged-over-up={dragIndex !== null && index < dragIndex && index === hoveringIndex}
      class:is-dragged-over-down={dragIndex !== null && index > dragIndex && index === hoveringIndex}
      draggable={!readonly}
      on:click|self={(evt) => {
        openIssue(evt, issue)
      }}
      on:dragstart={(ev) => {
        handleDragStart(ev, index, issue)
      }}
      on:dragover|preventDefault={() => false}
      on:dragenter={() => (hoveringIndex = index)}
      on:drop|preventDefault={(ev) => {
        handleDrop(ev, index)
      }}
      on:dragend={resetDrag}
    >
      <div class="draggable-container">
        <IconCircles size={'small'} />
      </div>
      <div class="flex-row-center ml-6 clear-mins gap-2">
        {#if selectable}
          <CheckBox
            checked={doneRows.has(issue.id) || selected.includes(issue.id)}
            readonly={doneRows.has(issue.id)}
            on:value={() => {
              toggle(issue.id)
            }}
          />
        {/if}
        <PriorityEditor
          value={issue}
          isEditable={!readonly}
          kind={'list'}
          size={'small'}
          justify={'center'}
          on:change={(evt) => {
            dispatch('update-issue', { id: issue.id, priority: evt.detail })
            issue.priority = evt.detail
          }}
        />
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <span
          class="issuePresenter"
          on:click={(evt) => {
            openIssue(evt, issue)
          }}
        >
          <FixedColumn key={'issue_template_issue'} justify={'left'}>
            {getIssueTemplateId(currentProject, issue)}
          </FixedColumn>
        </span>
        <span
          class="text name"
          title={issue.title}
          on:click={(evt) => {
            openIssue(evt, issue)
          }}
        >
          {issue.title}
        </span>
      </div>
      <div class="flex-center flex-no-shrink">
        <!-- The selector has no readonly mode; in a frozen list there is nothing to pick. -->
        {#if !readonly}
          <TaskKindSelector
            projectType={currentProject?.type}
            kind={'link'}
            bind:value={issue.kind}
            baseClass={tracker.class.Issue}
            on:change={(evt) => {
              dispatch('update-issue', { id: issue.id, kind: evt.detail })
              issue.kind = evt.detail
            }}
          />
        {/if}
        <EstimationEditor
          kind={'link'}
          size={'large'}
          isEditable={!readonly}
          bind:value={issue}
          on:change={(evt) => {
            dispatch('update-issue', { id: issue.id, estimation: evt.detail })
            issue.estimation = evt.detail
          }}
        />
        <AssigneeEditor
          object={{ ...issue, space: project }}
          {readonly}
          on:change={(evt) => {
            dispatch('update-issue', { id: issue.id, assignee: evt.detail })
            issue.assignee = evt.detail
          }}
        />
      </div>
    </div>
    {#if showDescription && issue.description !== undefined && issue.description !== ''}
      <div class="description">
        <MessageViewer message={issue.description} />
      </div>
    {/if}
  </div>
{/each}

<style lang="scss">
  .item {
    border-bottom: 1px solid var(--theme-divider-color);

    // Already created: visibly out of play, so a second run cannot pick it again.
    &.done {
      opacity: 0.6;
    }

    &:last-child {
      border-bottom: none;
    }
  }

  .description {
    padding: 0.25rem 1rem 0.75rem 4rem;
    color: var(--theme-darker-color);
    font-size: 0.8125rem;
    line-height: 1.25rem;
  }

  .row {
    position: relative;

    .text {
      font-weight: 500;
      color: var(--theme-caption-color);
    }

    .issuePresenter {
      flex-shrink: 0;
      min-width: 0;
      min-height: 0;
      color: var(--theme-content-color);
      cursor: pointer;

      &:hover {
        color: var(--theme-caption-color);
        text-decoration: underline;
      }
      &:active {
        color: var(--theme-caption-color);
      }
    }

    .name {
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
    }

    .draggable-container {
      position: absolute;
      display: flex;
      align-items: center;
      top: 50%;
      left: 0.125rem;
      width: 1rem;
      height: 1rem;
      opacity: 0;
      transform: translateY(-50%);
      transition: opacity 0.1s;
      cursor: grabbing;
    }

    &:hover .draggable-container {
      opacity: 0.4;
    }

    &.is-dragging::before {
      position: absolute;
      content: '';
      background-color: var(--theme-divider-color);
      inset: 0;
      z-index: -1;
    }

    &.is-dragged-over-up::before {
      position: absolute;
      content: '';
      inset: 0;
      border-top: 1px solid var(--theme-caret-color);
    }
    &.is-dragged-over-down::before {
      position: absolute;
      content: '';
      inset: 0;
      border-bottom: 1px solid var(--theme-caret-color);
    }
  }
</style>

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
  import { Ref } from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import { TaskType } from '@hcengineering/task'
  import {
    Button,
    ButtonIcon,
    Icon,
    IconError,
    IconInfo,
    Label,
    ModernCheckbox,
    showPopup,
    Toggle,
    tooltip
  } from '@hcengineering/ui'
  import setting from '@hcengineering/setting'
  import tracker from '@hcengineering/tracker'

  import task from '../../plugin'
  import TaskTypeIcon from './TaskTypeIcon.svelte'
  import TaskTypeDiagramPopup from './TaskTypeDiagramPopup.svelte'

  export let taskType: TaskType
  export let taskTypes: TaskType[] = []
  export let readonly: boolean = false

  const client = getClient()

  $: isRootTaskType = taskType.isRootTaskType !== false
  $: allowAnyParent = taskType.allowAnyParent === true
  $: allowedAsChildOf = taskType.allowedAsChildOf ?? []

  $: sortedTaskTypes = [...taskTypes].sort((a, b) => a.name.localeCompare(b.name))

  $: hasWarning = !isRootTaskType && !allowAnyParent && allowedAsChildOf.length === 0

  async function handleAllowRootChange (val: boolean): Promise<void> {
    if (readonly) return
    await client.diffUpdate(taskType, { isRootTaskType: val })
  }

  async function handleAllowAnyParentToggle (val: boolean): Promise<void> {
    if (readonly) return
    if (val) {
      await client.diffUpdate(taskType, { allowAnyParent: true, allowedAsChildOf: taskTypes.map((t) => t._id) })
    } else {
      await client.diffUpdate(taskType, { allowAnyParent: false, allowedAsChildOf: taskTypes.map((t) => t._id) })
    }
  }

  async function toggleParent (parentId: Ref<TaskType>): Promise<void> {
    if (readonly) return
    if (allowAnyParent) {
      const newParents = taskTypes.filter((t) => t._id !== parentId).map((t) => t._id)
      await client.diffUpdate(taskType, { allowAnyParent: false, allowedAsChildOf: newParents })
      return
    }

    const isSelected = allowedAsChildOf.includes(parentId)
    const newParents = isSelected ? allowedAsChildOf.filter((id) => id !== parentId) : [...allowedAsChildOf, parentId]

    const isAll = newParents.length === taskTypes.length
    await client.diffUpdate(taskType, { allowAnyParent: isAll, allowedAsChildOf: newParents })
  }

  async function selectAllParents (): Promise<void> {
    if (readonly) return
    const allIds = taskTypes.map((t) => t._id)
    await client.diffUpdate(taskType, { allowAnyParent: true, allowedAsChildOf: allIds })
  }

  async function clearAllParents (): Promise<void> {
    if (readonly) return
    await client.diffUpdate(taskType, {
      allowAnyParent: false,
      allowedAsChildOf: []
    })
  }

  function getConnectedTaskTypes (target: TaskType, allTypes: TaskType[]): TaskType[] {
    const typeMap = new Map<Ref<TaskType>, TaskType>()
    for (const t of allTypes) {
      typeMap.set(t._id, t)
    }

    const connectedIds = new Set<Ref<TaskType>>()
    connectedIds.add(target._id)

    // 1. Ancestors: all types that target or its ancestors can be a child of
    const upQueue: Ref<TaskType>[] = [target._id]
    const visitedUp = new Set<Ref<TaskType>>([target._id])

    while (upQueue.length > 0) {
      const currentId = upQueue.shift()
      if (currentId === undefined) continue
      const current = typeMap.get(currentId)
      if (current === undefined) continue

      const parents = (current.allowedAsChildOf ?? []).filter((p) => p !== current._id)
      for (const parentId of parents) {
        if (typeMap.has(parentId)) {
          connectedIds.add(parentId)
          if (!visitedUp.has(parentId)) {
            visitedUp.add(parentId)
            upQueue.push(parentId)
          }
        }
      }
    }

    // 2. Descendants: all types that can be a child of target or its descendants
    const downQueue: Ref<TaskType>[] = [target._id]
    const visitedDown = new Set<Ref<TaskType>>([target._id])

    while (downQueue.length > 0) {
      const currentId = downQueue.shift()
      if (currentId === undefined) continue

      for (const candidate of allTypes) {
        if (candidate._id === currentId) continue

        const isDirectChild = (candidate.allowedAsChildOf ?? []).includes(currentId)
        const isUniversalChild = candidate.allowAnyParent === true

        if (isDirectChild || isUniversalChild) {
          connectedIds.add(candidate._id)
          if (!visitedDown.has(candidate._id)) {
            visitedDown.add(candidate._id)
            if (!isUniversalChild) {
              downQueue.push(candidate._id)
            }
          }
        }
      }
    }

    return allTypes.filter((t) => connectedIds.has(t._id))
  }

  function handleShowDiagram (): void {
    const connectedTypes = getConnectedTaskTypes(taskType, taskTypes)
    showPopup(TaskTypeDiagramPopup, { taskTypes: connectedTypes, focusTypeId: taskType._id }, 'centered')
  }
</script>

<div class="hierarchy-section flex-column gap-3 w-full">
  <!-- Single Unified Hierarchy Card -->
  <div class="hulyTableAttr-container w-full">
    <!-- Header of the Card -->
    <div class="hulyTableAttr-header font-medium-12">
      <div class="header-left flex-row-center gap-1-5">
        <Icon icon={setting.icon.Clazz} size="small" />
        <span class="header-title"><Label label={task.string.HierarchyRelations} /></span>
      </div>

      <div class="header-right flex-row-center gap-2">
        {#if hasWarning}
          <div class="header-error-badge" use:tooltip={{ label: task.string.HierarchyWarningNoParentAndNoRoot }}>
            <Icon icon={IconError} size="small" />
            <span class="error-text"><Label label={task.string.HierarchyWarningShort} /></span>
          </div>
        {/if}

        <ButtonIcon
          icon={task.icon.TypeHierarchy}
          tooltip={{ label: task.string.TaskTypesDiagram, direction: 'bottom' }}
          size="small"
          kind="tertiary"
          on:click={handleShowDiagram}
        />
      </div>
    </div>

    <div class="hulyTableAttr-content flex-column w-full">
      <!-- 1. Allow Root Task Toggle Row -->
      <div class="root-toggle-row w-full">
        <div class="title-wrapper">
          <span class="font-medium-14 title-text">
            <Label label={task.string.AllowRootTask} />
          </span>
          <span class="font-normal-12 subtitle-text">
            <Label label={task.string.AllowRootTaskTooltip} />
          </span>
        </div>
        <div class="toggle-slot">
          <Toggle
            on={isRootTaskType}
            disabled={readonly}
            on:change={(evt) => {
              void handleAllowRootChange(evt.detail)
            }}
          />
        </div>
      </div>

      <!-- 2. Parents Section Header with Action Buttons -->
      <div class="parents-subheader w-full">
        <span class="subheader-title font-medium-13">
          <Icon icon={tracker.icon.Subissue} size="small" />
          <Label label={task.string.AllowedParentTaskTypes} />
        </span>
        {#if !readonly && taskTypes.length > 0}
          <div class="actions-group">
            <Button kind="ghost" size="small" on:click={selectAllParents}>
              <Label slot="content" label={task.string.SelectAll} />
            </Button>
            <span class="actions-divider">•</span>
            <Button kind="ghost" size="small" on:click={clearAllParents}>
              <Label slot="content" label={task.string.ClearAll} />
            </Button>
          </div>
        {/if}
      </div>

      <!-- 3. Master "Any task type" Row -->
      <button
        type="button"
        class="task-type-row master-row w-full"
        class:checked-row={allowAnyParent}
        disabled={readonly}
        on:click={() => {
          void handleAllowAnyParentToggle(!allowAnyParent)
        }}
      >
        <span class="checkbox-slot">
          <ModernCheckbox checked={allowAnyParent} disabled={readonly} />
        </span>
        <span class="label-wrapper flex-row-center gap-1-5">
          <span class="font-medium-14 label-text">
            <Label label={task.string.AllowAnyParent} />
          </span>
          <span class="info-slot" use:tooltip={{ label: task.string.AllowAnyParentTooltip }}>
            <IconInfo size="small" />
          </span>
        </span>
      </button>

      <!-- 4. Task Types Rows -->
      {#each sortedTaskTypes as candidate (candidate._id)}
        {@const isParent = allowAnyParent || allowedAsChildOf.includes(candidate._id)}
        {@const isSelf = candidate._id === taskType._id}
        <button
          type="button"
          class="task-type-row w-full"
          class:checked-row={isParent}
          disabled={readonly}
          on:click={() => {
            void toggleParent(candidate._id)
          }}
        >
          <span class="checkbox-slot">
            <ModernCheckbox checked={isParent} disabled={readonly} />
          </span>
          <span class="icon-slot">
            <TaskTypeIcon value={candidate} size="small" />
          </span>
          <span class="font-medium-14 label-text">
            {candidate.name}
          </span>
          {#if isSelf}
            <span class="self-pill font-normal-11">
              <Label label={task.string.SameTypeNesting} />
            </span>
          {/if}
        </button>
      {/each}
    </div>
  </div>
</div>

<style lang="scss">
  .hierarchy-section {
    width: 100%;
  }

  .hulyTableAttr-container {
    overflow: hidden;
    border-radius: var(--large-BorderRadius, 0.75rem);
  }

  .w-full {
    width: 100%;
    box-sizing: border-box;
  }

  .header-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    color: var(--global-secondary-TextColor);
  }

  .root-toggle-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--spacing-2) var(--spacing-2_5);
    background: transparent;
    border-bottom: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.08));

    .title-wrapper {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.25rem;
      flex-grow: 1;
    }

    .title-text {
      color: var(--global-primary-TextColor);
      display: block;
      line-height: 1.25rem;
    }

    .subtitle-text {
      color: var(--global-secondary-TextColor);
      display: block;
      line-height: 1rem;
    }

    .toggle-slot {
      margin-left: 1rem;
      flex-shrink: 0;
    }
  }

  .parents-subheader {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--spacing-2) var(--spacing-2_5);
    background: var(--theme-table-row-color);
    border-bottom: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.08));

    .subheader-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      font-weight: 500;
      text-transform: uppercase;
      color: var(--global-secondary-TextColor);
    }

    .actions-group {
      display: flex;
      align-items: center;
      gap: 0.375rem;

      .actions-divider {
        color: var(--global-secondary-TextColor);
        font-size: 0.75rem;
        user-select: none;
      }
    }
  }

  .task-type-row {
    width: 100%;
    cursor: pointer;
    border: none;
    border-bottom: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.08));
    text-align: left;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    padding: var(--spacing-1_5) var(--spacing-2_5);
    min-height: 2.375rem;
    box-sizing: border-box;
    transition: background-color 0.15s ease-in-out;

    &:hover:not(:disabled) {
      background: var(
        --global-ui-hover-BackgroundColor,
        var(--global-surface-01-hover-BackgroundColor, rgba(0, 0, 0, 0.04))
      );
    }

    &:last-child {
      border-bottom: none;
    }

    .checkbox-slot {
      display: flex;
      align-items: center;
      margin-right: 0.75rem;
      flex-shrink: 0;
      pointer-events: none;
    }

    .icon-slot {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 1.25rem;
      height: 1.25rem;
      margin-right: 0.75rem;
      flex-shrink: 0;
      overflow: hidden;
      color: var(--global-primary-TextColor);

      :global(svg) {
        width: 1rem;
        height: 1rem;
      }
    }

    .label-wrapper {
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }

    .label-text {
      color: var(--theme-text-primary, var(--global-primary-TextColor));
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.25rem;
    }

    .info-slot {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      color: var(--button-primary-loading-LabelColor);
      cursor: help;
      transition: color 0.15s ease-in-out;
      flex-shrink: 0;

      &:hover {
        color: var(--global-primary-LinkColor, #3566e2);
      }
    }

    .self-pill {
      display: inline-flex;
      align-items: center;
      margin-left: 0.625rem;
      padding: 0.0625rem 0.4375rem;
      background: transparent;
      border: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.12));
      color: var(--theme-text-secondary, var(--global-secondary-TextColor));
      border-radius: 4px;
      font-size: 0.6875rem;
      line-height: 1.2;
      font-weight: 500;
      letter-spacing: 0.01em;
      flex-shrink: 0;
    }
  }

  .header-error-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.5rem;
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.25);
    border-radius: 999px;
    color: var(--global-negative-TextColor, #ef4444);
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: none;
    letter-spacing: normal;
    cursor: help;
    transition: background-color 0.15s ease-in-out;

    span {
      margin-left: 0 !important;
      flex-grow: 0 !important;
    }

    &:hover {
      background: rgba(239, 68, 68, 0.14);
    }

    .error-text {
      color: var(--global-negative-TextColor, #ef4444);
      margin-left: 0 !important;
      flex-grow: 0 !important;
    }
  }
</style>

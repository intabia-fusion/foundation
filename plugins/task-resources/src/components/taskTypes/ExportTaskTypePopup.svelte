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
  import { copyTextToClipboard, getClient, getCurrentWorkspaceUuid, IconDownload } from '@hcengineering/presentation'
  import {
    TaskType,
    TaskTypeDependencyItem,
    exportTaskTypeConfig,
    getConnectedTaskTypesWithDependencies
  } from '@hcengineering/task'
  import ui, {
    ButtonBase,
    DropdownIntlItem,
    IconCopy,
    IconInfo,
    Label,
    Modal,
    ModernCheckbox,
    ModernDropdown
  } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import { Severity, Status, setPlatformStatus } from '@hcengineering/platform'

  import plugin from '../../plugin'
  import TaskTypeIcon from './TaskTypeIcon.svelte'

  export let taskType: TaskType
  export let taskTypes: TaskType[] = []

  interface GroupedReasons {
    parentOf: Ref<TaskType>[]
    childOf: Ref<TaskType>[]
    universalChild?: boolean
  }

  const client = getClient()
  const dispatch = createEventDispatcher()

  let isCopying = false
  let isExporting = false

  let dependencyItems: TaskTypeDependencyItem[] = []
  $: dependencyItems = taskType != null ? getConnectedTaskTypesWithDependencies(taskType, taskTypes ?? []) : []

  let selectedRelatedIds = new Set<Ref<TaskType>>()
  let relatedItems: TaskTypeDependencyItem[] = []

  $: {
    relatedItems = (dependencyItems ?? []).filter((it) => it.taskType._id !== taskType?._id)
    selectedRelatedIds = new Set<Ref<TaskType>>(relatedItems.map((it) => it.taskType._id))
  }
  $: hasHierarchy = relatedItems.length > 0

  let exportMode: 'single' | 'hierarchy' = 'single'

  let modeItems: DropdownIntlItem[] = []
  $: modeItems = [
    { id: 'single', label: plugin.string.ExportSingleTaskType },
    { id: 'hierarchy', label: plugin.string.ExportHierarchy }
  ]

  $: selectedCount = exportMode === 'hierarchy' ? 1 + selectedRelatedIds.size : 1
  $: taskTypesMap = new Map<Ref<TaskType>, TaskType>([taskType, ...(taskTypes ?? [])].map((t) => [t._id, t]))

  function toggleRelated (typeId: Ref<TaskType>): void {
    if (selectedRelatedIds.has(typeId)) {
      selectedRelatedIds.delete(typeId)
    } else {
      selectedRelatedIds.add(typeId)
    }
    selectedRelatedIds = new Set(selectedRelatedIds)
  }

  function selectAll (): void {
    selectedRelatedIds = new Set<Ref<TaskType>>((relatedItems ?? []).map((it) => it.taskType._id))
  }

  function deselectAll (): void {
    selectedRelatedIds = new Set()
  }

  async function handleExport (): Promise<void> {
    if (isExporting) return
    isExporting = true
    try {
      const typesToExport =
        exportMode === 'single'
          ? [taskType]
          : [taskType, ...relatedItems.filter((d) => selectedRelatedIds.has(d.taskType._id)).map((d) => d.taskType)]

      const config = await exportTaskTypeConfig(client, typesToExport, {
        mode: exportMode,
        taskTypeName: taskType.name,
        taskTypeId: taskType._id,
        workspace: getCurrentWorkspaceUuid(),
        projectTypeId: taskType.parent
      })

      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const suffix = exportMode === 'hierarchy' ? 'task-type-hierarchy' : 'task-type'
      a.download = `${taskType.name}.${suffix}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      dispatch('close')
    } catch (err) {
      console.error('Failed to export task type', err)
      await setPlatformStatus(
        new Status(Severity.ERROR, plugin.status.ExportTaskTypeError, {}, undefined, { timeout: 5000 })
      )
    } finally {
      isExporting = false
    }
  }

  function formatTypeNames (ids: Ref<TaskType>[]): string {
    return ids.map((id) => taskTypesMap.get(id)?.name ?? id).join(', ')
  }

  function groupReasons (reasons: TaskTypeDependencyItem['reasons']): GroupedReasons {
    const parentOf: Ref<TaskType>[] = []
    const childOf: Ref<TaskType>[] = []
    const seenParentIds = new Set<Ref<TaskType>>()
    const seenChildIds = new Set<Ref<TaskType>>()
    let universalChild = false

    for (const r of reasons ?? []) {
      if (r.role === 'parent' && !seenParentIds.has(r.id)) {
        seenParentIds.add(r.id)
        parentOf.push(r.id)
      } else if (r.role === 'child') {
        if (r.universal === true) {
          universalChild = true
        } else if (!seenChildIds.has(r.id)) {
          seenChildIds.add(r.id)
          childOf.push(r.id)
        }
      }
    }

    return { parentOf, childOf, universalChild }
  }

  function handleModeSelected (val: DropdownIntlItem['id'] | Array<DropdownIntlItem['id']> | undefined): void {
    if (isExporting || isCopying) return
    const v = Array.isArray(val) ? val[0] : val
    if (v == null) return
    exportMode = v === 'single' ? 'single' : 'hierarchy'
  }

  async function handleCopyToClipboard (): Promise<void> {
    if (isExporting || isCopying) return
    isCopying = true
    try {
      const typesToExport =
        exportMode === 'single'
          ? [taskType]
          : [taskType, ...relatedItems.filter((d) => selectedRelatedIds.has(d.taskType._id)).map((d) => d.taskType)]

      const config = await exportTaskTypeConfig(client, typesToExport, {
        mode: exportMode,
        taskTypeName: taskType.name,
        taskTypeId: taskType._id,
        workspace: getCurrentWorkspaceUuid(),
        projectTypeId: taskType.parent
      })

      await copyTextToClipboard(JSON.stringify(config, null, 2))
      dispatch('close')
    } catch (err) {
      console.error('Failed to copy task type config to clipboard', err)
      await setPlatformStatus(
        new Status(Severity.ERROR, plugin.status.ClipboardCopyError, {}, undefined, { timeout: 5000 })
      )
    } finally {
      isCopying = false
    }
  }

  function handleClose (): void {
    dispatch('close')
  }
</script>

<Modal
  type="type-popup"
  width="medium"
  maxWidth="36rem"
  label={plugin.string.ExportTaskTypeDialogTitle}
  labelProps={{ name: taskType.name }}
  hideFooter={true}
  onCancel={handleClose}
>
  <div class="export-dialog-body flex-col flex-gap-4">
    <!-- Export Mode Field: Label and Dropdown on one row, Description with IconInfo below -->
    <div class="mode-section flex-col flex-gap-2">
      <div class="hulyModal-content__settingsSet" style="padding: 0;">
        <div class="hulyModal-content__settingsSet-line" style="border: 0;padding-top: 0; padding-bottom: 0">
          <span class="label no-word-wrap"> <Label label={plugin.string.ExportMode} /></span>
          <div class="dropdown-container">
            <ModernDropdown
              items={modeItems}
              bind:selected={exportMode}
              kind="secondary"
              size="large"
              withSearch={false}
              wrap={true}
              width="100%"
              justify="left"
              on:selected={(evt) => {
                handleModeSelected(evt.detail)
              }}
            />
          </div>
        </div>
        <!-- Hint banner styled like workflow validators -->
        <div class="mode-hint">
          <div class="mode-hint-icon">
            <IconInfo size="small" />
          </div>
          <span class="mode-hint-text">
            {#if exportMode === 'hierarchy'}
              {#if hasHierarchy}
                <Label label={plugin.string.ExportHierarchyDescription} />
              {:else}
                <Label label={plugin.string.NoConnectedTaskTypes} />
              {/if}
            {:else}
              <Label label={plugin.string.ExportSingleTaskTypeDescription} />
            {/if}
          </span>
        </div>
      </div>
    </div>

    <!-- Connected Task Types (when Hierarchy is selected) -->
    {#if exportMode === 'hierarchy' && hasHierarchy}
      <div class="hierarchy-card flex-col">
        <div class="hierarchy-header flex-row-center justify-between">
          <span class="hierarchy-title font-medium-11">
            <Label label={plugin.string.TaskTypes} />
            <span class="count-pill font-normal-11">
              {selectedRelatedIds.size} / {relatedItems.length}
            </span>
          </span>
          <div class="header-actions flex-row-center flex-gap-1">
            <button
              type="button"
              class="btn-link font-normal-12"
              class:disabled={selectedRelatedIds.size === relatedItems.length}
              disabled={selectedRelatedIds.size === relatedItems.length}
              on:click={selectAll}
            >
              <Label label={plugin.string.SelectAll} />
            </button>
            <span class="dot-sep">•</span>
            <button
              type="button"
              class="btn-link font-normal-12"
              class:disabled={selectedRelatedIds.size === 0}
              disabled={selectedRelatedIds.size === 0}
              on:click={deselectAll}
            >
              <Label label={plugin.string.DeselectAll} />
            </button>
          </div>
        </div>

        <div class="hierarchy-list flex-col">
          {#each relatedItems as item (item.taskType._id)}
            {@const isChecked = selectedRelatedIds.has(item.taskType._id)}
            {@const grp = groupReasons(item.reasons)}
            <div
              class="type-row flex-row-center"
              class:checked={isChecked}
              class:unchecked={!isChecked}
              on:click={() => {
                toggleRelated(item.taskType._id)
              }}
            >
              <div class="checkbox-slot" on:click|stopPropagation>
                <ModernCheckbox
                  checked={isChecked}
                  on:change={() => {
                    toggleRelated(item.taskType._id)
                  }}
                />
              </div>
              <div class="icon-slot">
                <TaskTypeIcon value={item.taskType} size="small" />
              </div>
              <span class="type-name font-medium-13">{item.taskType.name}</span>
              <div class="relations-wrap">
                {#if grp.parentOf.length > 0}
                  <span class="relation-badge">
                    <span class="badge-role"><Label label={plugin.string.ParentOf} />:</span>
                    <span class="badge-names">{formatTypeNames(grp.parentOf)}</span>
                  </span>
                {/if}
                {#if grp.universalChild}
                  <span class="relation-badge">
                    ↳ <Label label={plugin.string.UniversalChildRelation} />
                  </span>
                {:else if grp.childOf.length > 0}
                  <span class="relation-badge">
                    <span class="badge-role">↳ <Label label={plugin.string.ChildOf} />:</span>
                    <span class="badge-names">{formatTypeNames(grp.childOf)}</span>
                  </span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <div slot="afterContent" class="export-footer">
    <ButtonBase type="type-button" kind="secondary" size="medium" label={ui.string.Cancel} on:click={handleClose} />
    <div class="export-actions">
      <ButtonBase
        type="type-button"
        kind="primary"
        size="medium"
        icon={IconCopy}
        label={plugin.string.CopyToClipboard}
        loading={isCopying}
        disabled={selectedCount === 0 || isExporting || isCopying}
        on:click={handleCopyToClipboard}
      />
      <ButtonBase
        type="type-button"
        kind="primary"
        size="medium"
        icon={IconDownload}
        label={plugin.string.ExportToFile}
        loading={isExporting}
        disabled={selectedCount === 0 || isExporting || isCopying}
        on:click={handleExport}
      />
    </div>
  </div>
</Modal>

<style lang="scss">
  :global(.hulyModal-container.type-popup) {
    height: auto;
  }

  .export-footer {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
    padding: var(--spacing-1_5);
    border-top: 1px solid var(--theme-popup-divider);
    flex-shrink: 0;
  }

  .export-actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--spacing-1);
  }

  .export-dialog-body {
    width: 100%;
    box-sizing: border-box;
  }

  .mode-section {
    width: 100%;
    box-sizing: border-box;
  }

  .dropdown-container {
    flex: 1;
    min-width: 0;
    max-width: 22rem;

    :global(button) {
      width: 100%;
      justify-content: space-between;
    }
  }

  .mode-hint {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.875rem;
    border: 1px solid var(--theme-divider-color);
    border-radius: var(--border-radius-1, 0.5rem);
    background-color: var(--global-ui-highlight-BackgroundColor, var(--theme-table-row-color, var(--theme-card-bg)));
    box-sizing: border-box;
    width: 100%;
  }

  .mode-hint-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--theme-secondary-color);
    flex-shrink: 0;
  }

  .mode-hint-text {
    font-size: 0.8125rem;
    line-height: 1.35;
    color: var(--theme-secondary-color);
    flex: 1;
    min-width: 0;
  }

  .hierarchy-card {
    width: 100%;
    box-sizing: border-box;
    border-radius: var(--border-radius-1, 0.75rem);
    border: 1px solid var(--theme-divider-color);
    background: var(--theme-card-bg);
    overflow: hidden;
  }

  .hierarchy-header {
    width: 100%;
    box-sizing: border-box;
    padding: 0.55rem 1rem;
    background: var(--theme-table-row-color, var(--theme-item-hover-bg));
    border-bottom: 1px solid var(--theme-divider-color);
  }

  .hierarchy-title {
    color: var(--theme-caption-color);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .count-pill {
    display: inline-flex;
    align-items: center;
    padding: 0.05rem 0.4rem;
    border-radius: 0.4rem;
    background: var(--theme-card-bg);
    color: var(--theme-secondary-color);
    border: 1px solid var(--theme-divider-color);
    text-transform: none;
    letter-spacing: normal;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .btn-link {
    background: none;
    border: none;
    padding: 0.15rem 0.4rem;
    border-radius: 0.25rem;
    color: var(--theme-accent-color);
    cursor: pointer;
    transition: all 0.1s ease;

    &:hover:not(.disabled) {
      background: rgba(var(--theme-accent-rgb, 100, 80, 240), 0.08);
    }

    &.disabled {
      color: var(--theme-caption-color);
      cursor: default;
      opacity: 0.6;
    }
  }

  .dot-sep {
    color: var(--theme-divider-color);
    font-size: 8px;
  }

  .hierarchy-list {
    width: 100%;
    box-sizing: border-box;
    max-height: 14rem;
    overflow-y: auto;
  }

  .type-row {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 1rem;
    min-height: 2.875rem;
    border-bottom: 1px solid var(--theme-divider-color);
    cursor: pointer;
    transition: all 0.12s ease;

    &:hover {
      background: var(--theme-item-hover-bg);
    }

    &.unchecked {
      opacity: 0.5;

      .type-name {
        color: var(--theme-secondary-color);
      }
    }

    &:last-child {
      border-bottom: none;
    }
  }

  .checkbox-slot {
    display: flex;
    align-items: center;
    margin-right: 0.75rem;
    flex-shrink: 0;
  }

  .icon-slot {
    display: flex;
    align-items: center;
    margin-right: 0.625rem;
    flex-shrink: 0;
  }

  .type-name {
    color: var(--theme-content-color);
    flex-shrink: 0;
    margin-right: 0.75rem;
    transition: color 0.12s ease;
  }

  .relations-wrap {
    margin-left: auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: center;
    gap: 0.25rem;
    max-width: 65%;
  }

  .relation-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.55rem;
    border-radius: 0.375rem;
    font-size: 11px;
    line-height: 1.3;
    white-space: nowrap;
    border: 1px solid var(--theme-divider-color);
    background: var(--theme-card-bg);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
    flex-shrink: 0;
  }

  .badge-role {
    font-weight: 600;
    color: var(--theme-secondary-color);
  }

  .badge-names {
    color: var(--theme-content-color);
    font-weight: 400;
  }
</style>

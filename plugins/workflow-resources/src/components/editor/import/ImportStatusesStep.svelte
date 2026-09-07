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
  import type { Ref, Status } from '@hcengineering/core'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import type { ProjectType, TaskType } from '@hcengineering/task'
  import { StatePresenter, taskTypeStore } from '@hcengineering/task-resources'
  import ui, {
    type DropdownIntlItem,
    IconCheck,
    IconChevronDown,
    IconError,
    Label,
    ModernCheckbox,
    ModernDropdown
  } from '@hcengineering/ui'
  import { statusStore } from '@hcengineering/view-resources'
  import type { WorkflowCompatibilityReport } from '@hcengineering/workflow'

  import plugin from '../../../plugin'
  import { getSourceStatusDoc, hasDuplicateTargetStatuses } from './utils'

  export let projectType: ProjectType
  export let selectedTaskTypeId: Ref<TaskType> | undefined = undefined
  export let report: WorkflowCompatibilityReport | null = null
  export let statusMap: Record<Ref<Status>, Ref<Status> | undefined> = {}
  export let createMissingStatuses: boolean = true

  let showAffectedTransitions = false

  $: duplicateTargetStatuses = hasDuplicateTargetStatuses(statusMap)

  $: targetTaskType = selectedTaskTypeId !== undefined ? $taskTypeStore.get(selectedTaskTypeId) : undefined

  $: targetTaskTypeStatuses = ((): Status[] => {
    if (targetTaskType?.statuses !== undefined && targetTaskType.statuses.length > 0) {
      return targetTaskType.statuses
        .map((sId) => $statusStore.byId.get(sId))
        .filter((s): s is Status => s !== undefined)
    }
    return $statusStore.array
  })()

  $: targetStatusItems = targetTaskTypeStatuses.map(
    (st): DropdownIntlItem => ({
      id: st._id,
      label: getEmbeddedLabel(st.name),
      component: StatePresenter,
      componentProps: {
        value: st,
        projectType: projectType._id,
        taskType: selectedTaskTypeId,
        size: 'small',
        shouldShowName: true
      }
    })
  )

  $: unmappedStatuses = report?.statuses.filter((s) => statusMap[s.sourceStatusId] === undefined) ?? []

  $: affectedTransitions = (report?.transitions ?? []).filter((t) => {
    const toUnmapped = unmappedStatuses.some((s) => s.sourceStatusId === t.to)
    const fromUnmapped = t.from?.some((f) => unmappedStatuses.some((s) => s.sourceStatusId === f)) ?? false
    return toUnmapped || fromUnmapped
  })

  $: getStatusLabel = (id: Ref<Status>): string =>
    report?.statuses.find((s) => s.sourceStatusId === id)?.sourceName ?? (id as string)

  function getTargetStatusItemsForRow (sourceStatusId: Ref<Status>): DropdownIntlItem[] {
    const selectedInOtherRows = new Set(
      Object.entries(statusMap)
        .filter(([k, v]) => k !== sourceStatusId && v !== undefined)
        .map(([, v]) => v)
    )
    return targetStatusItems.filter((item) => !selectedInOtherRows.has(item.id as Ref<Status>))
  }
</script>

<div class="form-section">
  {#if duplicateTargetStatuses}
    <div class="error-banner flex-row-center flex-gap-2 mb-3">
      <IconError size="small" />
      <span><Label label={plugin.string.DuplicateStatusMappingWarning} /></span>
    </div>
  {:else if report != null && report.statuses.every((s) => statusMap[s.sourceStatusId] !== undefined)}
    <div class="success-banner flex-row-center flex-gap-2 mb-3">
      <div class="success-icon-badge flex-center">
        <IconCheck size="small" />
      </div>
      <span class="font-medium-12">
        <Label label={plugin.string.AllStatusesMatch} />
      </span>
    </div>
  {:else if createMissingStatuses}
    <div class="success-banner flex-row-center flex-gap-2 mb-3">
      <div class="success-icon-badge flex-center">
        <IconCheck size="small" />
      </div>
      <span class="font-medium-12">
        <Label label={plugin.string.MissingStatusesWillBeCreated} />
      </span>
    </div>
  {:else if report != null && report.statuses.some((s) => statusMap[s.sourceStatusId] === undefined)}
    <div class="warning-banner flex-col flex-gap-2 mb-3">
      <div class="flex-between flex-row-center flex-gap-2">
        <div class="flex-row-center flex-gap-2">
          <IconError size="small" />
          <span class="font-medium-12">
            <Label label={plugin.string.UnmappedStatusesWarning} />
          </span>
        </div>
        {#if affectedTransitions.length > 0}
          <button
            type="button"
            class="toggle-details-btn font-medium-12 flex-row-center flex-gap-1"
            on:click={() => {
              showAffectedTransitions = !showAffectedTransitions
            }}
          >
            <span>
              {#if showAffectedTransitions}
                <Label label={plugin.string.Hide} />
              {:else}
                <Label label={plugin.string.Show} /> ({affectedTransitions.length})
              {/if}
            </span>
            <div class="chevron-icon-wrapper flex-center" class:rotated={showAffectedTransitions}>
              <IconChevronDown size="small" />
            </div>
          </button>
        {/if}
      </div>

      {#if showAffectedTransitions && affectedTransitions.length > 0}
        <div class="affected-transitions-scroll flex-col flex-gap-1">
          {#each affectedTransitions as t (t.id)}
            <div class="affected-transition-row flex-between flex-row-center font-regular-12">
              <span class="transition-name font-medium-12">{t.name}</span>
              <span class="transition-flow font-regular-12">
                {#if t.from == null}<Label label={plugin.string.AnyStatus} />{:else}{t.from
                  .map((s) => getStatusLabel(s))
                  .join(', ')}{/if} → {getStatusLabel(t.to)}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <div class="flex-between flex-row-center py-1 mb-2">
    <span class="font-medium-12 color-primary">
      <Label label={plugin.string.CreateMissingStatuses} />
    </span>
    <ModernCheckbox bind:checked={createMissingStatuses} />
  </div>

  {#if report != null && report.statuses.length > 0}
    <div class="mapping-table">
      <div class="mapping-header-row font-medium-12">
        <div><Label label={plugin.string.SourceStatus} /></div>
        <div><Label label={plugin.string.TargetStatus} /></div>
      </div>
      {#each report.statuses as item (item.sourceStatusId)}
        <div class="mapping-grid-row">
          <div class="status-cell flex-row-center">
            {#if getSourceStatusDoc(item, $statusStore) !== undefined}
              <StatePresenter value={getSourceStatusDoc(item, $statusStore)} size="small" />
            {:else}
              <span class="status-badge font-medium-12">{item.sourceName}</span>
            {/if}
          </div>
          <div>
            <ModernDropdown
              items={getTargetStatusItemsForRow(item.sourceStatusId)}
              bind:selected={statusMap[item.sourceStatusId]}
              autoSelect={false}
              placeholder={createMissingStatuses ? plugin.string.WillBeCreated : ui.string.NotSelected}
              justify="left"
              width="100%"
            />
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style lang="scss">
  .form-section {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .success-banner {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 0.875rem;
    border-radius: var(--border-radius-1, 0.5rem);
    background-color: var(--global-success-highlight-BackgroundColor, rgba(46, 160, 67, 0.08));
    border: 1px solid var(--global-success-BorderColor, rgba(46, 160, 67, 0.25));
    color: var(--global-success-TextColor, #2ea043);
    box-sizing: border-box;
    width: 100%;
  }

  .success-icon-badge {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    background-color: rgba(46, 160, 67, 0.15);
    color: #2ea043;
    flex-shrink: 0;
  }

  .warning-banner {
    display: flex;
    padding: 0.625rem 0.875rem;
    border-radius: var(--border-radius-1, 0.5rem);
    background-color: var(--global-warning-highlight-BackgroundColor, rgba(227, 98, 9, 0.08));
    border: 1px solid var(--global-warning-BorderColor, rgba(227, 98, 9, 0.25));
    color: var(--global-warning-TextColor, #e36209);
    box-sizing: border-box;
    width: 100%;
  }

  .toggle-details-btn {
    border: none;
    background: transparent;
    cursor: pointer;
    padding: 0.125rem 0.375rem;
    border-radius: var(--border-radius-1, 0.25rem);
    color: var(--global-warning-TextColor, #e36209);
    opacity: 0.85;
    transition:
      opacity 0.15s ease,
      background-color 0.15s ease;

    &:hover {
      opacity: 1;
      background-color: rgba(227, 98, 9, 0.12);
    }
  }

  .chevron-icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.2s ease;

    &.rotated {
      transform: rotate(180deg);
    }
  }

  .affected-transitions-scroll {
    max-height: 8rem;
    overflow-y: auto;
    padding-top: 0.375rem;
    margin-top: 0.25rem;
    border-top: 1px solid rgba(227, 98, 9, 0.2);
    box-sizing: border-box;
  }

  .affected-transition-row {
    padding: 0.25rem 0.125rem;
    gap: 1rem;
    border-bottom: 1px solid rgba(227, 98, 9, 0.1);

    &:last-child {
      border-bottom: none;
    }
  }

  .transition-name {
    color: var(--theme-content-color, #1a1a1a);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .transition-flow {
    color: var(--theme-secondary-color, rgba(0, 0, 0, 0.6));
    white-space: nowrap;
  }

  .error-banner {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 0.875rem;
    border-radius: var(--border-radius-1, 0.5rem);
    background-color: rgba(218, 54, 51, 0.08);
    border: 1px solid rgba(218, 54, 51, 0.25);
    color: #da3633;
    box-sizing: border-box;
  }

  .mapping-table {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-2);
    width: 100%;
  }

  .mapping-header-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    align-items: center;
    gap: 1.5rem;
    color: var(--theme-secondary-color, #666);
    border-bottom: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.08));
    padding: 0 0 0.5rem 0;
    margin-bottom: 0.25rem;
  }

  .mapping-grid-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    align-items: center;
    gap: 1.5rem;
    min-height: 2.25rem;
    padding: 0.25rem 0;
  }

  .status-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    background-color: var(--theme-card-background, rgba(0, 0, 0, 0.05));
    border: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.08));
  }
</style>

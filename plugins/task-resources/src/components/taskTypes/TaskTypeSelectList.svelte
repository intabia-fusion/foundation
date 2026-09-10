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
<!--
  Shared task type checklist used by both the export and the import dialog, so the two stay
  visually identical. Callers normalize their own data (TaskType / TaskTypeConfigEntry) into
  TaskTypeSelectItem and own the selection state.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { IconError, Label, ModernCheckbox, tooltip } from '@hcengineering/ui'

  import plugin from '../../plugin'
  import TaskTypeIcon from './TaskTypeIcon.svelte'
  import { type TaskTypeRelation, type TaskTypeSelectItem } from './types'

  /** Selectable rows. */
  export let items: TaskTypeSelectItem[] = []
  /** Header title; pass false when the caller already labels the section above the card. */
  export let showTitle: boolean = true
  export let selectedIds = new Set<string>()

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  const dispatch = createEventDispatcher<{ toggle: string, selectAll: void, deselectAll: void }>()

  function formatRelations (relations: TaskTypeRelation[]): string {
    return relations.map((r) => r.name).join(', ')
  }

  $: selectedCount = selectedIds.size
  $: totalCount = items.length
</script>

<div class="hierarchy-card flex-col">
  <div class="hierarchy-header flex-row-center justify-between">
    <span class="hierarchy-title font-medium-11">
      {#if showTitle}
        <Label label={plugin.string.TaskTypes} />
      {:else}
        <Label label={plugin.string.Selected} />
      {/if}
      <span class="count-pill font-normal-11">
        {selectedCount} / {totalCount}
      </span>
    </span>
    <div class="header-actions flex-row-center flex-gap-1">
      <button
        type="button"
        class="btn-link font-normal-12"
        class:disabled={selectedIds.size === items.length}
        disabled={selectedIds.size === items.length}
        on:click={() => {
          dispatch('selectAll')
        }}
      >
        <Label label={plugin.string.SelectAll} />
      </button>
      <span class="dot-sep">•</span>
      <button
        type="button"
        class="btn-link font-normal-12"
        class:disabled={selectedIds.size === 0}
        disabled={selectedIds.size === 0}
        on:click={() => {
          dispatch('deselectAll')
        }}
      >
        <Label label={plugin.string.DeselectAll} />
      </button>
    </div>
  </div>

  <div class="hierarchy-list flex-col">
    {#each items as item (item.id)}
      {@const isChecked = selectedIds.has(item.id)}
      <div
        class="type-row flex-row-center"
        class:checked={isChecked}
        class:unchecked={!isChecked}
        on:click={() => {
          dispatch('toggle', item.id)
        }}
      >
        <div class="checkbox-slot" on:click|stopPropagation>
          <ModernCheckbox
            checked={isChecked}
            on:change={() => {
              dispatch('toggle', item.id)
            }}
          />
        </div>
        <div class="icon-slot">
          <TaskTypeIcon value={item.icon} size="small" />
        </div>
        <span class="type-name font-medium-13" use:tooltip={{ label: getEmbeddedLabel(item.name) }}>
          {item.name}
        </span>

        {#if item.exists === true}
          <div class="collision-warning flex-center" use:tooltip={{ label: plugin.string.TaskTypeAlreadyExists }}>
            <IconError size="small" />
          </div>
        {/if}

        <div class="relations-wrap">
          {#if item.parentOf.length > 0}
            {@const parents = formatRelations(item.parentOf)}
            <span class="relation-badge" use:tooltip={{ label: getEmbeddedLabel(parents) }}>
              <span class="badge-role"><Label label={plugin.string.ParentOf} />:</span>
              <span class="badge-names">{parents}</span>
            </span>
          {/if}
          {#if item.universalChild}
            <span class="relation-badge">
              ↳ <Label label={plugin.string.UniversalChildRelation} />
            </span>
          {/if}
          {#if item.childOf.length > 0}
            {@const children = formatRelations(item.childOf)}
            <span class="relation-badge" use:tooltip={{ label: getEmbeddedLabel(children) }}>
              <span class="badge-role">↳ <Label label={plugin.string.ChildOf} />:</span>
              <span class="badge-names">{children}</span>
            </span>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>

<style lang="scss">
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
    // a tall row (several relation badges) must not leave the checkbox, name and warning
    // floating in its vertical middle
    align-items: flex-start;
    // the list is a flex column: without this a row with several relation badges gets squeezed
    // back to min-height and its content spills over the neighbouring rows
    height: auto;
    flex-shrink: 0;
    gap: 0.5rem;
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
    min-height: 1.875rem;
    margin-right: 0.25rem;
    flex-shrink: 0;
  }

  .icon-slot {
    display: flex;
    align-items: center;
    min-height: 1.875rem;
    margin-right: 0.125rem;
    flex-shrink: 0;
  }

  .type-name {
    color: var(--theme-content-color);
    line-height: 1.875rem;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color 0.12s ease;
  }

  .collision-warning {
    width: 1.5rem;
    height: 1.5rem;
    margin-top: 0.1875rem;
    border-radius: 0.375rem;
    color: #e36209;
    background-color: rgba(227, 98, 9, 0.12);
    border: 1px solid rgba(227, 98, 9, 0.35);
    cursor: default;
    flex-shrink: 0;
    opacity: 1 !important;
    transition: all 0.15s ease;

    &:hover {
      background-color: rgba(227, 98, 9, 0.2);
      border-color: rgba(227, 98, 9, 0.6);
    }
  }

  .relations-wrap {
    margin-left: auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: center;
    gap: 0.25rem;
    min-width: 0;
    max-width: 60%;
    flex-shrink: 1;
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
    max-width: 100%;
    min-width: 0;
  }

  .badge-role {
    font-weight: 600;
    color: var(--theme-secondary-color);
    flex-shrink: 0;
    white-space: nowrap;
  }

  .badge-names {
    color: var(--theme-content-color);
    font-weight: 400;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>

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
  import { Status } from '@hcengineering/core'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { StatePresenter } from '@hcengineering/task-resources'
  import { Label, tooltip } from '@hcengineering/ui'
  import { WorkflowTransition } from '@hcengineering/workflow'

  import plugin from '../plugin'

  export let transition: WorkflowTransition
  export let statuses: Status[] = []

  $: fromStatuses = (transition?.from ?? [])
    .map((id) => (statuses ?? []).find((s) => s._id === id))
    .filter((s): s is Status => s != null)

  $: toStatus = (statuses ?? []).find((s) => s._id === transition?.to)

  $: showFromNames = fromStatuses.length <= 2
  $: fromNamesStr = fromStatuses.map((s) => s.name).join(', ') || '*'
  $: tooltipText = `${transition?.name ?? ''}: ${fromNamesStr} → ${toStatus?.name ?? ''}`
</script>

<div class="transition-presenter" use:tooltip={{ label: getEmbeddedLabel(tooltipText), timeout: 600 }}>
  <span class="transition-presenter--name">{transition?.name}</span>
  <span class="transition-presenter--colon">:</span>

  <div class="transition-presenter--statuses-flow">
    {#if fromStatuses.length === 0}
      <span class="transition-presenter--any-status"><Label label={plugin.string.AnyStatus} /></span>
    {:else}
      <div class="transition-presenter--status-list">
        {#each fromStatuses as status, i (status._id)}
          {#if i > 0 && showFromNames}<span class="transition-presenter--separator">,</span>{/if}
          <StatePresenter value={status} shouldShowName={showFromNames} />
        {/each}
      </div>
    {/if}

    <span class="transition-presenter--arrow">→</span>

    {#if toStatus}
      <div class="transition-presenter--to-status">
        <StatePresenter value={toStatus} />
      </div>
    {/if}
  </div>
</div>

<style lang="scss">
  .transition-presenter {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    line-height: 1.25rem;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;

    &--name {
      font-weight: 500;
      color: var(--global-secondary-TextColor) !important;
      text-transform: uppercase;
      max-width: 10rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex-shrink: 1;
      font-size: 0.75rem;
    }

    &--colon {
      color: var(--global-tertiary-TextColor);
      margin-right: 0.125rem;
      flex-shrink: 0;
    }

    &--statuses-flow {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      min-width: 0;
      overflow: hidden;
      flex-shrink: 1;
      color: var(--button-subtle-LabelColor);

      :global(*) {
        text-transform: none !important;
        font-size: 0.85rem !important;
        color: var(--button-subtle-LabelColor) !important;
        text-decoration: none !important;
      }

      :global(*:hover) {
        text-decoration: none !important;
      }
    }

    &--status-list {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      min-width: 0;
      overflow: hidden;
      flex-shrink: 1;
    }

    &--separator {
      color: var(--global-tertiary-TextColor);
      margin-right: 0.125rem;
      flex-shrink: 0;
    }

    &--any-status {
      color: var(--global-secondary-TextColor);
      font-size: 0.85rem;
      flex-shrink: 0;
    }

    &--arrow {
      color: var(--global-tertiary-TextColor) !important;
      font-weight: 600;
      padding: 0 0.125rem;
      flex-shrink: 0;
    }

    &--to-status {
      flex-shrink: 0;
    }
  }
</style>

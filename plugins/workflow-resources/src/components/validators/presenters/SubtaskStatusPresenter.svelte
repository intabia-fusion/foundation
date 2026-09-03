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
  import core, { Ref, Status } from '@hcengineering/core'
  import task, { TaskType } from '@hcengineering/task'
  import { WorkflowValidatorConfig } from '@hcengineering/workflow'
  import { getClient, IconWithEmoji, reduceCalls } from '@hcengineering/presentation'
  import { Icon, languageStore } from '@hcengineering/ui'
  import { StatePresenter, taskTypeStore } from '@hcengineering/task-resources'
  import { translate } from '@hcengineering/platform'
  import view from '@hcengineering/view'

  import plugin from '../../../plugin'

  export let config: WorkflowValidatorConfig

  const client = getClient()
  const allStatuses: Status[] = client.getModel().findAllSync(core.class.Status, {})

  interface RowData {
    taskType: TaskType | undefined
    taskTypeName: string
    statuses: Status[]
    isAny: boolean
  }

  let rows: RowData[] = []
  let anyStatusLabel: string = ''

  const updateAnyStatusLabel = reduceCalls(async (lang: string): Promise<void> => {
    anyStatusLabel = await translate(plugin.string.AnyStatus, {}, lang)
  })

  $: void updateAnyStatusLabel($languageStore)

  $: {
    const res: RowData[] = []
    const statusesProp = config?.props?.statuses
    if (statusesProp != null && typeof statusesProp === 'object') {
      for (const [ttId, stIds] of Object.entries(statusesProp)) {
        const tt = $taskTypeStore.get(ttId as Ref<TaskType>)
        const isAny = stIds === null || (Array.isArray(stIds) && stIds.includes('null'))
        const matchedStatuses =
          Array.isArray(stIds) && !isAny ? allStatuses.filter((s) => (stIds as string[]).includes(s._id)) : []
        res.push({
          taskType: tt,
          taskTypeName: tt?.name ?? ttId,
          statuses: matchedStatuses,
          isAny
        })
      }
    }
    rows = res
  }
</script>

<div class="subtask-status-presenter">
  {#each rows as row (row.taskTypeName)}
    <div class="subtask-status-presenter--row">
      <div class="subtask-status-presenter--label">
        {#if row.taskType?.icon}
          <Icon
            icon={row.taskType.icon === view.ids.IconWithEmoji ? IconWithEmoji : (row.taskType.icon ?? task.icon.Task)}
            iconProps={row.taskType.icon === view.ids.IconWithEmoji ? { icon: row.taskType.color } : {}}
            size="small"
          />
        {/if}
        <span>{row.taskTypeName}:</span>
      </div>

      <div class="subtask-status-presenter--status-list">
        {#if row.isAny}
          <span class="subtask-status-presenter--any-badge">{anyStatusLabel}</span>
        {:else if row.statuses.length > 0}
          {#each row.statuses as st (st._id)}
            <StatePresenter value={st} />
          {/each}
        {:else}
          <span class="subtask-status-presenter--none-badge">—</span>
        {/if}
      </div>
    </div>
  {/each}
</div>

<style lang="scss">
  .subtask-status-presenter {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;

    &--row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    &--label {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--global-secondary-TextColor);

      :global(svg) {
        width: 0.875rem !important;
        height: 0.875rem !important;
        min-width: 0.875rem !important;
        min-height: 0.875rem !important;
        max-width: 0.875rem !important;
        max-height: 0.875rem !important;
        flex-shrink: 0;
      }
    }

    &--status-list {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      flex-wrap: wrap;
    }

    &--any-badge {
      display: inline-flex;
      align-items: center;
      padding: 0.2rem 0.5rem;
      border-radius: 0.375rem;
      font-size: 0.75rem;
      font-weight: 500;
      background-color: var(--global-subtle-ui-BorderColor);
      color: var(--global-secondary-TextColor);
    }

    &--none-badge {
      font-size: 0.75rem;
      color: var(--global-tertiary-TextColor);
    }
  }
</style>

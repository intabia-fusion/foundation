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
  import { createEventDispatcher } from 'svelte'
  import core, { Ref, Status } from '@hcengineering/core'
  import task, { getAllowedParentTaskTypes, TaskType } from '@hcengineering/task'
  import { translate } from '@hcengineering/platform'
  import ui, {
    DropdownTextItem,
    Icon,
    IconInfo,
    IconOpenedArrow,
    Label,
    languageStore,
    ModernDropdownLabels
  } from '@hcengineering/ui'
  import { StatePresenter, taskTypeStore } from '@hcengineering/task-resources'
  import { ParentStatusesProps, ParentStatusesValidatorConfig } from '@hcengineering/workflow'
  import { getClient, IconWithEmoji, reduceCalls } from '@hcengineering/presentation'
  import view from '@hcengineering/view'

  import { navigateToTaskType } from '../../../location'
  import plugin from '../../../plugin'

  type StatusId = Ref<Status> | 'null'

  export let taskType: TaskType
  export let config: ParentStatusesValidatorConfig | undefined = undefined
  export let canSave = false

  const client = getClient()
  const dispatch = createEventDispatcher<{ update: ParentStatusesProps }>()

  const allStatuses: Status[] = client.getModel().findAllSync(core.class.Status, {})

  let statusesMap: Record<Ref<TaskType>, StatusId[]> = {}
  let statusItemsMap: Record<Ref<TaskType>, DropdownTextItem[]> = {}

  $: projectTypeId = taskType.parent
  $: taskTypeId = taskType._id
  $: allTaskTypes = Array.from($taskTypeStore.values())

  $: relevantTaskTypes = getAllowedParentTaskTypes(projectTypeId, taskTypeId, allTaskTypes)

  $: {
    const updated: Record<Ref<TaskType>, StatusId[]> = { ...statusesMap }
    let changed = false
    for (const tt of relevantTaskTypes) {
      if (updated[tt._id] == null) {
        changed = true
        const saved = config?.props?.statuses?.[tt._id]
        if (saved === null || saved === undefined) {
          updated[tt._id] = ['null']
        } else if (Array.isArray(saved)) {
          updated[tt._id] = [...saved]
        }
      }
    }
    if (changed) {
      statusesMap = updated
    }
  }

  const updateStatusItems = reduceCalls(async (taskTypes: TaskType[]): Promise<void> => {
    const map: Record<Ref<TaskType>, DropdownTextItem[]> = {}
    for (const tt of taskTypes) {
      map[tt._id] = await getStatusItems(tt._id)
    }
    statusItemsMap = map
  })

  $: void updateStatusItems(relevantTaskTypes)

  $: {
    const result: ParentStatusesProps['statuses'] = {}
    for (const tt of relevantTaskTypes) {
      const selected = statusesMap[tt._id]
      if (Array.isArray(selected) && selected.includes('null')) {
        result[tt._id] = null
      } else if (Array.isArray(selected) && selected.length > 0) {
        result[tt._id] = selected as Ref<Status>[]
      }
    }
    canSave = relevantTaskTypes.length > 0 && Object.keys(result).length === relevantTaskTypes.length
    dispatch('update', { statuses: result })
  }

  async function getStatusItems (taskId: Ref<TaskType>): Promise<DropdownTextItem[]> {
    const tt = $taskTypeStore.get(taskId)
    const list = allStatuses.filter((s) => tt?.statuses.includes(s._id))
    return [
      {
        id: 'null',
        label: await translate(plugin.string.AnyStatus, {}, $languageStore),
        exclusive: true
      },
      ...list.map(
        (s): DropdownTextItem => ({
          id: s._id,
          label: s.name,
          icon: StatePresenter,
          iconProps: { value: s, shouldShowName: false }
        })
      )
    ]
  }

  function handleStatusChange (
    ttId: Ref<TaskType>,
    selected: DropdownTextItem['id'] | DropdownTextItem['id'][] | undefined | null
  ): void {
    const list = Array.isArray(selected) ? selected.map(String) : selected != null ? [String(selected)] : []
    statusesMap = {
      ...statusesMap,
      [ttId]: list
    }
  }

  function handleConfigureTaskType (): void {
    if (taskType?._id != null) {
      navigateToTaskType(taskType._id, true)
    }
  }
</script>

{#if relevantTaskTypes.length > 0}
  <div class="parent-status">
    <div class="parent-status--header">
      <span class="parent-status--column-title">
        <Label label={task.string.TaskType} />
      </span>
      <span class="parent-status--column-title">
        <Label label={plugin.string.ParentStatusRequired} />
      </span>
    </div>

    <div class="parent-status--rows">
      {#each relevantTaskTypes as tt (tt._id)}
        <div class="parent-status--row">
          <div class="parent-status--task-type">
            {#if tt.icon}
              <Icon
                icon={tt.icon === view.ids.IconWithEmoji ? IconWithEmoji : tt.icon}
                iconProps={tt.icon === view.ids.IconWithEmoji ? { icon: tt.color } : {}}
                size="small"
              />
            {/if}
            <span class="parent-status--task-type-name">{tt.name}</span>
          </div>
          <div class="parent-status--statuses">
            <ModernDropdownLabels
              items={statusItemsMap[tt._id] ?? []}
              selected={statusesMap[tt._id] ?? []}
              multiselect={true}
              wrap={true}
              autoSelect={false}
              placeholder={ui.string.NotSelected}
              justify="left"
              width="100%"
              on:selected={(ev) => {
                handleStatusChange(tt._id, ev.detail)
              }}
            />
          </div>
        </div>
      {/each}
    </div>
  </div>
{:else}
  <button type="button" class="parent-status--hint" on:click={handleConfigureTaskType}>
    <span class="parent-status--hint-icon">
      <Icon icon={IconInfo} size="small" />
    </span>
    <span class="parent-status--hint-text">
      <Label label={plugin.string.NoParentTaskTypesDescription} />
    </span>
    <span class="parent-status--hint-action">
      <span>
        <Label label={plugin.string.ConfigureTaskType} params={{ name: taskType.name }} />
      </span>
      <span class="parent-status--hint-arrow">
        <Icon icon={IconOpenedArrow} size="x-small" />
      </span>
    </span>
  </button>
{/if}

<style lang="scss">
  .parent-status {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;

    &--header {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 1rem;
      align-items: center;
      padding-bottom: 0.375rem;
      border-bottom: 1px solid var(--global-subtle-ui-BorderColor);
    }

    &--column-title {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--global-secondary-TextColor);
    }

    &--rows {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    &--row {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 1rem;
      align-items: center;
    }

    &--task-type {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    &--task-type-name {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--global-primary-TextColor);
    }

    &--statuses {
      display: flex;
      width: 100%;
    }

    &--hint {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.625rem 0.875rem;
      border: 1px solid var(--global-subtle-ui-BorderColor);
      border-radius: var(--medium-BorderRadius);
      background-color: var(--global-ui-highlight-BackgroundColor);
      box-sizing: border-box;
      width: 100%;
      text-align: left;
      cursor: pointer;
      transition:
        background-color 0.15s ease,
        border-color 0.15s ease;

      &:hover {
        background-color: var(--global-ui-active-BackgroundColor);
        border-color: var(--global-subtle-ui-BorderColor);

        .parent-status--hint-action {
          color: var(--primary-color-purple-01, #513ecd);
        }

        .parent-status--hint-arrow {
          transform: translateX(2px);
        }
      }
    }

    &--hint-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--global-secondary-TextColor);
      flex-shrink: 0;
    }

    &--hint-text {
      font-size: 0.8125rem;
      line-height: 1.35;
      color: var(--global-secondary-TextColor);
      flex: 1;
      min-width: 0;
    }

    &--hint-action {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--primary-color-purple-02, #6452db);
      white-space: nowrap;
      flex-shrink: 0;
      transition: color 0.15s ease;
    }

    &--hint-arrow {
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.15s ease;
      flex-shrink: 0;
    }
  }
</style>

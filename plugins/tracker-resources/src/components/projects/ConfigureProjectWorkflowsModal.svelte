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
  import { Ref, SortingOrder } from '@hcengineering/core'
  import { translate } from '@hcengineering/platform'
  import presentation, { createQuery, IconWithEmoji } from '@hcengineering/presentation'
  import task, { ProjectType, TaskType } from '@hcengineering/task'
  import ui, {
    DropdownTextItem,
    Icon,
    Label,
    languageStore,
    Modal,
    ModernDropdownLabels,
    Scroller
  } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import workflow, { Workflow } from '@hcengineering/workflow'

  export let taskTypes: TaskType[]
  export let projectType: Ref<ProjectType>
  export let workflowsMapping: Record<Ref<TaskType>, Ref<Workflow>> = {}

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  const dispatch = createEventDispatcher<{ close: Record<Ref<TaskType>, Ref<Workflow>> | void }>()
  const workflowsQuery = createQuery()

  let localMapping: Record<Ref<TaskType>, Ref<Workflow>> = { ...workflowsMapping }
  let dropdownItemsMap: Record<Ref<TaskType>, DropdownTextItem[]> = {}

  let workflows: Workflow[] = []
  $: workflowsQuery.query(
    workflow.class.Workflow,
    { projectType },
    (res) => {
      workflows = res
    },
    {
      sort: {
        name: SortingOrder.Ascending
      }
    }
  )

  $: void updateWorkflowItems(taskTypes, workflows, $languageStore)

  async function updateWorkflowItems (types: TaskType[], allWorkflows: Workflow[], lang: string): Promise<void> {
    const notSelectedLabel = await translate(ui.string.NotSelected, {}, lang)
    const map: Record<Ref<TaskType>, DropdownTextItem[]> = {}

    for (const tt of types) {
      const taskTypeWorkflows = allWorkflows.filter((w) => w.taskType === tt._id)
      map[tt._id] = [
        { id: 'none', label: notSelectedLabel },
        ...taskTypeWorkflows.map((w) => ({
          id: w._id,
          label: w.name
        }))
      ]
    }
    dropdownItemsMap = map
  }

  function handleWorkflowSelected (
    taskTypeId: Ref<TaskType>,
    selectedId: DropdownTextItem['id'] | DropdownTextItem['id'][] | undefined | null
  ): void {
    const rawId = Array.isArray(selectedId) ? selectedId[0] : selectedId
    const idStr = rawId != null ? String(rawId) : null
    if (idStr != null && idStr !== 'none') {
      localMapping[taskTypeId] = idStr as Ref<Workflow>
    } else {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete localMapping[taskTypeId]
    }
    localMapping = { ...localMapping }
  }

  function handleSave (): void {
    dispatch('close', localMapping)
  }

  function handleCancel (): void {
    dispatch('close')
  }
</script>

<Modal
  type="type-popup"
  label={workflow.string.Workflows}
  okLabel={presentation.string.Save}
  okAction={handleSave}
  canSave
  onCancel={handleCancel}
  scrollableContent={false}
  padding="1rem 0"
  bottomPadding="1rem"
  width="medium"
>
  <div class="hulyModal-content__settingsSet modal-settings-padding">
    <div class="hulyModal-content__settingsSet-line header no-top-border">
      <div class="col-task-type">
        <span class="label font-medium-12">
          <Label label={task.string.TaskType} />
        </span>
      </div>
      <div class="col-workflow">
        <span class="label font-medium-12 mr-20">
          <Label label={workflow.string.Workflow} />
        </span>
      </div>
    </div>
  </div>

  <Scroller padding="0" bottomPadding="3rem">
    <div class="hulyModal-content__settingsSet modal-settings-padding">
      <div class="workflows-list">
        {#each taskTypes as taskType (taskType._id)}
          {@const taskTypeWorkflows = workflows.filter((w) => w.taskType === taskType._id)}
          {@const selectedWfId = localMapping[taskType._id]}
          {@const taskTypeIcon =
            taskType.icon === view.ids.IconWithEmoji ? IconWithEmoji : (taskType.icon ?? task.icon.Task)}
          {@const workflowItems = dropdownItemsMap[taskType._id] ?? []}
          <div class="hulyModal-content__settingsSet-line no-top-border">
            <div class="label col-task-type">
              <Icon
                icon={taskTypeIcon}
                size="small"
                iconProps={taskType.icon === view.ids.IconWithEmoji ? { icon: taskType.color } : {}}
              />
              <span class="task-type-name" title={taskType.name}>{taskType.name}</span>
            </div>
            <div class="col-workflow">
              <ModernDropdownLabels
                dataId={`workflow-for-${taskType.name}`}
                items={workflowItems}
                selected={selectedWfId ?? 'none'}
                placeholder={ui.string.NotSelected}
                disabled={taskTypeWorkflows.length === 0}
                kind="secondary"
                size="large"
                multiselect={false}
                showDropdownIcon={true}
                on:selected={(evt) => {
                  handleWorkflowSelected(taskType._id, evt.detail)
                }}
              />
            </div>
          </div>
        {/each}
      </div>
    </div>
  </Scroller>
</Modal>

<style lang="scss">
  .modal-settings-padding {
    padding: 0 3rem;
  }

  .workflows-list {
    max-height: 30rem;
    display: flex;
    flex-direction: column;
  }

  .col-task-type {
    flex: 1 1 0%;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-right: 0.5rem;

    .task-type-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
  }

  .col-workflow {
    flex: 0 0 14rem;
    width: 14rem;
    min-width: 0;
    display: flex;
    justify-content: flex-end;

    :global(.modern-dropdown-labels-container) {
      width: 100%;
      max-width: 100%;
      min-width: 0;

      :global(.hulyButton) {
        width: 100%;
        max-width: 100%;
        min-width: 0;
      }

      :global(.dropdown-content-wrapper) {
        overflow: hidden;
        min-width: 0;
      }

      :global(.content) {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
        min-width: 0;
      }

      :global(.content > span) {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
      }
    }
  }
</style>

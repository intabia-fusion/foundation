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
  import { Ref } from '@hcengineering/core'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import presentation, { getClient, IconWithEmoji } from '@hcengineering/presentation'
  import { clearSettingsStore } from '@hcengineering/setting-resources'
  import task, { ProjectType, TaskType } from '@hcengineering/task'
  import ui, { Label, Modal, ModernDropdown, ModernEditbox } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { createWorkflow } from '@hcengineering/workflow'

  import plugin from '../plugin'

  export let type: ProjectType
  export let taskTypes: TaskType[]

  const client = getClient()

  let name = ''
  let selectedTaskTypeId: Ref<TaskType> | undefined = undefined

  $: if (selectedTaskTypeId === undefined && taskTypes.length > 0) {
    selectedTaskTypeId = taskTypes[0]._id
  }

  $: taskTypeMenuItems = taskTypes.map((tt) => ({
    id: tt._id,
    label: getEmbeddedLabel(tt.name),
    icon: tt.icon === view.ids.IconWithEmoji ? IconWithEmoji : tt.icon,
    iconProps: { icon: tt.color }
  }))
  $: canSave = name.trim() !== '' && selectedTaskTypeId != null

  async function save (): Promise<void> {
    if (!canSave || selectedTaskTypeId == null) return
    await createWorkflow(client, type._id, selectedTaskTypeId, name.trim())
    clearSettingsStore()
  }
</script>

<Modal
  label={plugin.string.Workflow}
  type="type-aside"
  okAction={save}
  {canSave}
  okLabel={presentation.string.Create}
  on:changeContent
  onCancel={() => {
    clearSettingsStore()
  }}
>
  <div class="hulyModal-content__titleGroup">
    <ModernEditbox bind:value={name} label={plugin.string.WorkflowName} size="large" kind="ghost" autoFocus />
  </div>
  <div class="hulyModal-content__settingsSet">
    <div class="hulyModal-content__settingsSet-line">
      <span class="label">
        <Label label={task.string.TaskType} />
      </span>
      <ModernDropdown
        dataId="workflow-taskType"
        items={taskTypeMenuItems}
        bind:selected={selectedTaskTypeId}
        kind="secondary"
        size="medium"
        placeholder={ui.string.NotSelected}
        showDropdownIcon
      />
    </div>
  </div>
</Modal>

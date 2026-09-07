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
  import type { Ref } from '@hcengineering/core'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { IconWithEmoji } from '@hcengineering/presentation'
  import type { ProjectType, TaskType } from '@hcengineering/task'
  import { taskTypeStore } from '@hcengineering/task-resources'
  import ui, { type DropdownIntlItem, Label, ModernDropdown, ModernEditbox } from '@hcengineering/ui'
  import view from '@hcengineering/view'

  import plugin from '../../../plugin'

  export let projectType: ProjectType
  export let workflowName: string = ''
  export let selectedTaskTypeId: Ref<TaskType> | undefined = undefined

  $: availableTaskTypes = Array.from($taskTypeStore.values()).filter((tt) => tt.parent === projectType._id)

  $: taskTypeItems = availableTaskTypes.map(
    (tt): DropdownIntlItem => ({
      id: tt._id,
      label: getEmbeddedLabel(tt.name),
      icon: tt.icon === view.ids.IconWithEmoji ? IconWithEmoji : tt.icon,
      iconProps: { icon: tt.color }
    })
  )
</script>

<div class="form-section">
  <div class="form-field">
    <span class="field-label font-medium-12"><Label label={plugin.string.Name} /></span>
    <ModernEditbox bind:value={workflowName} label={plugin.string.Name} autoFocus={true} width="100%" />
  </div>

  <div class="form-field mt-4">
    <span class="field-label font-medium-12"><Label label={plugin.string.TargetTaskType} /></span>
    <ModernDropdown
      dataId="import-target-task-type"
      items={taskTypeItems}
      bind:selected={selectedTaskTypeId}
      autoSelect={false}
      placeholder={ui.string.NotSelected}
      justify="left"
      width="100%"
    />
  </div>
</div>

<style lang="scss">
  .form-section {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    width: 100%;
  }

  .field-label {
    color: var(--theme-secondary-color, #666);
  }
</style>

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
  import { TaskType } from '@hcengineering/task'
  import { ButtonIcon, IconClose, IconMaximize, IconMinimize, Label, Modal } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'

  import plugin from '../../plugin'
  import TaskTypeDiagram from './TaskTypeDiagram.svelte'

  export let taskTypes: TaskType[] = []
  export let focusTypeId: Ref<TaskType> | undefined = undefined
  export let fullSize = false

  $: focusedTaskType = focusTypeId !== undefined ? taskTypes.find((t) => t._id === focusTypeId) : undefined

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  const dispatch = createEventDispatcher<{ close: void, fullsize: boolean }>()

  function handleClose (): void {
    dispatch('close')
  }

  function handleToggleFullSize (): void {
    fullSize = !fullSize
    dispatch('fullsize', fullSize)
  }
</script>

<Modal type="type-component" scrollableContent={false} on:fullsize on:close>
  <svelte:fragment slot="beforeTitle">
    <ButtonIcon icon={IconClose} kind="tertiary" size="small" noPrint on:click={handleClose} />
    <div class="hulyHeader-divider short no-line no-print" />
    <ButtonIcon
      icon={!fullSize ? IconMaximize : IconMinimize}
      kind="tertiary"
      size="small"
      noPrint
      on:click={handleToggleFullSize}
    />
    <div class="hulyHeader-divider short no-print" />
    {#if focusedTaskType !== undefined}
      <Label label={plugin.string.TaskTypeHierarchyTitle} params={{ name: focusedTaskType.name }} />
    {:else}
      <Label label={plugin.string.TaskTypesDiagram} />
    {/if}
  </svelte:fragment>

  <TaskTypeDiagram {taskTypes} {focusTypeId} />
</Modal>

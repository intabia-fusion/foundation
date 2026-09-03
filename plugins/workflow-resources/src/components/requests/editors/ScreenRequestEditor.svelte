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
  import { createEventDispatcher } from 'svelte'
  import { Ref } from '@hcengineering/core'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import { ProjectType, TaskType } from '@hcengineering/task'
  import ui, { IconOpenedArrow, Label, ModernButton, ModernDropdownLabels } from '@hcengineering/ui'
  import { Screen, ScreenProps, ScreenRequestConfig } from '@hcengineering/workflow'

  import plugin from '../../../plugin'
  import { navigateToScreen } from '../../../location'

  export let taskType: TaskType
  export let projectType: ProjectType | undefined = undefined
  export let config: ScreenRequestConfig | undefined = undefined
  export let canSave = false

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  const dispatch = createEventDispatcher<{ update: ScreenProps, close: void }>()
  const client = getClient()
  const hierarchy = client.getHierarchy()
  const screensQuery = createQuery()

  let selectedScreenId: Ref<Screen> | undefined = config?.props?.screen
  let screens: Screen[] = []
  let isLoaded = false

  const projectTypeId = projectType?._id ?? taskType?.parent

  $: if (projectTypeId != null) {
    screensQuery.query(plugin.class.Screen, { projectType: projectTypeId }, (res) => {
      screens = res.filter((it) => hierarchy.isDerived(taskType.targetClass, it.targetClass))
      isLoaded = true
    })
  }

  $: screenItems = screens.map((s) => ({
    id: s._id,
    label: s.name,
    icon: plugin.icon.Screens
  }))

  $: if (isLoaded) {
    if (selectedScreenId !== undefined && !screens.some((s) => s._id === selectedScreenId)) {
      selectedScreenId = screens.length > 0 ? screens[0]._id : undefined
    } else if (selectedScreenId === undefined && screens.length > 0) {
      selectedScreenId = screens[0]._id
    }
  }

  $: canSave = selectedScreenId !== undefined
  $: if (selectedScreenId != null) {
    dispatch('update', { screen: selectedScreenId })
  }

  function handleOpenScreen (): void {
    if (selectedScreenId != null) {
      navigateToScreen(selectedScreenId, true)
      dispatch('close')
    }
  }
</script>

<div class="screen-selector">
  <span class="screen-selector--label">
    <Label label={plugin.string.Screen} />
  </span>
  <ModernDropdownLabels
    items={screenItems}
    bind:selected={selectedScreenId}
    placeholder={ui.string.NotSelected}
    size="medium"
    width="100%"
  />
</div>

{#if selectedScreenId != null}
  <div class="flex-row-center">
    <ModernButton
      label={plugin.string.ConfigureScreen}
      icon={IconOpenedArrow}
      size="small"
      kind="tertiary"
      on:click={handleOpenScreen}
    />
  </div>
{/if}

<style lang="scss">
  .screen-selector {
    display: flex;
    gap: 1rem;

    &--label {
      display: flex;
      align-items: center;
      white-space: nowrap;
      height: 2.375rem;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--global-secondary-TextColor);
    }
  }
</style>

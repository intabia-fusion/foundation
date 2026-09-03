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
  import { onDestroy } from 'svelte'
  import { Class, Ref, SortingOrder } from '@hcengineering/core'
  import { getEmbeddedLabel, IntlString } from '@hcengineering/platform'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import { clearSettingsStore, settingsStore } from '@hcengineering/setting-resources'
  import { ProjectType, ProjectTypeDescriptor, Task } from '@hcengineering/task'
  import { taskTypeStore } from '@hcengineering/task-resources'
  import tracker from '@hcengineering/tracker'
  import { ButtonIcon, Icon, IconAdd, Label } from '@hcengineering/ui'
  import { Screen } from '@hcengineering/workflow'

  import { navigateToScreen } from '../location'
  import plugin from '../plugin'
  import CreateScreen from './screen/CreateScreen.svelte'

  export let type: ProjectType
  export let descriptor: ProjectTypeDescriptor | undefined = undefined
  export let disabled = true

  const client = getClient()
  const screensQuery = createQuery()

  let isLoading = true
  let screens: Screen[] = []

  $: screensQuery.query(
    plugin.class.Screen,
    { projectType: type._id },
    (res) => {
      screens = res
      isLoading = false
    },
    { sort: { name: SortingOrder.Ascending } }
  )

  function getClassLabel (targetClass?: Ref<Class<Task>>): IntlString | undefined {
    if (targetClass == null) return undefined
    if (targetClass === tracker.class.Issue) return plugin.string.AnyTaskType
    // Task type classes all inherit the "Issue" label, so name them by their task type.
    const taskType = Array.from($taskTypeStore.values()).find((t) => t.targetClass === targetClass)
    if (taskType !== undefined) return getEmbeddedLabel(taskType.name)
    return client.getHierarchy().findClass(targetClass)?.label
  }

  onDestroy(() => {
    clearSettingsStore()
  })
</script>

<div class="hulyTableAttr-header font-medium-12">
  <Icon icon={plugin.icon.Screens} size="small" />
  <span><Label label={plugin.string.Screens} /></span>
  <ButtonIcon
    kind="primary"
    icon={IconAdd}
    size="small"
    dataId="btnAddScreen"
    {disabled}
    loading={isLoading}
    on:click={() => {
      if (disabled) return
      if ($settingsStore.id !== 'createScreen') {
        clearSettingsStore()
      }
      $settingsStore = { id: 'createScreen', component: CreateScreen, props: { type, descriptor } }
    }}
  />
</div>

{#if screens.length > 0 && !isLoading}
  <div class="hulyTableAttr-content screen">
    {#each screens as screen (screen._id)}
      {@const classLabel = getClassLabel(screen.targetClass)}
      <button
        type="button"
        class="hulyTableAttr-content__row"
        data-id="screen-row"
        data-screen-name={screen.name}
        on:click|stopPropagation={() => {
          navigateToScreen(screen._id, false)
        }}
      >
        <span class="hulyTableAttr-content__row-icon-wrapper">
          <Icon icon={plugin.icon.Screen} size="small" />
        </span>
        <span
          class="hulyTableAttr-content__row-label font-medium-14 screen-name"
          class:has-description={screen.description != null}
          title={screen.name}
        >
          {screen.name}
        </span>
        {#if classLabel}
          <span class="screen-class">
            <Label label={classLabel} />
          </span>
        {/if}
        {#if screen.description}
          <div
            class="hulyTableAttr-content__row-label dark font-regular-14 screen-description"
            title={screen.description}
          >
            {screen.description}
          </div>
        {/if}
      </button>
    {/each}
  </div>
{/if}

<style lang="scss">
  .hulyTableAttr-content__row {
    width: 100%;
    justify-content: flex-start;
    align-items: center;
    text-align: left;
  }

  .screen-name {
    flex-shrink: 0;

    &.has-description {
      max-width: 35%;
    }
  }

  .screen-class {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1rem;
    letter-spacing: 0.01em;
    padding: 0.1875rem 0.5rem;
    border-radius: 0.25rem;
    background-color: var(--text-editor-selected-node-background, rgba(76, 56, 189, 0.12));
    color: var(--primary-color-purple-02, #6452db);
    white-space: nowrap;
    margin: 0 0.25rem;
  }

  .screen-description {
    flex-shrink: 1;
    min-width: 0;
  }
</style>

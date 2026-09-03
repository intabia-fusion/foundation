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
  import { createEventDispatcher, SvelteComponent } from 'svelte'
  import { Class, Ref, Status } from '@hcengineering/core'
  import presentation, { getClient } from '@hcengineering/presentation'
  import { TaskType } from '@hcengineering/task'
  import ui, { ButtonBase, Label, Modal } from '@hcengineering/ui'
  import { Workflow, WorkflowRule, WorkflowTransition } from '@hcengineering/workflow'

  import plugin from '../../plugin'
  import { rulesDisplay } from '../../types'
  import TransitionsDropdown from '../TransitionsDropdown.svelte'
  import RulesList from './RulesList.svelte'
  import RulesSidebar from './RulesSidebar.svelte'

  export let workflow: Workflow
  export let taskType: TaskType
  export let transitions: WorkflowTransition[] = []
  export let statuses: Status[] = []
  export let transition: WorkflowTransition | undefined = undefined
  export let _class: Ref<Class<WorkflowRule>> = plugin.class.WorkflowRule

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  const dispatch = createEventDispatcher<{ close: void }>()
  const client = getClient()

  let selectedRule: WorkflowRule | undefined = undefined
  let canSave = false
  let isSaving = false

  $: display = rulesDisplay[_class]
  $: mode = selectedRule != null ? 'edit' : 'list'
  $: canSave = mode === 'list' ? false : canSave

  function onSelectTransition (event: CustomEvent<Ref<WorkflowTransition>>): void {
    const _id = event.detail
    transition = transitions.find((t) => t._id === _id)
  }

  function handleSelectRule (event: CustomEvent<Pick<WorkflowRule, '_id' | '_class'>>): void {
    selectedRule = client.getModel().findObject(event.detail._id)
  }

  async function handleSave (): Promise<void> {
    if (editorComponent == null) return
    if (editorComponent.save != null) {
      await editorComponent.save()
    }
    dispatch('close')
  }

  function handleRuleTypeSelect (ev: CustomEvent<Ref<Class<WorkflowRule>>>): void {
    selectedRule = undefined
    _class = ev.detail
  }

  let editorComponent: SvelteComponent | undefined = undefined
</script>

<Modal
  type="type-popup"
  okAction={handleSave}
  okLabel={presentation.string.Add}
  okLoading={isSaving}
  canSave={transition != null && selectedRule != null && editorComponent != null && canSave}
  label={plugin.string.AddRule}
  maxWidth="55rem"
  padding="0"
  scrollableContent={false}
  onCancel={() => dispatch('close')}
>
  <div class="add-rules-popup">
    <!-- Left Sidebar -->
    <RulesSidebar {_class} {rulesDisplay} on:select={handleRuleTypeSelect} />

    <!-- Main Content Area -->
    <div class="add-rules-popup--content">
      <!-- Transition Selector -->
      <div class="add-rules-popup--transition-bar">
        <span class="add-rules-popup--transition-label">
          <Label label={plugin.string.Transition} />
        </span>
        <TransitionsDropdown {transitions} {statuses} selected={transition?._id} on:select={onSelectTransition} />
      </div>

      <!-- Rules List / Editor -->
      <div class="add-rules-popup--body">
        {#if mode === 'list'}
          <RulesList {_class} {display} on:select={handleSelectRule} />
        {:else if mode === 'edit' && selectedRule != null}
          {@const editor = rulesDisplay[selectedRule._class]?.editor}
          {#if editor}
            <svelte:component
              this={editor}
              bind:this={editorComponent}
              bind:canSave
              bind:isSaving
              value={selectedRule}
              {taskType}
              {transition}
              {workflow}
              {statuses}
              on:close={() => {
                selectedRule = undefined
              }}
            />
          {/if}
        {/if}
      </div>
    </div>
  </div>

  <svelte:fragment slot="buttons">
    <div class="add-rules-popup--back-button">
      {#if selectedRule != null}
        <ButtonBase
          type="type-button"
          kind="secondary"
          size="medium"
          label={ui.string.Back}
          on:click={() => {
            selectedRule = undefined
          }}
        />
      {/if}
    </div>
  </svelte:fragment>
</Modal>

<style lang="scss">
  .add-rules-popup {
    display: flex;
    width: 55rem;
    max-width: calc(100vw - 2rem);
    min-height: 30rem;
    max-height: 80vh;
    box-sizing: border-box;

    @media (max-width: 48rem) {
      flex-direction: column;
      width: 100%;
      min-height: auto;
      max-height: 85vh;
    }

    &--content {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      padding: 1rem;
      gap: 1rem;
      overflow-y: auto;
    }

    &--transition-bar {
      display: flex;
      align-items: center;
      gap: 1rem;
      width: 100%;
      min-width: 0;
      overflow: hidden;
    }

    &--transition-label {
      display: flex;
      align-items: center;
      white-space: nowrap;
      height: 2.375rem;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--global-secondary-TextColor);
    }

    &--body {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      min-width: 0;
      width: 100%;
    }

    &--back-button {
      margin-right: auto;
    }
  }
</style>

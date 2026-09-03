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
  import { Doc, Ref, Status } from '@hcengineering/core'
  import { clearSettingsStore, settingsStore } from '@hcengineering/setting-resources'
  import { TaskType } from '@hcengineering/task'
  import { StatusPresenter } from '@hcengineering/tracker-resources'
  import {
    ButtonIcon,
    closePanel,
    closePopup,
    Icon,
    IconAdd,
    IconArrowRight,
    IconMoreV2,
    IconOpenedArrow,
    Label,
    showPopup,
    tooltip
  } from '@hcengineering/ui'
  import { SortableDocListStatic } from '@hcengineering/view-resources'
  import { Workflow, WorkflowTransition } from '@hcengineering/workflow'

  import plugin from '../../plugin'
  import AddTransitionPopup from './AddTransitionPopup.svelte'
  import AsideTransitionEditor from './AsideTransitionEditor.svelte'

  export let workflow: Workflow
  export let transitions: WorkflowTransition[] = []
  export let statuses: Status[] = []
  export let taskType: TaskType
  export let readonly: boolean

  function addTransition (): void {
    if (readonly) return
    showPopup(AddTransitionPopup, { workflow, statuses, transitions }, 'top')
  }

  function editTransition (_id: Ref<WorkflowTransition>): void {
    if ($settingsStore.id === _id) {
      clearSettingsStore()
      closePanel()
      closePopup()
      return
    }
    $settingsStore = {
      id: _id,
      component: AsideTransitionEditor,
      props: {
        workflow,
        statuses,
        _id,
        readonly,
        transition: transitions.find((it) => it._id === _id),
        transitions,
        taskType
      }
    }
  }

  function toTransition (doc: Doc): WorkflowTransition {
    return doc as WorkflowTransition
  }

  function hasRules (transition: WorkflowTransition): boolean {
    return (
      (transition.requests?.length ?? 0) > 0 ||
      (transition.validators?.length ?? 0) > 0 ||
      (transition.postFunctions?.length ?? 0) > 0
    )
  }
</script>

<div class="hulyTableAttr-container editor">
  <div class="hulyTableAttr-header font-medium-12">
    <Icon icon={plugin.icon.Transition} size="small" />
    <span><Label label={plugin.string.Transitions} /></span>
    <ButtonIcon
      kind="primary"
      icon={IconAdd}
      size="small"
      dataId="btnAddTransition"
      on:click={addTransition}
      disabled={readonly}
    />
  </div>
  <SortableDocListStatic _class={plugin.class.WorkflowTransition} items={transitions}>
    <svelte:fragment slot="object" let:value>
      {@const transition = toTransition(value)}
      {@const statusTo = statuses.find((it) => it._id === transition.to)}
      {@const rulesPresent = hasRules(transition)}
      <div class="hulyTableAttr-content class withTitle">
        <button
          type="button"
          class="hulyTableAttr-content__row"
          data-id="transition-row"
          data-transition-name={transition.name}
          class:selected={$settingsStore?.id === transition._id}
          draggable={!readonly}
          on:click={() => {
            editTransition(transition._id)
          }}
        >
          <button type="button" class="hulyTableAttr-content__row-dragMenu" on:click|stopPropagation={() => {}}>
            <IconMoreV2 size="small" />
          </button>
          <span class="hulyTableAttr-content__title center flex-row-center flex-gap-1">
            {#if rulesPresent}
              <span data-id="transition-rules" use:tooltip={{ label: plugin.string.TransitionRulesConfigured }}>
                <Icon icon={plugin.icon.Action} size="x-small" />
              </span>
            {/if}
            <span class="overflow-label" title={transition.name}>{transition.name}</span>
          </span>
          <span class="hulyTableAttr-content__row noPadding">
            {#if transition.from !== null}
              <div class="status-column">
                {#each transition.from as from (from)}
                  {@const status = statuses.find((it) => it._id === from)}
                  {#if status}
                    <div class="flex-row-center flex-gap-1">
                      <StatusPresenter
                        value={status}
                        projectType={workflow.projectType}
                        taskType={workflow.taskType}
                        kind="table-attrs"
                        size="small"
                      />
                    </div>
                  {/if}
                {/each}
              </div>
            {:else}
              <div class="hulyTableAttr-content__row flex-no-grow noPadding any-status">
                <Label label={plugin.string.AnyStatus} />
              </div>
            {/if}
            <div class="transition-arrow">
              <Icon icon={IconArrowRight} size="small" />
            </div>
            <span class="hulyTableAttr-content__row flex-no-grow noPadding">
              <StatusPresenter
                value={statusTo}
                projectType={workflow.projectType}
                taskType={workflow.taskType}
                kind="table-attrs"
                size="small"
              />
            </span>
          </span>
          <span class="hulyTableAttr-content__row-arrow">
            <IconOpenedArrow size="small" />
          </span>
        </button>
      </div>
    </svelte:fragment>
  </SortableDocListStatic>
</div>

<style lang="scss">
  .editor {
    min-width: 25rem;

    :global(.hulyTableAttr-content__row) {
      :global(.hulyTableAttr-content__row-dragMenu) {
        color: var(--global-secondary-TextColor);
        transition: color 0.15s ease;
      }

      :global(.hulyTableAttr-content__row-arrow) {
        color: var(--global-secondary-TextColor);
        transition: color 0.15s ease;
      }

      &:hover {
        :global(.hulyTableAttr-content__row-dragMenu),
        :global(.hulyTableAttr-content__row-arrow) {
          color: var(--global-primary-TextColor);
        }
      }
    }
  }

  .transition-arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--global-secondary-TextColor);
    flex-shrink: 0;
    padding: 0 0.25rem;

    :global(svg) {
      color: inherit;
    }
  }

  .any-status {
    text-transform: uppercase;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--global-secondary-TextColor);
  }

  .status-column {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
</style>

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
  import { Class, Ref, Status } from '@hcengineering/core'
  import { IntlString } from '@hcengineering/platform'
  import presentation, { getClient } from '@hcengineering/presentation'
  import { TaskType } from '@hcengineering/task'
  import {
    ButtonMenu,
    DropdownIntlItem,
    Icon,
    IconAdd,
    IconClose,
    IconEdit,
    IconMoreV,
    Label,
    NavGroup,
    showPopup
  } from '@hcengineering/ui'
  import {
    removeRuleConfig,
    Workflow,
    WorkflowRule,
    WorkflowRuleConfig,
    WorkflowTransition
  } from '@hcengineering/workflow'

  import plugin from '../../plugin'
  import AddRulesPopup from './AddRulesPopup.svelte'
  import EditRulePopup from './EditRulePopup.svelte'
  import RuleConfigPresenter from './RuleConfigPresenter.svelte'

  export let _class: Ref<Class<WorkflowRule>>
  export let label: IntlString
  export let workflow: Workflow
  export let taskType: TaskType
  export let transitions: WorkflowTransition[] = []
  export let statuses: Status[] = []
  export let transition: WorkflowTransition

  const client = getClient()

  $: rules = client.getModel().findAllSync(_class, {})

  const actionItems: DropdownIntlItem[] = [
    {
      id: 'edit',
      label: presentation.string.Edit,
      icon: IconEdit
    },
    {
      id: 'delete',
      label: presentation.string.Delete,
      icon: IconClose
    }
  ]

  function getCategory (ruleClass: Ref<Class<WorkflowRule>>): 'validators' | 'requests' | 'postFunctions' {
    if (ruleClass === plugin.class.WorkflowValidator) return 'validators'
    if (ruleClass === plugin.class.WorkflowRequest) return 'requests'
    if (ruleClass === plugin.class.WorkflowPostFunction) return 'postFunctions'
    return 'validators'
  }

  function getConfigs (ruleClass: Ref<Class<WorkflowRule>>, trans: WorkflowTransition): WorkflowRuleConfig[] {
    if (ruleClass === plugin.class.WorkflowValidator) return trans.validators ?? []
    if (ruleClass === plugin.class.WorkflowRequest) return trans.requests ?? []
    if (ruleClass === plugin.class.WorkflowPostFunction) return trans.postFunctions ?? []
    return []
  }

  $: configs = getConfigs(_class, transition)
  $: count = configs.length
  $: category = getCategory(_class)

  function handleAdd (): void {
    showPopup(AddRulesPopup, { workflow, transitions, statuses, transition, _class, taskType }, 'center')
  }

  function handleEdit (config: WorkflowRuleConfig): void {
    showPopup(EditRulePopup, { workflow, transitions, statuses, transition, taskType, config }, 'center')
  }

  async function remove (configId: string): Promise<void> {
    await removeRuleConfig(client, workflow._id, transition._id, category, configId)
  }

  async function handleAction (actionId: string, config: WorkflowRuleConfig): Promise<void> {
    if (actionId === 'edit') {
      handleEdit(config)
    } else if (actionId === 'delete') {
      await remove(config.id)
    }
  }

  function getRule (ruleId: string): WorkflowRule | undefined {
    return rules.find((r) => r._id === ruleId)
  }
</script>

<div class="rules-nav-group">
  <NavGroup
    _id={category}
    {label}
    categoryName={category}
    isFold
    defaultOpen={false}
    empty={count === 0}
    noDivider
    noPadding
    headerClickType="toggle"
  >
    <svelte:fragment slot="afterTitle">
      {#if count > 0}
        <div class="antiHSpacer" />
        <div class="rules-nav-group--counter">
          {count}
        </div>
        <div class="antiHSpacer" />
      {/if}
    </svelte:fragment>

    <svelte:fragment slot="after">
      <button
        type="button"
        class="rules-nav-group--action"
        data-testid={`action-add-${category}`}
        on:click|preventDefault|stopPropagation={handleAdd}
      >
        <Icon icon={IconAdd} size="small" />
      </button>
    </svelte:fragment>

    <div class="rules-nav-group--list">
      {#each configs as config, idx (config.id ?? idx)}
        {@const rule = getRule(config.rule)}
        <div class="rule-card" data-id="rule-card" data-rule-id={config.rule}>
          <div class="rule-card--header">
            <div class="rule-card--title">
              {#if rule?.icon}
                <div class="rule-card--icon">
                  <Icon icon={rule.icon} size="small" />
                </div>
              {/if}
              {#if rule?.label}
                <span class="rule-card--name"><Label label={rule.label} /></span>
              {/if}
            </div>
            <div class="rule-card--actions" on:click|stopPropagation>
              <ButtonMenu
                items={actionItems}
                icon={IconMoreV}
                kind="tertiary"
                size="extra-small"
                noSelection={true}
                on:selected={(ev) => {
                  void handleAction(ev.detail, config)
                }}
              />
            </div>
          </div>

          <div class="rule-card--body">
            <RuleConfigPresenter {config} {taskType} {rule} />
          </div>
        </div>
      {/each}
    </div>
  </NavGroup>
</div>

<style lang="scss">
  .rules-nav-group {
    :global(.hulyNavGroup-header) {
      padding: 0;
    }

    &--action {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      padding: var(--spacing-0_5);
      color: var(--global-tertiary-TextColor);
      border: none;
      border-radius: var(--extra-small-BorderRadius);
      outline: none;
      cursor: pointer;

      &:hover {
        color: var(--global-primary-TextColor);
        background-color: var(--global-ui-highlight-BackgroundColor);
      }
    }

    &--counter {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      background: var(--global-ui-active-BackgroundColor);
      color: var(--global-primary-TextColor);
    }

    &--list {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
      padding: 0.25rem 0.5rem;
    }
  }

  .rule-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 0.875rem;
    border-radius: var(--medium-BorderRadius, 0.5rem);
    border: 1px solid var(--global-subtle-ui-BorderColor);
    background-color: var(--global-ui-highlight-BackgroundColor);
    transition:
      border-color 0.15s ease,
      background-color 0.15s ease;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;

    &:hover {
      border-color: var(--global-subtle-ui-BorderColor);
      background-color: var(--global-ui-active-BackgroundColor);
    }

    &--header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      width: 100%;
      min-width: 0;
    }

    &--title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
      flex: 1;
      color: var(--global-primary-TextColor);
    }

    &--icon {
      width: 1.5rem;
      height: 1.5rem;
      border-radius: 0.375rem;
      background-color: var(--global-subtle-ui-BorderColor);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: var(--global-primary-TextColor);

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

    &--name {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--global-primary-TextColor);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    &--actions {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    &--body {
      padding-left: 2rem;
      width: 100%;
      min-width: 0;
      overflow: hidden;
      box-sizing: border-box;
    }
  }
</style>

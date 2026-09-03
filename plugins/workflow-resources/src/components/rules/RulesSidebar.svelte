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
  import { Class, Ref } from '@hcengineering/core'
  import { Label } from '@hcengineering/ui'
  import { WorkflowRule } from '@hcengineering/workflow'

  import plugin from '../../plugin'
  import { RuleDisplay } from '../../types'

  export let _class: Ref<Class<WorkflowRule>>
  export let rulesDisplay: Record<Ref<Class<WorkflowRule>>, RuleDisplay>

  const dispatch = createEventDispatcher<{ select: Ref<Class<WorkflowRule>> }>()

  function handleSelect (ruleClass: Ref<Class<WorkflowRule>>): void {
    _class = ruleClass
    dispatch('select', _class)
  }
</script>

<div class="rules-sidebar">
  <button
    type="button"
    class="rules-sidebar--item"
    class:active={_class === plugin.class.WorkflowRule}
    on:click={() => {
      handleSelect(plugin.class.WorkflowRule)
    }}
  >
    <span class="rules-sidebar--label"><Label label={rulesDisplay[plugin.class.WorkflowRule].label} /></span>
  </button>

  <div class="rules-sidebar--group-header">
    <Label label={plugin.string.RuleTypes} />
  </div>

  {#each Object.values(rulesDisplay) as display (display._class)}
    {#if display._class !== plugin.class.WorkflowRule}
      <button
        type="button"
        class="rules-sidebar--item"
        class:active={_class === display._class}
        on:click={() => {
          handleSelect(display._class)
        }}
      >
        {#if display.icon}
          <span class="rules-sidebar--icon">{display.icon}</span>
        {/if}
        <span class="rules-sidebar--label"><Label label={display.label} /></span>
      </button>
    {/if}
  {/each}
</div>

<style lang="scss">
  .rules-sidebar {
    width: 14rem;
    flex-shrink: 0;
    border-right: 1px solid var(--global-subtle-ui-BorderColor);
    padding: 1rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;

    @media (max-width: 48rem) {
      width: 100%;
      border-right: none;
      border-bottom: 1px solid var(--global-subtle-ui-BorderColor);
      flex-direction: row;
      overflow-x: auto;
      padding: 0.5rem;
    }

    &--group-header {
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      color: var(--global-tertiary-TextColor);
      padding: 0.75rem 0.75rem 0.25rem 0.75rem;
      text-transform: uppercase;

      @media (max-width: 48rem) {
        display: none;
      }
    }

    &--item {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      padding: 0.5rem 0.75rem;
      border-radius: var(--small-BorderRadius, 0.375rem);
      border: none;
      background: transparent;
      color: var(--global-secondary-TextColor);
      font-size: 0.8125rem;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      white-space: nowrap;
      transition:
        background-color 0.15s ease,
        color 0.15s ease;

      &:hover {
        background-color: var(--global-ui-highlight-BackgroundColor);
        color: var(--global-primary-TextColor);
      }

      &.active {
        background-color: var(--global-primary-OptionColor, rgba(59, 130, 246, 0.1));
        color: var(--global-primary-TextColor);
        font-weight: 600;

        .rules-sidebar--icon {
          color: var(--accent-button-default, #2563eb);
        }
      }
    }

    &--icon {
      font-size: 0.875rem;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 1rem;
    }

    &--label {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }
</style>

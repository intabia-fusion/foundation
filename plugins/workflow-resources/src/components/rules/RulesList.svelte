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
  import { getClient } from '@hcengineering/presentation'
  import { WorkflowRule } from '@hcengineering/workflow'

  import { RuleDisplay } from '../../types'
  import RulePresenter from './RulePresenter.svelte'

  export let _class: Ref<Class<WorkflowRule>>
  export let display: RuleDisplay

  const client = getClient()
  const dispatch = createEventDispatcher<{ select: Pick<WorkflowRule, '_id' | '_class'> }>()

  $: rules = client.getModel().findAllSync(_class, {}, {})

  function handleClick (ruleClass: Ref<Class<WorkflowRule>>, id: Ref<WorkflowRule>): void {
    dispatch('select', { _id: id, _class: ruleClass })
  }
</script>

<div class="rules-list">
  {#each rules as r (r._id)}
    {#if display.presenter}
      <svelte:component
        this={display.presenter}
        value={r}
        on:click={() => {
          handleClick(r._class, r._id)
        }}
      />
    {:else}
      <RulePresenter
        value={r}
        on:click={() => {
          handleClick(r._class, r._id)
        }}
      />
    {/if}
  {/each}
</div>

<style lang="scss">
  .rules-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;
  }
</style>

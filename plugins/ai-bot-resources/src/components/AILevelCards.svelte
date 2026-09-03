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
  import { type AILevelInfo } from '@hcengineering/ai-bot'
  import { ModernButton } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'

  export let levels: AILevelInfo[] = []
  export let selected: string = ''
  export let disabled: boolean = false

  const dispatch = createEventDispatcher()

  function select (level: string): void {
    if (disabled || level === selected) return
    dispatch('select', level)
  }
</script>

<div class="cards">
  {#each levels as info (info.level)}
    {@const active = info.level === selected}
    <ModernButton
      title={info.label}
      size={'small'}
      kind={active ? 'primary' : 'tertiary'}
      pressed={active}
      {disabled}
      dataId={`btnAiLevel-${info.level}`}
      on:click={() => {
        select(info.level)
      }}
    >
      <span class="content-dark-color text-xs">×{info.displayMultiplier ?? info.tokenMultiplier}</span>
    </ModernButton>
  {/each}
</div>

<style lang="scss">
  .cards {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
</style>

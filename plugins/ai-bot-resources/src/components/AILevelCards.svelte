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
    <button
      type="button"
      class="level-chip"
      class:active
      class:disabled
      {disabled}
      on:click={() => {
        select(info.level)
      }}
    >
      <span class="title">{info.label}</span>
      <span class="content-dark-color text-xs multiplier">×{info.displayMultiplier ?? info.tokenMultiplier}</span>
    </button>
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

  .level-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
    padding: 0.375rem 0.75rem;
    background-color: var(--theme-button-default);
    border: 1px solid var(--theme-divider-color);
    border-radius: var(--small-BorderRadius);
    cursor: pointer;
    white-space: nowrap;

    &:hover:not(.disabled) {
      background-color: var(--theme-button-hovered);
    }

    &.active {
      border-color: var(--primary-button-default);
      background-color: var(--theme-button-pressed);
    }

    &.disabled {
      cursor: default;
      opacity: 0.6;
    }

    .title {
      font-weight: 500;
      color: var(--theme-caption-color);
    }
  }
</style>

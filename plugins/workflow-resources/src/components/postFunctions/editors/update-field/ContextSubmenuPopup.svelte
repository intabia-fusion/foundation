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
  import { closePopup, Label, resizeObserver, Scroller, Submenu } from '@hcengineering/ui'

  import ContextSubmenuPopup from './ContextSubmenuPopup.svelte'
  import plugin from '../../../../plugin'
  import { ContextOption } from './types'

  export let options: ContextOption[] = []
  export let onSelect: (val: ContextOption) => void

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  const dispatch = createEventDispatcher<{ close: void, changeContent: void }>()

  function handleItemClick (opt: ContextOption): void {
    onSelect(opt)
    closePopup()
    dispatch('close')
  }

  const elements: HTMLElement[] = []

  const keyDown = (event: KeyboardEvent, index: number): void => {
    if (event.key === 'ArrowDown') {
      elements[(index + 1) % elements.length]?.focus()
    }
    if (event.key === 'ArrowUp') {
      elements[(elements.length + index - 1) % elements.length]?.focus()
    }
    if (event.key === 'ArrowLeft') {
      closePopup()
      dispatch('close')
    }
  }
</script>

<div class="selectPopup" use:resizeObserver={() => dispatch('changeContent')}>
  <div class="menu-space" />
  <Scroller>
    {#each options as opt, i}
      {#if opt.separatorBefore}
        <div class="menu-separator" />
      {/if}
      {#if opt.children != null && opt.children.length > 0}
        <Submenu
          bind:element={elements[i]}
          on:keydown={(event) => {
            keyDown(event, i)
          }}
          on:mouseover={() => {
            elements[i]?.focus()
          }}
          label={opt.label}
          props={{ options: opt.children, onSelect }}
          options={{ component: ContextSubmenuPopup }}
          withHover
        />
      {:else}
        <!-- svelte-ignore a11y-mouse-events-have-key-events -->
        <button
          bind:this={elements[i]}
          on:keydown={(event) => {
            keyDown(event, i)
          }}
          on:mouseover={() => {
            elements[i]?.focus()
          }}
          on:click={() => {
            handleItemClick(opt)
          }}
          class="menu-item"
        >
          <span class="overflow-label pr-1">
            {#if opt.isParent}
              <span class="pill-tag"><Label label={plugin.string.Parent} /></span>
            {/if}
            <Label label={opt.label} />
          </span>
        </button>
      {/if}
    {/each}
  </Scroller>
  <div class="menu-space" />
</div>

<style lang="scss">
  .pill-tag {
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 0.125rem 0.375rem;
    margin-right: 0.375rem;
    border-radius: 0.25rem;
    background-color: var(--text-editor-selected-node-background, rgba(76, 56, 189, 0.12));
    color: var(--primary-color-purple-02, #6452db);
  }
</style>

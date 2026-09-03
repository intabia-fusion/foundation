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
  import type { IntlString } from '@hcengineering/platform'
  import { createEventDispatcher } from 'svelte'

  import { deviceOptionsStore, resizeObserver } from '..'
  import plugin from '../plugin'
  import type { DropdownTextItem } from '../types'
  import Icon from './Icon.svelte'
  import IconCheck from './icons/Check.svelte'
  import Label from './Label.svelte'
  import ModernEditbox from './ModernEditbox.svelte'
  import Scroller from './Scroller.svelte'

  export let placeholder: IntlString = plugin.string.SearchDots
  export let items: DropdownTextItem[] = []
  export let selected: DropdownTextItem['id'] | Array<DropdownTextItem['id']> | undefined = undefined
  export let multiselect: boolean = false
  export let enableSearch: boolean = true
  export let params: Record<string, any> = {}

  const dispatch = createEventDispatcher<{
    update: DropdownTextItem['id'] | Array<DropdownTextItem['id']>
    close: DropdownTextItem['id']
    changeContent: undefined
  }>()

  let search: string = ''
  let btns: HTMLButtonElement[] = []

  $: filteredItems = (items ?? []).filter((x) => {
    const trimmed = search.trim()
    if (trimmed.length === 0) return true
    return x.label.toLowerCase().includes(trimmed.toLowerCase())
  })
  $: btns = btns.slice(0, filteredItems.length)

  function isSelected (
    sel: DropdownTextItem['id'] | Array<DropdownTextItem['id']> | undefined,
    item: DropdownTextItem
  ): boolean {
    if (Array.isArray(sel)) {
      return sel.includes(item.id)
    }
    return item.id === sel
  }

  function handleItemClick (item: DropdownTextItem): void {
    if (multiselect && Array.isArray(selected)) {
      if (item.exclusive === true) {
        const index = selected.indexOf(item.id)
        selected = index !== -1 ? [] : [item.id]
      } else {
        const exclusiveIds = items.filter((it) => it.exclusive === true).map((it) => it.id)
        const newSelected = selected.filter((id) => !exclusiveIds.includes(id))
        const index = newSelected.indexOf(item.id)
        if (index !== -1) {
          newSelected.splice(index, 1)
        } else {
          newSelected.push(item.id)
        }
        selected = newSelected
      }
      dispatch('update', selected)
    } else {
      dispatch('close', item.id)
    }
  }

  function keyDown (ev: KeyboardEvent, n: number): void {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      if (n === btns.length - 1) {
        btns[0]?.focus()
      } else {
        btns[n + 1]?.focus()
      }
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      if (n === 0) {
        btns[btns.length - 1]?.focus()
      } else {
        btns[n - 1]?.focus()
      }
    }
  }
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="hulyPopup-container" use:resizeObserver={() => dispatch('changeContent')}>
  {#if enableSearch}
    <div class="search-wrapper">
      <ModernEditbox
        bind:value={search}
        label={placeholder}
        size="small"
        kind="default"
        autoFocus={!$deviceOptionsStore.isMobile}
      />
    </div>
  {/if}

  <Scroller padding="var(--spacing-0_5)" gap="flex-gap-0-5">
    {#each filteredItems as item, i (item.id)}
      {#if item.separatorBefore === true || item.separatorLabel !== undefined}
        {#if item.separatorLabel !== undefined}
          <div class="hulyPopup-category">
            <div class="hulyPopup-line" />
            <span class="hulyPopup-category-label">
              <Label label={item.separatorLabel} />
            </span>
            <div class="hulyPopup-line" />
          </div>
        {:else}
          <div class="hulyPopup-divider" />
        {/if}
      {/if}
      <!-- svelte-ignore a11y-mouse-events-have-key-events -->
      <button
        bind:this={btns[i]}
        class="hulyPopup-row"
        class:selected={isSelected(selected, item)}
        on:mouseover={(ev) => {
          ev.currentTarget.focus()
        }}
        on:keydown={(ev) => {
          keyDown(ev, i)
        }}
        on:click={() => {
          handleItemClick(item)
        }}
      >
        {#if item.icon}
          <span class="hulyPopup-row__icon">
            <Icon icon={item.icon} iconProps={item.iconProps} size="small" />
          </span>
        {/if}

        <span class="hulyPopup-row__label overflow-label">
          {item.label}
        </span>

        {#if isSelected(selected, item)}
          <span class="hulyPopup-row__icon">
            <IconCheck size="small" />
          </span>
        {/if}
      </button>
    {:else}
      <div class="empty-placeholder">
        <Label label={plugin.string.NoResults} />
      </div>
    {/each}
  </Scroller>
</div>

<style lang="scss">
  .search-wrapper {
    padding: var(--spacing-1) var(--spacing-1_5);
    border-bottom: 1px solid var(--theme-divider-color);
  }

  .empty-placeholder {
    padding: 0.75rem 1rem;
    text-align: center;
    font-size: 0.8125rem;
    color: var(--global-secondary-TextColor, var(--theme-trans-color, #6b7280));
  }

  .hulyPopup-category {
    display: flex;
    align-items: center;
    gap: var(--spacing-1);
    padding: var(--spacing-1_5) var(--spacing-1) var(--spacing-0_5) var(--spacing-1);
    min-width: 0;
    overflow: hidden;

    &-label {
      font-size: 0.625rem;
      font-weight: 500;
      color: var(--global-tertiary-TextColor);
      text-transform: uppercase;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .hulyPopup-line {
      flex: 1;
      height: 1px;
      background-color: var(--theme-popup-divider);
      min-width: 0.5rem;
    }
  }
</style>

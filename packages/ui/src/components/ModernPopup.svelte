<!--
// Copyright © 2024 Hardcore Engineering Inc.
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
  import { createEventDispatcher } from 'svelte'
  import { translate, type IntlString } from '@hcengineering/platform'

  import { deviceOptionsStore, languageStore, resizeObserver } from '..'
  import ui from '../plugin'
  import type { DropdownIntlItem } from '../types'
  import { capitalizeFirstLetter, formatKey } from '../utils'
  import Icon from './Icon.svelte'
  import IconCheck from './icons/Check.svelte'
  import Label from './Label.svelte'
  import ModernEditbox from './ModernEditbox.svelte'
  import Scroller from './Scroller.svelte'

  export let items: DropdownIntlItem[] = []
  export let selected: DropdownIntlItem['id'] | Array<DropdownIntlItem['id']> | undefined = undefined
  export let multiselect: boolean = false
  export let params: Record<string, any> = {}
  export let withSearch: boolean = false
  export let searchPlaceholder: IntlString = ui.string.SearchDots
  export let popupClass: string | undefined = undefined

  const dispatch = createEventDispatcher<{
    update: DropdownIntlItem['id'] | Array<DropdownIntlItem['id']>
    close: DropdownIntlItem['id']
    changeContent: undefined
    search: string
  }>()

  let btns: HTMLButtonElement[] = []
  let search = ''
  let searchMap: Record<string, string> = {}

  $: lowerSearch = search.toLowerCase().trim()

  async function fillSearchMap (itemsList: DropdownIntlItem[], lang: string): Promise<void> {
    const result: Record<string, string> = {}
    for (const item of itemsList) {
      if (item.label != null) {
        if (typeof item.label === 'string') {
          result[String(item.id)] = item.label.toLowerCase()
        } else {
          result[String(item.id)] = (await translate(item.label, item.params ?? params, lang)).toLowerCase()
        }
      }
    }
    searchMap = result
  }

  $: if (withSearch) {
    void fillSearchMap(items ?? [], $languageStore)
  } else {
    searchMap = {}
  }

  $: filteredItems =
    withSearch && lowerSearch.length > 0
      ? (items ?? []).filter((item) => {
          const translated = searchMap[String(item.id)]
          if (translated !== undefined && translated.length > 0) return translated.includes(lowerSearch)
          if (typeof item.label === 'string') return item.label.toLowerCase().includes(lowerSearch)
          return true
        })
      : (items ?? [])

  $: btns = btns.slice(0, filteredItems.length)
  $: withIcons = filteredItems.some((it) => it.icon !== undefined)

  function isSelected (
    sel: DropdownIntlItem['id'] | Array<DropdownIntlItem['id']> | undefined,
    item: DropdownIntlItem
  ): boolean {
    if (Array.isArray(sel)) {
      return sel.includes(item.id)
    }
    return item.id === sel
  }

  function handleItemClick (item: DropdownIntlItem): void {
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
<div class="hulyPopup-container {popupClass ?? ''}" use:resizeObserver={() => dispatch('changeContent')}>
  {#if withSearch}
    <div class="search-wrapper">
      <ModernEditbox
        bind:value={search}
        label={searchPlaceholder}
        size="small"
        kind="default"
        autoFocus={!$deviceOptionsStore.isMobile}
        on:change={() => dispatch('search', search)}
        on:input={() => dispatch('search', search)}
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
              <Label label={item.separatorLabel} params={item.params ?? params} />
            </span>
            <div class="hulyPopup-line" />
          </div>
        {:else}
          <div class="hulyPopup-divider" />
        {/if}
      {/if}
      <!-- svelte-ignore a11y-mouse-events-have-key-events -->
      <button
        class="hulyPopup-row"
        class:withKeys={item.keys !== undefined && item.keys.length > 0}
        class:selected={isSelected(selected, item)}
        bind:this={btns[i]}
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
        {#if withIcons}
          <div class="hulyPopup-row__icon">
            {#if item.icon}<Icon icon={item.icon} iconProps={item.iconProps} size="small" />{/if}
          </div>
        {/if}
        {#if item.component}
          <div class="hulyPopup-row__label flex-grow">
            <svelte:component this={item.component} {...item.componentProps ?? {}} />
          </div>
        {:else if item.description !== undefined}
          <div class="hulyPopup-row__labels-wrapper">
            <div class="hulyPopup-row__label overflow-label">
              <Label label={item.label} params={item.params ?? params} />
            </div>
            <div class="hulyPopup-row__label small dark">
              <Label label={item.description} params={item.paramsDescription ?? params} />
            </div>
          </div>
        {:else}
          <div class="hulyPopup-row__label"><Label label={item.label} params={item.params ?? params} /></div>
        {/if}
        {#if item.keys !== undefined && item.keys.length > 0}
          <div class="hulyPopup-row__keys">
            {#each item.keys as key, j}
              {#if j !== 0}
                <div class="mr-1 ml-1">/</div>
              {/if}
              {#each formatKey(key) as k}
                <div class="key">
                  {#each k as kk, j}
                    {#if j !== 0}
                      +
                    {/if}
                    {capitalizeFirstLetter(kk.trim())}
                  {/each}
                </div>
              {/each}
            {/each}
          </div>
        {/if}
        {#if isSelected(selected, item)}
          <div class="hulyPopup-row__icon">
            <IconCheck size="small" />
          </div>
        {/if}
      </button>
    {:else}
      <div class="empty-placeholder">
        <Label label={ui.string.NoResults} />
      </div>
    {/each}
  </Scroller>
</div>

<style lang="scss">
  .hulyPopup-container {
    &.wide {
      max-width: 90vw;
      width: 32rem;
      min-width: 24rem;
    }
    &.x-wide {
      max-width: 90vw;
      width: 40rem;
      min-width: 28rem;
    }
  }

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

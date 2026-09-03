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
  import { type IntlString } from '@hcengineering/platform'
  import { createEventDispatcher } from 'svelte'
  import { deepEqual } from 'fast-equals'

  import { getFocusManager } from '../focus'
  import ui from '../plugin'
  import { closePopup, showPopup } from '../popups'
  import { tooltip as tp } from '../tooltips'
  import type {
    ButtonBaseKind,
    ButtonBaseSize,
    DropdownIntlItem,
    IconComponent,
    IconSize,
    LabelAndProps,
    TooltipAlignment
  } from '../types'
  import Icon from './Icon.svelte'
  import DropdownIcon from './icons/Dropdown.svelte'
  import Label from './Label.svelte'
  import ModernButton from './ModernButton.svelte'
  import ModernPopup from './ModernPopup.svelte'

  type SelectedItem = DropdownIntlItem['id'] | Array<DropdownIntlItem['id']>

  export let icon: IconComponent | undefined = undefined
  export let iconProps: Record<string, any> = {}
  export let label: IntlString = ui.string.DropdownDefaultLabel
  export let placeholder: IntlString | undefined = undefined
  export let params: Record<string, any> = {}
  export let items: DropdownIntlItem[] = []
  export let multiselect: boolean = false
  export let wrap: boolean = false
  export let selected: SelectedItem | undefined = multiselect ? [] : undefined
  export let disabled: boolean = false

  export let kind: ButtonBaseKind = 'secondary'
  export let size: ButtonBaseSize = 'large'
  export let iconSize: IconSize | undefined = undefined
  export let justify: 'left' | 'center' = 'center'
  export let width: string | undefined = undefined
  export let minWidth: string | undefined = undefined
  export let stretchWidth: boolean | undefined = undefined
  export let labelDirection: TooltipAlignment | undefined = undefined
  export let autoSelect: boolean = true
  export let minW0: boolean = true
  export let focusIndex: number = -1
  export let dataId: string | undefined = undefined
  export let noFocus: boolean = false
  export let withSearch: boolean = false
  export let searchPlaceholder: IntlString = ui.string.Search
  export let allowDeselect: boolean = false
  export let showDropdownIcon: boolean = false
  export let popupClass: string | undefined = undefined
  export let tooltip: LabelAndProps | undefined = undefined
  export let loading: boolean = false
  export let useFlexGrow: boolean = false

  const dispatch = createEventDispatcher<{
    selected: DropdownIntlItem['id'] | Array<DropdownIntlItem['id']> | undefined
  }>()
  const mgr = getFocusManager()

  let container: HTMLElement
  let opened = false

  $: activeTooltip = tooltip !== undefined ? { timeout: 600, ...tooltip } : undefined

  function getItemId (item: DropdownIntlItem | SelectedItem | undefined): DropdownIntlItem['id'] | undefined {
    if (item == null) return undefined
    if (Array.isArray(item)) return item[0]
    if (typeof item === 'object') return item.id
    return item
  }

  $: selectedItem = multiselect
    ? (items ?? []).filter((p) => {
        const pId = getItemId(p)
        if (Array.isArray(selected)) {
          return selected.some((s) => getItemId(s) === pId)
        }
        return false
      })
    : (items ?? []).find((x) => {
        const xId = getItemId(x)
        const sId = getItemId(selected)
        return xId !== undefined && xId === sId
      })

  $: singleSelectedItem = !Array.isArray(selectedItem) ? selectedItem : undefined
  $: selectedItemComponent = singleSelectedItem?.component
  $: selectedItemComponentProps = singleSelectedItem?.componentProps

  $: fallbackLabel = placeholder ?? label
  $: computedWidth = stretchWidth === true ? '100%' : (width ?? (wrap ? '100%' : 'min-content'))

  $: if (autoSelect && selected === undefined && items?.[0] !== undefined) {
    const firstId = getItemId(items[0])
    if (firstId !== undefined) {
      selected = multiselect ? [firstId] : firstId
      dispatch('selected', selected)
    }
  }

  function handleSelect (result: DropdownIntlItem['id'] | undefined): void {
    if (result != null) {
      const matchedItem = (items ?? []).find((x) => getItemId(x) === result)
      if (allowDeselect && getItemId(selected) === result) {
        selected = undefined
        dispatch('selected', undefined)
        return
      }
      if (typeof selected === 'object' && selected !== null && !Array.isArray(selected) && matchedItem !== undefined) {
        selected = matchedItem.id
      } else {
        selected = result
      }
      dispatch('selected', selected)
    }
  }

  function openPopup (): void {
    if (!opened && !disabled) {
      opened = true
      showPopup(
        ModernPopup,
        { items, selected, params, withSearch, searchPlaceholder, multiselect, popupClass },
        container,
        (result) => {
          if (result != null) {
            handleSelect(result)
          }
          opened = false
          mgr?.setFocusPos(focusIndex)
        },
        (result) => {
          if (result != null) {
            handleSelect(result)
          }
        }
      )
    }
  }

  let prevItems: DropdownIntlItem[]
  $: if (!deepEqual(items, prevItems)) {
    prevItems = items

    if (opened) {
      closePopup()
      opened = false
      openPopup()
    }
  }
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
  bind:this={container}
  class="modern-dropdown-container"
  class:min-w-0={minW0}
  class:stretch-width={stretchWidth}
  class:flex-grow={useFlexGrow}
  class:multiselect-wrap={wrap}
  style:width={computedWidth}
  style:min-width={minWidth}
  use:tp={activeTooltip}
>
  <ModernButton
    {focusIndex}
    {dataId}
    {icon}
    {iconProps}
    {size}
    {iconSize}
    {kind}
    {disabled}
    pressed={opened}
    {loading}
    {noFocus}
    tooltip={label !== undefined ? { label, direction: labelDirection } : undefined}
    on:click={openPopup}
  >
    <div class="dropdown-content-wrapper flex-row-center w-full min-w-0" class:justify-left={justify === 'left'}>
      <span
        class="overflow-label grow min-w-0 flex-row-center flex-gap-1"
        class:mr-2={showDropdownIcon}
        class:content-color={selectedItem === undefined}
      >
        {#if $$slots.content}
          <slot name="content" />
        {:else if Array.isArray(selectedItem)}
          {#if selectedItem.length > 0}
            {#each selectedItem as item (item.id)}
              <span class="step-row flex-row-center flex-gap-1">
                {#if item.icon}
                  <Icon icon={item.icon} size="small" iconProps={item.iconProps} />
                {/if}
                <Label label={item.label} params={item.params ?? params} />
              </span>
            {/each}
          {:else}
            <span class="placeholder">
              <Label label={fallbackLabel} {params} />
            </span>
          {/if}
        {:else if selectedItem}
          {#if selectedItemComponent}
            <svelte:component this={selectedItemComponent} {...selectedItemComponentProps ?? {}} />
          {:else}
            <span class="flex-row-center flex-gap-1">
              {#if selectedItem.icon}
                <Icon icon={selectedItem.icon} size="small" iconProps={selectedItem.iconProps} />
              {/if}
              <Label label={selectedItem.label} params={selectedItem.params ?? params} />
            </span>
          {/if}
        {:else}
          <span class="placeholder">
            <Label label={fallbackLabel} {params} />
          </span>
        {/if}
      </span>
      {#if showDropdownIcon}
        <div class="dropdown-arrow-icon ml-2 flex-row-center">
          <DropdownIcon
            size="small"
            fill={kind === 'primary' && !disabled ? 'var(--primary-button-content-color)' : 'var(--theme-dark-color)'}
          />
        </div>
      {/if}
    </div>
  </ModernButton>
</div>

<style lang="scss">
  .modern-dropdown-container {
    display: inline-flex;
    min-width: 0;

    &.stretch-width {
      flex: 1;
    }

    :global(.hulyButton) {
      width: 100%;
      display: inline-flex;
      align-items: center;
      justify-content: flex-start;
      min-width: 0;
      height: 2.25rem;
    }
  }

  .dropdown-content-wrapper {
    display: flex;
    align-items: center;
    min-width: 0;
    width: 100%;

    &.justify-left {
      text-align: left;
      justify-content: flex-start;
    }
  }

  .placeholder {
    color: var(--input-PlaceholderColor) !important;
  }

  .step-row + .step-row {
    position: relative;
    margin-left: 0.75rem;

    &::before {
      position: absolute;
      content: '';
      top: 50%;
      left: -0.5rem;
      width: 0.25rem;
      height: 0.25rem;
      background-color: var(--dark-color);
      border-radius: 50%;
      transform: translateY(-50%);
    }
  }

  .multiselect-wrap {
    :global(.hulyButton) {
      height: auto !important;
      min-height: 2.25rem;
      padding-top: 0.25rem !important;
      padding-bottom: 0.25rem !important;
    }

    :global(.overflow-label) {
      white-space: normal !important;
      overflow: visible !important;
      text-overflow: unset !important;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.5rem;
    }

    .step-row + .step-row {
      margin-left: 0;

      &::before {
        display: none;
      }
    }
  }
</style>

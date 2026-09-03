<!--
// Copyright © 2023 Hardcore Engineering Inc.
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
  import type { Doc, Ref } from '@hcengineering/core'
  import { createEventDispatcher } from 'svelte'
  import type { Asset, IntlString } from '@hcengineering/platform'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import type { AnyComponent, IconSize, AnySvelteComponent } from '..'
  import {
    showPopup,
    Menu,
    Action,
    Label,
    Component,
    IconDown,
    IconDownOutline,
    IconOpenedArrow,
    IconFolderCollapsed,
    IconFolderExpanded,
    Icon,
    getTreeCollapsed,
    setTreeCollapsed,
    getCollapsedKey,
    tooltip
  } from '..'

  export let icon: Asset | AnySvelteComponent | undefined = undefined
  export let folderIcon: boolean = false
  export let iconProps: any | undefined = undefined
  export let iconSize: IconSize = 'small'
  export let label: IntlString | undefined = undefined
  export let title: string | undefined = undefined
  export let categoryName: string
  export let tools: AnyComponent | undefined = undefined
  export let defaultOpen: boolean | undefined = undefined
  export let isOpen: boolean = true
  export let isFold: boolean = false
  export let empty: boolean = false
  export let collapsedPrefix: string = ''
  export let visible: boolean = false
  export let highlighted: boolean = false
  export let selected: boolean = false
  export let type: 'default' | 'nested' | 'nested-selectable' | 'selectable-header' = 'default'
  export let noDivider: boolean = false
  export let showMenu: boolean = false
  export let shouldTooltip: boolean = false
  export let forciblyСollapsed: boolean = false
  export let draggable: boolean = false
  export let actions: Action[] = []
  export let _id: Ref<Doc> | string | undefined = undefined
  export let noPadding: boolean = false
  export let headerClickType: 'menu' | 'toggle' = 'menu'
  export let contextClickType: 'menu' | undefined = undefined
  export let testid: string | undefined = undefined

  const dispatch = createEventDispatcher()

  $: id = `navGroup-${categoryName}`
  let pressed: boolean = false

  $: isStored = _id ? localStorage.getItem(getCollapsedKey(_id as string, collapsedPrefix)) !== null : false
  $: isOpen = isStored ? !getTreeCollapsed(_id, collapsedPrefix) : (defaultOpen ?? true)

  const handleClick = (e: MouseEvent): void => {
    if (type === 'selectable-header') dispatch('click')
    else if ((!selected || empty) && type === 'nested-selectable') dispatch('click')
    else if (!empty) {
      toggle(e)
    }
  }

  function toggle (e: MouseEvent): void {
    e.stopPropagation()
    e.preventDefault()
    if (!empty) {
      isOpen = !isOpen
      if (_id) {
        const key = getCollapsedKey(_id as string, collapsedPrefix)
        !isOpen ? localStorage.setItem(key, 'COLLAPSED') : localStorage.setItem(key, 'EXPANDED')
      }
      dispatch('toggle', isOpen)
    }
  }

  function handleMenuClicked (ev: MouseEvent): void {
    if (actions.length === 0) return
    ev.stopPropagation()
    ev.preventDefault()
    pressed = true
    showPopup(Menu, { actions, ctx: { _id } }, ev.target as HTMLElement, () => {
      pressed = false
    })
  }

  $: visibleIcon = folderIcon ? (isOpen && !empty ? IconFolderExpanded : IconFolderCollapsed) : icon

  function onHeaderClick (e: MouseEvent): void {
    if (headerClickType === 'menu') handleMenuClicked(e)
    else if (headerClickType === 'toggle') toggle(e)
  }

  function onContextClick (e: MouseEvent): void {
    if (contextClickType === 'menu') handleMenuClicked(e)
  }
</script>

<div
  class="hulyNavGroup-container"
  class:nested={type === 'nested' || type === 'nested-selectable'}
  class:selectable={type === 'nested-selectable' || type === 'selectable-header'}
  class:selectableHeader={type === 'selectable-header'}
  class:noIcon={!icon}
  class:noDivider
  on:contextmenu={onContextClick}
  data-testid={testid}
>
  <button
    class="hulyNavGroup-header"
    class:isOpen={(isOpen || visible) && !empty}
    class:highlighted
    class:selected
    class:showMenu={showMenu || pressed}
    on:click={handleClick}
    {draggable}
    on:dragstart
    on:dragover
    on:dragend
    on:drop
  >
    {#if isFold && !empty}
      <button class="hulyNavGroup-header__chevron" class:collapsed={!isOpen} on:click={toggle}>
        <IconDown size={'small'} />
      </button>
    {/if}
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div class="hulyNavGroup-header__label font-medium-12" on:click={onHeaderClick}>
      {#if visibleIcon}
        <div class="hulyNavGroup-header__icon" class:folder={folderIcon}>
          <Icon icon={visibleIcon} size={iconSize} {iconProps} />
        </div>
      {/if}
      <span
        use:tooltip={shouldTooltip ? { label: label ?? getEmbeddedLabel(title ?? ''), direction: 'top' } : undefined}
        class="overflow-label"
      >
        {#if label}<Label {label} />{/if}
        {#if title}{title}{/if}
      </span>
      {#if actions.length > 0}
        <IconDownOutline size={'tiny'} />
      {/if}
    </div>
    {#if $$slots.afterTitle}<slot name="afterTitle" />{/if}
    <div class="flex-grow" />
    {#if $$slots.extra}<slot name="extra" />{/if}
    {#if tools || $$slots.tools}
      <div class="hulyNavGroup-header__tools">
        {#if tools}
          <Component
            is={tools}
            props={{
              kind: 'tools',
              categoryName
            }}
          />
        {/if}
        <slot name="tools" />
      </div>
    {/if}
    {#if $$slots.actions}
      <div class="hulyNavGroup-header__actions">
        <slot name="actions" />
      </div>
    {/if}
    {#if $$slots.after}
      <slot name="after" {isOpen} />
    {/if}
    {#if selected && type === 'nested-selectable'}
      <div class="hulyNavGroup-header__arrow"><IconOpenedArrow size={'small'} /></div>
    {/if}
  </button>
  {#if !empty}
    <div {id} class="hulyNavGroup-content" class:noPadding>
      {#if (!isOpen && visible) || forciblyСollapsed}
        <slot name="visible" {isOpen} />
      {:else}
        <slot />
      {/if}
    </div>
  {/if}
</div>

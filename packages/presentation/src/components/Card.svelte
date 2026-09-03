<!--
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021 Hardcore Engineering Inc.
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
  import {
    Button,
    IconClose,
    Label,
    Scroller,
    deviceOptionsStore as deviceInfo,
    resizeObserver,
    IconBack,
    getFocusManager
  } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import presentation from '..'
  import IconForward from './icons/Forward.svelte'

  export let label: IntlString
  export let labelProps: any | undefined = undefined
  export let okAction: () => Promise<void> | void
  export let canSave: boolean = false
  export let okLabel: IntlString = presentation.string.Create
  export let onCancel: (() => void) | undefined = undefined
  export let backAction: () => Promise<void> | void = () => {}
  export let isBack: boolean = false
  export let fullSize: boolean = false
  export let numberOfBlocks: number = 0
  export let thinHeader: boolean = false
  export let accentHeader: boolean = false
  export let headerNoPadding: boolean = false
  export let hideSubheader: boolean = false
  export let hideContent: boolean = false
  export let hideAttachments: boolean = false
  export let hideFooter: boolean = false
  export let hideClose: boolean = false
  export let gap: string | undefined = undefined
  export let width: 'large' | 'medium' | 'small' | 'x-small' | 'menu' = 'large'
  export let noFade = false

  const dispatch = createEventDispatcher()

  const focusManager = getFocusManager()

  let okProcessing = false
  $: headerDivide = hideContent && numberOfBlocks > 1

  function handleKeyDown (event: KeyboardEvent) {
    const target = event.target as HTMLInputElement

    if (target) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault()
        handleOkClick()
      } else if (event.key === 'Enter') {
        // ignore customized editable divs to not interrupt multiline behavior
        if (!target.isContentEditable && target.nodeName !== 'TEXTAREA') {
          event.preventDefault()
          focusManager?.next(1)
        }
      }
    }
  }

  function handleOkClick (): void {
    if (canSave) {
      if (okProcessing) {
        return
      }
      okProcessing = true
      const r = okAction()
      if (r instanceof Promise) {
        r.then(() => {
          okProcessing = false
          dispatch('close')
        })
      } else {
        okProcessing = false
        dispatch('close')
      }
    }
  }
</script>

<!-- The aside sits next to the card inside one wrapper, so the popup engine centres card+aside
     together: opening a side panel shifts the dialog instead of pushing it off-centre. -->
<div class="antiCard-wrap" class:mobile={$deviceInfo.isMobile}>
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <form
    id={label}
    class="antiCard {$deviceInfo.isMobile ? 'mobile' : 'dialog'} {width}"
    class:full={fullSize}
    on:keydown={handleKeyDown}
    on:submit|preventDefault={() => {}}
    use:resizeObserver={() => {
      dispatch('changeContent')
    }}
  >
    <div
      class="antiCard-header"
      class:withSub={$$slots.subheader && !hideSubheader}
      class:thinHeader
      class:noPadding={headerNoPadding}
      class:border-bottom-popup-divider={headerDivide}
    >
      <div class="antiCard-header__title-wrap">
        {#if $$slots.header}
          <slot name="header" />
        {/if}
        {#if isBack}
          <Button icon={IconBack} kind={'ghost'} size={'small'} on:click={backAction} />
        {/if}
        <!-- Divider and title are one wrap item: on a narrow header the ">" has to travel to the
             second line with the title it points at, not stay behind on the first. -->
        <div class="antiCard-header__title-group">
          {#if $$slots.header}
            <span class="antiCard-header__divider"><IconForward size={'small'} /></span>
          {/if}
          <div class="antiCard-header__title" class:accentHeader>
            {#if $$slots.title}
              <slot name="title" {label} labelProps={labelProps ?? {}} />
            {:else}
              <Label {label} params={labelProps ?? {}} />
            {/if}
          </div>
        </div>
      </div>
      {#if $$slots['header-actions']}
        <!-- ml-auto, not just a margin: the header is space-between, so without it the actions
             float in the middle of the gap instead of sitting next to the close button. -->
        <div class="ml-auto mr-2 buttons-group small-gap">
          <slot name="header-actions" />
        </div>
      {/if}
      {#if !hideClose}
        <div class="ml-2 buttons-group small-gap content-dark-color">
          <Button
            id="card-close"
            focusIndex={10002}
            icon={IconClose}
            iconProps={{ size: 'medium', fill: 'var(--theme-dark-color)' }}
            kind={'ghost'}
            size={'small'}
            on:click={() => {
              if (onCancel) {
                onCancel()
              } else {
                dispatch('close')
              }
            }}
          />
        </div>
      {/if}
    </div>
    {#if $$slots.subheader && !hideSubheader}
      <div class="antiCard-subheader">
        <slot name="subheader" />
      </div>
    {/if}
    {#if !hideContent}
      <div class="antiCard-content">
        <Scroller padding={$$slots.pool ? '.5rem 1.5rem' : '.5rem 1.5rem 1.5rem'} {gap} {noFade}>
          <slot />
        </Scroller>
      </div>
    {/if}
    {#if $$slots.pool}
      <div class="antiCard-pool">
        <slot name="pool" />
      </div>
    {/if}
    {#if $$slots.blocks && numberOfBlocks}
      {#if numberOfBlocks === 1}
        <div class="antiCard-block">
          <slot name="blocks" block={0} />
        </div>
      {:else}
        <Scroller noFade={false}>
          {#each [...Array(numberOfBlocks).keys()] as block}
            <div class="antiCard-blocks" class:border-top-none={headerDivide && block === 0}>
              <slot name="blocks" {block} />
            </div>
          {/each}
        </Scroller>
      {/if}
    {/if}
    {#if $$slots.attachments && !hideAttachments}
      <div class="antiCard-attachments">
        <Scroller horizontal contentDirection={'horizontal'} {gap} noFade={false}>
          <div class="antiCard-attachments__container">
            <slot name="attachments" />
          </div>
        </Scroller>
      </div>
    {/if}
    {#if !hideFooter}
      <div class="antiCard-footer divide reverse">
        <div class="buttons-group text-sm flex-no-shrink">
          {#if $$slots.buttons}
            <slot name="buttons" />
          {/if}
          {#if $$slots['after-buttons']}
            <slot name="after-buttons" {handleOkClick} {okProcessing} focusIndex={10001} {canSave} {okLabel} />
          {:else}
            <Button
              loading={okProcessing}
              focusIndex={10001}
              minWidth={'5rem'}
              disabled={!canSave}
              label={okLabel}
              kind={'primary'}
              size={'large'}
              on:click={handleOkClick}
            />
          {/if}
        </div>
        <div class="buttons-group small-gap text-sm">
          <slot name="footer" />
          {#if $$slots.error}
            <div class="antiCard-footer__error">
              <slot name="error" />
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </form>

  {#if $$slots.aside}
    <div class="antiCard-aside">
      <slot name="aside" />
    </div>
  {/if}
</div>

<style lang="scss">
  .antiCard-wrap {
    display: flex;
    align-items: stretch;
    gap: 0.75rem;
    min-height: 0;

    // The card keeps its own fixed width and the aside its own: without this the row would
    // squeeze the aside to zero instead of making the popup wider.
    form {
      flex: 0 0 auto;
    }

    &.mobile {
      flex-direction: column;
    }
  }

  .antiCard-aside {
    display: flex;
    flex: 0 0 auto;
    min-height: 0;
    max-height: 100%;
  }

  // Set from the outside by an aside that wants the full stage, hence :global. Card and panel then
  // split the row, leaving at most 100px free per side; the extra classes outweigh the fixed width.
  :global(.antiCard-wrap.wide) {
    width: max(60vw, 100vw - 200px);
    height: 80vh;
  }

  :global(.antiCard-wrap.wide > form.antiCard.dialog),
  :global(.antiCard-wrap.wide > .antiCard-aside) {
    flex: 1 1 0;
    min-width: 0;
    width: auto;
    max-width: none;
  }
</style>

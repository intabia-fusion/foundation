<!--
// Copyright © 2026 Intabia Fusion.
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
  import { Button, FocusHandler, Label, createFocusManager, Scroller } from '@hcengineering/ui'
  import { createEventDispatcher, onMount, onDestroy } from 'svelte'
  import { ChatMessage } from '@hcengineering/chunter'
  import view from '@hcengineering/view'
  import presentation, { getClient } from '@hcengineering/presentation'

  import DeleteMessagePresenter from './DeleteMessagePresenter.svelte'
  import chunter from '../plugin'

  export let message: ChatMessage

  const dispatch = createEventDispatcher()
  const manager = createFocusManager()

  let processing = false

  let isAtTop = true

  function onKeyDown (ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()

      dispatch('close', false)
    }
  }

  async function handleDelete (): Promise<void> {
    try {
      processing = true
      const client = getClient()

      await client.removeCollection(
        message._class,
        message.space,
        message._id,
        message.attachedTo,
        message.attachedToClass,
        message.collection
      )
      dispatch('close', true)
    } finally {
      processing = false
    }
  }

  let isAtBottom = false

  function handleScroll (): void {
    if (!divScroll) return

    const { scrollHeight, clientHeight, scrollTop } = divScroll
    isAtTop = scrollTop < 1
    isAtBottom = scrollHeight - scrollTop - clientHeight < 1
  }

  let divScroll: HTMLDivElement | undefined | null = undefined

  onMount(() => {
    if (!divScroll) return undefined

    handleScroll()
    divScroll.addEventListener('scroll', handleScroll)

    return () => {
      divScroll?.removeEventListener('scroll', handleScroll)
    }
  })

  onDestroy(() => {
    divScroll?.removeEventListener('scroll', handleScroll)
  })
</script>

<FocusHandler {manager} />

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="container" on:keydown={onKeyDown}>
  <div class="header overflow-label fs-title" class:noBorder={isAtTop}>
    <Label label={chunter.string.DeleteMessage} />
  </div>
  <Scroller padding="0" bind:divScroll>
    <div class="message">
      <Label label={chunter.string.DeleteMessageDescription} />
    </div>

    <div class="component">
      <DeleteMessagePresenter value={message} />
    </div>
  </Scroller>
  <div class="footer" class:noBorder={isAtBottom}>
    <Button
      focus={false}
      focusIndex={1}
      label={view.string.Delete}
      size="large"
      kind="dangerous"
      loading={processing}
      on:click={handleDelete}
    />
    <Button
      focusIndex={2}
      label={presentation.string.Cancel}
      size={'large'}
      on:click={() => {
        dispatch('close', false)
      }}
    />
  </div>
</div>

<style lang="scss">
  .container {
    display: flex;
    flex-direction: column;
    width: 40rem;
    max-width: 40rem;
    background: var(--theme-popup-color);
    border-radius: 0.5rem;
    user-select: none;
    box-shadow: var(--theme-popup-shadow);
    max-height: 30rem;

    @media screen and (max-width: 480px) {
      width: 100%;
      max-width: 100%;
    }

    .message {
      padding: 0 2rem;
      margin-bottom: 1.5rem;
      color: var(--theme-content-color);
    }

    .component {
      display: flex;
      flex-direction: column;
      padding: 0 2rem;
    }

    .header {
      font-size: 1.25rem;
      padding: 1rem 2rem;
      min-height: 3.75rem;
      border-bottom: 1px solid var(--global-ui-BorderColor);

      &.noBorder {
        border-bottom: none;
      }
    }

    .footer {
      flex-shrink: 0;
      display: grid;
      grid-auto-flow: column;
      direction: rtl;
      justify-content: flex-start;
      align-items: center;
      column-gap: 0.5rem;
      padding: 1rem 2rem;
      border-top: 1px solid var(--global-ui-BorderColor);

      &.noBorder {
        border-top: none;
      }
    }
  }
</style>

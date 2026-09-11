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
  import notification, { ActivityNotificationViewlet, DocNotifyContext } from '@hcengineering/notification'
  import { Ref } from '@hcengineering/core'
  import { createEventDispatcher } from 'svelte'
  import { ListView } from '@hcengineering/ui'
  import { getClient } from '@hcengineering/presentation'

  import DocNotifyContextCard from '../DocNotifyContextCard.svelte'
  import { removeDocNotifyContext } from '../../actions'

  export let contexts: DocNotifyContext[] = []
  export let selectedContext: Ref<DocNotifyContext> | undefined

  const client = getClient()
  const dispatch = createEventDispatcher()

  let list: ListView
  let listSelection = 0
  let element: HTMLDivElement | undefined

  let removingContexts = new Set<Ref<DocNotifyContext>>()
  let viewlets: ActivityNotificationViewlet[] = []

  void client.findAll(notification.class.ActivityNotificationViewlet, {}).then((res) => {
    viewlets = res
  })

  async function removeContext (listSelection: number): Promise<void> {
    const context = contexts[listSelection]
    if (context === undefined) return

    removingContexts = removingContexts.add(context._id)

    try {
      await removeDocNotifyContext(context)
    } finally {
      removingContexts.delete(context._id)
      removingContexts = removingContexts
    }
  }

  async function onKeydown (key: KeyboardEvent): Promise<void> {
    const actions: Record<string, () => void> = {
      ArrowUp: () => {
        selectIndex(listSelection - 1)
      },
      ArrowDown: () => {
        selectIndex(listSelection + 1)
      },
      Home: () => {
        selectIndex(0)
      },
      End: () => {
        selectIndex(contexts.length - 1)
      },
      Enter: () =>
        dispatch('click', {
          context: contexts[listSelection]
        }),
      Backspace: () => {
        void removeContext(listSelection)
      },
      Delete: () => {
        void removeContext(listSelection)
      }
    }

    if (actions[key.code] != null) {
      key.preventDefault()
      key.stopPropagation()
      actions[key.code]()
    }
  }

  $: if (element != null) element.focus()

  function selectIndex (index: number): void {
    if (contexts.length > 0) {
      list.select(Math.max(0, Math.min(index, contexts.length - 1)))
    }
  }
  function getContextKey (index: number): string {
    const contextId = contexts[index]?._id
    return contextId ?? index.toString()
  }
</script>

<div
  class="root"
  bind:this={element}
  tabindex="0"
  role="listbox"
  aria-label="Inbox notifications"
  on:keydown={onKeydown}
>
  <ListView
    bind:this={list}
    bind:selection={listSelection}
    count={contexts.length}
    items={contexts}
    highlightIndex={contexts.findIndex((context) => context._id === selectedContext)}
    noScroll
    kind="full-size"
    colorsSchema="lumia"
    getKey={getContextKey}
  >
    <svelte:fragment slot="item" let:item={itemIndex} let:value={context}>
      {#if context}
        <DocNotifyContextCard
          value={context}
          {viewlets}
          isClearing={removingContexts.has(context._id)}
          on:clear={() => removeContext(itemIndex)}
          on:click={(event) => {
            dispatch('click', event.detail)
            listSelection = itemIndex
          }}
        />
      {/if}
    </svelte:fragment>
  </ListView>
</div>

<style lang="scss">
  .root {
    &:focus {
      outline: 0;
    }
    :global(.list-item) {
      border-radius: 0;
    }
  }
</style>

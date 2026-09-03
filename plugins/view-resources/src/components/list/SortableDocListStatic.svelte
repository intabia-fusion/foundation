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
  import { Class, Doc, Ref, SortingOrder } from '@hcengineering/core'
  import { Asset, getResource, IntlString } from '@hcengineering/platform'
  import { getClient } from '@hcengineering/presentation'
  import { DocWithRank, makeRank } from '@hcengineering/task'
  import { IconSize } from '@hcengineering/ui'
  import { SvelteComponent, createEventDispatcher } from 'svelte'
  import { getListItemPresenter, getObjectPresenter } from '../../utils'
  import SortableList from './SortableList.svelte'

  export let _class: Ref<Class<Doc>>
  export let items: Doc[] = []
  export let sortingOrder: SortingOrder = SortingOrder.Ascending
  export let label: IntlString | undefined = undefined
  export let presenterProps: Record<string, any> = {}
  export let direction: 'row' | 'column' = 'column'
  export let flipDuration = 200
  export let itemsCount = 0
  export let icon: Asset | undefined = undefined
  export let iconSize: IconSize = 'small'

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const dispatch = createEventDispatcher()

  let presenter: typeof SvelteComponent | undefined

  async function updatePresenter (classRef: Ref<Class<Doc>>): Promise<void> {
    try {
      const listItemPresenter = await getListItemPresenter(client, classRef)
      if (listItemPresenter) {
        presenter = await getResource(listItemPresenter)
        return
      }

      const objectModel = await getObjectPresenter(client, classRef, { key: '' })
      if (objectModel?.presenter) {
        presenter = objectModel.presenter
      }
    } catch (e) {
      console.error(e)
    }
  }

  $: !$$slots.object && updatePresenter(_class)

  $: isSortable = hierarchy.getAllAttributes(_class).has('rank')

  let sortedItems: Doc[] = []
  $: {
    if (isSortable) {
      sortedItems = [...items].sort((a, b) => {
        const rankA = (a as any).rank ?? ''
        const rankB = (b as any).rank ?? ''
        if (rankA === rankB) return 0
        const comp = rankA < rankB ? -1 : 1
        return sortingOrder === SortingOrder.Ascending ? comp : -comp
      })
    } else {
      sortedItems = items
    }
  }

  async function handleMove (
    e: CustomEvent<{ item: DocWithRank, prev: DocWithRank | undefined, next: DocWithRank | undefined, items: Doc[] }>
  ): Promise<void> {
    const { item, prev, next, items: newItems } = e.detail

    if (isSortable) {
      const rank =
        sortingOrder === SortingOrder.Ascending ? makeRank(prev?.rank, next?.rank) : makeRank(next?.rank, prev?.rank)
      try {
        await client.update(item, { rank })
      } catch (err) {
        console.error('Failed to update rank', err)
      }
    }

    dispatch('move', { item, prev, next, items: newItems })
  }
</script>

<SortableList
  items={sortedItems}
  {label}
  {direction}
  {flipDuration}
  {icon}
  {iconSize}
  bind:itemsCount
  on:move={handleMove}
>
  <svelte:fragment slot="object" let:value>
    {#if $$slots.object}
      <slot name="object" {value} />
    {:else if presenter}
      <svelte:component this={presenter} {...presenterProps} {value} />
    {/if}
  </svelte:fragment>
</SortableList>

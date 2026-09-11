<!--
// Copyright © 2022, 2023 Hardcore Engineering Inc.
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
  import type { Class, Ref, Space } from '@hcengineering/core'
  import { DocNotifyContext } from '@hcengineering/notification'
  import { NotificationClientImpl } from '@hcengineering/notification-resources'
  import { IntlString } from '@hcengineering/platform'
  import { getClient } from '@hcengineering/presentation'
  import { TreeNode } from '@hcengineering/view-resources'
  import { SpacesNavModel } from '@hcengineering/workbench'
  import StarredNavItem from './StarredNavItem.svelte'

  export let label: IntlString
  export let spaces: Space[]
  export let models: SpacesNavModel[]
  export let currentSpace: Ref<Space> | undefined
  export let currentSpecial: string | undefined
  export let currentFragment: string | undefined
  export let deselect: boolean = false

  const client = getClient()

  function getSpaceModel (space: Ref<Class<Space>>): SpacesNavModel | undefined {
    const hierarchy = client.getHierarchy()
    const ancestors = [space, ...[...hierarchy.getAncestors(space)].reverse()]
    for (const clazz of ancestors) {
      const model = models.find((p) => p.spaceClass === clazz)
      if (model !== undefined) return model
    }
    return undefined
  }

  const inboxClient = NotificationClientImpl.getClient()
  const notifyContextByDocStore = inboxClient.contextByDoc

  function isChanged (context: DocNotifyContext | undefined): boolean {
    return (context?.unreadCount ?? 0) > 0
  }
  $: visibleSpace = spaces.find((space) => currentSpace === space._id)
  $: void inboxClient.loadContextsByDoc(spaces.map((s) => s._id))
</script>

<TreeNode
  _id={'tree-stared'}
  {label}
  highlighted={spaces.some((s) => s._id === currentSpace) && !deselect}
  isFold
  empty={spaces.length === 0}
  visible={visibleSpace !== undefined && !deselect}
>
  {#each spaces as space (space._id)}
    {@const model = getSpaceModel(space._class)}
    <StarredNavItem
      {space}
      {model}
      {currentSpace}
      {currentSpecial}
      {currentFragment}
      {deselect}
      isChanged={isChanged($notifyContextByDocStore.get(space._id) ?? undefined)}
    />
  {/each}

  <svelte:fragment slot="visible">
    {#if visibleSpace}
      {@const model = getSpaceModel(visibleSpace._class)}
      <StarredNavItem
        space={visibleSpace}
        {model}
        {currentSpace}
        {currentSpecial}
        {currentFragment}
        {deselect}
        isChanged={isChanged($notifyContextByDocStore.get(visibleSpace._id) ?? undefined)}
        forciblyСollapsed
      />
    {/if}
  </svelte:fragment>
</TreeNode>

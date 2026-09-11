<!--
// Copyright © 2024 Hardcore Engineering Inc.
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
  import { Action, Menu, ModernTab, showPopup } from '@hcengineering/ui'
  import { Widget } from '@hcengineering/workbench'
  import { getResource } from '@hcengineering/platform'
  import { ChatWidgetTab } from '@hcengineering/chunter'
  import { NotificationClientImpl, NotifyMarker } from '@hcengineering/notification-resources'
  import { getUnreadMessageCount } from '@hcengineering/notification'

  export let tab: ChatWidgetTab
  export let widget: Widget
  export let selected = false
  export let actions: Action[] = []

  const notificationClient = NotificationClientImpl.getClient()
  const contextByDocStore = notificationClient.contextByDoc

  $: icon = tab.icon ?? widget.icon

  $: if (tab.iconComponent != null) {
    void getResource(tab.iconComponent).then((res) => {
      icon = res
    })
  }

  let count: number = 0

  $: objectId = tab.data.thread ?? tab.data._id
  $: void notificationClient.loadContextByDoc(objectId)
  $: context = objectId != null ? ($contextByDocStore.get(objectId) ?? undefined) : undefined
  $: count = getUnreadMessageCount(context)

  function handleMenu (event: CustomEvent<MouseEvent>): void {
    if (actions.length === 0) {
      return
    }
    event.preventDefault()
    event.stopPropagation()

    showPopup(Menu, { actions }, event.detail.target as HTMLElement)
  }
</script>

<ModernTab
  label={tab.name}
  labelIntl={widget.label}
  highlighted={selected}
  orientation="vertical"
  kind={tab.isPinned ? 'secondary' : 'primary'}
  italic={tab.isPinned !== true && tab.isKept !== true}
  {icon}
  iconProps={tab.iconProps}
  canClose={!tab.isPinned}
  maxSize="13.5rem"
  on:close
  on:click
  on:contextmenu={handleMenu}
>
  <svelte:fragment slot="prefix">
    {#if count > 0}
      <NotifyMarker kind="simple" size="xx-small" />
    {/if}
  </svelte:fragment>
</ModernTab>

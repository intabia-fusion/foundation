<!--
// Copyright © 2023 Hardcore Engineering Inc.
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
  import activity, { ActivityMessage } from '@hcengineering/activity'
  import chunter from '@hcengineering/chunter'
  import { Class, Doc, Ref } from '@hcengineering/core'
  import { ContextNotification, DocNotifyContext, notificationId } from '@hcengineering/notification'
  import { ActionContext, getClient } from '@hcengineering/presentation'
  import {
    AnyComponent,
    closePanel,
    Component,
    defineSeparators,
    deviceOptionsStore as deviceInfo,
    getCurrentLocation,
    Location,
    location as locationStore,
    restoreLocation,
    Separator,
    Scroller
  } from '@hcengineering/ui'
  import view, { decodeObjectURI } from '@hcengineering/view'
  import { parseLinkId } from '@hcengineering/view-resources'
  import { getResource } from '@hcengineering/platform'

  import notification from '../../plugin'
  import { InboxFilter } from '../../types'
  import { resetInboxContext, resolveLocation, selectInboxContext } from '../../utils'
  import { onDestroy, onMount } from 'svelte'
  import InboxHeader from './InboxHeader.svelte'
  import InboxGroupedListView from './InboxGroupedListView.svelte'
  import { updateInboxContexts, inboxContextsStore, hasInboxNextPageStore } from '../../stores'
  import LoadingHistory from '../LoadingHistory.svelte'

  import { NotificationClientImpl } from '../../client'

  const inboxClient = NotificationClientImpl.getClient()
  const client = getClient()
  const hierarchy = client.getHierarchy()

  let syncLocationToken = 0

  const linkProviders = client.getModel().findAllSync(view.mixin.LinkIdProvider, {})
  const unsubscribeLoc = locationStore.subscribe((loc) => {
    void syncLocation(loc)
  })

  let urlObjectId: Ref<Doc> | undefined = undefined
  let urlObjectClass: Ref<Class<Doc>> | undefined = undefined

  let filter: InboxFilter | undefined = undefined
  let selectedTabId: string = 'all'

  let selectedContextId: Ref<DocNotifyContext> | undefined = undefined
  let selectedContext: DocNotifyContext | undefined = undefined
  let selectedComponent: AnyComponent | undefined = undefined
  let selectedMessage: ActivityMessage | undefined = undefined

  let divScroll: HTMLDivElement | null | undefined = undefined
  let replacedPanel: HTMLElement

  let limit = 20
  let contexts: DocNotifyContext[] = $inboxContextsStore

  let isLocationInitialized = false

  $: updateInboxContexts(
    {
      ...(selectedTabId === 'all'
        ? {}
        : { objectClass: { $in: Array.from(new Set(hierarchy.getDescendants(selectedTabId as Ref<Class<Doc>>))) } }),
      ...(filter === 'unread' ? { unreadCount: { $gt: 0 } } : {})
    },
    limit
  )
  $: contexts = $inboxContextsStore

  $: initializeLocation(contexts)

  let prevTabId = selectedTabId
  let prevFilter: InboxFilter | undefined = filter

  $: if (selectedTabId !== prevTabId || filter !== prevFilter) {
    prevTabId = selectedTabId
    prevFilter = filter
    limit = 20
    if (divScroll != null) {
      divScroll.scrollTop = 0
    }
  }

  function initializeLocation (contexts: DocNotifyContext[]): void {
    if (selectedContext !== undefined || contexts.length === 0 || isLocationInitialized) {
      return
    }

    isLocationInitialized = true

    const loc = getCurrentLocation()
    void syncLocation(loc)
  }

  async function syncLocation (newLocation: Location): Promise<void> {
    const token = ++syncLocationToken
    const loc = await resolveLocation(newLocation)
    if (token !== syncLocationToken) return
    if (loc?.loc.path[2] !== notificationId) {
      return
    }

    if (loc?.loc.path[3] == null) {
      selectedContext = undefined
      urlObjectId = undefined
      urlObjectClass = undefined
      restoreLocation(newLocation, notificationId)
      return
    }

    const [id, _class] = decodeObjectURI(loc?.loc.path[3] ?? '')
    const _id = await parseLinkId(linkProviders, id, _class)

    if (token !== syncLocationToken) return
    urlObjectId = _id
    urlObjectClass = _class

    const thread = loc?.loc.path[4] as Ref<ActivityMessage>
    const queryContext = loc.loc.query?.context as Ref<DocNotifyContext>

    urlObjectId = _id
    urlObjectClass = _class

    let context: DocNotifyContext | undefined = undefined

    if (queryContext != null) {
      context =
        contexts.find((c) => c._id === queryContext) ??
        (await client.findOne(notification.class.DocNotifyContext, { _id: queryContext }))
    } else if (thread != null) {
      context = await client.findOne(notification.class.DocNotifyContext, { objectId: thread })
    } else {
      context = await client.findOne(notification.class.DocNotifyContext, { objectId: _id })
    }

    if (token !== syncLocationToken) return
    selectedContextId = context?._id

    if (selectedContextId !== selectedContext?._id) {
      selectedContext = undefined
    }

    const selectedMessageId = loc?.loc.query?.message as Ref<ActivityMessage> | undefined

    if (thread !== undefined) {
      const fn = await getResource(chunter.function.OpenThreadInSidebar)
      if (token !== syncLocationToken) return
      void fn(thread, undefined, undefined, selectedMessageId, { autofocus: false }, false)
    }

    if (selectedMessageId !== undefined) {
      const msg = await client.findOne(activity.class.ActivityMessage, { _id: selectedMessageId })
      if (token !== syncLocationToken) return
      selectedMessage = msg
    }
  }

  $: selectedContext =
    selectedContextId != null ? (selectedContext ?? contexts.find((c) => c._id === selectedContextId)) : undefined

  $: void updateSelectedPanel(selectedContext, urlObjectClass)

  async function selectContext (
    event?: CustomEvent<{ context?: DocNotifyContext, notification?: ContextNotification }>
  ): Promise<void> {
    closePanel()
    selectedContext = event?.detail?.context
    selectedContextId = selectedContext?._id

    if (selectedContext === undefined) {
      resetInboxContext()
      return
    }

    const selectedNotification: ContextNotification | undefined = event?.detail?.notification

    void selectInboxContext(linkProviders, selectedContext, selectedNotification)
  }

  function isChunterChannel (selectedContext: DocNotifyContext, urlObjectClass?: Ref<Class<Doc>>): boolean {
    const isActivityMessageContext = hierarchy.isDerived(selectedContext.objectClass, activity.class.ActivityMessage)
    const chunterClass = isActivityMessageContext
      ? (urlObjectClass ?? selectedContext.objectClass)
      : selectedContext.objectClass
    return hierarchy.isDerived(chunterClass, chunter.class.ChunterSpace)
  }

  async function updateSelectedPanel (
    selectedContext?: DocNotifyContext,
    urlObjectClass?: Ref<Class<Doc>>
  ): Promise<void> {
    if (selectedContext === undefined) {
      selectedComponent = undefined
      return
    }

    const isChunter = isChunterChannel(selectedContext, urlObjectClass)
    const panelComponent = hierarchy.classHierarchyMixin(
      isChunter ? (urlObjectClass ?? selectedContext.objectClass) : selectedContext.objectClass,
      view.mixin.ObjectPanel
    )

    selectedComponent = panelComponent?.component ?? view.component.EditDoc

    if (isChunter) {
      await inboxClient.readNotificationsWithoutMessage(selectedContext.objectId)
    } else {
      await inboxClient.readDoc(selectedContext.objectId)
    }
  }

  defineSeparators('inbox', [
    { minSize: 12.5, maxSize: 40, size: 17.5, float: 'navigator' },
    { size: 'auto', minSize: 20, maxSize: 'auto' },
    { size: 20, minSize: 20, maxSize: 50, float: 'aside' }
  ])

  $: $deviceInfo.replacedPanel = replacedPanel

  function handleScroll (): void {
    if (divScroll != null && $hasInboxNextPageStore && contexts.length === limit) {
      const isAtBottom = divScroll.scrollTop + divScroll.clientHeight >= divScroll.scrollHeight - 400
      if (isAtBottom) {
        limit += 20
      }
    }
  }

  onMount(() => {
    divScroll?.addEventListener('scroll', handleScroll)
  })
  onDestroy(() => {
    $deviceInfo.replacedPanel = undefined
    unsubscribeLoc()

    divScroll?.removeEventListener('scroll', handleScroll)
  })
</script>

<ActionContext
  context={{
    mode: 'browser'
  }}
/>

<div class="hulyPanels-container">
  {#if $deviceInfo.navigator.visible}
    <div
      class="antiPanel-navigator {$deviceInfo.navigator.direction === 'horizontal'
        ? 'portrait'
        : 'landscape'} border-left"
      class:fly={$deviceInfo.navigator.float}
    >
      <div class="antiPanel-wrap__content hulyNavPanel-container">
        <InboxHeader bind:filter bind:selectedTabId />

        <Scroller padding="0" bind:divScroll>
          <InboxGroupedListView {contexts} selectedContext={selectedContextId} on:click={selectContext} />
          {#if $hasInboxNextPageStore && contexts.length > 0}
            <LoadingHistory isLoading={contexts.length < limit} />
          {/if}
        </Scroller>
      </div>
      {#if !($deviceInfo.isMobile && $deviceInfo.isPortrait && $deviceInfo.minWidth)}
        <Separator name="inbox" float={$deviceInfo.navigator.float ? 'navigator' : true} index={0} />
      {/if}
    </div>
    <Separator
      name="inbox"
      float={$deviceInfo.navigator.float}
      index={0}
      color={'transparent'}
      separatorSize={0}
      short
    />
  {/if}
  <div bind:this={replacedPanel} class="hulyComponent">
    {#if selectedContext != null && selectedComponent != null}
      <Component
        is={selectedComponent}
        props={{
          _id: isChunterChannel(selectedContext, urlObjectClass)
            ? (urlObjectId ?? selectedContext.objectId)
            : selectedContext.objectId,
          _class: isChunterChannel(selectedContext, urlObjectClass)
            ? (urlObjectClass ?? selectedContext.objectClass)
            : selectedContext.objectClass,
          autofocus: false,
          embedded: true,
          context: selectedContext,
          activityMessage: selectedMessage,
          props: { context: selectedContext, autofocus: false }
        }}
        on:close={() => selectContext(undefined)}
      />
    {/if}
  </div>
</div>

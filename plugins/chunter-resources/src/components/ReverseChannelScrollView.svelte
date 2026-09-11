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
  import activity, { ActivityMessage } from '@hcengineering/activity'
  import {
    ActivityMessagePresenter,
    canGroupMessages,
    messageInFocus,
    editingMessageStore
  } from '@hcengineering/activity-resources'
  import core, { Doc, getCurrentAccount, Ref, Space, Tx, TxCUD, getDay, Timestamp, notEmpty } from '@hcengineering/core'
  import { ReadState } from '@hcengineering/notification'
  import { NotificationClientImpl } from '@hcengineering/notification-resources'
  import { addTxListener, getClient, removeTxListener } from '@hcengineering/presentation'
  import { ModernButton, Scroller, Loading, isAppFocusedStore } from '@hcengineering/ui'
  import { afterUpdate, onDestroy, onMount, tick } from 'svelte'
  import { ChatMessage } from '@hcengineering/chunter'

  import { ChatViewport } from '../chatViewport'
  import chunter from '../plugin'
  import {
    messageInView,
    recheckNotifications,
    chatReadMessagesStore,
    readMessages,
    readViewportMessages
  } from '../scroll'
  import BlankView from './BlankView.svelte'
  import ChannelInput from './ChannelInput.svelte'
  import ActivityMessagesSeparator from './ChannelMessagesSeparator.svelte'
  import HistoryLoading from './LoadingHistory.svelte'
  import JumpToDateSelector from './JumpToDateSelector.svelte'

  export let viewport: ChatViewport
  export let object: Doc
  export let channel: Doc
  export let selectedMessageId: Ref<ActivityMessage> | undefined = undefined
  export let fixedInput = true
  export let collection: string = 'messages'
  export let fullHeight = true
  export let freeze = false
  export let autofocus = true
  export let withInput: boolean = true
  export let readonly: boolean = false
  export let onReply: ((message: ActivityMessage) => void) | undefined = undefined

  const minMsgHeightRem = 2
  const loadMoreThreshold = 200
  const newSeparatorOffset = 150

  const account = getCurrentAccount()
  const socialStrings = account.socialIds
  const client = getClient()
  const hierarchy = client.getHierarchy()
  const inboxClient = NotificationClientImpl.getClient()
  const contextByDocStore = inboxClient.contextByDoc
  const readStateByDocStore = inboxClient.readStateByDoc

  // Stores
  const messagesStore = viewport.messages
  const isLoadingStore = viewport.isLoading
  const isTailLoadedStore = viewport.isTailLoaded
  const newTimestampStore = viewport.newTimestamp
  const canLoadNextForward = viewport.canLoadNextForward
  const isLoadingMoreStore = viewport.isLoadingMore

  const doc = object

  let messages: ActivityMessage[] = []
  let messagesCount = 0

  let isReadStateLoaded = false
  let readState: ReadState | undefined = undefined

  // Elements
  let scroller: Scroller | undefined | null = undefined
  let scrollDiv: HTMLDivElement | undefined | null = undefined
  let contentDiv: HTMLDivElement | undefined | null = undefined
  let separatorDiv: HTMLDivElement | undefined | null = undefined
  let contentResizeObserver: ResizeObserver | undefined

  // Scrolling
  let isScrollInitialized = false
  let shouldScrollToNew = false
  let isScrollAtBottom = false

  function setupContentObserver (node: HTMLDivElement | undefined | null): void {
    if (contentResizeObserver !== undefined) {
      contentResizeObserver.disconnect()
      contentResizeObserver = undefined
    }

    if (node != null) {
      contentResizeObserver = new ResizeObserver(() => {
        if ((shouldScrollToNew || isScrollAtBottom) && isScrollInitialized) {
          scrollToBottom()
        }
      })
      contentResizeObserver.observe(node)
    }
  }

  $: setupContentObserver(contentDiv)

  let isLatestMessageButtonVisible = false

  // Pagination
  let backwardRequested = false
  let restoreScrollTop = 0
  let restoreScrollHeight = 0

  let isPageHidden = false
  let lastMsgBeforeFreeze: Ref<ActivityMessage> | undefined = undefined
  let needUpdateTimestamp = false

  interface MessageGroup {
    day: Timestamp
    messages: ActivityMessage[]
  }

  let messageGroups: MessageGroup[] = []

  $: messages = $messagesStore

  $: {
    const groups: MessageGroup[] = []
    const groupsMap = new Map<Timestamp, MessageGroup>()

    for (const message of messages) {
      const day = getDay(message.createdOn ?? message.modifiedOn ?? 0)
      let group = groupsMap.get(day)
      if (group === undefined) {
        group = { day, messages: [] }
        groupsMap.set(day, group)
        groups.push(group)
      }
      group.messages.push(message)
    }
    messageGroups = groups
  }
  $: void inboxClient.loadContextByDoc(doc._id)
  $: notifyContext = $contextByDocStore.get(doc._id) ?? undefined
  $: isThread = hierarchy.isDerived(doc._class, activity.class.ActivityMessage)
  $: isChunterSpace = hierarchy.isDerived(doc._class, chunter.class.ChunterSpace)
  $: readonly = hierarchy.isDerived(channel._class, core.class.Space)
    ? readonly || (channel as Space).archived
    : readonly

  $: separatorIndex =
    $newTimestampStore !== undefined
      ? messages.findIndex((message) => (message.createdOn ?? 0) >= ($newTimestampStore ?? 0))
      : -1

  $: if (!freeze && !isPageHidden && isScrollInitialized) {
    read()
  }

  $: void inboxClient.getReadState(object._id).then((it) => {
    readState = it
    isReadStateLoaded = true
  })
  $: readState = $readStateByDocStore.get(doc._id) ?? undefined

  $: if (notifyContext !== undefined && !isFreeze() && isScrollInitialized) {
    recheckNotifications(notifyContext)
  }

  $: adjustScrollPosition(selectedMessageId)
  $: void initializeScroll($isLoadingStore || !isReadStateLoaded, separatorDiv, separatorIndex)
  $: void handleMessagesUpdated(messages.length)

  function adjustScrollPosition (selectedMessageId?: Ref<ActivityMessage>): void {
    if ($isLoadingStore || !isReadStateLoaded || !isScrollInitialized) {
      return
    }
    if (selectedMessageId !== undefined) {
      void viewport.jumpToMessageId(selectedMessageId).then((isReload) => {
        if (isReload) {
          reinitializeScroll()
        } else {
          scrollToMessage()
        }
      })
    }
  }

  function handleJumpToDate (e: CustomEvent<{ date: Timestamp }>): void {
    const date = e.detail.date
    if (date !== undefined) {
      void viewport.jumpToDate(date).then((targetId) => {
        if (targetId !== undefined) {
          selectedMessageId = targetId
        }
        reinitializeScroll()
      })
    }
  }

  $: {
    if (!$isAppFocusedStore) {
      if (!isPageHidden) {
        isPageHidden = true
        needUpdateTimestamp = true
        lastMsgBeforeFreeze = shouldScrollToNew ? messages[messages.length - 1]?._id : undefined
        flushReadQueue()
      }
    } else {
      if (isPageHidden) {
        isPageHidden = false
        needUpdateTimestamp = false
      }
    }
  }

  function isFreeze (): boolean {
    return freeze || isPageHidden
  }

  function scrollToBottom (): void {
    if (scroller != null && scrollDiv != null && !isFreeze()) {
      scrollDiv.scroll({ top: 0, behavior: 'instant' })
    }
  }

  function scrollToSeparator (): void {
    if (separatorDiv == null || scrollDiv == null || contentDiv == null) {
      return
    }

    const messagesElements = contentDiv?.getElementsByClassName('activityMessage')
    const messagesHeight = messages
      .slice(separatorIndex)
      .reduce((res, msg) => res + (messagesElements?.[msg._id as any]?.clientHeight ?? 0), 0)

    separatorDiv.scrollIntoView()

    if (messagesHeight >= scrollDiv.clientHeight) {
      scroller?.scrollBy(-newSeparatorOffset)
    }

    updateShouldScrollToNew()
    read()
  }

  function scrollToMessage (): void {
    if (selectedMessageId === undefined) return
    if (scrollDiv == null || contentDiv == null) {
      setTimeout(scrollToMessage, 50)
      return
    }

    const messagesElements = contentDiv?.getElementsByClassName('activityMessage')
    const msgElement = messagesElements?.[selectedMessageId as any]

    if (msgElement == null) {
      if (messages.some(({ _id }) => _id === selectedMessageId)) {
        setTimeout(scrollToMessage, 50)
        return
      }
    } else {
      msgElement.scrollIntoView({ block: 'start' })
    }
    read()
  }

  function scrollToStartOfNew (): void {
    if (scrollDiv == null || lastMsgBeforeFreeze === undefined) return
    if (needUpdateTimestamp || $newTimestampStore === undefined) {
      void viewport.syncUnreadMarker(readState)
      needUpdateTimestamp = false
    }
    const lastIndex = messages.findIndex(({ _id }) => _id === lastMsgBeforeFreeze)
    if (lastIndex === -1) return
    const firstNewMessage = messages.find(
      ({ createdBy }, index) => index > lastIndex && (createdBy === undefined || !socialStrings.includes(createdBy))
    )

    if (firstNewMessage === undefined) {
      scrollToBottom()
      return
    }

    const messagesElements = contentDiv?.getElementsByClassName('activityMessage')
    const msgElement = messagesElements?.[firstNewMessage._id as any]

    if (msgElement == null) return

    const messageRect = msgElement.getBoundingClientRect()
    const topOffset = messageRect.top - newSeparatorOffset

    if (topOffset < 0) {
      scroller?.scrollBy(topOffset)
    } else if (scrollDiv.scrollTop > 0) {
      scrollDiv.scroll({ top: 0, behavior: 'instant' })
    }
  }

  function updateShouldScrollToNew (): void {
    if (scrollDiv != null && contentDiv != null) {
      const { scrollTop } = scrollDiv
      const offset = 100

      shouldScrollToNew = Math.abs(scrollTop) < offset
    }
  }

  async function wait (): Promise<void> {
    // One tick is not enough for messages to be rendered,
    // I think this is due to the fact that we are using a Component, which takes some time to load,
    // because after one tick I see spinners from Component
    await tick() // wait until the DOM is updated
    await tick() // wait until the DOM is updated
  }

  async function initializeScroll (
    isLoading: boolean,
    separatorElement?: HTMLDivElement | null,
    separatorIndex?: number
  ): Promise<void> {
    if (isLoading || isScrollInitialized) {
      return
    }

    const selectedMessageExists =
      selectedMessageId !== undefined && messages.some(({ _id }) => _id === selectedMessageId)
    if (selectedMessageExists) {
      await wait()
      scrollToMessage()
      isScrollInitialized = true
    } else if (separatorIndex === -1) {
      await wait()
      isScrollInitialized = true
      shouldScrollToNew = true
      isScrollAtBottom = true
    } else if (separatorElement != null) {
      await wait()
      scrollToSeparator()
      isScrollInitialized = true
    }

    if (isScrollInitialized) {
      await wait()
      updateScrollData()
      updateDownButtonVisibility(messages, scrollDiv, $isTailLoadedStore)
      loadMore()
    }
  }

  function reinitializeScroll (): void {
    isScrollInitialized = false
    void initializeScroll($isLoadingStore, separatorDiv, separatorIndex)
  }

  function read (): void {
    if (isFreeze() || !isScrollInitialized) return
    readViewportMessages(object._id, messages, scrollDiv, contentDiv, notifyContext, readState)
  }

  function updateScrollData (): void {
    if (scrollDiv == null) return
    const { scrollTop } = scrollDiv

    isScrollAtBottom = Math.abs(scrollTop) < 50
    if (isScrollAtBottom && $isTailLoadedStore) {
      shouldScrollToNew = true
      restoreScrollTop = 0
      restoreScrollHeight = 0
    }
  }

  $: if ($isTailLoadedStore && isScrollAtBottom) {
    shouldScrollToNew = true
    restoreScrollTop = 0
    restoreScrollHeight = 0
  }

  $: updateDownButtonVisibility(messages, scrollDiv, $isTailLoadedStore)

  function updateDownButtonVisibility (
    messages: ActivityMessage[],
    scrollDiv?: HTMLDivElement | null,
    isTailLoaded: boolean = $isTailLoadedStore
  ): void {
    if (messages.length === 0 || !isScrollInitialized) {
      isLatestMessageButtonVisible = false
      return
    }

    if (!isTailLoaded) {
      isLatestMessageButtonVisible = true
    } else if (scrollDiv != null) {
      const { scrollTop } = scrollDiv

      isLatestMessageButtonVisible = Math.abs(scrollTop) > 200
    } else {
      isLatestMessageButtonVisible = false
    }
  }

  async function handleScrollToLatestMessage (): Promise<void> {
    selectedMessageId = undefined
    messageInFocus.set(undefined)

    if (!$isTailLoadedStore) {
      separatorIndex = -1
      // Jump directly to the latest tail, ignoring any unread message anchors
      viewport.jumpToEnd(true)
      reinitializeScroll()
    } else {
      scrollToBottom()
    }

    await inboxClient.readDoc(doc._id)
  }

  let forceRead = false
  $: void forceReadState(isScrollAtBottom, readState)

  async function forceReadState (isScrollAtBottom: boolean, readState?: ReadState): Promise<void> {
    if (readState === undefined || !isScrollAtBottom || forceRead || isFreeze()) return
    const lastView = readState[getCurrentAccount().uuid]?.timestamp ?? 0
    const lastUpdate = readState.latestMessageTimestamp ?? 0

    if (lastView < lastUpdate) {
      forceRead = true
      await inboxClient.forceReadDocState(object._id)
      forceRead = false
    }
  }

  function shouldLoadMoreUp (): boolean {
    if (scrollDiv == null) return false
    const { scrollHeight, scrollTop, clientHeight } = scrollDiv

    return scrollHeight + Math.ceil(scrollTop - clientHeight) <= loadMoreThreshold
  }

  function shouldLoadMoreDown (): boolean {
    if (scrollDiv == null) return false

    return Math.abs(scrollDiv.scrollTop) <= loadMoreThreshold
  }

  function loadMore (): void {
    if ($isLoadingMoreStore || scrollDiv == null || !isScrollInitialized) {
      return
    }

    const minMsgHeightPx = minMsgHeightRem * parseFloat(getComputedStyle(document.documentElement).fontSize)
    const maxMsgPerScreen = Math.ceil(scrollDiv.clientHeight / minMsgHeightPx)
    const limit = Math.max(maxMsgPerScreen, viewport.limit)
    const isLoadMoreUp = shouldLoadMoreUp()
    const isLoadMoreDown = shouldLoadMoreDown()

    if (!isLoadMoreUp && backwardRequested) {
      backwardRequested = false
    }

    if (
      isLoadMoreUp &&
      !backwardRequested &&
      !shouldScrollToNew &&
      !isScrollAtBottom &&
      viewport.canLoadMore('backward', messages[0]?.createdOn)
    ) {
      shouldScrollToNew = false
      restoreScrollTop = scrollDiv?.scrollTop ?? 0
      restoreScrollHeight = 0
      void viewport.loadMore('backward', messages[0]?.createdOn, limit)
      backwardRequested = true
    } else if (isLoadMoreUp && backwardRequested) {
      restoreScrollTop = scrollDiv?.scrollTop ?? 0
    } else if (isLoadMoreDown && !$isTailLoadedStore && !shouldScrollToNew && !isScrollAtBottom) {
      restoreScrollTop = 0
      restoreScrollHeight = scrollDiv?.scrollHeight ?? 0
      shouldScrollToNew = false
      isScrollAtBottom = false
      void viewport.loadMore('forward', messages[messages.length - 1]?.createdOn, limit)
    }
  }

  async function restoreScroll (): Promise<void> {
    await wait()

    if (scrollDiv == null || scroller == null) return

    if (restoreScrollTop !== 0) {
      scroller.scroll(restoreScrollTop)
    } else if (restoreScrollHeight !== 0) {
      const delta = restoreScrollHeight - scrollDiv.scrollHeight
      scroller.scroll(delta)
    }
    backwardRequested = false
    restoreScrollHeight = 0
    restoreScrollTop = 0
  }

  function scrollToNewMessages (): void {
    if (scrollDiv == null || !shouldScrollToNew) {
      read()
      return
    }

    scrollToBottom()
    read()
  }

  async function handleMessagesUpdated (newCount: number): Promise<void> {
    if (newCount === messagesCount) {
      return
    }

    const prevCount = messagesCount
    messagesCount = newCount

    if (isFreeze()) {
      await wait()
      scrollToStartOfNew()
      return
    }

    if (restoreScrollTop !== 0 || restoreScrollHeight !== 0) {
      void restoreScroll()
    } else if (shouldScrollToNew && prevCount > 0 && newCount > prevCount) {
      await wait()
      scrollToNewMessages()
    } else {
      await wait()
      read()
    }
  }

  let observer: IntersectionObserver | undefined
  const observedMessages = new Set<string>()
  let readTimeoutId: number | undefined

  function flushReadQueue (): void {
    if (readTimeoutId !== undefined) {
      window.clearTimeout(readTimeoutId)
      readTimeoutId = undefined
    }

    if (observedMessages.size === 0) return

    const messagesList = Array.from(observedMessages)
      .map((id) => messages.find((m) => m._id === id))
      .filter(notEmpty)

    observedMessages.clear()
    if (messagesList.length === 0) return

    const sorted = messagesList.sort((a, b) => (a.createdOn ?? 0) - (b.createdOn ?? 0))
    void readMessages(sorted, notifyContext, readState)
  }

  function handleMessageIntersect (msgId: string): void {
    if (isFreeze() || !isScrollInitialized) {
      return
    }
    observedMessages.add(msgId)

    if (readTimeoutId !== undefined) {
      window.clearTimeout(readTimeoutId)
    }

    readTimeoutId = window.setTimeout(() => {
      flushReadQueue()
    }, 500)
  }

  function observeMessage (
    node: HTMLElement,
    message: ActivityMessage
  ): { update: (newMessage: ActivityMessage) => void, destroy: () => void } {
    const initObserver = (): void => {
      if (observer !== undefined) return
      if (scrollDiv == null) return

      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const msgId = entry.target.getAttribute('data-msg-id')
            if (entry.isIntersecting) {
              if (msgId != null) {
                handleMessageIntersect(msgId)
              }
            }
          }
        },
        {
          root: scrollDiv,
          threshold: 0.1
        }
      )
    }

    initObserver()

    if (observer !== undefined) {
      node.setAttribute('data-msg-id', message._id)
      observer.observe(node)
    } else {
      window.setTimeout(() => {
        initObserver()
        if (observer !== undefined) {
          node.setAttribute('data-msg-id', message._id)
          observer.observe(node)
        }
      }, 50)
    }

    return {
      update (newMessage: ActivityMessage) {
        node.setAttribute('data-msg-id', newMessage._id)
      },
      destroy () {
        observer?.unobserve(node)
      }
    }
  }

  async function handleScroll (): Promise<void> {
    updateScrollData()
    updateDownButtonVisibility(messages, scrollDiv, $isTailLoadedStore)
    updateShouldScrollToNew()
    loadMore()
  }

  function handleResize (): void {
    if (!isScrollInitialized) return
    if (shouldScrollToNew) {
      scrollToBottom()
    }

    loadMore()
  }

  const newMessageTxListener = (txes: Tx[]): void => {
    const ctx = txes
      .map((it) => it as TxCUD<ActivityMessage>)
      .filter((it) => it.attachedTo === doc._id && it._class === core.class.TxCreateDoc)

    if (ctx.length > 0 && shouldScrollToNew) {
      void wait().then(scrollToNewMessages)
    }
  }

  afterUpdate(() => {
    if (isFreeze()) {
      updateScrollData()
    }
  })

  onMount(() => {
    chatReadMessagesStore.update(() => new Set())
    addTxListener(newMessageTxListener)
  })

  onDestroy(() => {
    flushReadQueue()
    chatReadMessagesStore.update(() => new Set())
    if (observer !== undefined) {
      observer.disconnect()
      observer = undefined
    }
    if (contentResizeObserver !== undefined) {
      contentResizeObserver.disconnect()
      contentResizeObserver = undefined
    }
    removeTxListener(newMessageTxListener)
  })

  $: showBlankView = !($isLoadingStore || !isReadStateLoaded) && messages.length === 0 && !isThread

  export function editLastMessage (): void {
    if ($isLoadingStore || !isReadStateLoaded || !isScrollInitialized || !$isTailLoadedStore || scrollDiv == null) {
      return
    }
    if (!isScrollAtBottom) return
    const me = getCurrentAccount()
    let lastMessage: ChatMessage | undefined = undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!hierarchy.isDerived(message._class, chunter.class.ChatMessage)) continue
      if (message.createdBy == null || !me.socialIds.includes(message.createdBy)) continue
      lastMessage = message as ChatMessage
      break
    }

    if (lastMessage == null) return
    editingMessageStore.set(lastMessage._id)
    const messagesElements = contentDiv?.getElementsByClassName('activityMessage')
    const msgElement = messagesElements?.[selectedMessageId as any]
    if (msgElement == null) return
    const scrollRect = scrollDiv.getBoundingClientRect()

    if (!messageInView(msgElement, scrollRect)) {
      msgElement.scrollIntoView({ behavior: 'instant', block: 'end' })
    }
  }

  function handleKeyDown (e: KeyboardEvent): void {
    const key = e.key

    if (key === 'ArrowUp') {
      if ($editingMessageStore !== undefined) return
      editLastMessage()
    }
  }

  $: loadingOverlay = $isLoadingStore || !isReadStateLoaded || !isScrollInitialized
</script>

<div class="flex-col relative" class:h-full={fullHeight}>
  {#if loadingOverlay}
    <div class="overlay">
      <Loading />
    </div>
  {/if}
  <Scroller
    bind:this={scroller}
    bind:divScroll={scrollDiv}
    bind:divBox={contentDiv}
    scrollDirection="vertical-reverse"
    noStretch={!showBlankView}
    bottomStart={!showBlankView}
    disableOverscroll
    disablePointerEventsOnScroll
    onScroll={handleScroll}
    onResize={handleResize}
  >
    {#if showBlankView}
      <BlankView
        icon={chunter.icon.Thread}
        header={chunter.string.NoMessagesInChannel}
        label={readonly ? undefined : chunter.string.SendMessagesInChannel}
      />
    {/if}

    {#if !isThread}
      <HistoryLoading isLoading={$isLoadingMoreStore} />
    {/if}

    <slot name="header" />

    {#each messageGroups as group (group.day)}
      <div class="day-group">
        {#if !isThread}
          <JumpToDateSelector timestamp={group.day} on:jumpToDate={handleJumpToDate} />
        {/if}
        {#each group.messages as message, index (message._id)}
          {@const isSelected = message._id === selectedMessageId}
          {@const canGroup = index > 0 && canGroupMessages(message, group.messages[index - 1])}
          {#if separatorIndex !== -1 && messages[separatorIndex]?._id === message._id}
            <ActivityMessagesSeparator bind:element={separatorDiv} label={activity.string.New} />
          {/if}

          <div use:observeMessage={message} class="activityMessageWrapper" id={message._id}>
            <ActivityMessagePresenter
              {doc}
              value={message}
              skipLabel={isThread || isChunterSpace}
              hideLink
              hoverStyles="filledHover"
              attachmentImageSize="x-large"
              type={canGroup ? 'short' : 'default'}
              isHighlighted={isSelected}
              shouldScroll={false}
              {readonly}
              {onReply}
            />
          </div>
        {/each}
      </div>
    {/each}

    {#if messages.length > 0}
      <div class="h-4" />
    {/if}

    {#if $canLoadNextForward}
      <HistoryLoading isLoading={$isLoadingMoreStore} />
    {/if}
    {#if !fixedInput && withInput}
      <ChannelInput
        {object}
        {readonly}
        boundary={scrollDiv}
        {collection}
        {isThread}
        {autofocus}
        onKeyDown={handleKeyDown}
      />
    {/if}
  </Scroller>
  {#if isLatestMessageButtonVisible}
    <div class="down-button absolute">
      <ModernButton
        label={chunter.string.LatestMessages}
        shape="round"
        size="small"
        kind="primary"
        on:click={handleScrollToLatestMessage}
      />
    </div>
  {/if}
</div>

{#if fixedInput && withInput}
  <ChannelInput
    {object}
    {readonly}
    boundary={scrollDiv}
    {collection}
    {isThread}
    {autofocus}
    onKeyDown={handleKeyDown}
  />
{/if}

{#if readonly}
  <div class="h-6" />
{/if}

<style lang="scss">
  .day-group {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .overlay {
    width: 100%;
    height: 100%;
    position: absolute;
    background: var(--theme-panel-color);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .down-button {
    width: 100%;
    display: flex;
    justify-content: center;
    bottom: 0.5rem;
    animation: 0.5s fadeIn;
    animation-fill-mode: forwards;
    visibility: hidden;
  }

  @keyframes fadeIn {
    99% {
      visibility: hidden;
    }
    100% {
      visibility: visible;
    }
  }
</style>

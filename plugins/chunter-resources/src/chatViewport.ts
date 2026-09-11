//
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
//

import { createQuery, getClient, addTxListener, removeTxListener } from '@hcengineering/presentation'
import core, {
  type Client,
  type Doc,
  getCurrentAccount,
  type Lookup,
  type Ref,
  SortingOrder,
  type Timestamp,
  type Tx,
  type TxCUD,
  type TxCreateDoc,
  type TxUpdateDoc,
  type TxMixin,
  TxProcessor,
  type WithLookup
} from '@hcengineering/core'
import { derived, get, type Readable, writable } from 'svelte/store'
import activity, { type ActivityMessage, type Reaction } from '@hcengineering/activity'
import attachment, { type Attachment } from '@hcengineering/attachment'
import { type ReadPosition, type ReadState } from '@hcengineering/notification'
import chunter, { type ChatMessage } from '@hcengineering/chunter'

export type LoadMode = 'forward' | 'backward'

/**
 * Interface defining the minimal API required for chat viewports.
 */
interface IChatViewport {
  readonly limit: number

  readonly isLoading: Readable<boolean>
  readonly isLoadingMore: Readable<boolean>
  readonly messages: Readable<ActivityMessage[]>
  readonly newTimestamp: Readable<Timestamp | undefined>

  canLoadMore: (mode: LoadMode, loadAfter: Timestamp) => boolean
  jumpToDate: (date: Timestamp) => Promise<Ref<ActivityMessage> | undefined>
}

class StaleVersionError extends Error {
  constructor () {
    super('Viewport version changed')
    this.name = 'StaleVersionError'
  }
}

/**
 * Viewport manager for chat channels and message threads.
 * Manages reactive messages tail and handles cursor-based backward/forward pagination.
 *
 * DESIGN FEATURES:
 * 1. 100% Metadata-Free: Does not load full channel metadata to calculate scroll position or dates,
 *    eliminating websocket and memory overhead in large chats.
 * 2. On-Demand Anchor Navigation: Lazily queries the database to position viewports around targets
 *    (e.g., specific message links or first unread markers).
 * 3. Space-Agnostic Resolution: Resolves messages and external cross-space references in a single query
 *    by omitting the space filter, removing the need for manual reference loading.
 */
export class ChatViewport implements IChatViewport {
  private static readonly chatCache = new Map<
    string,
    { viewport: ChatViewport, lastAccessed: number, lastAccessedTime: number }
  >()

  private static readonly threadCache = new Map<
    string,
    { viewport: ChatViewport, lastAccessed: number, lastAccessedTime: number }
  >()

  private static readonly MAX_CACHE_SIZE = 10
  private static accessCounter = 0
  private static readonly TTL_MS = 15 * 60 * 1000 // 15 minutes
  private static cleanupIntervalId: ReturnType<typeof setInterval> | undefined = undefined

  private static startCleanupInterval (): void {
    if (ChatViewport.cleanupIntervalId !== undefined) return

    ChatViewport.cleanupIntervalId = setInterval(
      () => {
        ChatViewport.evictExpired(ChatViewport.chatCache)
        ChatViewport.evictExpired(ChatViewport.threadCache)
      },
      5 * 60 * 1000 // Check every 5 minutes
    )

    const timer = ChatViewport.cleanupIntervalId
    if (timer !== undefined && typeof timer === 'object' && timer !== null) {
      const unreffable = timer as { unref?: () => void }
      if (typeof unreffable.unref === 'function') {
        unreffable.unref()
      }
    }
  }

  private static evictExpired (
    cache: Map<string, { viewport: ChatViewport, lastAccessed: number, lastAccessedTime: number }>
  ): void {
    const now = Date.now()
    for (const [key, entry] of cache.entries()) {
      if (entry.viewport.isEvictable() && now - entry.lastAccessedTime > ChatViewport.TTL_MS) {
        entry.viewport.destroyInternal()
        cache.delete(key)
      }
    }
  }

  public static getOrCreate (
    readState: ReadState | undefined,
    chatId: Ref<Doc>,
    selectedMessageId: Ref<ActivityMessage> | undefined,
    limit = 50,
    isThread = false
  ): ChatViewport {
    ChatViewport.startCleanupInterval()

    // Clean up expired entries in both caches
    ChatViewport.evictExpired(ChatViewport.chatCache)
    ChatViewport.evictExpired(ChatViewport.threadCache)

    const cache = isThread ? ChatViewport.threadCache : ChatViewport.chatCache
    const key = chatId
    let entry = cache.get(key)

    if (entry === undefined) {
      const viewport = new ChatViewport(readState, chatId, selectedMessageId, limit)
      entry = { viewport, lastAccessed: ++ChatViewport.accessCounter, lastAccessedTime: Date.now() }
      cache.set(key, entry)
      ChatViewport.cleanCache(cache)
    } else {
      entry.lastAccessed = ++ChatViewport.accessCounter
      entry.lastAccessedTime = Date.now()
      void entry.viewport.syncUnreadMarker(readState)
      if (selectedMessageId !== undefined) {
        void entry.viewport.jumpToMessageId(selectedMessageId)
      }
    }

    // Automatically acquire the viewport reference
    entry.viewport.acquire()

    return entry.viewport
  }

  private static cleanCache (
    cache: Map<string, { viewport: ChatViewport, lastAccessed: number, lastAccessedTime: number }>
  ): void {
    // Only evict viewports that are not currently active in the UI
    const evictable = Array.from(cache.entries()).filter(([_, entry]) => entry.viewport.isEvictable())

    if (evictable.length <= ChatViewport.MAX_CACHE_SIZE) return

    const sorted = evictable.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)
    const toRemoveCount = evictable.length - ChatViewport.MAX_CACHE_SIZE
    for (let i = 0; i < toRemoveCount; i++) {
      const [key, entry] = sorted[i]
      entry.viewport.destroyInternal()
      cache.delete(key)
    }
  }

  public static clearCache (): void {
    if (ChatViewport.cleanupIntervalId !== undefined) {
      clearInterval(ChatViewport.cleanupIntervalId)
      ChatViewport.cleanupIntervalId = undefined
    }

    for (const entry of ChatViewport.chatCache.values()) {
      entry.viewport.destroyInternal()
    }
    ChatViewport.chatCache.clear()

    for (const entry of ChatViewport.threadCache.values()) {
      entry.viewport.destroyInternal()
    }
    ChatViewport.threadCache.clear()
  }

  // Active UI subscriber reference tracking
  private activeRefCount = 0

  public acquire (): void {
    this.activeRefCount++
  }

  public release (): void {
    this.activeRefCount = Math.max(0, this.activeRefCount - 1)
  }

  public isEvictable (): boolean {
    return this.activeRefCount <= 0
  }

  // Private State & Queries (Must be declared first as derived stores depend on them)
  private readonly loadedHistory = writable<Array<WithLookup<ActivityMessage>>>([])
  private readonly liveTail = writable<Array<WithLookup<ActivityMessage>>>([])
  private readonly tailQuery = createQuery(true)
  private tailStartTs: Timestamp | undefined = undefined

  /**
   * Tracks the active viewport session version.
   * Incremented on each viewport reset (e.g., during jumps or route changes).
   * Checked after all asynchronous boundaries to discard stale database query results
   * that resolve after the user has navigated away from the original location.
   */
  private viewportVersion = 0
  private txListener: ((txes: Tx[]) => void) | undefined
  private readonly loadedMessageIds = new Set<Ref<ActivityMessage>>()
  private readonly loadedAttachmentIds = new Map<Ref<Attachment>, Ref<ActivityMessage>>()
  private readonly loadedReactionIds = new Map<Ref<Reaction>, Ref<ActivityMessage>>()
  private readonly historyUnsubscribe: () => void

  public readonly isTailLoaded = writable(false)
  public readonly isLoading = writable(true)
  public readonly isLoadingMore = writable(false)
  public readonly newTimestamp = writable<Timestamp | undefined>(undefined)

  public readonly hasMoreBackward = writable(true)
  public readonly hasMoreForward = writable(false)

  /**
   * Complete chronologically sorted list of currently loaded messages.
   */
  public readonly messages = derived([this.loadedHistory, this.liveTail], ([history, tail]) => {
    const seen = new Set<string>()
    const result: ActivityMessage[] = []

    for (const msg of history) {
      if (!seen.has(msg._id)) {
        seen.add(msg._id)
        result.push(msg)
      }
    }

    for (const msg of tail) {
      if (!seen.has(msg._id)) {
        seen.add(msg._id)
        result.push(msg)
      }
    }

    return result
  })

  /**
   * Derived flag helper for scrolling/pagination triggers.
   */
  public readonly canLoadNextForward = derived(this.messages, (messages) => {
    return this.canLoadMore('forward', messages[messages.length - 1]?.createdOn)
  })

  private readonly LOOKUP: Lookup<ActivityMessage> = {
    _id: {
      attachments: attachment.class.Attachment,
      reactions: activity.class.Reaction
    },
    forwardedMessage: chunter.class.ChatMessage
  }

  constructor (
    private readState: ReadState | undefined,
    public chatId: Ref<Doc>,
    public selectedMessageId: Ref<ActivityMessage> | undefined,
    public readonly limit = 50
  ) {
    this.historyUnsubscribe = this.loadedHistory.subscribe((history) => {
      this.loadedMessageIds.clear()
      this.loadedAttachmentIds.clear()
      this.loadedReactionIds.clear()

      for (const msg of history) {
        this.loadedMessageIds.add(msg._id)

        const attachments = ((msg as any).$lookup?.attachments ?? []) as Attachment[]
        for (const att of attachments) {
          this.loadedAttachmentIds.set(att._id, msg._id)
        }

        const reactions = (msg.$lookup?.reactions ?? []) as Reaction[]
        for (const react of reactions) {
          this.loadedReactionIds.set(react._id, msg._id)
        }
      }
    })

    void this.initializeViewport(undefined)

    this.txListener = (txes) => {
      void this.handleTransactions(txes)
    }
    addTxListener(this.txListener)
  }

  // ==========================================
  // Public API Methods
  // ==========================================

  /**
   * Checks if more messages can be loaded in a specific direction.
   */
  public canLoadMore (mode: LoadMode, timestamp?: Timestamp): boolean {
    if (timestamp === undefined) {
      return false
    }

    if (mode === 'forward') {
      const isTailLoading = get(this.isLoading) && !get(this.isTailLoaded)
      const tail = get(this.liveTail)
      const hasMoreNewer = get(this.hasMoreForward)
      return hasMoreNewer && !isTailLoading && tail.length === 0
    } else {
      return get(this.hasMoreBackward)
    }
  }

  /**
   * Synchronous load action for pagination triggers.
   */
  public async loadMore (mode: LoadMode, loadAfter?: Timestamp, limit?: number): Promise<void> {
    await this.loadMoreInternal(undefined, mode, loadAfter, limit)
  }

  /**
   * Jumps to a specific day in the message history, finding the closest available message.
   */
  public async jumpToDate (date: Timestamp): Promise<Ref<ActivityMessage> | undefined> {
    const version = this.viewportVersion
    const client = this.getVersionedClient(version)

    try {
      let res = await client.findAll(
        activity.class.ActivityMessage,
        {
          attachedTo: this.chatId,
          createdOn: { $gte: date }
        },
        {
          limit: 1,
          sort: { createdOn: SortingOrder.Ascending },
          projection: { _id: 1 }
        }
      )

      let msg = res[0]
      if (msg === undefined) {
        res = await client.findAll(
          activity.class.ActivityMessage,
          {
            attachedTo: this.chatId,
            createdOn: { $lt: date }
          },
          {
            limit: 1,
            sort: { createdOn: SortingOrder.Descending },
            projection: { _id: 1 }
          }
        )
        msg = res[0]
      }

      if (msg === undefined) {
        return undefined
      }

      const isLoaded = get(this.messages).some((it) => it._id === msg._id)
      if (!isLoaded) {
        this.resetViewport()
        await this.initializeViewport(msg._id)
      }
      return msg._id
    } catch (err) {
      if (err instanceof StaleVersionError) return undefined
      console.error('Failed to jump to date:', err)
      return undefined
    }
  }

  /**
   * Focuses and loads chat viewport surrounding a specific message ID.
   */
  public async jumpToMessageId (messageId: Ref<ActivityMessage>): Promise<boolean> {
    const isAlreadyLoaded = get(this.messages).some(({ _id }) => _id === messageId)

    if (isAlreadyLoaded) {
      return false
    }

    this.resetViewport()
    await this.initializeViewport(messageId)

    return true
  }

  /**
   * Resets viewport and scrolls to the latest end of history.
   *
   * @param ignoreUnread - If true, bypasses unread messages and directly jumps to the latest tail.
   */
  public jumpToEnd (ignoreUnread = false): boolean {
    this.selectedMessageId = undefined
    this.resetViewport()
    void this.initializeViewport(this.selectedMessageId, ignoreUnread)

    return true
  }

  /**
   * Refreshes the unread markers.
   */
  public async syncUnreadMarker (readState?: ReadState): Promise<void> {
    if (readState === undefined) return
    this.readState = readState

    const version = this.viewportVersion
    const client = this.getVersionedClient(version)

    try {
      const me = getCurrentAccount()
      const readPosition: ReadPosition | undefined = readState[me.uuid]
      const lastView = readPosition?.timestamp ?? 0

      if (lastView === 0) {
        this.newTimestamp.set(undefined)
        return
      }

      const res = await client.findAll(
        activity.class.ActivityMessage,
        {
          attachedTo: this.chatId,
          createdOn: { $gt: lastView },
          createdBy: { $nin: me.socialIds }
        },
        {
          limit: 1,
          projection: { _id: 1, createdOn: 1, createdBy: 1 },
          sort: { createdOn: SortingOrder.Ascending }
        }
      )

      this.newTimestamp.set(res[0]?.createdOn)
    } catch (err) {
      if (err instanceof StaleVersionError) return
      console.error('Failed to sync unread marker:', err)
    }
  }

  /**
   * Unsubscribes active queries and resets internal stores.
   */
  public destroy (): void {
    this.destroyInternal()
  }

  private destroyInternal (): void {
    this.resetViewport()
    this.tailQuery.unsubscribe()
    this.historyUnsubscribe()
    if (this.txListener !== undefined) {
      removeTxListener(this.txListener)
      this.txListener = undefined
    }
  }

  // ==========================================
  // Private Helper Methods
  // ==========================================

  /**
   * Performs the initial load. Decides whether to target a specific selected message,
   * the first unread message, or simply fetch the latest tail of history.
   */
  private async initializeViewport (selectedMessageId?: Ref<ActivityMessage>, ignoreUnread = false): Promise<void> {
    this.isLoading.set(true)
    const version = this.viewportVersion
    const client = this.getVersionedClient(version)

    try {
      const targetAnchor = await this.resolveAnchor(client, selectedMessageId, ignoreUnread)

      // Always query the latest tail of history first to optimize loading
      const latestRes = await client.findAll(
        activity.class.ActivityMessage,
        {
          attachedTo: this.chatId
        },
        {
          limit: this.limit + 1,
          sort: { createdOn: SortingOrder.Descending },
          lookup: this.LOOKUP
        }
      )

      if (targetAnchor === undefined) {
        this.applyLatestTail(latestRes)
      } else {
        const hasMoreOlder = latestRes.length > this.limit
        const messages = hasMoreOlder ? latestRes.slice(0, this.limit) : latestRes
        const oldestMsg = messages[messages.length - 1]

        if (
          oldestMsg === undefined ||
          targetAnchor.createdOn === undefined ||
          oldestMsg.createdOn === undefined ||
          targetAnchor.createdOn >= oldestMsg.createdOn
        ) {
          this.applyLatestTail(latestRes)
        } else {
          await this.loadAnchoredStart(client, targetAnchor)
        }
      }
    } catch (err) {
      if (err instanceof StaleVersionError) {
        return
      }
      console.error('Failed to initialize viewport:', err)
    } finally {
      if (version === this.viewportVersion) {
        this.isLoading.set(false)
      }
    }
  }

  private async resolveAnchor (
    client: ReturnType<typeof this.getVersionedClient>,
    _selectedMessageId?: Ref<ActivityMessage>,
    ignoreUnread = false
  ): Promise<ActivityMessage | undefined> {
    // 1. Resolve selected message as a prioritized anchor
    const selectedMessageId = _selectedMessageId ?? this.selectedMessageId
    let selectedMessage: ActivityMessage | undefined
    if (selectedMessageId !== undefined) {
      selectedMessage = await client.findOne(
        activity.class.ActivityMessage,
        { _id: selectedMessageId },
        { projection: { _id: 1, createdOn: 1 } }
      )
      if (selectedMessage !== undefined) return selectedMessage
    }

    // 2. Resolve first unread message as a prospective anchor
    const me = getCurrentAccount()
    const readPosition: ReadPosition | undefined = this.readState?.[me.uuid]
    const lastViewTs = readPosition?.timestamp ?? 0
    const latestMessageTs = this.readState?.latestMessageTimestamp ?? 0

    // Only query if user has unread messages
    const hasUnread = latestMessageTs === 0 || latestMessageTs > lastViewTs

    let firstUnreadMessage: ActivityMessage | undefined
    if (!ignoreUnread && hasUnread) {
      firstUnreadMessage = await client.findOne(
        activity.class.ActivityMessage,
        {
          attachedTo: this.chatId,
          createdOn: { $gt: lastViewTs },
          createdBy: { $nin: me.socialIds }
        },
        {
          sort: { createdOn: SortingOrder.Ascending },
          projection: { _id: 1, createdOn: 1 }
        }
      )
    }

    if (firstUnreadMessage !== undefined) {
      this.newTimestamp.set(firstUnreadMessage.createdOn)
    } else if (ignoreUnread) {
      this.newTimestamp.set(undefined)
    }

    return firstUnreadMessage
  }

  private applyLatestTail (latestRes: ActivityMessage[]): void {
    const hasMoreOlder = latestRes.length > this.limit
    const messages = hasMoreOlder ? latestRes.slice(0, this.limit) : latestRes

    this.loadedHistory.set([...messages].reverse())
    this.hasMoreBackward.set(hasMoreOlder)
    this.hasMoreForward.set(false)

    const newestMsg = messages[0]
    if (newestMsg !== undefined) {
      this.subscribeToLiveTail(newestMsg.createdOn, [newestMsg._id])
    } else {
      this.subscribeToLiveTail(undefined)
    }
  }

  private async loadAnchoredStart (
    client: ReturnType<typeof this.getVersionedClient>,
    targetAnchor: ActivityMessage
  ): Promise<void> {
    const midLimit = Math.floor(this.limit / 2)
    // Mid-history positioning: load split-window chunk centered around the anchor
    const beforeRes: Array<Pick<ActivityMessage, '_id' | 'createdOn'>> = await client.findAll(
      activity.class.ActivityMessage,
      {
        attachedTo: this.chatId,
        createdOn: { $lt: targetAnchor.createdOn }
      },
      {
        limit: midLimit + 1,
        projection: { _id: 1, createdOn: 1 },
        sort: { createdOn: SortingOrder.Descending }
      }
    )

    const hasMoreOlder = beforeRes.length > midLimit
    const backwardMessages = hasMoreOlder ? beforeRes.slice(0, midLimit) : beforeRes
    const oldestBefore = backwardMessages[backwardMessages.length - 1]
    const chunkStart = oldestBefore?.createdOn ?? targetAnchor.createdOn

    this.hasMoreBackward.set(hasMoreOlder)
    this.hasMoreForward.set(true)

    await this.loadMoreInternal(client, 'forward', chunkStart, this.limit)
  }

  /**
   * Sets up a LiveQuery subscription to listen to real-time chat messages arriving in the channel.
   */
  private subscribeToLiveTail (start?: Timestamp, skipIds?: Array<Ref<ActivityMessage>>): void {
    this.tailStartTs ??= start

    const version = this.viewportVersion

    this.tailQuery.query(
      activity.class.ActivityMessage,
      {
        attachedTo: this.chatId,
        ...(this.tailStartTs !== undefined ? { createdOn: { $gte: this.tailStartTs } } : {})
      },
      async (res) => {
        if (version !== this.viewportVersion) return
        const skipSet = skipIds !== undefined ? new Set(skipIds) : undefined
        const filtered = skipSet !== undefined ? res.filter(({ _id }) => !skipSet.has(_id as any)) : res
        this.liveTail.set(filtered.reverse())
        this.isTailLoaded.set(true)
      },
      {
        sort: { createdOn: SortingOrder.Descending },
        lookup: this.LOOKUP
      }
    )
  }

  private async loadMoreInternal (
    externalClient: ReturnType<typeof this.getVersionedClient> | undefined,
    mode: LoadMode,
    loadAfterTs?: Timestamp,
    limit?: number
  ): Promise<void> {
    if (get(this.isLoadingMore) || loadAfterTs === undefined) return

    this.isLoadingMore.set(true)
    const version = this.viewportVersion
    const client = externalClient ?? this.getVersionedClient(version)

    try {
      const isBackward = mode === 'backward'
      const history = get(this.loadedHistory)

      if (!isBackward) {
        const hasMoreNewer = get(this.hasMoreForward)
        if (!hasMoreNewer) {
          const skipIds = history.filter(({ createdOn }) => createdOn === loadAfterTs).map(({ _id }) => _id)
          this.subscribeToLiveTail(loadAfterTs, skipIds)
          return
        }
      }

      const messages = await this.queryHistoryChunk(client, isBackward, loadAfterTs, limit)

      if (messages.length > 0) {
        this.loadedHistory.update((currentHistory) => {
          return isBackward ? [...messages, ...currentHistory] : [...currentHistory, ...messages]
        })
      }
    } catch (err) {
      if (err instanceof StaleVersionError) {
        return
      }
      console.error(`Failed to load more messages (${mode}):`, err)
    } finally {
      if (version === this.viewportVersion) {
        this.isLoadingMore.set(false)
      }
    }
  }

  /**
   * Fetches historical chat pages via cursor parameters.
   */
  private async queryHistoryChunk (
    client: ReturnType<typeof this.getVersionedClient>,
    isBackward: boolean,
    loadAfter: Timestamp,
    limit?: number,
    equal = true
  ): Promise<ActivityMessage[]> {
    const skipSet = new Set(this.getBoundaryOverlapIds(loadAfter))
    const actualLimit = limit ?? this.limit

    let messages: ActivityMessage[] = await client.findAll(
      activity.class.ActivityMessage,
      {
        attachedTo: this.chatId,
        createdOn: equal
          ? isBackward
            ? { $lte: loadAfter }
            : { $gte: loadAfter }
          : isBackward
            ? { $lt: loadAfter }
            : { $gt: loadAfter }
      },
      {
        limit: actualLimit + 1,
        sort: { createdOn: isBackward ? SortingOrder.Descending : SortingOrder.Ascending },
        lookup: this.LOOKUP
      }
    )

    const hasMore = messages.length > actualLimit

    // Deduplicate against overlap boundaries
    messages = messages.filter(({ _id }) => !skipSet.has(_id as any))

    if (messages.length === 0) {
      if (hasMore && equal) {
        return await this.queryHistoryChunk(client, isBackward, loadAfter, limit, false)
      }
      if (isBackward) {
        this.hasMoreBackward.set(false)
      } else {
        this.hasMoreForward.set(false)
      }
      return []
    }

    if (messages.length > actualLimit) {
      messages = messages.slice(0, actualLimit)
    }

    if (isBackward) {
      this.hasMoreBackward.set(hasMore)
    } else {
      this.hasMoreForward.set(hasMore)
    }

    return isBackward ? messages.reverse() : messages
  }

  private getBoundaryOverlapIds (after: Timestamp, loadTail = false): Array<Ref<ActivityMessage>> {
    const history = get(this.loadedHistory)
    const tail = get(this.liveTail)
    const loaded = [...history, ...(loadTail ? [] : tail)]

    return loaded.filter(({ createdOn }) => createdOn === after).map(({ _id }) => _id)
  }

  private resetViewport (): void {
    this.viewportVersion++
    this.liveTail.set([])
    this.loadedHistory.set([])
    this.tailQuery.unsubscribe()
    this.tailStartTs = undefined
    this.isTailLoaded.set(false)
  }

  private getVersionedClient (version: number): Pick<Client, 'findOne' | 'findAll'> {
    const client = getClient()
    return {
      findOne: async (...args) => {
        const res = await client.findOne(...args)
        if (version !== this.viewportVersion) throw new StaleVersionError()
        return res
      },
      findAll: async (...args) => {
        const res = await client.findAll(...args)
        if (version !== this.viewportVersion) throw new StaleVersionError()
        return res
      }
    }
  }

  private findMessageInViewport (
    msgId: Ref<ActivityMessage>,
    history: Array<WithLookup<ActivityMessage>>
  ): { message: WithLookup<ActivityMessage>, index: number } | undefined {
    const hIdx = history.findIndex(({ _id }) => _id === msgId)
    if (hIdx !== -1) {
      return { message: history[hIdx], index: hIdx }
    }
    return undefined
  }

  private async handleMessageTx (tx: TxCUD<ActivityMessage>): Promise<void> {
    const msgId = tx.objectId
    if (!this.loadedMessageIds.has(msgId)) return

    const history = get(this.loadedHistory)
    const found = this.findMessageInViewport(msgId, history)
    if (found === undefined) return

    const currentModifiedOn = found.message.modifiedOn ?? found.message.createdOn ?? 0
    if (tx.modifiedOn < currentModifiedOn) {
      const client = getClient()
      const updated = await client.findOne(activity.class.ActivityMessage, { _id: msgId }, { lookup: this.LOOKUP })
      this.loadedHistory.update((currentHistory) => {
        const foundLatest = this.findMessageInViewport(msgId, currentHistory)
        if (foundLatest !== undefined) {
          if (updated !== undefined) {
            currentHistory[foundLatest.index] = updated
          } else {
            currentHistory.splice(foundLatest.index, 1)
          }
        }
        return currentHistory
      })
      return
    }

    this.loadedHistory.update((currentHistory) => {
      const foundLatest = this.findMessageInViewport(msgId, currentHistory)
      if (foundLatest !== undefined) {
        if (tx._class === core.class.TxUpdateDoc) {
          TxProcessor.updateDoc2Doc(foundLatest.message, tx as TxUpdateDoc<ActivityMessage>)
        } else if (tx._class === core.class.TxMixin) {
          TxProcessor.updateMixin4Doc(foundLatest.message, tx as TxMixin<ActivityMessage, ActivityMessage>)
        } else if (tx._class === core.class.TxRemoveDoc) {
          currentHistory.splice(foundLatest.index, 1)
        }
      }
      return currentHistory
    })
  }

  private async handleAttachmentTx (tx: TxCUD<Attachment>): Promise<void> {
    const attachmentId = tx.objectId
    const messageId = (tx.attachedTo as Ref<ActivityMessage>) ?? this.loadedAttachmentIds.get(attachmentId)
    if (messageId === undefined || !this.loadedMessageIds.has(messageId)) return

    const history = get(this.loadedHistory)
    const found = this.findMessageInViewport(messageId, history)
    if (found === undefined) return

    const msg = found.message as WithLookup<ChatMessage>
    const attachment = msg.$lookup?.attachments?.find((it) => it._id === attachmentId) as Attachment

    const resolvedMessageId = found.message._id

    if (attachment !== undefined) {
      const currentModifiedOn = attachment.modifiedOn ?? attachment.createdOn ?? 0
      if (tx.modifiedOn < currentModifiedOn) {
        const client = getClient()
        const updated = await client.findOne(
          activity.class.ActivityMessage,
          { _id: resolvedMessageId },
          { lookup: this.LOOKUP }
        )
        this.loadedHistory.update((currentHistory) => {
          const foundLatest = this.findMessageInViewport(resolvedMessageId, currentHistory)
          if (foundLatest !== undefined) {
            if (updated !== undefined) {
              currentHistory[foundLatest.index] = updated
            } else {
              currentHistory.splice(foundLatest.index, 1)
            }
          }
          return currentHistory
        })
        return
      }
    }

    this.loadedHistory.update((currentHistory) => {
      const foundLatest = this.findMessageInViewport(resolvedMessageId, currentHistory)
      if (foundLatest !== undefined) {
        const msgLatest = foundLatest.message as WithLookup<ChatMessage>
        msgLatest.$lookup = msgLatest.$lookup ?? {}
        msgLatest.$lookup.attachments = msgLatest.$lookup.attachments ?? []
        const attachments = msgLatest.$lookup.attachments as Attachment[]

        if (tx._class === core.class.TxCreateDoc) {
          const newAttachment = TxProcessor.createDoc2Doc(tx as TxCreateDoc<Attachment>)
          if (!attachments.some((a) => a._id === tx.objectId)) {
            attachments.push(newAttachment)
          }
        } else if (tx._class === core.class.TxUpdateDoc) {
          const idx = attachments.findIndex((a) => a._id === tx.objectId)
          if (idx !== -1) {
            attachments[idx] = TxProcessor.updateDoc2Doc(attachments[idx], tx as TxUpdateDoc<Attachment>)
          }
        } else if (tx._class === core.class.TxMixin) {
          const idx = attachments.findIndex((a) => a._id === tx.objectId)
          if (idx !== -1) {
            attachments[idx] = TxProcessor.updateMixin4Doc(attachments[idx], tx as TxMixin<Attachment, Attachment>)
          }
        } else if (tx._class === core.class.TxRemoveDoc) {
          const filtered = attachments.filter((a) => a._id !== tx.objectId)
          if (filtered.length !== attachments.length) {
            msgLatest.$lookup.attachments = filtered
          }
        }
      }
      return currentHistory
    })
  }

  private async handleReactionTx (tx: TxCUD<Reaction>): Promise<void> {
    const reactionId = tx.objectId
    const messageId = (tx.attachedTo as Ref<ActivityMessage>) ?? this.loadedReactionIds.get(reactionId)
    if (messageId === undefined || !this.loadedMessageIds.has(messageId)) return

    const history = get(this.loadedHistory)
    const found = this.findMessageInViewport(messageId, history)
    if (found === undefined) return

    const msg = found.message
    const reaction = msg.$lookup?.reactions?.find((it) => it._id === reactionId) as Reaction

    const resolvedMessageId = found.message._id

    if (reaction !== undefined) {
      const currentModifiedOn = reaction.modifiedOn ?? reaction.createdOn ?? 0
      if (tx.modifiedOn < currentModifiedOn) {
        const client = getClient()
        const updated = await client.findOne(
          activity.class.ActivityMessage,
          { _id: resolvedMessageId },
          { lookup: this.LOOKUP }
        )
        this.loadedHistory.update((currentHistory) => {
          const foundLatest = this.findMessageInViewport(resolvedMessageId, currentHistory)
          if (foundLatest !== undefined) {
            if (updated !== undefined) {
              currentHistory[foundLatest.index] = updated
            } else {
              currentHistory.splice(foundLatest.index, 1)
            }
          }
          return currentHistory
        })
        return
      }
    }

    this.loadedHistory.update((currentHistory) => {
      const foundLatest = this.findMessageInViewport(resolvedMessageId, currentHistory)
      if (foundLatest !== undefined) {
        const msgLatest = foundLatest.message
        msgLatest.$lookup = msgLatest.$lookup ?? {}
        msgLatest.$lookup.reactions = msgLatest.$lookup.reactions ?? []

        const reactions = msgLatest.$lookup.reactions as Reaction[]

        if (tx._class === core.class.TxCreateDoc) {
          const newReaction = TxProcessor.createDoc2Doc(tx as TxCreateDoc<Reaction>)
          if (!reactions.some((it) => it._id === tx.objectId)) {
            reactions.push(newReaction)
          }
        } else if (tx._class === core.class.TxUpdateDoc) {
          const idx = reactions.findIndex((r) => r._id === tx.objectId)
          if (idx !== -1) {
            reactions[idx] = TxProcessor.updateDoc2Doc(reactions[idx], tx as TxUpdateDoc<Reaction>)
          }
        } else if (tx._class === core.class.TxMixin) {
          const idx = reactions.findIndex((r) => r._id === tx.objectId)
          if (idx !== -1) {
            reactions[idx] = TxProcessor.updateMixin4Doc(reactions[idx], tx as TxMixin<Reaction, Reaction>)
          }
        } else if (tx._class === core.class.TxRemoveDoc) {
          const filtered = reactions.filter((r) => r._id !== tx.objectId)
          if (filtered.length !== reactions.length) {
            msgLatest.$lookup.reactions = filtered
          }
        }
      }
      return currentHistory
    })
  }

  private async handleTransactions (txes: Tx[]): Promise<void> {
    const client = getClient()
    const hierarchy = client.getHierarchy()

    for (const tx of txes) {
      if (!TxProcessor.isExtendsCUD(tx._class)) continue

      const cudTx = tx as TxCUD<Doc>

      const isMessage = hierarchy.isDerived(cudTx.objectClass, activity.class.ActivityMessage)
      const isAttachment = hierarchy.isDerived(cudTx.objectClass, attachment.class.Attachment)
      const isReaction = hierarchy.isDerived(cudTx.objectClass, activity.class.Reaction)

      if (!isMessage && !isAttachment && !isReaction) continue

      if (isMessage) {
        await this.handleMessageTx(cudTx as TxCUD<ActivityMessage>)
      } else if (isAttachment) {
        await this.handleAttachmentTx(cudTx as TxCUD<Attachment>)
      } else if (isReaction) {
        await this.handleReactionTx(cudTx as TxCUD<Reaction>)
      }
    }
  }
}

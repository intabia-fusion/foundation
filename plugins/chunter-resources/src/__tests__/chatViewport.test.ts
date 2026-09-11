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

import { get } from 'svelte/store'
import activity from '@hcengineering/activity'
import attachment from '@hcengineering/attachment'
import { type Ref, type Doc } from '@hcengineering/core'
import { addTxListener } from '@hcengineering/presentation'

import { ChatViewport } from '../chatViewport'

// Mock svelte/store before any other imports
jest.mock('svelte/store', () => {
  return {
    writable: (initialValue: any) => {
      let value = initialValue
      const subscribers = new Set<(val: any) => void>()
      return {
        subscribe: (fn: (val: any) => void): (() => void) => {
          subscribers.add(fn)
          fn(value)
          return () => {
            subscribers.delete(fn)
          }
        },
        set: (newValue: any) => {
          value = newValue
          for (const sub of subscribers) {
            sub(value)
          }
        },
        update: (fn: (val: any) => any) => {
          value = fn(value)
          for (const sub of subscribers) {
            sub(value)
          }
        }
      }
    },
    derived: (stores: any, fn: (values: any) => any) => {
      const isArray = Array.isArray(stores)
      const storeList = isArray ? stores : [stores]
      const getValues = (): any => {
        const values = storeList.map((s) => {
          let val: any
          const unsub = s.subscribe((v: any) => {
            val = v
          })
          unsub()
          return val
        })
        return isArray ? values : values[0]
      }

      return {
        subscribe: (fnCallback: (val: any) => void): (() => void) => {
          const run = (): void => {
            const currentValues = getValues()
            fnCallback(fn(currentValues))
          }
          const unsubs = storeList.map((s) => s.subscribe(run))
          run()
          return () => {
            unsubs.forEach((unsub) => unsub())
          }
        }
      }
    },
    get: (store: any): any => {
      let value: any
      const unsub = store.subscribe((v: any) => {
        value = v
      })
      unsub()
      return value
    }
  }
})

const mockAccount = {
  uuid: 'me-uuid',
  socialIds: ['me-social-id']
}

// Mock @hcengineering/core statically to avoid loading actual core package in Jest
jest.mock('@hcengineering/core', () => {
  return {
    __esModule: true,
    SortingOrder: {
      Ascending: 1,
      Descending: -1
    },
    getCurrentAccount: () => mockAccount,
    default: {
      class: {
        TxCreateDoc: 'TxCreateDoc',
        TxUpdateDoc: 'TxUpdateDoc',
        TxRemoveDoc: 'TxRemoveDoc',
        TxMixin: 'TxMixin'
      }
    },
    TxProcessor: {
      isExtendsCUD: (cls: any) => {
        return cls === 'TxCreateDoc' || cls === 'TxUpdateDoc' || cls === 'TxRemoveDoc' || cls === 'TxMixin'
      },
      createDoc2Doc: (tx: any) => ({
        ...tx.attributes,
        _id: tx.objectId,
        _class: tx.objectClass,
        attachedTo: tx.attachedTo,
        attachedToClass: tx.attachedToClass,
        modifiedOn: tx.modifiedOn,
        createdOn: tx.createdOn ?? tx.modifiedOn
      }),
      updateDoc2Doc: (doc: any, tx: any) => {
        Object.assign(doc, tx.operations)
        return doc
      },
      updateMixin4Doc: (doc: any, tx: any) => {
        doc[tx.mixin] = { ...doc[tx.mixin], ...tx.attributes }
        return doc
      }
    }
  }
})

const mockHierarchy = {
  isDerived: (sub: any, parent: any) => {
    if (sub === parent) return true
    if (sub === 'ChatMessage' && parent === activity.class.ActivityMessage) return true
    if (sub === 'Reaction' && parent === activity.class.Reaction) return true
    if (sub === 'Attachment' && parent === attachment.class.Attachment) return true
    if (typeof sub === 'string' && typeof parent === 'string') {
      if (sub === parent) return true
      if (sub === 'ChatMessage' && parent === 'ActivityMessage') return true
    }
    return false
  }
}

const mockClient = {
  findAll: jest.fn(),
  findOne: jest.fn(),
  getHierarchy: () => mockHierarchy
}

const mockQuery = {
  query: jest.fn(),
  unsubscribe: jest.fn()
}

jest.mock('@hcengineering/presentation', () => ({
  getClient: () => mockClient,
  createQuery: () => mockQuery,
  addTxListener: jest.fn(),
  removeTxListener: jest.fn()
}))

describe('ChatViewport', () => {
  const flushTasks = async (): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  const chatId = 'test-chat-id' as Ref<any>
  let liveMessages: any[] = []
  let liveCallback: ((res: any[]) => void) | undefined

  beforeEach(() => {
    jest.clearAllMocks()
    mockClient.findAll.mockReset()
    mockClient.findOne.mockReset()
    mockQuery.query.mockReset()
    mockQuery.unsubscribe.mockReset()

    liveMessages = []
    liveCallback = undefined

    mockQuery.query.mockImplementation((cls, query, callback) => {
      liveCallback = callback
      if (liveMessages.length > 0) {
        callback(liveMessages)
      }
    })
  })

  afterEach(() => {
    ChatViewport.clearCache()
  })

  describe('Suite 1: Initial viewport', () => {
    it('1.1 should default to loading latest tail when no anchor or unread messages are present', async () => {
      const mockMessages = Array.from({ length: 5 }, (_, i) => ({
        _id: `msg-${i}`,
        createdOn: 1000 - i * 10
      }))
      mockClient.findAll.mockResolvedValue(mockMessages)
      liveMessages = []

      const readState = {
        'me-uuid': { timestamp: 2000 }
      }
      const viewport = new ChatViewport(readState as any, chatId, undefined)
      await flushTasks()

      expect(mockClient.findAll).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        { attachedTo: chatId },
        expect.objectContaining({ limit: 51, sort: { createdOn: -1 } })
      )

      expect(get(viewport.hasMoreBackward)).toBe(false)
      expect(get(viewport.hasMoreForward)).toBe(false)
      expect(mockQuery.query).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        expect.objectContaining({ attachedTo: chatId, createdOn: { $gte: 1000 } }),
        expect.any(Function),
        expect.any(Object)
      )
      expect(get(viewport.messages)).toEqual([...mockMessages].reverse())
    })

    it('1.1b should load from the beginning when lastViewTs is 0 and no anchor is present', async () => {
      const unreadMsg = { _id: 'unread-1', createdOn: 100 }
      mockClient.findOne.mockResolvedValueOnce(unreadMsg)

      // Mock tail query first: oldest message is at createdOn 950 (far after unreadMsg 100)
      const tailRes = Array.from({ length: 51 }, (_, i) => ({
        _id: `tail-${i}`,
        createdOn: 1000 - i
      }))

      mockClient.findAll
        .mockResolvedValueOnce(tailRes)
        .mockResolvedValueOnce([]) // backward query returns empty
        .mockResolvedValueOnce([
          { _id: 'unread-1', createdOn: 100 },
          { _id: 'msg-1', createdOn: 110 },
          { _id: 'msg-2', createdOn: 120 }
        ]) // forward query

      liveMessages = []

      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      expect(mockClient.findOne).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        expect.objectContaining({ createdOn: { $gt: 0 } }),
        expect.any(Object)
      )

      expect(get(viewport.hasMoreBackward)).toBe(false)
      expect(get(viewport.messages)).toEqual([
        { _id: 'unread-1', createdOn: 100 },
        { _id: 'msg-1', createdOn: 110 },
        { _id: 'msg-2', createdOn: 120 }
      ])
    })

    it('1.2 should anchor around unread messages if present', async () => {
      const unreadMsg = { _id: 'unread-1', createdOn: 500 }
      mockClient.findOne.mockResolvedValueOnce(unreadMsg)
      // Mock tail query first: oldest message is at createdOn 950 (far after unreadMsg 500)
      const tailRes = Array.from({ length: 51 }, (_, i) => ({
        _id: `tail-${i}`,
        createdOn: 1000 - i
      }))
      mockClient.findAll
        .mockResolvedValueOnce(tailRes)
        .mockResolvedValueOnce([{ _id: 'older-1', createdOn: 400 }])
        .mockResolvedValueOnce([{ _id: 'fw-1', createdOn: 600 }])

      const readState = {
        'me-uuid': { timestamp: 300 }
      }

      const viewport = new ChatViewport(readState as any, chatId, undefined)
      await flushTasks()

      expect(get(viewport.newTimestamp)).toBe(500)
      expect(mockClient.findOne).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        expect.objectContaining({ createdOn: { $gt: 300 } }),
        expect.any(Object)
      )
      expect(get(viewport.hasMoreBackward)).toBe(false)
    })

    it('1.3 should anchor around selectedMessageId if provided', async () => {
      const selectedMsg = { _id: 'selected-1', createdOn: 910 }
      mockClient.findOne.mockResolvedValueOnce(selectedMsg)
      // Mock tail containing selectedMsg at index 9 (createdOn: 910 >= oldest message 910)
      const tailRes = Array.from({ length: 10 }, (_, i) => ({
        _id: i === 9 ? 'selected-1' : `msg-after-${i}`,
        createdOn: 1000 - i * 10
      }))
      mockClient.findAll.mockResolvedValueOnce(tailRes)
      liveMessages = []

      const viewport = new ChatViewport(undefined, chatId, 'selected-1' as any)
      await flushTasks()

      expect(viewport).toBeDefined()
      expect(mockClient.findOne).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        { _id: 'selected-1' },
        { projection: { _id: 1, createdOn: 1 } }
      )
      expect(mockClient.findAll).toHaveBeenLastCalledWith(
        activity.class.ActivityMessage,
        { attachedTo: chatId },
        expect.objectContaining({ limit: 51, sort: { createdOn: -1 } })
      )
    })

    it('1.4 should anchor mid-history with split window if anchor is far back', async () => {
      const selectedMsg = { _id: 'selected-1', createdOn: 700 }
      mockClient.findOne.mockResolvedValueOnce(selectedMsg)
      // Mock tail query first: oldest message is at createdOn 950 (far after selectedMsg 700)
      const tailRes = Array.from({ length: 51 }, (_, i) => ({
        _id: `tail-${i}`,
        createdOn: 1000 - i
      }))
      mockClient.findAll.mockResolvedValueOnce(tailRes)
      const beforeMessages = Array.from({ length: 26 }, (_, i) => ({
        _id: `older-${i}`,
        createdOn: 699 - i
      }))
      mockClient.findAll.mockResolvedValueOnce(beforeMessages)

      const forwardMessages = Array.from({ length: 10 }, (_, i) => ({
        _id: `newer-${i}`,
        createdOn: 701 + i
      }))
      mockClient.findAll.mockResolvedValueOnce(forwardMessages)

      const viewport = new ChatViewport(undefined, chatId, 'selected-1' as any)
      await flushTasks()

      expect(get(viewport.hasMoreBackward)).toBe(true)
      expect(mockClient.findAll).toHaveBeenLastCalledWith(
        activity.class.ActivityMessage,
        expect.objectContaining({
          createdOn: { $gte: 675 }
        }),
        expect.objectContaining({
          limit: 51,
          sort: { createdOn: 1 }
        })
      )
    })

    it('1.5 should transition near-end anchor to loading latest tail', async () => {
      const selectedMsg = { _id: 'selected-1', createdOn: 910 }
      mockClient.findOne.mockResolvedValueOnce(selectedMsg)
      // Mock tail containing selectedMsg at index 9 (createdOn: 910 >= oldest message 910)
      const tailRes = Array.from({ length: 10 }, (_, i) => ({
        _id: i === 9 ? 'selected-1' : `msg-after-${i}`,
        createdOn: 1000 - i * 10
      }))
      mockClient.findAll.mockResolvedValueOnce(tailRes)
      liveMessages = []

      const viewport = new ChatViewport(undefined, chatId, 'selected-1' as any)
      await flushTasks()

      expect(viewport).toBeDefined()
      expect(mockClient.findAll).toHaveBeenLastCalledWith(
        activity.class.ActivityMessage,
        { attachedTo: chatId },
        expect.objectContaining({ limit: 51, sort: { createdOn: -1 } })
      )
    })

    it('1.6 should skip unread query if selectedMessageId is resolved', async () => {
      const selectedMsg = { _id: 'selected-1', createdOn: 910 }
      mockClient.findOne.mockResolvedValueOnce(selectedMsg)
      // Mock tail containing selectedMsg at index 9 (createdOn: 910 >= oldest message 910)
      const tailRes = Array.from({ length: 10 }, (_, i) => ({
        _id: i === 9 ? 'selected-1' : `msg-after-${i}`,
        createdOn: 1000 - i * 10
      }))
      mockClient.findAll.mockResolvedValueOnce(tailRes)

      const readState = {
        'me-uuid': { timestamp: 300 }
      }

      const viewport = new ChatViewport(readState as any, chatId, 'selected-1' as any)
      await flushTasks()

      expect(viewport).toBeDefined()
      expect(mockClient.findOne).toHaveBeenCalledTimes(1)
      expect(mockClient.findOne).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        { _id: 'selected-1' },
        { projection: { _id: 1, createdOn: 1 } }
      )
    })

    it('1.7 should skip unread query if latestMessageTimestamp is less than or equal to lastView', async () => {
      const mockMessages = [{ _id: 'msg-1', createdOn: 500 }]
      mockClient.findAll.mockResolvedValue(mockMessages)

      const readState = {
        'me-uuid': { timestamp: 500 },
        latestMessageTimestamp: 500
      }

      const viewport = new ChatViewport(readState as any, chatId, undefined)
      await flushTasks()

      expect(viewport).toBeDefined()
      expect(mockClient.findOne).not.toHaveBeenCalled()
      expect(mockClient.findAll).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        { attachedTo: chatId },
        expect.objectContaining({ limit: 51, sort: { createdOn: -1 } })
      )
    })
  })

  describe('Suite 2: Real-time Live Updates (subscribeToLiveTail)', () => {
    it('2.1 should order live update messages chronologically', async () => {
      mockClient.findAll.mockResolvedValueOnce([])

      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      const liveUpdates = [
        { _id: 'msg-new', createdOn: 1100 },
        { _id: 'msg-old', createdOn: 1050 }
      ]
      if (liveCallback !== undefined) {
        liveCallback(liveUpdates)
      }

      expect(get(viewport.messages)).toEqual([
        { _id: 'msg-old', createdOn: 1050 },
        { _id: 'msg-new', createdOn: 1100 }
      ])
    })

    it('2.2 should call unsubscribe when viewport is destroyed', async () => {
      mockClient.findAll.mockResolvedValueOnce([])
      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      viewport.destroy()
      expect(mockQuery.unsubscribe).toHaveBeenCalled()
    })
  })

  describe('Suite 3: History Pagination (loadMore)', () => {
    it('3.1 should prepend backward page in chronological order', async () => {
      const initialMsg = { _id: 'initial-1', createdOn: 1000 }
      mockClient.findAll.mockResolvedValueOnce([initialMsg])
      liveMessages = []

      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      const backwardPage = [
        { _id: 'back-1', createdOn: 950 },
        { _id: 'back-2', createdOn: 900 }
      ]
      mockClient.findAll.mockResolvedValueOnce(backwardPage)

      await viewport.loadMore('backward', 1000)

      expect(get(viewport.messages)).toEqual([
        { _id: 'back-2', createdOn: 900 },
        { _id: 'back-1', createdOn: 950 },
        { _id: 'initial-1', createdOn: 1000 }
      ])
    })

    it('3.2 should append forward page', async () => {
      const initialMsg = { _id: 'initial-1', createdOn: 1000 }
      mockClient.findAll.mockResolvedValueOnce([initialMsg])
      liveMessages = []

      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      const liveTailStore = (viewport as any).liveTail
      liveTailStore.set([])
      const loadedHistoryStore = (viewport as any).loadedHistory
      loadedHistoryStore.set([initialMsg])

      viewport.hasMoreForward.set(true)

      const forwardPage = [
        { _id: 'fw-1', createdOn: 1050 },
        { _id: 'fw-2', createdOn: 1100 }
      ]
      mockClient.findAll.mockResolvedValueOnce(forwardPage)

      await viewport.loadMore('forward', 1000)

      expect(get(viewport.messages)).toEqual([
        { _id: 'initial-1', createdOn: 1000 },
        { _id: 'fw-1', createdOn: 1050 },
        { _id: 'fw-2', createdOn: 1100 }
      ])
    })

    it('3.3 should enforce correct canLoadMore outputs based on direction and state', async () => {
      mockClient.findAll.mockResolvedValueOnce([])
      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      expect(viewport.canLoadMore('backward', undefined)).toBe(false)

      viewport.hasMoreBackward.set(true)
      expect(viewport.canLoadMore('backward', 1000)).toBe(true)
      viewport.hasMoreBackward.set(false)
      expect(viewport.canLoadMore('backward', 1000)).toBe(false)

      viewport.hasMoreForward.set(false)
      expect(viewport.canLoadMore('forward', 1000)).toBe(false)

      viewport.hasMoreForward.set(true)
      viewport.isLoading.set(true)
      viewport.isTailLoaded.set(false)
      expect(viewport.canLoadMore('forward', 1000)).toBe(false)

      viewport.isLoading.set(false)
      expect(viewport.canLoadMore('forward', 1000)).toBe(true)

      const liveTailStore = (viewport as any).liveTail
      liveTailStore.set([{ _id: 'live-1', createdOn: 1050 }])
      expect(viewport.canLoadMore('forward', 1000)).toBe(false)
    })
  })

  describe('Suite 4: Viewport Session Versioning (viewportVersion)', () => {
    it('4.1 should increment viewportVersion on resetViewport', async () => {
      mockClient.findAll.mockResolvedValueOnce([])
      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      const initialVersion = (viewport as any).viewportVersion
      ;(viewport as any).resetViewport()
      expect((viewport as any).viewportVersion).toBe(initialVersion + 1)
    })

    it('4.2 should discard stale query results when version increments', async () => {
      let queryResolve: (val: any) => void = () => {}
      const queryPromise = new Promise((resolve) => {
        queryResolve = resolve
      })
      mockClient.findAll.mockReturnValue(queryPromise)

      const viewport = new ChatViewport(undefined, chatId, undefined)
      viewport.destroy()

      queryResolve([{ _id: 'msg-1', createdOn: 1000 }])
      await flushTasks()

      expect(get(viewport.messages)).toEqual([])
    })

    it('4.3 should not toggle isLoadingMore when stale query finally block runs', async () => {
      let queryResolve: (val: any) => void = () => {}
      const queryPromise = new Promise((resolve) => {
        queryResolve = resolve
      })

      mockClient.findAll.mockResolvedValueOnce([])
      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      mockClient.findAll.mockReturnValueOnce(queryPromise)
      const loadPromise = viewport.loadMore('backward', 1000)

      expect(get(viewport.isLoadingMore)).toBe(true)
      ;(viewport as any).resetViewport()
      viewport.isLoadingMore.set(true)

      queryResolve([])
      await loadPromise

      expect(get(viewport.isLoadingMore)).toBe(true)
    })
  })

  describe('Suite 5: Duplicate Timestamps & Fallback Queries', () => {
    it('5.1 / 5.2 / 5.3 should compute hasMore before filtering, handle strict inequality fallback, and terminate fallback', async () => {
      const skipMsg = { _id: 'msg-boundary', createdOn: 1000 }
      mockClient.findAll.mockResolvedValueOnce([skipMsg])

      const viewport = new ChatViewport(undefined, chatId, undefined)
      Object.defineProperty(viewport, 'limit', { value: 1 })

      await flushTasks()
      mockClient.findAll.mockClear()

      mockClient.findAll
        .mockResolvedValueOnce([skipMsg, skipMsg])
        .mockResolvedValueOnce([{ _id: 'msg-fallback', createdOn: 900 }])

      const loadedHistoryStore = (viewport as any).loadedHistory
      loadedHistoryStore.set([skipMsg])

      await viewport.loadMore('backward', 1000, 1)

      expect(mockClient.findAll).toHaveBeenCalledTimes(2)
      expect(mockClient.findAll).toHaveBeenNthCalledWith(
        1,
        activity.class.ActivityMessage,
        expect.objectContaining({ createdOn: { $lte: 1000 } }),
        expect.any(Object)
      )
      expect(mockClient.findAll).toHaveBeenNthCalledWith(
        2,
        activity.class.ActivityMessage,
        expect.objectContaining({ createdOn: { $lt: 1000 } }),
        expect.any(Object)
      )

      expect(get(viewport.messages)).toEqual([{ _id: 'msg-fallback', createdOn: 900 }, skipMsg])
    })
  })

  describe('Suite 6: Interactive Navigation API (jumpToDate, jumpToMessageId, jumpToEnd, syncUnreadMarker)', () => {
    it('6.1.1 should jumpToDate successfully targeting >= date message', async () => {
      mockClient.findAll
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ _id: 'msg-date-gte', createdOn: 1200 }])
        .mockResolvedValueOnce([{ _id: 'msg-date-gte', createdOn: 1200 }])

      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      const resetSpy = jest.spyOn(viewport as any, 'resetViewport')
      const resId = await viewport.jumpToDate(1100)
      await flushTasks()

      expect(resId).toBe('msg-date-gte')
      expect(resetSpy).toHaveBeenCalled()
      expect(mockClient.findAll).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        { attachedTo: chatId, createdOn: { $gte: 1100 } },
        expect.objectContaining({ limit: 1, sort: { createdOn: 1 } })
      )
    })

    it('6.1.2 should jumpToDate successfully falling back to < date message', async () => {
      mockClient.findAll
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ _id: 'msg-date-lt', createdOn: 900 }])
        .mockResolvedValueOnce([{ _id: 'msg-date-lt', createdOn: 900 }])

      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      const resetSpy = jest.spyOn(viewport as any, 'resetViewport')
      const resId = await viewport.jumpToDate(1100)
      await flushTasks()

      expect(resId).toBe('msg-date-lt')
      expect(resetSpy).toHaveBeenCalled()
      expect(mockClient.findAll).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        { attachedTo: chatId, createdOn: { $lt: 1100 } },
        expect.objectContaining({ limit: 1, sort: { createdOn: -1 } })
      )
    })

    it('6.1.3 should jumpToDate do nothing if no message is found in both directions', async () => {
      mockClient.findAll.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])

      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      const resetSpy = jest.spyOn(viewport as any, 'resetViewport')
      const resId = await viewport.jumpToDate(1100)
      await flushTasks()

      expect(resId).toBeUndefined()
      expect(resetSpy).not.toHaveBeenCalled()
    })

    it('6.2.1 should jumpToMessageId return false if message already loaded', async () => {
      mockClient.findAll.mockResolvedValueOnce([])

      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      const loadedHistoryStore = (viewport as any).loadedHistory
      loadedHistoryStore.set([{ _id: 'msg-loaded', createdOn: 1000 } as any])

      const resetSpy = jest.spyOn(viewport as any, 'resetViewport')
      const result = await viewport.jumpToMessageId('msg-loaded' as any)

      expect(result).toBe(false)
      expect(resetSpy).not.toHaveBeenCalled()
    })

    it('6.2.2 should jumpToMessageId return true, reset, and re-initialize if message not loaded', async () => {
      mockClient.findAll.mockResolvedValueOnce([])
      mockClient.findOne.mockResolvedValueOnce({ _id: 'msg-new', createdOn: 1200 })
      mockClient.findAll
        .mockResolvedValueOnce([{ _id: 'msg-new', createdOn: 1200 }])
        .mockResolvedValueOnce([{ _id: 'msg-new', createdOn: 1200 }])

      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      const resetSpy = jest.spyOn(viewport as any, 'resetViewport')
      const result = await viewport.jumpToMessageId('msg-new' as any)
      await flushTasks()

      expect(result).toBe(true)
      expect(resetSpy).toHaveBeenCalled()
      expect(mockClient.findOne).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        { _id: 'msg-new' },
        { projection: { _id: 1, createdOn: 1 } }
      )
    })

    it('6.3 should jumpToEnd reset viewport and initialize with undefined target', async () => {
      mockClient.findAll.mockResolvedValue([])
      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      mockClient.findAll.mockClear()
      const resetSpy = jest.spyOn(viewport as any, 'resetViewport')
      const result = viewport.jumpToEnd()
      await flushTasks()

      expect(result).toBe(true)
      expect(resetSpy).toHaveBeenCalled()
      expect(viewport.selectedMessageId).toBeUndefined()
    })

    it('6.4.1 should syncUnreadMarker update newTimestamp based on first unread message', async () => {
      mockClient.findAll.mockResolvedValueOnce([])
      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      const readState = {
        'me-uuid': { timestamp: 500 }
      }

      mockClient.findAll.mockResolvedValueOnce([{ _id: 'msg-unread', createdOn: 600 }])
      await viewport.syncUnreadMarker(readState as any)

      expect(get(viewport.newTimestamp)).toBe(600)
      expect(mockClient.findAll).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        {
          attachedTo: chatId,
          createdOn: { $gt: 500 },
          createdBy: { $nin: ['me-social-id'] }
        },
        expect.objectContaining({ limit: 1, sort: { createdOn: 1 } })
      )
    })

    it('6.4.2 should syncUnreadMarker set newTimestamp undefined if lastView is 0', async () => {
      mockClient.findAll.mockResolvedValueOnce([])
      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      viewport.newTimestamp.set(600)
      const readState = {
        'me-uuid': { timestamp: 0 }
      }

      await viewport.syncUnreadMarker(readState as any)
      expect(get(viewport.newTimestamp)).toBeUndefined()
    })
  })

  describe('Suite 7: Chat Continuity and Boundary Verification (No Gaps, No Lost Messages)', () => {
    it('7.1 should load split-window mid-history centered around anchor without any gaps', async () => {
      const selectedMsg = { _id: 'selected-1', createdOn: 700 }
      mockClient.findOne.mockResolvedValueOnce(selectedMsg)

      // Mock tail query returns messages far ahead of the anchor (e.g. from 1000 down to 950)
      const tailRes = Array.from({ length: 51 }, (_, i) => ({
        _id: `tail-${i}`,
        createdOn: 1000 - i
      }))
      mockClient.findAll.mockResolvedValueOnce(tailRes)

      // Mock beforeRes (messages before 700): 25 messages, oldest is older-24 (675)
      const beforeMessages = Array.from({ length: 26 }, (_, i) => ({
        _id: `older-${i}`,
        createdOn: 699 - i
      }))
      mockClient.findAll.mockResolvedValueOnce(beforeMessages)

      // Mock forward query starting from 675.
      // Must contain all messages from 675 up to the forward limit.
      const forwardMessages = Array.from({ length: 50 }, (_, i) => ({
        _id: i < 25 ? `older-${24 - i}` : i === 25 ? 'selected-1' : `newer-${i - 26}`,
        createdOn: 675 + i
      }))
      mockClient.findAll.mockResolvedValueOnce(forwardMessages)

      const viewport = new ChatViewport(undefined, chatId, 'selected-1' as any)
      await flushTasks()

      const messages = get(viewport.messages)
      expect(messages.length).toBe(50)
      expect(messages[0]._id).toBe('older-24') // oldest loaded
      expect(messages[messages.length - 1]._id).toBe('newer-23') // newest loaded
      expect(messages.some((m) => m._id === 'selected-1')).toBe(true)

      // Verify that every message has a chronological timestamp increment of exactly 1
      for (let i = 1; i < messages.length; i++) {
        const msg = messages[i]
        const prev = messages[i - 1]
        expect(msg).toBeDefined()
        expect(prev).toBeDefined()
        if (msg !== undefined && prev !== undefined) {
          expect(msg.createdOn).toBe(prev.createdOn !== undefined ? prev.createdOn + 1 : undefined)
        }
      }
    })

    it('7.2 should filter out duplicate boundary messages in backward pagination but retain concurrent new ones', async () => {
      // Initialize viewport with simple tail
      const initialMsg = { _id: 'boundary-msg', createdOn: 1000 }
      mockClient.findAll.mockResolvedValueOnce([initialMsg])

      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      // Now query backward from 1000.
      // Database returns boundary-msg (already loaded) and a concurrent message at 1000, and older messages.
      const backwardPage = [
        { _id: 'boundary-msg', createdOn: 1000 },
        { _id: 'concurrent-msg', createdOn: 1000 },
        { _id: 'older-1', createdOn: 950 }
      ]
      mockClient.findAll.mockResolvedValueOnce(backwardPage)

      await viewport.loadMore('backward', 1000)

      const messages = get(viewport.messages)
      // Expect: 'older-1' (950), 'concurrent-msg' (1000), 'boundary-msg' (1000)
      // boundary-msg must not be duplicated!
      expect(messages.filter((m) => m._id === 'boundary-msg').length).toBe(1)
      expect(messages.filter((m) => m._id === 'concurrent-msg').length).toBe(1)
      expect(messages).toEqual([
        { _id: 'older-1', createdOn: 950 },
        { _id: 'concurrent-msg', createdOn: 1000 },
        { _id: 'boundary-msg', createdOn: 1000 }
      ])
    })

    it('7.3 should successfully transition to live query and handle concurrent boundary messages without loss', async () => {
      const boundaryMsg = { _id: 'boundary-msg', createdOn: 1000 }
      mockClient.findAll.mockResolvedValueOnce([boundaryMsg])

      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      // Trigger forward load that switches to live tail since hasMoreForward is false
      viewport.hasMoreForward.set(false)

      // Setup live tail mock return containing boundaryMsg and a new concurrent message at 1000
      const liveUpdates = [
        { _id: 'new-msg-2', createdOn: 1010 },
        { _id: 'new-msg-1', createdOn: 1000 },
        { _id: 'boundary-msg', createdOn: 1000 }
      ]

      await viewport.loadMore('forward', 1000)

      if (liveCallback !== undefined) {
        liveCallback(liveUpdates)
      }

      const messages = get(viewport.messages)
      // Expect: boundary-msg, new-msg-1, new-msg-2.
      // boundary-msg must not be duplicated, and new-msg-1 (concurrent timestamp) must not be lost!
      expect(messages).toEqual([
        { _id: 'boundary-msg', createdOn: 1000 },
        { _id: 'new-msg-1', createdOn: 1000 },
        { _id: 'new-msg-2', createdOn: 1010 }
      ])
    })

    it('7.4 should handle empty chat initialization and verify live updates append successfully', async () => {
      mockClient.findAll.mockResolvedValueOnce([])
      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      expect(get(viewport.messages)).toEqual([])
      expect(get(viewport.hasMoreBackward)).toBe(false)
      expect(get(viewport.hasMoreForward)).toBe(false)

      // Verify that subscribeToLiveTail was called without a timestamp restriction
      expect(mockQuery.query).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        expect.objectContaining({ attachedTo: chatId }),
        expect.any(Function),
        expect.any(Object)
      )

      // Push real-time messages
      const liveUpdates = [
        { _id: 'live-new', createdOn: 200 },
        { _id: 'live-old', createdOn: 100 }
      ]
      if (liveCallback !== undefined) {
        liveCallback(liveUpdates)
      }

      expect(get(viewport.messages)).toEqual([
        { _id: 'live-old', createdOn: 100 },
        { _id: 'live-new', createdOn: 200 }
      ])
    })

    it('7.5 should handle strict inequality fallback in forward pagination when all items in a page are duplicates', async () => {
      // Initialize viewport with loaded messages
      const boundaryMsg = { _id: 'boundary-msg', createdOn: 1000 }
      mockClient.findAll.mockResolvedValueOnce([boundaryMsg])

      const viewport = new ChatViewport(undefined, chatId, undefined)
      Object.defineProperty(viewport, 'limit', { value: 1 })
      await flushTasks()

      // Setup forward states
      viewport.hasMoreForward.set(true)
      const loadedHistoryStore = (viewport as any).loadedHistory
      loadedHistoryStore.set([boundaryMsg])

      mockClient.findAll.mockClear()
      // First page query returns duplicate boundaryMsg (will be filtered out)
      mockClient.findAll
        .mockResolvedValueOnce([boundaryMsg, boundaryMsg])
        // Fallback query returns the actual next message
        .mockResolvedValueOnce([{ _id: 'newer-msg', createdOn: 1100 }])

      await viewport.loadMore('forward', 1000, 1)

      expect(mockClient.findAll).toHaveBeenCalledTimes(2)
      expect(mockClient.findAll).toHaveBeenNthCalledWith(
        1,
        activity.class.ActivityMessage,
        expect.objectContaining({ createdOn: { $gte: 1000 } }),
        expect.any(Object)
      )
      expect(mockClient.findAll).toHaveBeenNthCalledWith(
        2,
        activity.class.ActivityMessage,
        expect.objectContaining({ createdOn: { $gt: 1000 } }),
        expect.any(Object)
      )

      expect(get(viewport.messages)).toEqual([boundaryMsg, { _id: 'newer-msg', createdOn: 1100 }])
    })

    it('7.6 should handle stale version on slow syncUnreadMarker or jumpToDate', async () => {
      // 1. syncUnreadMarker version check
      mockClient.findAll.mockResolvedValueOnce([])
      const viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      let queryResolve: (val: any) => void = () => {}
      const queryPromise = new Promise((resolve) => {
        queryResolve = resolve
      })

      // Mock query client to return the promise
      mockClient.findAll.mockReturnValueOnce(queryPromise)

      const readState = {
        'me-uuid': { timestamp: 500 }
      }
      const syncPromise = viewport.syncUnreadMarker(readState as any)

      // Increment version before the query resolves to simulate navigation/stale state
      ;(viewport as any).resetViewport()

      queryResolve([{ _id: 'msg-unread', createdOn: 600 }])
      await syncPromise

      // Since the viewport was reset/stale, newTimestamp must not be set from the resolved query
      expect(get(viewport.newTimestamp)).toBeUndefined()

      // 2. jumpToDate version check
      mockClient.findAll.mockClear()
      let jumpResolve: (val: any) => void = () => {}
      const jumpPromise = new Promise((resolve) => {
        jumpResolve = resolve
      })
      mockClient.findAll.mockReturnValueOnce(jumpPromise)

      const jumpToDatePromise = viewport.jumpToDate(700)

      // Increment version
      ;(viewport as any).resetViewport()

      jumpResolve([{ _id: 'msg-date', createdOn: 800 }])
      await jumpToDatePromise

      // The viewport was reset, messages store must remain empty (or cleared)
      expect(get(viewport.messages)).toEqual([])
    })

    it('7.7 should handle anchor in tail when tail contains exactly limit + 1 messages', async () => {
      const selectedMsg = { _id: 'selected-1', createdOn: 951 }
      mockClient.findOne.mockResolvedValueOnce(selectedMsg)

      // Tail query returns exactly limit + 1 (51) messages, oldest loaded is index 49 (createdOn 951)
      const tailRes = Array.from({ length: 51 }, (_, i) => ({
        _id: i === 49 ? 'selected-1' : `tail-${i}`,
        createdOn: 1000 - i
      }))
      mockClient.findAll.mockResolvedValueOnce(tailRes)

      const viewport = new ChatViewport(undefined, chatId, 'selected-1' as any)
      await flushTasks()

      // Since oldest loaded message createdOn is 951 and selected-1 createdOn is 951,
      // it should be treated as in tail (951 >= 951) and initialized directly from the tail.
      expect(get(viewport.hasMoreBackward)).toBe(true)
      expect(get(viewport.hasMoreForward)).toBe(false)
      expect(get(viewport.messages).length).toBe(50)
      const firstMsg = get(viewport.messages)[0]
      expect(firstMsg?._id).toBe('selected-1')
    })

    it('7.8 should handle scenario where anchor createdOn is undefined or missing', async () => {
      // Anchor createdOn is undefined
      const selectedMsg = { _id: 'selected-1', createdOn: undefined }
      mockClient.findOne.mockResolvedValueOnce(selectedMsg)

      const tailRes = Array.from({ length: 10 }, (_, i) => ({
        _id: `msg-${i}`,
        createdOn: 1000 - i * 10
      }))
      mockClient.findAll.mockResolvedValueOnce(tailRes)

      const viewport = new ChatViewport(undefined, chatId, 'selected-1' as any)
      await flushTasks()

      // Since targetAnchor.createdOn is undefined, it should fallback to applying latest tail.
      expect(get(viewport.messages).length).toBe(10)
      expect(get(viewport.hasMoreBackward)).toBe(false)
    })
  })

  describe('Suite 8: Transaction Reactivity', () => {
    let listener: (txes: any[]) => void
    let viewport: ChatViewport
    let mockMsg: any

    beforeEach(async () => {
      mockMsg = {
        _id: 'msg-1',
        _class: 'ChatMessage',
        createdOn: 1000,
        modifiedOn: 1000,
        message: 'Hello'
      }
      mockClient.findAll.mockResolvedValue([mockMsg])
      ;(addTxListener as jest.Mock).mockClear()

      viewport = new ChatViewport(undefined, chatId, undefined)
      await flushTasks()

      expect(addTxListener).toHaveBeenCalled()
      listener = (addTxListener as jest.Mock).mock.calls[0][0]
      mockClient.findOne.mockClear()
    })

    it('8.1 should update message content on TxUpdateDoc without fetching from DB', async () => {
      const tx = {
        _class: 'TxUpdateDoc',
        objectId: 'msg-1',
        objectClass: 'ChatMessage',
        modifiedOn: 1050,
        operations: {
          message: 'Hello World'
        }
      }

      listener([tx])
      await flushTasks()

      const msgs = get(viewport.messages)
      expect(msgs.length).toBe(1)
      expect(msgs[0].message).toBe('Hello World')
      expect(mockClient.findOne).not.toHaveBeenCalled()
    })

    it('8.2 should update message content on TxMixin without fetching from DB', async () => {
      const tx = {
        _class: 'TxMixin',
        objectId: 'msg-1',
        objectClass: 'ChatMessage',
        mixin: 'someMixin',
        modifiedOn: 1050,
        attributes: {
          field: 'value'
        }
      }

      listener([tx])
      await flushTasks()

      const msgs = get(viewport.messages)
      expect((msgs[0] as any).someMixin?.field).toBe('value')
      expect(mockClient.findOne).not.toHaveBeenCalled()
    })

    it('8.3 should delete message locally on TxRemoveDoc', async () => {
      const removeTx = {
        _class: 'TxRemoveDoc',
        objectId: 'msg-1',
        objectClass: 'ChatMessage',
        modifiedOn: 1050
      }

      listener([removeTx])
      await flushTasks()

      const msgs = get(viewport.messages)
      expect(msgs.length).toBe(0)
    })

    it('8.4 should add, update, and remove reactions locally in $lookup.reactions', async () => {
      // Create reaction
      const createTx = {
        _class: 'TxCreateDoc',
        objectId: 'react-1',
        objectClass: 'Reaction',
        attachedTo: 'msg-1',
        attachedToClass: 'ChatMessage',
        modifiedOn: 1050,
        attributes: {
          emoji: '👍'
        }
      }

      listener([createTx])
      await flushTasks()

      let msgs = get(viewport.messages)
      expect((msgs[0] as any).$lookup?.reactions).toEqual([
        {
          _id: 'react-1',
          _class: 'Reaction',
          emoji: '👍',
          attachedTo: 'msg-1',
          attachedToClass: 'ChatMessage',
          modifiedOn: 1050,
          createdOn: 1050
        }
      ])

      // Update reaction
      const updateTx = {
        _class: 'TxUpdateDoc',
        objectId: 'react-1',
        objectClass: 'Reaction',
        attachedTo: 'msg-1',
        attachedToClass: 'ChatMessage',
        modifiedOn: 1060,
        operations: {
          emoji: '❤️'
        }
      }

      listener([updateTx])
      await flushTasks()

      msgs = get(viewport.messages)
      expect((msgs[0] as any).$lookup?.reactions[0].emoji).toBe('❤️')

      // Remove reaction
      const removeTx = {
        _class: 'TxRemoveDoc',
        objectId: 'react-1',
        objectClass: 'Reaction',
        attachedTo: 'msg-1',
        attachedToClass: 'ChatMessage',
        modifiedOn: 1070
      }

      listener([removeTx])
      await flushTasks()

      msgs = get(viewport.messages)
      expect((msgs[0] as any).$lookup?.reactions).toEqual([])
      expect(mockClient.findOne).not.toHaveBeenCalled()
    })

    it('8.5 should add and remove attachments locally in $lookup.attachments', async () => {
      // Create attachment
      const createTx = {
        _class: 'TxCreateDoc',
        objectId: 'attach-1',
        objectClass: 'Attachment',
        attachedTo: 'msg-1',
        attachedToClass: 'ChatMessage',
        modifiedOn: 1050,
        attributes: {
          name: 'file.txt'
        }
      }

      listener([createTx])
      await flushTasks()

      let msgs = get(viewport.messages)
      expect((msgs[0] as any).$lookup?.attachments).toEqual([
        {
          _id: 'attach-1',
          _class: 'Attachment',
          name: 'file.txt',
          attachedTo: 'msg-1',
          attachedToClass: 'ChatMessage',
          modifiedOn: 1050,
          createdOn: 1050
        }
      ])

      // Remove attachment
      const removeTx = {
        _class: 'TxRemoveDoc',
        objectId: 'attach-1',
        objectClass: 'Attachment',
        attachedTo: 'msg-1',
        attachedToClass: 'ChatMessage',
        modifiedOn: 1060
      }

      listener([removeTx])
      await flushTasks()

      msgs = get(viewport.messages)
      expect((msgs[0] as any).$lookup?.attachments).toEqual([])
      expect(mockClient.findOne).not.toHaveBeenCalled()
    })

    it('8.6 should refetch from database when transaction modifiedOn is older than message modifiedOn (conflict)', async () => {
      const tx = {
        _class: 'TxUpdateDoc',
        objectId: 'msg-1',
        objectClass: 'ChatMessage',
        modifiedOn: 950, // older than mockMsg.modifiedOn (1000)
        operations: {
          message: 'Stale update'
        }
      }

      const updatedMsg = {
        ...mockMsg,
        modifiedOn: 1100,
        message: 'Fresh message from DB'
      }
      mockClient.findOne.mockResolvedValueOnce(updatedMsg)

      listener([tx])
      await flushTasks()

      expect(mockClient.findOne).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        { _id: 'msg-1' },
        expect.any(Object)
      )

      const msgs = get(viewport.messages)
      expect(msgs[0].message).toBe('Fresh message from DB')
    })

    it('8.7 should successfully find parent message by searching lookup list when attachedTo is missing/undefined in transaction', async () => {
      // 1. First add a reaction so it exists in lookup
      const createTx = {
        _class: 'TxCreateDoc',
        objectId: 'react-2',
        objectClass: 'Reaction',
        attachedTo: 'msg-1',
        attachedToClass: 'ChatMessage',
        modifiedOn: 1050,
        attributes: {
          emoji: '🎉'
        }
      }

      listener([createTx])
      await flushTasks()

      let msgs = get(viewport.messages)
      expect((msgs[0] as any).$lookup?.reactions.length).toBe(1)

      // 2. Now send a TxRemoveDoc without attachedTo field
      const removeTx = {
        _class: 'TxRemoveDoc',
        objectId: 'react-2',
        objectClass: 'Reaction',
        modifiedOn: 1060
      }

      listener([removeTx])
      await flushTasks()

      msgs = get(viewport.messages)
      expect((msgs[0] as any).$lookup?.reactions).toEqual([])
      expect(mockClient.findOne).not.toHaveBeenCalled()
    })

    it('8.8 should refetch from database when transaction modifiedOn is older than reaction modifiedOn (conflict)', async () => {
      // 1. First add a reaction with modifiedOn 1050
      const createTx = {
        _class: 'TxCreateDoc',
        objectId: 'react-3',
        objectClass: 'Reaction',
        attachedTo: 'msg-1',
        attachedToClass: 'ChatMessage',
        modifiedOn: 1050,
        attributes: {
          emoji: '🎉'
        }
      }

      listener([createTx])
      await flushTasks()

      let msgs = get(viewport.messages)
      expect((msgs[0] as any).$lookup?.reactions.length).toBe(1)
      expect((msgs[0] as any).$lookup?.reactions[0].modifiedOn).toBe(1050)

      // 2. Mock resolved message from DB when refetch occurs
      const updatedMsg = {
        ...mockMsg,
        message: 'Refetched after reaction conflict'
      }
      mockClient.findOne.mockResolvedValueOnce(updatedMsg)

      // 3. Send update transaction for reaction with modifiedOn 950 (older than 1050)
      const staleUpdateTx = {
        _class: 'TxUpdateDoc',
        objectId: 'react-3',
        objectClass: 'Reaction',
        attachedTo: 'msg-1',
        attachedToClass: 'ChatMessage',
        modifiedOn: 950,
        operations: {
          emoji: '😢'
        }
      }

      listener([staleUpdateTx])
      await flushTasks()

      expect(mockClient.findOne).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        { _id: 'msg-1' },
        expect.any(Object)
      )

      msgs = get(viewport.messages)
      expect(msgs[0].message).toBe('Refetched after reaction conflict')
    })

    it('8.9 should immediately ignore transactions for message IDs that are not loaded in the viewport', async () => {
      const tx = {
        _class: 'TxUpdateDoc',
        objectId: 'msg-not-loaded',
        objectClass: 'ChatMessage',
        modifiedOn: 1050,
        operations: {
          message: 'Hello Stale'
        }
      }

      listener([tx])
      await flushTasks()

      const msgs = get(viewport.messages)
      expect(msgs.length).toBe(1)
      expect(msgs[0].message).toBe('Hello') // unchanged
      expect(mockClient.findOne).not.toHaveBeenCalled()
    })

    it('8.10 should immediately ignore attachment/reaction transactions when parent message is not loaded in the viewport', async () => {
      const tx = {
        _class: 'TxCreateDoc',
        objectId: 'react-unloaded',
        objectClass: 'Reaction',
        attachedTo: 'msg-not-loaded',
        attachedToClass: 'ChatMessage',
        modifiedOn: 1050,
        attributes: {
          emoji: '😢'
        }
      }

      listener([tx])
      await flushTasks()

      const msgs = get(viewport.messages)
      expect((msgs[0] as any).$lookup?.reactions ?? []).toEqual([])
      expect(mockClient.findOne).not.toHaveBeenCalled()
    })

    it('8.11 should ignore non-CUD transactions or unrelated document class transactions', async () => {
      const nonCudTx = {
        _class: 'TxSomeCustomTransaction',
        objectId: 'msg-1',
        objectClass: 'ChatMessage',
        modifiedOn: 1050
      }

      const unrelatedClassTx = {
        _class: 'TxUpdateDoc',
        objectId: 'msg-1',
        objectClass: 'UnrelatedClass',
        modifiedOn: 1050,
        operations: {
          someField: 'val'
        }
      }

      listener([nonCudTx, unrelatedClassTx])
      await flushTasks()

      const msgs = get(viewport.messages)
      expect(msgs[0].message).toBe('Hello') // unchanged
      expect(mockClient.findOne).not.toHaveBeenCalled()
    })

    it('8.12 should ignore updates/removals of attachments/reactions that do not exist in lookup list', async () => {
      // Send TxUpdateDoc for a reaction that does not exist in lookup of loaded message 'msg-1'
      const updateReactionTx = {
        _class: 'TxUpdateDoc',
        objectId: 'react-nonexistent',
        objectClass: 'Reaction',
        attachedTo: 'msg-1',
        attachedToClass: 'ChatMessage',
        modifiedOn: 1050,
        operations: {
          emoji: '❤️'
        }
      }

      listener([updateReactionTx])
      await flushTasks()

      const msgs = get(viewport.messages)
      expect((msgs[0] as any).$lookup?.reactions ?? []).toEqual([])
      expect(mockClient.findOne).not.toHaveBeenCalled()
    })

    it('8.13 should refetch from database when transaction modifiedOn is older than attachment modifiedOn (conflict)', async () => {
      // 1. First add an attachment with modifiedOn 1050
      const createTx = {
        _class: 'TxCreateDoc',
        objectId: 'attach-stale-test',
        objectClass: 'Attachment',
        attachedTo: 'msg-1',
        attachedToClass: 'ChatMessage',
        modifiedOn: 1050,
        attributes: {
          name: 'file1.png'
        }
      }

      listener([createTx])
      await flushTasks()

      let msgs = get(viewport.messages)
      expect((msgs[0] as any).$lookup?.attachments.length).toBe(1)
      expect((msgs[0] as any).$lookup?.attachments[0].modifiedOn).toBe(1050)

      // 2. Mock resolved message from DB when refetch occurs
      const updatedMsg = {
        ...mockMsg,
        message: 'Refetched after attachment conflict'
      }
      mockClient.findOne.mockResolvedValueOnce(updatedMsg)

      // 3. Send update transaction for attachment with modifiedOn 950 (older than 1050)
      const staleUpdateTx = {
        _class: 'TxUpdateDoc',
        objectId: 'attach-stale-test',
        objectClass: 'Attachment',
        attachedTo: 'msg-1',
        attachedToClass: 'ChatMessage',
        modifiedOn: 950,
        operations: {
          name: 'file2.png'
        }
      }

      listener([staleUpdateTx])
      await flushTasks()

      expect(mockClient.findOne).toHaveBeenCalledWith(
        activity.class.ActivityMessage,
        { _id: 'msg-1' },
        expect.any(Object)
      )

      msgs = get(viewport.messages)
      expect(msgs[0].message).toBe('Refetched after attachment conflict')
    })
  })

  describe('Suite 9: Viewport Caching & LRU Eviction', () => {
    beforeEach(() => {
      mockClient.findAll.mockResolvedValue([])
      mockClient.findOne.mockResolvedValue(undefined)
    })

    it('9.1 should reuse cached viewport and separate chat/thread caches', () => {
      const vp1 = ChatViewport.getOrCreate(undefined, 'chat-1' as Ref<Doc>, undefined, 50, false)
      const vp2 = ChatViewport.getOrCreate(undefined, 'chat-1' as Ref<Doc>, undefined, 50, false)
      expect(vp1).toBe(vp2)

      const vpThread = ChatViewport.getOrCreate(undefined, 'chat-1' as Ref<Doc>, undefined, 50, true)
      expect(vpThread).not.toBe(vp1)
    })

    it('9.2 should evict least recently used chat viewports when limit (10) is exceeded', () => {
      const viewports: ChatViewport[] = []

      // Create 10 viewports and release them to make them evictable
      for (let i = 1; i <= 10; i++) {
        const vp = ChatViewport.getOrCreate(undefined, `chat-${i}` as Ref<Doc>, undefined, 50, false)
        vp.release()
        viewports.push(vp)
      }

      // Access chat-1 to make it recently used, then release
      const vp1 = ChatViewport.getOrCreate(undefined, 'chat-1' as Ref<Doc>, undefined, 50, false)
      vp1.release()

      // Create chat-11 to trigger eviction (evicting chat-2 because chat-1 was accessed recently), then release
      const vp11 = ChatViewport.getOrCreate(undefined, 'chat-11' as Ref<Doc>, undefined, 50, false)
      vp11.release()

      // chat-1 should still be cached, then release
      const vp1Again = ChatViewport.getOrCreate(undefined, 'chat-1' as Ref<Doc>, undefined, 50, false)
      vp1Again.release()
      expect(vp1Again).toBe(viewports[0])

      // chat-2 should have been evicted (recreated new)
      const vp2Again = ChatViewport.getOrCreate(undefined, 'chat-2' as Ref<Doc>, undefined, 50, false)
      vp2Again.release()
      expect(vp2Again).not.toBe(viewports[1])
    })

    it('9.3 should evict viewports that have not been accessed for more than TTL (15 minutes)', () => {
      let mockTime = 1000
      const originalDateNow = Date.now
      Date.now = () => mockTime

      try {
        // Create a viewport and release it to make it evictable
        const vp = ChatViewport.getOrCreate(undefined, 'chat-ttl' as Ref<Doc>, undefined, 50, false)
        vp.release()

        // Fast forward time by 10 minutes (not expired yet)
        mockTime += 10 * 60 * 1000

        // Accessing again should retrieve the same viewport, then release
        const vpSame = ChatViewport.getOrCreate(undefined, 'chat-ttl' as Ref<Doc>, undefined, 50, false)
        vpSame.release()
        expect(vpSame).toBe(vp)

        // Fast forward by 16 minutes (now expired)
        mockTime += 16 * 60 * 1000

        // Should be evicted, so getOrCreate returns a new instance
        const vpNew = ChatViewport.getOrCreate(undefined, 'chat-ttl' as Ref<Doc>, undefined, 50, false)
        vpNew.release()
        expect(vpNew).not.toBe(vp)
      } finally {
        Date.now = originalDateNow
      }
    })

    it('9.4 should not evict active (acquired) viewports even if TTL or limit is exceeded', () => {
      let mockTime = 1000
      const originalDateNow = Date.now
      Date.now = () => mockTime

      try {
        // Create a viewport (gets refCount = 1 from getOrCreate)
        const vp = ChatViewport.getOrCreate(undefined, 'chat-active' as Ref<Doc>, undefined, 50, false)

        // Fast forward by 16 minutes (TTL exceeded)
        mockTime += 16 * 60 * 1000

        // It should NOT be evicted because it is active (refCount = 1), then release the second getOrCreate call's ref count
        const vpSame = ChatViewport.getOrCreate(undefined, 'chat-active' as Ref<Doc>, undefined, 50, false)
        vpSame.release()
        expect(vpSame).toBe(vp)

        // Release it (since it was acquired once by getOrCreate)
        vp.release()

        // Fast forward by 16 minutes again
        mockTime += 16 * 60 * 1000

        // Now it should be evicted
        const vpNew = ChatViewport.getOrCreate(undefined, 'chat-active' as Ref<Doc>, undefined, 50, false)
        vpNew.release()
        expect(vpNew).not.toBe(vp)
      } finally {
        Date.now = originalDateNow
      }
    })

    it('9.5 should update unread marker for cached viewport when reopened with new readState', async () => {
      mockClient.findAll.mockResolvedValueOnce([])
      const chatId = 'chat-1' as Ref<Doc>
      const readState1 = {
        'me-uuid': { timestamp: 500 }
      }

      const vp1 = ChatViewport.getOrCreate(readState1 as any, chatId, undefined, 50, false)
      await flushTasks()

      // Set newTimestamp manually
      vp1.newTimestamp.set(600)

      // Reopen with new readState (e.g. read up to 700)
      const readState2 = {
        'me-uuid': { timestamp: 700 }
      }
      mockClient.findAll.mockResolvedValueOnce([{ _id: 'msg-unread', createdOn: 800 }])

      const vp2 = ChatViewport.getOrCreate(readState2 as any, chatId, undefined, 50, false)
      expect(vp2).toBe(vp1)
      await flushTasks()

      // It should query and update the unread marker based on new readState
      expect(get(vp1.newTimestamp)).toBe(800)
      expect(mockClient.findAll).toHaveBeenLastCalledWith(
        activity.class.ActivityMessage,
        {
          attachedTo: chatId,
          createdOn: { $gt: 700 },
          createdBy: { $nin: ['me-social-id'] }
        },
        expect.objectContaining({ limit: 1, sort: { createdOn: 1 } })
      )
    })
  })
})

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

import core, { Doc, Ref, TxCreateDoc, TxCUD, TxRemoveDoc, AccountUuid, Space } from '@hcengineering/core'
import activity, { ActivityMessage, Reaction } from '@hcengineering/activity'
import notification, { DocNotifyContext } from '@hcengineering/notification'

import { Client, Result, TxCache } from '../../types'
import Cache from '../../cache'
import { handleReaction } from '../reaction'
import { emptyResult } from '../../utils/result'
import { pushNotification } from '../notification'

jest.mock('../notification', () => ({
  pushNotification: jest.fn()
}))

jest.mock('../../config', () => ({
  __esModule: true,
  default: {
    AllowedNotificationProviders: ['all']
  },
  AllowedNotificationProviders: ['all']
}))

describe('handleReaction', () => {
  let mockClient: {
    ctx: {
      error: jest.Mock
      warn: jest.Mock
    }
    findOne: jest.Mock
    findAll: jest.Mock
    model: {
      findAllSync: jest.Mock
    }
    hierarchy: Record<string, jest.Mock>
    txFactory: {
      createTxUpdateDoc: jest.Mock
    }
  }
  let mockCache: {
    getDoc: jest.Mock
    getAccountBySocialId: jest.Mock
    getReceivers: jest.Mock
    getSettings: jest.Mock
    getContexts: jest.Mock
    getSender: jest.Mock
    getPushSubscriptions: jest.Mock
  }
  let txCache: TxCache
  let result: Result

  beforeEach(() => {
    mockClient = {
      ctx: {
        error: jest.fn(),
        warn: jest.fn()
      },
      findOne: jest.fn(),
      findAll: jest.fn(),
      model: {
        findAllSync: jest.fn()
      },
      hierarchy: {
        isDerived: jest.fn().mockReturnValue(true),
        getBaseClass: jest.fn().mockImplementation((cls) => cls),
        hasMixin: jest.fn().mockReturnValue(false),
        findAttribute: jest.fn(),
        classHierarchyMixin: jest.fn()
      },
      txFactory: {
        createTxUpdateDoc: jest
          .fn()
          .mockImplementation((cls: string, space: string, id: string, payload: Record<string, unknown>) => ({
            _class: core.class.TxUpdateDoc,
            objectId: id,
            space,
            operations: payload
          }))
      }
    }

    mockCache = {
      getDoc: jest.fn(),
      getAccountBySocialId: jest.fn(),
      getReceivers: jest.fn(),
      getSettings: jest.fn(),
      getContexts: jest.fn(),
      getSender: jest.fn(),
      getPushSubscriptions: jest.fn()
    }

    txCache = {
      titleByDoc: new Map(),
      urlByDoc: new Map(),
      labelByDoc: new Map(),
      identifierByDoc: new Map(),
      iconByDoc: new Map(),
      templates: new Map()
    }

    result = emptyResult()
    jest.clearAllMocks()
  })

  it('does nothing if transaction class is neither TxCreateDoc nor TxRemoveDoc', async () => {
    const tx = {
      _class: 'TxUpdateDoc'
    } as unknown as TxCUD<Reaction>

    await handleReaction(mockClient as unknown as Client, mockCache as unknown as Cache, txCache, result, tx)

    expect(mockClient.findOne).not.toHaveBeenCalled()
  })

  describe('handleCreateReaction', () => {
    it('logs error if attachedTo is missing', async () => {
      const tx = {
        _class: core.class.TxCreateDoc,
        attachedTo: undefined
      } as unknown as TxCreateDoc<Reaction>

      await handleReaction(mockClient as unknown as Client, mockCache as unknown as Cache, txCache, result, tx)

      expect(mockClient.ctx.error).toHaveBeenCalled()
    })

    it('logs warn and returns if message is not found', async () => {
      const tx = {
        _class: core.class.TxCreateDoc,
        attachedTo: 'msg-1',
        objectId: 'react-1'
      } as unknown as TxCreateDoc<Reaction>

      mockClient.findOne.mockResolvedValue(undefined)

      await handleReaction(mockClient as unknown as Client, mockCache as unknown as Cache, txCache, result, tx)

      expect(mockClient.ctx.warn).toHaveBeenCalled()
    })

    it('returns without notification if reaction is a self-reaction', async () => {
      const tx = {
        _class: core.class.TxCreateDoc,
        attachedTo: 'msg-1',
        objectId: 'react-1',
        modifiedBy: 'user-1'
      } as unknown as TxCreateDoc<Reaction>

      const message = {
        _id: 'msg-1',
        createdBy: 'user-1'
      } as unknown as ActivityMessage

      mockClient.findOne.mockResolvedValue(message)

      await handleReaction(mockClient as unknown as Client, mockCache as unknown as Cache, txCache, result, tx)

      expect(mockCache.getDoc).not.toHaveBeenCalled()
    })

    it('logs warn and returns if doc of the message is not found', async () => {
      const tx = {
        _class: core.class.TxCreateDoc,
        attachedTo: 'msg-1',
        objectId: 'react-1',
        modifiedBy: 'user-2'
      } as unknown as TxCreateDoc<Reaction>

      const message = {
        _id: 'msg-1',
        createdBy: 'user-1',
        attachedTo: 'doc-1',
        attachedToClass: 'DocClass'
      } as unknown as ActivityMessage

      mockClient.findOne.mockResolvedValue(message)
      mockCache.getDoc.mockResolvedValue(undefined)

      await handleReaction(mockClient as unknown as Client, mockCache as unknown as Cache, txCache, result, tx)

      expect(mockClient.ctx.warn).toHaveBeenCalled()
    })

    it('logs warn and returns if account is not found for message creator socialId', async () => {
      const tx = {
        _class: core.class.TxCreateDoc,
        attachedTo: 'msg-1',
        objectId: 'react-1',
        modifiedBy: 'user-2'
      } as unknown as TxCreateDoc<Reaction>

      const message = {
        _id: 'msg-1',
        createdBy: 'user-1',
        attachedTo: 'doc-1',
        attachedToClass: 'DocClass'
      } as unknown as ActivityMessage

      mockClient.findOne.mockResolvedValue(message)
      mockCache.getDoc.mockResolvedValue({ _id: 'doc-1' } as unknown as Doc)
      mockCache.getAccountBySocialId.mockResolvedValue(null)

      await handleReaction(mockClient as unknown as Client, mockCache as unknown as Cache, txCache, result, tx)

      expect(mockClient.ctx.warn).toHaveBeenCalled()
    })

    it('calls pushNotification if all conditions are met', async () => {
      const tx = {
        _class: core.class.TxCreateDoc,
        attachedTo: 'msg-1',
        objectId: 'react-1',
        modifiedBy: 'user-2',
        emoji: '👍',
        createdOn: 100,
        modifiedOn: 100
      } as unknown as TxCreateDoc<Reaction>

      const message = {
        _id: 'msg-1',
        createdBy: 'user-1',
        attachedTo: 'doc-1',
        attachedToClass: 'DocClass'
      } as unknown as ActivityMessage

      const doc = {
        _id: 'doc-1',
        _class: 'DocClass',
        space: 'space-1' as Ref<Space>
      } as unknown as Doc

      const receiver = {
        account: 'user-1' as AccountUuid,
        socialIds: ['social-1']
      }

      mockClient.findOne.mockResolvedValue(message)
      mockCache.getDoc.mockResolvedValue(doc)
      mockCache.getAccountBySocialId.mockResolvedValue('user-1')
      mockCache.getReceivers.mockResolvedValue([receiver])
      mockCache.getSettings.mockResolvedValue({
        providersSettings: [],
        typesSettings: [],
        settingsByProvider: new Map(),
        typesByProvider: new Map()
      })

      const type = {
        _id: activity.ids.AddReactionNotification,
        defaultEnabled: true
      }
      mockClient.model.findAllSync.mockReturnValue([type])

      mockClient.model.findAllSync.mockImplementation((cls: string) => {
        if (cls === notification.class.NotificationProvider) {
          return [{ _id: notification.providers.InboxNotificationProvider, defaultEnabled: true }]
        }
        return [type]
      })

      const context = {
        _id: 'ctx-1',
        user: 'user-1' as AccountUuid
      } as unknown as DocNotifyContext
      mockCache.getContexts.mockResolvedValue([context])

      const sender = { _id: 'user-2' }
      mockCache.getSender.mockResolvedValue(sender)

      mockCache.getPushSubscriptions.mockResolvedValue([])

      mockClient.findAll.mockResolvedValue([])

      await handleReaction(mockClient as unknown as Client, mockCache as unknown as Cache, txCache, result, tx)

      expect(pushNotification).toHaveBeenCalledWith(
        mockClient,
        txCache,
        result,
        context,
        expect.objectContaining({
          receiver,
          objectId: 'doc-1',
          objectClass: 'DocClass',
          notifyProviders: expect.any(Object)
        })
      )
    })
  })

  describe('handleRemoveReaction', () => {
    it('logs error if attachedTo is missing', async () => {
      const tx = {
        _class: core.class.TxRemoveDoc,
        attachedTo: undefined
      } as unknown as TxRemoveDoc<Reaction>

      await handleReaction(mockClient as unknown as Client, mockCache as unknown as Cache, txCache, result, tx)

      expect(mockClient.ctx.error).toHaveBeenCalled()
    })

    it('logs warn and returns if message is not found', async () => {
      const tx = {
        _class: core.class.TxRemoveDoc,
        attachedTo: 'msg-1'
      } as unknown as TxRemoveDoc<Reaction>

      mockClient.findOne.mockResolvedValue(undefined)

      await handleReaction(mockClient as unknown as Client, mockCache as unknown as Cache, txCache, result, tx)

      expect(mockClient.ctx.warn).toHaveBeenCalled()
    })

    it('logs warn and returns if account is not found for message creator', async () => {
      const tx = {
        _class: core.class.TxRemoveDoc,
        attachedTo: 'msg-1'
      } as unknown as TxRemoveDoc<Reaction>

      const message = {
        _id: 'msg-1',
        createdBy: 'user-1'
      } as unknown as ActivityMessage

      mockClient.findOne.mockResolvedValue(message)
      mockCache.getAccountBySocialId.mockResolvedValue(null)

      await handleReaction(mockClient as unknown as Client, mockCache as unknown as Cache, txCache, result, tx)

      expect(mockClient.ctx.warn).toHaveBeenCalled()
    })

    it('pulls unread reaction and decrements count from DocNotifyContext on reaction removal', async () => {
      const tx = {
        _class: core.class.TxRemoveDoc,
        attachedTo: 'msg-1',
        objectId: 'react-1'
      } as unknown as TxRemoveDoc<Reaction>

      const message = {
        _id: 'msg-1',
        createdBy: 'user-1',
        attachedTo: 'doc-1'
      } as unknown as ActivityMessage

      const context = {
        _id: 'ctx-1',
        _class: 'DocNotifyContext',
        space: 'space-1' as Ref<Space>,
        unreadReactions: [{ id: 'react-1', attachedTo: 'msg-1' }],
        latestNotifications: [{ type: 'reaction', id: 'react-1' }],
        lastNotify: 100
      } as unknown as DocNotifyContext

      mockClient.findOne.mockResolvedValue(message)
      mockCache.getAccountBySocialId.mockResolvedValue('user-1')
      mockClient.findAll.mockResolvedValue([context])

      await handleReaction(mockClient as unknown as Client, mockCache as unknown as Cache, txCache, result, tx)

      expect(result.updateContextTx).toHaveLength(1)
      expect(result.updateContextTx[0]).toEqual({
        _class: core.class.TxUpdateDoc,
        objectId: 'ctx-1',
        space: 'space-1',
        operations: {
          $pull: {
            unreadReactions: { id: 'react-1' },
            latestNotifications: { id: 'react-1' }
          },
          $inc: { unreadCount: -1 },
          lastNotify: 0
        }
      })
    })
  })
})

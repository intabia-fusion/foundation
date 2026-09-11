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

import core, {
  AccountUuid,
  Doc,
  Ref,
  Space,
  TxCreateDoc,
  TxRemoveDoc,
  TxUpdateDoc,
  PersonId
} from '@hcengineering/core'
import { ActivityMessage, DocUpdateMessage } from '@hcengineering/activity'
import notification, { DocNotifyContext, UnreadMessageId } from '@hcengineering/notification'
import { Receiver, Sender } from '@hcengineering/server-notification'
import { Employee, PersonSpace } from '@hcengineering/contact'

import { Result, TxCache } from '../../types'
import { handleMessage, addUnreadMessage } from '../message'

jest.mock('../../config', () => ({
  __esModule: true,
  default: {
    LatestNotificationsSliceSize: 5
  },
  LatestNotificationsSliceSize: 5
}))

function createEmptyResult (): Result {
  return {
    updateContextTx: [],
    createContextTx: [],
    createAppPushNotificationTx: [],
    queueMessages: [],
    createUserMentionInfoTx: [],
    updateUserMentionInfoTx: [],
    removeUserMentionInfoTx: []
  }
}

function createEmptyTxCache (): TxCache {
  return {
    titleByDoc: new Map(),
    urlByDoc: new Map(),
    labelByDoc: new Map(),
    identifierByDoc: new Map(),
    iconByDoc: new Map(),
    templates: new Map()
  }
}

const mockPushNotification = jest.fn()
jest.mock('../notification', () => ({
  pushNotification: (...args: any[]) => mockPushNotification(...args)
}))

jest.mock('@hcengineering/core', () => {
  let actual: any
  return new Proxy(
    {},
    {
      get: (target, prop) => {
        if (prop === 'generateId') {
          return (...args: any[]) => (global as any).mockGenerateId(...args)
        }
        if (prop === 'TxProcessor') {
          return {
            createDoc2Doc: (tx: any) => tx.attributes ?? tx,
            updateDoc2Doc: (doc: any, tx: any) => ({ ...doc, ...(tx.operations ?? {}) })
          }
        }
        if (prop === '__esModule') {
          return true
        }
        actual ??= jest.requireActual('@hcengineering/core')
        return actual[prop]
      }
    }
  ) as unknown as typeof import('@hcengineering/core')
})

const mockGetBaseDisplayParams = jest.fn()
const mockGetCollaboratorAccounts = jest.fn()
const mockGetObjectDisplayData = jest.fn()
const mockGetNotificationsByMessage = jest.fn()
const mockGetMessageNotifyProviders = jest.fn()
const mockGetMode = jest.fn()
const mockGetNotifiedUsers = jest.fn()
const mockHasMessageNotification = jest.fn()
const mockIsMuted = jest.fn()
const mockToNotificationMessage = jest.fn()
const mockHasReactionNotificationByMessage = jest.fn()
const mockGetLastNotify = jest.fn()
const mockHasMentionNotificationByMessage = jest.fn()
const mockHasUnreadMentionByMessage = jest.fn()
const mockGetAttachments = jest.fn()
const mockGetCreateContextTx = jest.fn()

jest.mock('../../utils/utils', () => {
  return {
    getBaseDisplayParams: (...args: any[]) => mockGetBaseDisplayParams(...args),
    getCollaboratorAccounts: (...args: any[]) => mockGetCollaboratorAccounts(...args),
    getObjectDisplayData: (...args: any[]) => mockGetObjectDisplayData(...args),
    getNotificationsByMessage: (...args: any[]) => mockGetNotificationsByMessage(...args),
    getMessageNotifyProviders: (...args: any[]) => mockGetMessageNotifyProviders(...args),
    getMode: (...args: any[]) => mockGetMode(...args),
    getNotifiedUsers: (...args: any[]) => mockGetNotifiedUsers(...args),
    hasMessageNotification: (...args: any[]) => mockHasMessageNotification(...args),
    isMuted: (...args: any[]) => mockIsMuted(...args),
    toNotificationMessage: (...args: any[]) => mockToNotificationMessage(...args),
    hasReactionNotificationByMessage: (...args: any[]) => mockHasReactionNotificationByMessage(...args),
    getLastNotify: (...args: any[]) => mockGetLastNotify(...args),
    hasMentionNotificationByMessage: (...args: any[]) => mockHasMentionNotificationByMessage(...args),
    hasUnreadMentionByMessage: (...args: any[]) => mockHasUnreadMentionByMessage(...args),
    getAttachments: (...args: any[]) => mockGetAttachments(...args),
    getCreateContextTx: (...args: any[]) => mockGetCreateContextTx(...args)
  }
})

describe('message module', () => {
  let mockClient: any
  let mockCache: any
  let txCache: TxCache
  let result: Result

  beforeAll(() => {
    ;(global as any).mockGenerateId = jest.fn()
  })

  beforeEach(() => {
    mockClient = {
      ctx: {
        error: jest.fn(),
        warn: jest.fn()
      },
      txFactory: {
        createTxUpdateDoc: jest.fn().mockImplementation((cls, space, id, payload) => ({
          _class: core.class.TxUpdateDoc,
          objectId: id,
          space,
          operations: payload
        })),
        createTxCreateDoc: jest.fn().mockImplementation((cls, space, payload) => ({
          _class: core.class.TxCreateDoc,
          space,
          attributes: payload
        }))
      },
      hierarchy: {
        isDerived: jest.fn().mockReturnValue(false),
        getClass: jest.fn().mockReturnValue({ label: 'DocLabel' })
      },
      findOne: jest.fn()
    }

    mockCache = {
      getDoc: jest.fn(),
      getDocSpace: jest.fn(),
      getReceivers: jest.fn(),
      getSettings: jest.fn(),
      getContexts: jest.fn(),
      getDocSettings: jest.fn(),
      getSender: jest.fn(),
      getPushSubscriptions: jest.fn(),
      getDocReadState: jest.fn()
    }

    txCache = createEmptyTxCache()
    result = createEmptyResult()
    ;(global as any).mockGenerateId.mockReset()
    mockPushNotification.mockReset()
    mockGetBaseDisplayParams.mockReset()
    mockGetCollaboratorAccounts.mockReset()
    mockGetObjectDisplayData.mockReset()
    mockGetNotificationsByMessage.mockReset()
    mockGetMessageNotifyProviders.mockReset()
    mockGetMode.mockReset()
    mockGetNotifiedUsers.mockReset()
    mockHasMessageNotification.mockReset()
    mockIsMuted.mockReset()
    mockToNotificationMessage.mockReset()
    mockHasReactionNotificationByMessage.mockReset()
    mockGetLastNotify.mockReset()
    mockHasMentionNotificationByMessage.mockReset()
    mockHasUnreadMentionByMessage.mockReset()
    mockGetAttachments.mockReset()
    mockGetCreateContextTx.mockReset()
    mockCache.getDocReadState.mockReset()

    // Default mock setups
    mockCache.getDocReadState.mockResolvedValue(undefined)
    ;(global as any).mockGenerateId.mockReturnValue('gen-id')
    mockGetBaseDisplayParams.mockResolvedValue({ intlParams: { doc: 'doc' }, intlParamsNotLocalized: {} })
    mockGetCollaboratorAccounts.mockResolvedValue([])
    mockGetObjectDisplayData.mockResolvedValue({ objectTitle: 'Object Title' })
    mockGetNotificationsByMessage.mockReturnValue([])
    mockGetMessageNotifyProviders.mockResolvedValue({})
    mockGetMode.mockReturnValue('all')
    mockGetNotifiedUsers.mockReturnValue([])
    mockHasMessageNotification.mockReturnValue(false)
    mockIsMuted.mockReturnValue(false)
    mockToNotificationMessage.mockReturnValue({ text: 'NotifMsg' })
    mockHasReactionNotificationByMessage.mockReturnValue(false)
    mockGetLastNotify.mockReturnValue(100)
    mockHasMentionNotificationByMessage.mockReturnValue(false)
    mockHasUnreadMentionByMessage.mockReturnValue(false)
    mockGetAttachments.mockResolvedValue([])
    mockGetCreateContextTx.mockImplementation((id, objId, objCls, objSpace, receiver, res, factory, display) => {
      const tx = factory.createTxCreateDoc('DocNotifyContext', receiver.space, {
        unreadMessages: []
      })
      res.createContextTx.push(tx)
      return tx
    })
  })

  describe('handleMessage routing', () => {
    it('routes TxCreateDoc to handleCreateMessage', async () => {
      const tx = {
        _class: core.class.TxCreateDoc,
        objectId: 'msg-1',
        objectClass: 'MsgClass',
        attributes: {
          attachedTo: 'doc-1',
          attachedToClass: 'DocClass',
          modifiedBy: 'user-2'
        }
      } as unknown as TxCreateDoc<ActivityMessage>

      mockCache.getDoc.mockResolvedValue(undefined) // early exit

      await handleMessage(mockClient, mockCache, txCache, result, tx)

      expect(mockCache.getDoc).toHaveBeenCalledWith('doc-1', 'DocClass')
    })

    it('routes TxRemoveDoc to handleRemoveMessage', async () => {
      const tx = {
        _class: core.class.TxRemoveDoc,
        objectId: 'msg-1',
        attachedTo: 'doc-1',
        removedDoc: {}
      } as unknown as TxRemoveDoc<ActivityMessage>

      mockCache.getContexts.mockResolvedValue([])

      await handleMessage(mockClient, mockCache, txCache, result, tx)

      expect(mockCache.getContexts).toHaveBeenCalledWith('doc-1')
    })

    it('routes TxUpdateDoc to handleUpdateMessage', async () => {
      const tx = {
        _class: core.class.TxUpdateDoc,
        objectId: 'msg-1',
        objectClass: 'MsgClass',
        operations: {
          message: null,
          attachments: null
        }
      } as unknown as TxUpdateDoc<ActivityMessage>

      await handleMessage(mockClient, mockCache, txCache, result, tx)

      // Since operations are empty, should return early
      expect(mockCache.getDoc).not.toHaveBeenCalled()
    })
  })

  describe('handleCreateMessage', () => {
    let mockTx: TxCreateDoc<ActivityMessage>
    let mockDoc: Doc
    let mockSpace: Space

    beforeEach(() => {
      mockTx = {
        _class: core.class.TxCreateDoc,
        objectId: 'msg-1',
        objectClass: 'MsgClass',
        attributes: {
          _id: 'msg-1',
          attachedTo: 'doc-1',
          attachedToClass: 'DocClass',
          modifiedBy: 'user-2',
          createdOn: 100
        }
      } as unknown as TxCreateDoc<ActivityMessage>

      mockDoc = {
        _id: 'doc-1',
        _class: 'DocClass',
        space: 'space-1' as Ref<Space>
      } as unknown as Doc

      mockSpace = {
        _id: 'space-1'
      } as unknown as Space
    })

    it('exits early if doc is not found in cache', async () => {
      mockCache.getDoc.mockResolvedValue(undefined)

      await handleMessage(mockClient, mockCache, txCache, result, mockTx)

      expect(mockCache.getDocSpace).not.toHaveBeenCalled()
    })

    it('exits early if space is not found in cache', async () => {
      mockCache.getDoc.mockResolvedValue(mockDoc)
      mockCache.getDocSpace.mockResolvedValue(undefined)

      await handleMessage(mockClient, mockCache, txCache, result, mockTx)

      expect(mockGetCollaboratorAccounts).not.toHaveBeenCalled()
    })

    it('exits early if collaborators list is empty', async () => {
      mockCache.getDoc.mockResolvedValue(mockDoc)
      mockCache.getDocSpace.mockResolvedValue(mockSpace)
      mockGetCollaboratorAccounts.mockResolvedValue([])

      await handleMessage(mockClient, mockCache, txCache, result, mockTx)

      expect(mockCache.getReceivers).not.toHaveBeenCalled()
    })

    it('exits early if receivers list is empty', async () => {
      mockCache.getDoc.mockResolvedValue(mockDoc)
      mockCache.getDocSpace.mockResolvedValue(mockSpace)
      mockGetCollaboratorAccounts.mockResolvedValue(['user-1'])
      mockCache.getReceivers.mockResolvedValue([])

      await handleMessage(mockClient, mockCache, txCache, result, mockTx)

      expect(mockCache.getSettings).not.toHaveBeenCalled()
    })

    it('adds collaborator from DocUpdateMessage if class is Collaborator', async () => {
      mockClient.hierarchy.isDerived.mockReturnValue(true) // Message is derived from DocUpdateMessage
      ;(mockTx.attributes as any).objectClass = core.class.Collaborator
      ;(mockTx.attributes as any).objectAttributes = { collaborator: 'new-user' }

      mockCache.getDoc.mockResolvedValue(mockDoc)
      mockCache.getDocSpace.mockResolvedValue(mockSpace)
      mockGetCollaboratorAccounts.mockResolvedValue(['user-1'])
      mockCache.getReceivers.mockResolvedValue([])

      await handleMessage(mockClient, mockCache, txCache, result, mockTx)

      expect(mockCache.getReceivers).toHaveBeenCalledWith(['user-1', 'new-user'])
    })

    describe('with receiver processing', () => {
      let receiver: Receiver
      let sender: Sender

      beforeEach(() => {
        receiver = {
          account: 'user-1' as AccountUuid,
          language: 'en',
          space: 'user-space' as Ref<PersonSpace>,
          online: true,
          socialIds: ['social1', 'social2'] as PersonId[],
          employeeRef: 'employee-ref' as Ref<Employee>
        }

        sender = {
          account: 'user-2' as AccountUuid,
          socialId: 'social3' as PersonId
        }

        mockCache.getDoc.mockResolvedValue(mockDoc)
        mockCache.getDocSpace.mockResolvedValue(mockSpace)
        mockGetCollaboratorAccounts.mockResolvedValue(['user-1'])
        mockCache.getReceivers.mockResolvedValue([receiver])
        mockCache.getSender.mockResolvedValue(sender)
        mockCache.getSettings.mockResolvedValue({})
        mockCache.getContexts.mockResolvedValue([])
        mockCache.getDocSettings.mockResolvedValue([])
      })

      it('skips processing if receiver account is same as sender', async () => {
        receiver.account = sender.account as AccountUuid

        await handleMessage(mockClient, mockCache, txCache, result, mockTx)

        expect(mockPushNotification).not.toHaveBeenCalled()
        expect(mockGetCreateContextTx).not.toHaveBeenCalled()
      })

      it('calls pushNotification if inbox notification type exists for provider', async () => {
        mockGetMessageNotifyProviders.mockResolvedValue({
          [notification.providers.InboxNotificationProvider]: [{ _id: 'inbox-type-1' }]
        })

        mockCache.getPushSubscriptions.mockResolvedValue([])

        await handleMessage(mockClient, mockCache, txCache, result, mockTx)

        expect(mockPushNotification).toHaveBeenCalledWith(
          mockClient,
          txCache,
          result,
          undefined, // context
          expect.objectContaining({
            unreadMessage: { id: 'msg-1', createdOn: 100, notified: true },
            receiver,
            objectId: 'doc-1',
            objectClass: 'DocClass',
            notifyProviders: expect.any(Object)
          })
        )
      })

      it('adds unread message if provider type does not exist', async () => {
        mockGetMessageNotifyProviders.mockResolvedValue({})

        await handleMessage(mockClient, mockCache, txCache, result, mockTx)

        expect(mockPushNotification).not.toHaveBeenCalled()
        expect(mockGetCreateContextTx).toHaveBeenCalled()
      })

      it('skips processing if receiver has already read up to or past message timestamp', async () => {
        mockCache.getDocReadState.mockResolvedValue({
          [receiver.account]: { timestamp: 150 }
        })

        await handleMessage(mockClient, mockCache, txCache, result, mockTx)

        expect(mockPushNotification).not.toHaveBeenCalled()
        expect(mockGetCreateContextTx).not.toHaveBeenCalled()
      })

      it('calls pushNotification even if receiver has already read up to or past message timestamp when provider exists', async () => {
        mockGetMessageNotifyProviders.mockResolvedValue({
          [notification.providers.InboxNotificationProvider]: [{ _id: 'inbox-type-1' }]
        })
        mockCache.getDocReadState.mockResolvedValue({
          [receiver.account]: { timestamp: 150 }
        })
        mockCache.getPushSubscriptions.mockResolvedValue([])

        await handleMessage(mockClient, mockCache, txCache, result, mockTx)

        expect(mockPushNotification).toHaveBeenCalledWith(
          mockClient,
          txCache,
          result,
          undefined,
          expect.objectContaining({
            unreadMessage: undefined,
            receiver,
            objectId: 'doc-1',
            objectClass: 'DocClass',
            notifyProviders: expect.any(Object)
          })
        )
      })
    })
  })

  describe('handleRemoveMessage', () => {
    it('logs error and returns if attachedTo is null', async () => {
      const tx = {
        _class: core.class.TxRemoveDoc,
        objectId: 'msg-1',
        attachedTo: undefined
      } as unknown as TxRemoveDoc<ActivityMessage>

      await handleMessage(mockClient, mockCache, txCache, result, tx)

      expect(mockClient.ctx.error).toHaveBeenCalledWith('Cannot remove message notification for null attachedTo', tx)
      expect(mockCache.getContexts).not.toHaveBeenCalled()
    })

    it('performs cleanup on active contexts', async () => {
      const tx = {
        _class: core.class.TxRemoveDoc,
        objectId: 'msg-1',
        attachedTo: 'doc-1',
        removedDoc: {}
      } as unknown as TxRemoveDoc<ActivityMessage>

      const context = {
        _id: 'ctx-1',
        _class: 'DocNotifyContext',
        space: 'space-1',
        unreadMessages: [{ id: 'msg-1', createdOn: 100, notified: true }],
        unreadReactions: [{ attachedTo: 'msg-1' }],
        unreadMentions: [{ messageId: 'msg-1' }],
        lastNotify: 50
      } as unknown as DocNotifyContext

      mockCache.getContexts.mockResolvedValue([context])
      mockGetNotificationsByMessage.mockReturnValue([{ id: 'msg-1' }])
      mockHasUnreadMentionByMessage.mockReturnValue(true)
      mockGetLastNotify.mockReturnValue(40) // lastNotify changed

      await handleMessage(mockClient, mockCache, txCache, result, tx)

      expect(result.updateContextTx).toHaveLength(1)
      expect(result.updateContextTx[0].operations).toEqual({
        $pull: {
          latestNotifications: { id: { $in: ['msg-1'] } },
          unreadMessages: { id: 'msg-1' },
          unreadReactions: { attachedTo: 'msg-1' }
        },
        $inc: {
          unreadCount: -2 // -1 for unreadMessage notified, -1 for reaction
        },
        lastNotify: 40
      })
    })

    it('decrements unread count and count of chunk if deleted message is inside a chunk', async () => {
      const tx = {
        _class: core.class.TxRemoveDoc,
        objectId: 'msg-5',
        attachedTo: 'doc-1',
        removedDoc: {
          createdOn: 1005
        }
      } as unknown as TxRemoveDoc<ActivityMessage>

      const context = {
        _id: 'ctx-1',
        _class: 'DocNotifyContext',
        space: 'space-1',
        unreadMessages: [{ from: 1000, to: 1009, count: 10, notifiedCount: 10 }],
        unreadCount: 10
      } as unknown as DocNotifyContext

      mockCache.getContexts.mockResolvedValue([context])
      mockGetNotificationsByMessage.mockReturnValue([])

      await handleMessage(mockClient, mockCache, txCache, result, tx)

      expect(result.updateContextTx).toHaveLength(1)
      expect(result.updateContextTx[0].operations.unreadMessages).toEqual([
        { from: 1000, to: 1009, count: 9, notifiedCount: 9 }
      ])
      expect(result.updateContextTx[0].operations.$inc).toEqual({
        unreadCount: -1
      })
    })

    it('removes chunk entirely if deleted message was the last one in a chunk of count 1', async () => {
      const tx = {
        _class: core.class.TxRemoveDoc,
        objectId: 'msg-5',
        attachedTo: 'doc-1',
        removedDoc: {
          createdOn: 1005
        }
      } as unknown as TxRemoveDoc<ActivityMessage>

      const context = {
        _id: 'ctx-1',
        _class: 'DocNotifyContext',
        space: 'space-1',
        unreadMessages: [{ from: 1005, to: 1005, count: 1, notifiedCount: 1 }],
        unreadCount: 1
      } as unknown as DocNotifyContext

      mockCache.getContexts.mockResolvedValue([context])
      mockGetNotificationsByMessage.mockReturnValue([])

      await handleMessage(mockClient, mockCache, txCache, result, tx)

      expect(result.updateContextTx).toHaveLength(1)
      expect(result.updateContextTx[0].operations.unreadMessages).toEqual([])
      expect(result.updateContextTx[0].operations.$inc).toEqual({
        unreadCount: -1
      })
    })

    it('restores next latest notifications if needed', async () => {
      const tx = {
        _class: core.class.TxRemoveDoc,
        objectId: 'msg-1',
        attachedTo: 'doc-1',
        removedDoc: {}
      } as unknown as TxRemoveDoc<ActivityMessage>

      const context = {
        _id: 'ctx-1',
        _class: 'DocNotifyContext',
        space: 'space-1',
        latestNotifications: [
          { id: 'msg-1', createdOn: 100, type: 'message' },
          { id: 'msg-2', createdOn: 150, type: 'message' },
          { id: 'msg-3', createdOn: 160, type: 'message' },
          { id: 'msg-4', createdOn: 170, type: 'message' }
        ],
        unreadMessages: [
          { id: 'msg-1', createdOn: 100, notified: true },
          { id: 'msg-2', createdOn: 150, notified: true },
          { id: 'msg-5', createdOn: 200, notified: true },
          { id: 'msg-6', createdOn: 300, notified: true }
        ],
        unreadReactions: [],
        unreadMentions: []
      } as unknown as DocNotifyContext

      mockCache.getContexts.mockResolvedValue([context])
      mockGetNotificationsByMessage.mockReturnValue([{ id: 'msg-1', type: 'message' }])

      const msg5Doc = {
        _id: 'msg-5',
        createdBy: 'user-1',
        createdOn: 200,
        message: 'Hello 5'
      }
      const msg6Doc = {
        _id: 'msg-6',
        createdBy: 'user-2',
        createdOn: 300,
        message: 'Hello 6'
      }

      mockClient.findOne.mockImplementation(async (clazz: any, query: any) => {
        if (query._id === 'msg-5') return msg5Doc
        if (query._id === 'msg-6') return msg6Doc
        return null
      })

      await handleMessage(mockClient, mockCache, txCache, result, tx)

      expect(result.updateContextTx).toHaveLength(1)
      expect(result.updateContextTx[0].operations.latestNotifications).toBeDefined()
      expect(result.updateContextTx[0].operations.latestNotifications).toHaveLength(5)
      expect(result.updateContextTx[0].operations.latestNotifications?.map((it: any) => it.id)).toEqual([
        'msg-6',
        'msg-5',
        'msg-4',
        'msg-3',
        'msg-2'
      ])
    })
  })

  describe('handleUpdateMessage', () => {
    let mockTx: TxUpdateDoc<ActivityMessage>

    beforeEach(() => {
      mockTx = {
        _class: core.class.TxUpdateDoc,
        objectId: 'msg-1',
        objectClass: 'MsgClass',
        operations: {
          message: 'New Text'
        }
      } as unknown as TxUpdateDoc<ActivityMessage>
    })

    it('returns early if not DocUpdateMessage and neither message nor attachments are updated', async () => {
      mockTx.operations = {
        message: null,
        attachments: null
      } as any

      await handleMessage(mockClient, mockCache, txCache, result, mockTx)

      expect(mockCache.getDoc).not.toHaveBeenCalled()
    })

    it('updates existing notification content inside active contexts', async () => {
      const messageDoc = {
        _id: 'msg-1',
        _class: 'MsgClass',
        attachedTo: 'doc-1',
        attachedToClass: 'DocClass',
        message: 'New Text'
      } as unknown as ActivityMessage

      const context = {
        _id: 'ctx-1',
        _class: 'DocNotifyContext',
        space: 'space-1'
      } as unknown as DocNotifyContext

      mockCache.getDoc.mockResolvedValueOnce(messageDoc).mockResolvedValueOnce({ _id: 'doc-1' })
      mockCache.getContexts.mockResolvedValue([context])
      mockHasMessageNotification.mockReturnValue(true)

      await handleMessage(mockClient, mockCache, txCache, result, mockTx)

      expect(result.updateContextTx).toHaveLength(2)
      expect(result.updateContextTx[0].operations).toEqual({
        $update: {
          latestNotifications: {
            $query: { messageId: 'msg-1' },
            $update: {
              message: { text: 'NotifMsg' },
              attachments: []
            }
          }
        }
      })
      expect(result.updateContextTx[1].operations).toEqual({
        object: { text: 'NotifMsg' }
      })
    })

    it('updates mention notifications if type is mention', async () => {
      const messageDoc = {
        _id: 'msg-1',
        _class: 'MsgClass',
        attachedTo: 'doc-1',
        attachedToClass: 'DocClass',
        message: 'New Mention Text'
      } as unknown as ActivityMessage

      const context = {
        _id: 'ctx-1',
        _class: 'DocNotifyContext',
        space: 'space-1'
      } as unknown as DocNotifyContext

      mockCache.getDoc.mockResolvedValueOnce(messageDoc).mockResolvedValueOnce({ _id: 'doc-1' })
      mockCache.getContexts.mockResolvedValue([context])
      mockHasMentionNotificationByMessage.mockReturnValue(true)

      await handleMessage(mockClient, mockCache, txCache, result, mockTx)

      expect(result.updateContextTx).toHaveLength(2)
      expect(result.updateContextTx[0].operations).toEqual({
        $update: {
          latestNotifications: {
            $query: { type: 'mention', messageId: 'msg-1' },
            $update: {
              markup: 'New Text',
              attachments: []
            }
          }
        }
      })
      expect(result.updateContextTx[1].operations).toEqual({
        object: { text: 'NotifMsg' }
      })
    })
  })

  describe('handleUpdateDUM', () => {
    let mockTx: TxUpdateDoc<DocUpdateMessage>
    let receiver: Receiver
    let sender: Sender
    let mockDoc: Doc
    let mockSpace: Space

    beforeEach(() => {
      mockClient.hierarchy.isDerived.mockReturnValue(true) // is DUM

      mockTx = {
        _class: core.class.TxUpdateDoc,
        objectId: 'msg-1',
        objectClass: 'DocUpdateMessageClass',
        operations: {
          history: ['item1']
        },
        modifiedBy: 'user-2'
      } as unknown as TxUpdateDoc<DocUpdateMessage>

      receiver = {
        account: 'user-1' as AccountUuid,
        language: 'en',
        space: 'user-space' as Ref<PersonSpace>,
        online: true,
        socialIds: ['social1', 'social2'] as PersonId[],
        employeeRef: 'employee-ref' as Ref<Employee>
      }

      sender = {
        account: 'user-2' as AccountUuid,
        socialId: 'social3' as PersonId
      }

      mockDoc = {
        _id: 'doc-1',
        _class: 'DocClass',
        space: 'space-1' as Ref<Space>
      } as unknown as Doc

      mockSpace = { _id: 'space-1' } as unknown as Space
    })

    it('returns early if history not changed or if operation is just history pushing', async () => {
      mockTx.operations = { other: '123' } as any // history not changed
      await handleMessage(mockClient, mockCache, txCache, result, mockTx)
      expect(mockCache.getDoc).toHaveBeenCalled()

      mockCache.getDoc.mockClear()
      mockTx.operations = { $push: { history: 'item' } } as any // combine operations (just pushing)
      await handleMessage(mockClient, mockCache, txCache, result, mockTx)
      expect(mockCache.getDoc).toHaveBeenCalled()
    })

    it('pulls DUM from context and handles pushNotification for receiver', async () => {
      const messageDoc = {
        _id: 'msg-1',
        attachedTo: 'doc-1',
        attachedToClass: 'DocClass',
        createdOn: 100
      } as unknown as DocUpdateMessage

      const context = {
        _id: 'ctx-1',
        _class: 'DocNotifyContext',
        space: 'space-1',
        user: 'user-1',
        unreadMessages: [{ id: 'msg-1', createdOn: 100, notified: true }]
      } as unknown as DocNotifyContext

      mockCache.getDoc.mockResolvedValueOnce(messageDoc).mockResolvedValueOnce(mockDoc)
      mockCache.getDocSpace.mockResolvedValue(mockSpace)
      mockGetCollaboratorAccounts.mockResolvedValue(['user-1'])
      mockCache.getReceivers.mockResolvedValue([receiver])
      mockCache.getSender.mockResolvedValue(sender)
      mockCache.getSettings.mockResolvedValue({})
      mockCache.getDocSettings.mockResolvedValue([])
      mockCache.getContexts.mockResolvedValue([context])
      mockHasMessageNotification.mockReturnValue(true)

      mockGetMessageNotifyProviders.mockResolvedValue({
        [notification.providers.InboxNotificationProvider]: [{ _id: 'inbox-type-1' }]
      })

      await handleMessage(mockClient, mockCache, txCache, result, mockTx)

      // Should pull DUM from context
      expect(result.updateContextTx).toHaveLength(1)
      expect(result.updateContextTx[0].operations).toEqual({
        $pull: {
          latestNotifications: { id: 'msg-1' },
          unreadMessages: { id: 'msg-1' }
        },
        $inc: { unreadCount: -1 }
      })

      // Should push new notification
      expect(mockPushNotification).toHaveBeenCalled()
    })
  })

  describe('addUnreadMessage', () => {
    it('appends unreadMessage to context operations if context is present', async () => {
      const context = {
        _id: 'ctx-1',
        _class: 'DocNotifyContextClass',
        space: 'space-1'
      } as unknown as DocNotifyContext

      const doc = { _id: 'doc-1' }
      const receiver = { account: 'user-1' }
      const unreadMessage: UnreadMessageId = { id: 'msg-1' as Ref<ActivityMessage>, createdOn: 1, notified: false }

      await addUnreadMessage(
        mockClient,
        receiver as Receiver,
        doc as Doc,
        unreadMessage,
        context,
        result,
        txCache,
        mockCache
      )

      expect(result.updateContextTx[0].operations.$push).toEqual({
        unreadMessages: unreadMessage
      })
    })

    it('creates context if context is undefined', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass', space: 'space-1' }
      const receiver = { account: 'user-1', space: 'user-space' }
      const unreadMessage: UnreadMessageId = { id: 'msg-1' as Ref<ActivityMessage>, createdOn: 1, notified: false }

      await addUnreadMessage(
        mockClient,
        receiver as Receiver,
        doc as Doc,
        unreadMessage,
        undefined,
        result,
        txCache,
        mockCache
      )

      expect(mockGetObjectDisplayData).toHaveBeenCalledWith(mockClient, mockCache, txCache, doc, 'user-1')
      expect(mockGetCreateContextTx).toHaveBeenCalled()
      expect(result.createContextTx[0].attributes.unreadMessages).toEqual([unreadMessage])
    })

    it('collapses unreadMessages when adding causes the count to exceed 100', async () => {
      const unreadMessages: UnreadMessageId[] = Array.from({ length: 100 }, (_, i) => ({
        id: `msg-${i}` as Ref<ActivityMessage>,
        createdOn: 1000 + i,
        notified: true
      }))
      const context = {
        _id: 'ctx-1',
        _class: 'DocNotifyContextClass',
        space: 'space-1',
        unreadMessages
      } as unknown as DocNotifyContext

      const doc = { _id: 'doc-1' }
      const receiver = { account: 'user-1' }
      const newMsg: UnreadMessageId = { id: 'msg-100' as Ref<ActivityMessage>, createdOn: 1100, notified: true }

      await addUnreadMessage(mockClient, receiver as Receiver, doc as Doc, newMsg, context, result, txCache, mockCache)

      expect(result.updateContextTx[0].operations.unreadMessages).toBeDefined()
      expect(result.updateContextTx[0].operations.$push).toBeUndefined()
      expect(result.updateContextTx[0].operations.unreadMessages).toHaveLength(29)
    })
  })
})

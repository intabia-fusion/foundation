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

import core, { AccountUuid, AnyAttribute, Doc, Ref, TxCUD } from '@hcengineering/core'
import activity, { UserMentionInfo } from '@hcengineering/activity'
import notification, { DocNotifyContext } from '@hcengineering/notification'
import { Receiver } from '@hcengineering/server-notification'
import contact, { Person } from '@hcengineering/contact'

import { Result, TxCache } from '../../types'
import { handleMention } from '../mention'

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

const mockAreEqualJson = jest.fn()
const mockExtractReferences = jest.fn()
const mockJsonToMarkup = jest.fn()
const mockMarkupToJSON = jest.fn()
const mockMarkupToText = jest.fn()

jest.mock('@hcengineering/text-core', () => ({
  areEqualJson: (...args: any[]) => mockAreEqualJson(...args),
  extractReferences: (...args: any[]) => mockExtractReferences(...args),
  jsonToMarkup: (...args: any[]) => mockJsonToMarkup(...args),
  markupToJSON: (...args: any[]) => mockMarkupToJSON(...args),
  markupToText: (...args: any[]) => mockMarkupToText(...args)
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
const mockGetObjectDisplayData = jest.fn()
const mockGetMode = jest.fn()
const mockGetTxNotifyProviders = jest.fn()
const mockIsMuted = jest.fn()
const mockGetMentionNotification = jest.fn()
const mockHasMessageNotification = jest.fn()
const mockGetAttachments = jest.fn()

jest.mock('../../utils/utils', () => ({
  getBaseDisplayParams: (...args: any[]) => mockGetBaseDisplayParams(...args),
  getObjectDisplayData: (...args: any[]) => mockGetObjectDisplayData(...args),
  getMode: (...args: any[]) => mockGetMode(...args),
  getTxNotifyProviders: (...args: any[]) => mockGetTxNotifyProviders(...args),
  isMuted: (...args: any[]) => mockIsMuted(...args),
  getMentionNotification: (...args: any[]) => mockGetMentionNotification(...args),
  hasMessageNotification: (...args: any[]) => mockHasMessageNotification(...args),
  getAttachments: (...args: any[]) => mockGetAttachments(...args)
}))

describe('mention module', () => {
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
          objectClass: cls,
          space,
          operations: payload
        })),
        createTxCreateDoc: jest.fn().mockImplementation((cls, space, payload) => ({
          _class: core.class.TxCreateDoc,
          objectClass: cls,
          space,
          attributes: payload
        })),
        createTxRemoveDoc: jest.fn().mockImplementation((cls, space, id) => ({
          _class: core.class.TxRemoveDoc,
          objectId: id,
          objectClass: cls,
          space
        }))
      },
      hierarchy: {
        isDerived: jest.fn().mockReturnValue(false),
        getClass: jest.fn().mockReturnValue({ label: 'DocLabel' }),
        getAllAttributes: jest.fn().mockReturnValue(new Map())
      },
      storage: {
        read: jest.fn()
      },
      workspace: {
        uuid: 'ws-uuid',
        url: 'ws-url'
      },
      findOne: jest.fn(),
      findAll: jest.fn()
    }

    mockCache = {
      getSender: jest.fn(),
      getContexts: jest.fn(),
      getSettings: jest.fn(),
      getDocSpace: jest.fn(),
      getDocSettings: jest.fn(),
      getReceivers: jest.fn(),
      getCollaborators: jest.fn(),
      getUserStatuses: jest.fn(),
      getPushSubscriptions: jest.fn()
    }

    txCache = createEmptyTxCache()
    result = createEmptyResult()
    ;(global as any).mockGenerateId.mockReset()
    mockPushNotification.mockReset()
    mockAreEqualJson.mockReset()
    mockExtractReferences.mockReset()
    mockJsonToMarkup.mockReset()
    mockMarkupToJSON.mockReset()
    mockMarkupToText.mockReset()
    mockGetBaseDisplayParams.mockReset()
    mockGetObjectDisplayData.mockReset()
    mockGetMode.mockReset()
    mockGetTxNotifyProviders.mockReset()
    mockIsMuted.mockReset()
    mockGetMentionNotification.mockReset()
    mockHasMessageNotification.mockReset()
    mockGetAttachments.mockReset()

    // Default mock setups
    ;(global as any).mockGenerateId.mockReturnValue('gen-id')
    mockGetBaseDisplayParams.mockResolvedValue({ intlParams: { doc: 'doc' }, intlParamsNotLocalized: {} })
    mockGetObjectDisplayData.mockResolvedValue({ objectTitle: 'Object Title' })
    mockGetMode.mockReturnValue('all')
    mockGetTxNotifyProviders.mockResolvedValue({})
    mockIsMuted.mockReturnValue(false)
    mockGetMentionNotification.mockReturnValue(null)
    mockHasMessageNotification.mockReturnValue(false)
    mockGetAttachments.mockResolvedValue([])
    mockAreEqualJson.mockReturnValue(false)
    mockMarkupToText.mockReturnValue('mocked-text')
  })

  describe('handleMention basic routing and generation', () => {
    it('executes handleMention and handles no mentions path', async () => {
      const tx = {
        _class: core.class.TxCreateDoc,
        objectId: 'msg-1',
        objectClass: 'MsgClass',
        attributes: {
          attachedTo: 'doc-1',
          attachedToClass: 'DocClass',
          modifiedBy: 'user-2'
        }
      } as unknown as TxCUD<Doc>

      const doc = { _id: 'doc-1', _class: 'DocClass', space: 'space-1' } as any as Doc
      const txObject = { _id: 'msg-1', _class: 'MsgClass' } as any as Doc

      mockCache.getSender.mockResolvedValue({ account: 'user-2' as AccountUuid })
      mockCache.getContexts.mockResolvedValue([])
      mockCache.getSettings.mockResolvedValue({})

      await handleMention(mockClient, mockCache, txCache, result, tx, doc, txObject, 'test-type' as any)

      expect(mockCache.getSender).toHaveBeenCalledWith(tx.modifiedBy)
      expect(mockPushNotification).not.toHaveBeenCalled()
    })

    it('processes and creates mention notification when a reference is parsed', async () => {
      const tx = {
        _class: core.class.TxCreateDoc,
        objectId: 'msg-1',
        objectClass: 'MsgClass',
        createdOn: 100,
        modifiedBy: 'user-2',
        attributes: {
          message: '<content>'
        }
      } as unknown as TxCUD<Doc>

      const doc: Doc = { _id: 'doc-1', _class: 'DocClass', space: 'space-1' } as any as Doc
      const txObject: Doc = { _id: 'msg-1', _class: 'MsgClass' } as any as Doc

      const mockAttr = {
        name: 'message',
        type: {
          _class: core.class.TypeMarkup
        }
      } as unknown as AnyAttribute
      const attrs = new Map()
      attrs.set('message', mockAttr)
      mockClient.hierarchy.getAllAttributes.mockReturnValue(attrs)
      mockClient.hierarchy.isDerived.mockImplementation((cls: string, target: string) => {
        if (target === contact.class.Person) return true
        if (target === activity.class.ActivityMessage && cls === 'MsgClass') return true
        return false
      })

      // Mock text-core extraction
      mockMarkupToJSON.mockReturnValue({ type: 'doc' })
      mockExtractReferences.mockReturnValue([
        {
          objectId: 'employee-1',
          objectClass: contact.class.Person,
          parentNode: { type: 'paragraph' }
        }
      ])
      mockJsonToMarkup.mockReturnValue('<mention-markup>')

      mockCache.getSender.mockResolvedValue({ account: 'user-2' as AccountUuid })
      mockCache.getContexts.mockResolvedValue([])
      mockCache.getSettings.mockResolvedValue({})
      mockCache.getDocSpace.mockResolvedValue({ _id: 'space-1', private: false })
      mockCache.getDocSettings.mockResolvedValue([])

      // Mock employee find
      mockClient.findOne.mockImplementation(async (cls: string, query: any) => {
        if (cls === contact.mixin.Employee && query._id === 'employee-1') {
          return { personUuid: 'user-1' as AccountUuid, employeeRef: 'emp-ref-1' }
        }
        return undefined
      })

      // Receiver
      const receiver = {
        account: 'user-1' as AccountUuid,
        employeeRef: 'emp-ref-1',
        space: 'user-space-1'
      } as unknown as Receiver
      mockCache.getReceivers.mockResolvedValue([receiver])

      // Provider
      mockGetTxNotifyProviders.mockResolvedValue({
        [notification.providers.InboxNotificationProvider]: [{ _id: 'provider-1' }]
      })

      mockCache.getPushSubscriptions.mockResolvedValue([])

      await handleMention(mockClient, mockCache, txCache, result, tx, doc, txObject, 'test-type' as any)

      expect(result.createUserMentionInfoTx).toHaveLength(1)
      expect(mockPushNotification).toHaveBeenCalledWith(
        mockClient,
        txCache,
        result,
        undefined,
        expect.objectContaining({
          objectId: 'doc-1',
          receiver,
          notification: expect.objectContaining({
            id: 'gen-id',
            type: 'mention',
            createdOn: 100
          })
        })
      )
    })
  })

  describe('createMentionsData scenarios', () => {
    it('processes collaborative doc attribute by reading from storage', async () => {
      const tx = {
        _class: core.class.TxCreateDoc,
        objectId: 'msg-1',
        objectClass: 'MsgClass',
        createdOn: 100,
        modifiedBy: 'user-2',
        attributes: {
          collabDoc: 'blob-id'
        }
      } as unknown as TxCUD<Doc>

      const doc = { _id: 'doc-1', _class: 'DocClass', space: 'space-1' } as any as Doc
      const txObject = { _id: 'msg-1', _class: 'MsgClass' } as any as Doc

      const mockAttr = {
        name: 'collabDoc',
        type: {
          _class: core.class.TypeCollaborativeDoc
        }
      } as unknown as AnyAttribute
      const attrs = new Map()
      attrs.set('collabDoc', mockAttr)
      mockClient.hierarchy.getAllAttributes.mockReturnValue(attrs)
      mockClient.hierarchy.isDerived.mockImplementation((cls: string, target: string) => {
        if (target === contact.class.Person) return true
        return false
      })

      mockClient.storage.read.mockResolvedValue([Buffer.from('<collaborative-content>')])

      // Mock text-core extraction
      mockMarkupToJSON.mockReturnValue({ type: 'doc' })
      mockExtractReferences.mockReturnValue([
        {
          objectId: 'employee-1',
          objectClass: contact.class.Person,
          parentNode: { type: 'paragraph' }
        }
      ])
      mockJsonToMarkup.mockReturnValue('<mention-markup>')

      mockCache.getSender.mockResolvedValue({ account: 'user-2' as AccountUuid })
      mockCache.getContexts.mockResolvedValue([])
      mockCache.getSettings.mockResolvedValue({})
      mockCache.getDocSpace.mockResolvedValue({ _id: 'space-1', private: false })
      mockCache.getDocSettings.mockResolvedValue([])

      // Mock employee find
      mockClient.findOne.mockResolvedValue({ personUuid: 'user-1' as AccountUuid, employeeRef: 'emp-ref-1' })

      const receiver = { account: 'user-1' as AccountUuid } as any as Receiver
      mockCache.getReceivers.mockResolvedValue([receiver])
      mockGetTxNotifyProviders.mockResolvedValue({
        [notification.providers.InboxNotificationProvider]: [{ _id: 'provider-1' }]
      })

      await handleMention(mockClient, mockCache, txCache, result, tx, doc, txObject, 'test-type' as any)

      expect(mockClient.storage.read).toHaveBeenCalledWith(
        mockClient.ctx,
        { uuid: 'ws-uuid', url: 'ws-url' },
        'blob-id'
      )
    })

    it('removes old references if they are no longer in the updated text', async () => {
      const tx = {
        _class: core.class.TxUpdateDoc,
        objectId: 'msg-1',
        objectClass: 'MsgClass',
        createdOn: 100,
        modifiedBy: 'user-2',
        operations: {
          message: '<content>'
        }
      } as unknown as TxCUD<Doc>

      const doc = { _id: 'doc-1', _class: 'DocClass', space: 'space-1' } as any as Doc
      const txObject = { _id: 'msg-1', _class: 'MsgClass' } as any as Doc

      // A new reference (employee-3) is found, which doesn't match the old one (employee-1)
      const mockAttr = {
        name: 'message',
        type: { _class: core.class.TypeMarkup }
      } as unknown as AnyAttribute
      const attrs = new Map()
      attrs.set('message', mockAttr)
      mockClient.hierarchy.getAllAttributes.mockReturnValue(attrs)

      mockClient.hierarchy.isDerived.mockImplementation((cls: string, target: string) => {
        if (target === contact.class.Person) return true
        if (target === activity.class.ActivityMessage && cls === 'MsgClass') return true
        return false
      })

      mockExtractReferences.mockReturnValue([
        {
          objectId: 'employee-3',
          objectClass: contact.class.Person,
          parentNode: { type: 'paragraph' }
        }
      ])
      mockJsonToMarkup.mockReturnValue('{"text":"new"}')

      // But we have an existing UserMentionInfo mock in findAll
      const oldMention = {
        _id: 'mention-info-1',
        _class: activity.class.UserMentionInfo,
        space: 'space-1',
        user: 'employee-1' as Ref<Person>,
        attachedTo: 'msg-1',
        content: '{"text":"old"}'
      } as unknown as UserMentionInfo
      mockClient.findAll.mockImplementation(async (cls: string) => {
        if (cls === activity.class.UserMentionInfo) {
          return [oldMention]
        }
        if (cls === notification.class.DocNotifyContext) {
          return [
            {
              _id: 'ctx-1',
              _class: 'DocNotifyContext',
              space: 'space-1',
              latestNotifications: [{ type: 'mention', messageId: 'msg-1' }],
              unreadMessages: [{ id: 'msg-1', createdOn: 100, notified: true, mentioned: true }]
            }
          ]
        }
        return []
      })

      mockClient.findOne.mockImplementation(async (cls: string) => {
        if (cls === contact.class.Person) {
          return { personUuid: 'user-1' as AccountUuid }
        }
        return undefined
      })

      mockCache.getSender.mockResolvedValue({ account: 'user-2' as AccountUuid })
      mockCache.getContexts.mockResolvedValue([])
      mockCache.getSettings.mockResolvedValue({})
      mockCache.getDocSpace.mockResolvedValue({ _id: 'space-1', private: false })
      mockCache.getDocSettings.mockResolvedValue([])

      const receiver = { account: 'user-3' as AccountUuid, employeeRef: 'employee-3' } as any as Receiver
      mockCache.getReceivers.mockResolvedValue([receiver])
      mockGetTxNotifyProviders.mockResolvedValue({
        [notification.providers.InboxNotificationProvider]: [{ _id: 'provider-1' }]
      })

      await handleMention(mockClient, mockCache, txCache, result, tx, doc, txObject, 'test-type' as any)

      // Verify removal operations
      expect(result.removeUserMentionInfoTx).toHaveLength(1)
      expect(result.updateContextTx).toHaveLength(1)
      expect(result.updateContextTx[0].operations).toEqual({
        $pull: {
          latestNotifications: { type: 'mention', messageId: 'msg-1' }
        },
        $update: {
          unreadMessages: {
            $query: { id: 'msg-1' },
            $update: {
              mentioned: false
            }
          }
        }
      })
    })

    it('updates existing mentions if references changed but UserMentionInfo exists', async () => {
      const tx = {
        _class: core.class.TxUpdateDoc,
        objectId: 'msg-1',
        objectClass: 'MsgClass',
        createdOn: 100,
        modifiedBy: 'user-2',
        operations: {
          message: '<content>'
        }
      } as unknown as TxCUD<Doc>

      const doc = { _id: 'doc-1', _class: 'DocClass', space: 'space-1' } as any as Doc
      const txObject = { _id: 'msg-1', _class: 'MsgClass' } as any as Doc

      const mockAttr = {
        name: 'message',
        type: { _class: core.class.TypeMarkup }
      } as unknown as AnyAttribute
      const attrs = new Map()
      attrs.set('message', mockAttr)
      mockClient.hierarchy.getAllAttributes.mockReturnValue(attrs)
      mockClient.hierarchy.isDerived.mockImplementation((cls: string, target: string) => {
        if (target === contact.class.Person) return true
        if (target === activity.class.ActivityMessage && cls === 'MsgClass') return true
        return false
      })

      // Mock new reference with changed content
      mockExtractReferences.mockReturnValue([
        {
          objectId: 'employee-1',
          objectClass: contact.class.Person,
          parentNode: { type: 'paragraph' }
        }
      ])
      mockJsonToMarkup.mockReturnValue('{"text":"new"}')
      mockAreEqualJson.mockReturnValue(false) // content changed!

      const existingMention = {
        _id: 'mention-info-1',
        _class: activity.class.UserMentionInfo,
        space: 'space-1',
        user: 'employee-1' as Ref<Person>,
        attachedTo: 'msg-1',
        content: '{"text":"old"}'
      } as unknown as UserMentionInfo
      mockClient.findAll.mockImplementation(async (cls: string) => {
        if (cls === activity.class.UserMentionInfo) {
          return [existingMention]
        }
        return []
      })

      // Mock employee find
      mockClient.findOne.mockImplementation(async (cls: string, query: any) => {
        if (cls === contact.mixin.Employee && query._id === 'employee-1') {
          return { personUuid: 'user-1' as AccountUuid, employeeRef: 'employee-1' }
        }
        return undefined
      })

      mockCache.getSender.mockResolvedValue({ account: 'user-2' as AccountUuid })
      mockCache.getContexts.mockResolvedValue([])
      mockCache.getSettings.mockResolvedValue({})
      mockCache.getDocSpace.mockResolvedValue({ _id: 'space-1', private: false })
      mockCache.getDocSettings.mockResolvedValue([])

      const receiver = { account: 'user-1' as AccountUuid, employeeRef: 'employee-1' } as any as Receiver
      mockCache.getReceivers.mockResolvedValue([receiver])
      mockGetTxNotifyProviders.mockResolvedValue({
        [notification.providers.InboxNotificationProvider]: [{ _id: 'provider-1' }]
      })

      await handleMention(mockClient, mockCache, txCache, result, tx, doc, txObject, 'test-type' as any)

      expect(result.updateUserMentionInfoTx).toHaveLength(1)
      expect(result.updateUserMentionInfoTx[0].operations).toEqual({
        content: '{"text":"new"}'
      })
    })
  })

  describe('receiver mapping scenarios', () => {
    let tx: TxCUD<Doc>
    let doc: Doc
    let txObject: Doc

    beforeEach(() => {
      tx = {
        _class: core.class.TxCreateDoc,
        objectId: 'msg-1',
        objectClass: 'MsgClass',
        createdOn: 100,
        modifiedBy: 'user-2',
        attributes: {
          message: '<content>'
        }
      } as unknown as TxCUD<Doc>

      doc = { _id: 'doc-1', _class: 'DocClass', space: 'space-1' } as any as Doc
      txObject = { _id: 'msg-1', _class: 'MsgClass' } as any as Doc

      mockCache.getSender.mockResolvedValue({ account: 'user-2' as AccountUuid })
      mockCache.getContexts.mockResolvedValue([])
      mockCache.getSettings.mockResolvedValue({})
      mockCache.getDocSettings.mockResolvedValue([])

      const mockAttr = {
        name: 'message',
        type: { _class: core.class.TypeMarkup }
      } as unknown as AnyAttribute
      const attrs = new Map()
      attrs.set('message', mockAttr)
      mockClient.hierarchy.getAllAttributes.mockReturnValue(attrs)
    })

    it('maps Everyone mention to all space collaborators', async () => {
      mockClient.hierarchy.isDerived.mockImplementation((cls: string, target: string) => {
        if (target === contact.class.Person) return true
        return false
      })

      mockExtractReferences.mockReturnValue([
        {
          objectId: contact.mention.Everyone,
          objectClass: contact.class.Person,
          parentNode: { type: 'paragraph' }
        }
      ])
      mockJsonToMarkup.mockReturnValue('<everyone-markup>')

      mockCache.getDocSpace.mockResolvedValue({ _id: 'space-1', private: true, members: ['user-1', 'user-3'] })

      mockCache.getCollaborators.mockResolvedValue([
        { collaborator: 'user-1' },
        { collaborator: 'user-2' }, // not in private space members
        { collaborator: 'user-3' }
      ])

      const receivers = [{ account: 'user-1' as AccountUuid }, { account: 'user-3' as AccountUuid }] as Receiver[]
      mockCache.getReceivers.mockResolvedValue(receivers)
      mockGetTxNotifyProviders.mockResolvedValue({
        [notification.providers.InboxNotificationProvider]: [{ _id: 'provider-1' }]
      })

      await handleMention(mockClient, mockCache, txCache, result, tx, doc, txObject, 'test-type' as any)

      expect(mockCache.getCollaborators).toHaveBeenCalledWith('doc-1', 'DocClass')
      expect(mockCache.getReceivers).toHaveBeenCalledWith(['user-1', 'user-3'])
    })

    it('maps Here mention to online space collaborators only', async () => {
      mockClient.hierarchy.isDerived.mockImplementation((cls: string, target: string) => {
        if (target === contact.class.Person) return true
        return false
      })

      mockExtractReferences.mockReturnValue([
        {
          objectId: contact.mention.Here,
          objectClass: contact.class.Person,
          parentNode: { type: 'paragraph' }
        }
      ])
      mockJsonToMarkup.mockReturnValue('<here-markup>')

      mockCache.getDocSpace.mockResolvedValue({ _id: 'space-1', private: false })

      mockCache.getCollaborators.mockResolvedValue([{ collaborator: 'user-1' }, { collaborator: 'user-2' }])

      mockCache.getUserStatuses.mockResolvedValue([
        { user: 'user-1', online: true },
        { user: 'user-2', online: false }
      ])

      const receivers = [{ account: 'user-1' as AccountUuid }] as Receiver[]
      mockCache.getReceivers.mockResolvedValue(receivers)
      mockGetTxNotifyProviders.mockResolvedValue({
        [notification.providers.InboxNotificationProvider]: [{ _id: 'provider-1' }]
      })

      await handleMention(mockClient, mockCache, txCache, result, tx, doc, txObject, 'test-type' as any)

      expect(mockCache.getReceivers).toHaveBeenCalledWith(['user-1'])
    })
  })

  describe('user preferences filtering & coexistences', () => {
    it('skips receivers if document/space is muted', async () => {
      const tx = {
        _class: core.class.TxCreateDoc,
        objectId: 'msg-1',
        objectClass: 'MsgClass',
        createdOn: 100,
        modifiedBy: 'user-2',
        attributes: {
          message: '<content>'
        }
      } as unknown as TxCUD<Doc>

      const doc = { _id: 'doc-1', _class: 'DocClass', space: 'space-1' } as any as Doc
      const txObject = { _id: 'msg-1', _class: 'MsgClass' } as any as Doc

      const mockAttr = {
        name: 'message',
        type: { _class: core.class.TypeMarkup }
      } as unknown as AnyAttribute
      const attrs = new Map()
      attrs.set('message', mockAttr)
      mockClient.hierarchy.getAllAttributes.mockReturnValue(attrs)
      mockClient.hierarchy.isDerived.mockImplementation((cls: string, target: string) => {
        if (target === contact.class.Person) return true
        return false
      })

      mockExtractReferences.mockReturnValue([
        {
          objectId: 'employee-1',
          objectClass: contact.class.Person,
          parentNode: { type: 'paragraph' }
        }
      ])
      mockJsonToMarkup.mockReturnValue('<mention-markup>')

      mockCache.getSender.mockResolvedValue({ account: 'user-2' as AccountUuid })
      mockCache.getContexts.mockResolvedValue([])
      mockCache.getSettings.mockResolvedValue({})
      mockCache.getDocSpace.mockResolvedValue({ _id: 'space-1', private: false })
      mockCache.getDocSettings.mockResolvedValue([])

      mockClient.findOne.mockResolvedValue({ personUuid: 'user-1' as AccountUuid, employeeRef: 'emp-ref-1' })

      const receiver = { account: 'user-1' as AccountUuid, employeeRef: 'emp-ref-1' } as any as Receiver
      mockCache.getReceivers.mockResolvedValue([receiver])

      // Mock user preference as muted
      mockIsMuted.mockReturnValue(true)

      await handleMention(mockClient, mockCache, txCache, result, tx, doc, txObject, 'test-type' as any)

      expect(mockGetTxNotifyProviders).not.toHaveBeenCalled()
      expect(mockPushNotification).not.toHaveBeenCalled()
    })

    it('skips receivers if InboxNotificationProvider is not configured', async () => {
      const tx = {
        _class: core.class.TxCreateDoc,
        objectId: 'msg-1',
        objectClass: 'MsgClass',
        createdOn: 100,
        modifiedBy: 'user-2',
        attributes: {
          message: '<content>'
        }
      } as unknown as TxCUD<Doc>

      const doc = { _id: 'doc-1', _class: 'DocClass', space: 'space-1' } as any as Doc
      const txObject = { _id: 'msg-1', _class: 'MsgClass' } as any as Doc

      const mockAttr = {
        name: 'message',
        type: { _class: core.class.TypeMarkup }
      } as unknown as AnyAttribute
      const attrs = new Map()
      attrs.set('message', mockAttr)
      mockClient.hierarchy.getAllAttributes.mockReturnValue(attrs)
      mockClient.hierarchy.isDerived.mockImplementation((cls: string, target: string) => {
        if (target === contact.class.Person) return true
        return false
      })

      mockExtractReferences.mockReturnValue([
        {
          objectId: 'employee-1',
          objectClass: contact.class.Person,
          parentNode: { type: 'paragraph' }
        }
      ])
      mockJsonToMarkup.mockReturnValue('<mention-markup>')

      mockCache.getSender.mockResolvedValue({ account: 'user-2' as AccountUuid })
      mockCache.getContexts.mockResolvedValue([])
      mockCache.getSettings.mockResolvedValue({})
      mockCache.getDocSpace.mockResolvedValue({ _id: 'space-1', private: false })
      mockCache.getDocSettings.mockResolvedValue([])

      mockClient.findOne.mockResolvedValue({ personUuid: 'user-1' as AccountUuid, employeeRef: 'emp-ref-1' })

      const receiver = { account: 'user-1' as AccountUuid, employeeRef: 'emp-ref-1' } as any as Receiver
      mockCache.getReceivers.mockResolvedValue([receiver])

      // Returns empty providers list
      mockGetTxNotifyProviders.mockResolvedValue({})

      await handleMention(mockClient, mockCache, txCache, result, tx, doc, txObject, 'test-type' as any)

      expect(mockPushNotification).not.toHaveBeenCalled()
    })

    it('skips mention processing if context already has a message notification to prevent duplication', async () => {
      const tx = {
        _class: core.class.TxCreateDoc,
        objectId: 'msg-1',
        objectClass: 'MsgClass',
        createdOn: 100,
        modifiedBy: 'user-2',
        attributes: {
          message: '<content>'
        }
      } as unknown as TxCUD<Doc>

      const doc = { _id: 'doc-1', _class: 'DocClass', space: 'space-1' } as any as Doc
      const txObject = { _id: 'msg-1', _class: 'MsgClass' } as any as Doc

      const mockAttr = {
        name: 'message',
        type: { _class: core.class.TypeMarkup }
      } as unknown as AnyAttribute
      const attrs = new Map()
      attrs.set('message', mockAttr)
      mockClient.hierarchy.getAllAttributes.mockReturnValue(attrs)
      mockClient.hierarchy.isDerived.mockImplementation((cls: string, target: string) => {
        if (target === contact.class.Person) return true
        if (target === activity.class.ActivityMessage && cls === 'MsgClass') return true
        return false
      })

      mockExtractReferences.mockReturnValue([
        {
          objectId: 'employee-1',
          objectClass: contact.class.Person,
          parentNode: { type: 'paragraph' }
        }
      ])
      mockJsonToMarkup.mockReturnValue('<mention-markup>')

      mockCache.getSender.mockResolvedValue({ account: 'user-2' as AccountUuid })
      mockCache.getSettings.mockResolvedValue({})
      mockCache.getDocSpace.mockResolvedValue({ _id: 'space-1', private: false })
      mockCache.getDocSettings.mockResolvedValue([])

      const context = {
        _id: 'ctx-1',
        _class: 'DocNotifyContext',
        user: 'user-1' as AccountUuid,
        space: 'space-1'
      } as unknown as DocNotifyContext
      mockCache.getContexts.mockResolvedValue([context])

      mockClient.findOne.mockResolvedValue({ personUuid: 'user-1' as AccountUuid, employeeRef: 'emp-ref-1' })

      const receiver = { account: 'user-1' as AccountUuid, employeeRef: 'emp-ref-1' } as any as Receiver
      mockCache.getReceivers.mockResolvedValue([receiver])
      mockGetTxNotifyProviders.mockResolvedValue({
        [notification.providers.InboxNotificationProvider]: [{ _id: 'provider-1' }]
      })

      // Mocks check that a message notification already exists
      mockHasMessageNotification.mockReturnValue(true)

      await handleMention(mockClient, mockCache, txCache, result, tx, doc, txObject, 'test-type' as any)

      expect(mockPushNotification).not.toHaveBeenCalled()
    })
  })
})

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

import {
  getCollaboratorAccounts,
  getTypeMatchClient,
  toNotificationMessage,
  isChatMessage,
  getAttachments
} from '../misc'
import contact from '@hcengineering/contact'
import chunter from '@hcengineering/chunter'
import attachment from '@hcengineering/attachment'
import { Client } from '../../types'
import Cache from '../../cache'
import { Doc, Space, AccountUuid, Ref, Class, MeasureContext } from '@hcengineering/core'
import { ActivityMessage } from '@hcengineering/activity'

jest.mock('@hcengineering/contact', () => ({
  mixin: {
    Employee: 'EmployeeMixin'
  }
}))

jest.mock('@hcengineering/chunter', () => ({
  class: {
    ChatMessage: 'ChatMessageClass'
  }
}))

jest.mock('@hcengineering/attachment', () => ({
  class: {
    Attachment: 'AttachmentClass'
  }
}))

describe('misc utils', () => {
  describe('getCollaboratorAccounts', () => {
    let mockClient: {
      hierarchy: {
        isDerived: jest.Mock
      }
    }
    let mockCache: {
      getCollaborators: jest.Mock
    }
    let mockSpace: Space

    beforeEach(() => {
      mockClient = {
        hierarchy: {
          isDerived: jest.fn()
        }
      }
      mockCache = {
        getCollaborators: jest.fn()
      }
      mockSpace = {
        private: false,
        members: []
      } as unknown as Space
    })

    it('returns collaborator accounts for public space', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass' } as unknown as Doc
      mockCache.getCollaborators.mockResolvedValue([
        { collaborator: 'user1' as AccountUuid },
        { collaborator: 'user2' as AccountUuid }
      ])
      mockClient.hierarchy.isDerived.mockReturnValue(false)

      const result = await getCollaboratorAccounts(
        mockClient as unknown as Client,
        mockCache as unknown as Cache,
        doc,
        mockSpace
      )

      expect(mockCache.getCollaborators).toHaveBeenCalledWith('doc-1', 'DocClass')
      expect(result).toEqual(['user1', 'user2'])
    })

    it('filters collaborators by space membership for private spaces', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass' } as unknown as Doc
      const privateSpace = {
        private: true,
        members: ['user1' as AccountUuid, 'user3' as AccountUuid]
      } as unknown as Space

      mockCache.getCollaborators.mockResolvedValue([
        { collaborator: 'user1' as AccountUuid },
        { collaborator: 'user2' as AccountUuid }
      ])
      mockClient.hierarchy.isDerived.mockReturnValue(false)

      const result = await getCollaboratorAccounts(
        mockClient as unknown as Client,
        mockCache as unknown as Cache,
        doc,
        privateSpace
      )

      expect(result).toEqual(['user1'])
    })

    it('always includes Employee account on their own employee-derived documents', async () => {
      const doc = { _id: 'doc-1', _class: 'EmployeeDoc', personUuid: 'employee-1' as AccountUuid } as unknown as Doc
      mockCache.getCollaborators.mockResolvedValue([{ collaborator: 'user1' as AccountUuid }])
      // Mock hierarchy check
      mockClient.hierarchy.isDerived.mockImplementation(
        (actual: string, expected: string) => actual === 'EmployeeDoc' && expected === contact.mixin.Employee
      )

      const result = await getCollaboratorAccounts(
        mockClient as unknown as Client,
        mockCache as unknown as Cache,
        doc,
        mockSpace
      )

      expect(result).toEqual(['user1', 'employee-1'])
    })

    it('excludes already notified accounts', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass' } as unknown as Doc
      mockCache.getCollaborators.mockResolvedValue([
        { collaborator: 'user1' as AccountUuid },
        { collaborator: 'user2' as AccountUuid }
      ])
      mockClient.hierarchy.isDerived.mockReturnValue(false)

      const result = await getCollaboratorAccounts(
        mockClient as unknown as Client,
        mockCache as unknown as Cache,
        doc,
        mockSpace,
        ['user1' as AccountUuid]
      )

      expect(result).toEqual(['user2'])
    })
  })

  describe('getTypeMatchClient', () => {
    it('creates adapter from Client', () => {
      const mockClientInstance = {
        hierarchy: 'hierarchy-val',
        model: 'model-val',
        txFactory: 'tx-val',
        ctx: 'ctx-val',
        branding: { lastNameFirst: true },
        findAll: jest.fn()
      } as unknown as Client

      const adapter = getTypeMatchClient(mockClientInstance)

      expect(adapter.hierarchy).toBe('hierarchy-val')
      expect(adapter.modelDb).toBe('model-val')
      expect(adapter.txFactory).toBe('tx-val')
      expect(adapter.ctx).toBe('ctx-val')
      expect(adapter.branding).toEqual({ lastNameFirst: true })

      void adapter.findAll({} as unknown as MeasureContext, 'ClassA' as unknown as Ref<Class<Doc>>, { q: 1 }, {})
      expect(mockClientInstance.findAll).toHaveBeenCalledWith('ClassA' as unknown as Ref<Class<Doc>>, { q: 1 }, {})
    })

    it('uses null if client.branding is missing', () => {
      const mockClientInstance = {
        hierarchy: 'hierarchy-val',
        model: 'model-val',
        txFactory: 'tx-val',
        ctx: 'ctx-val',
        findAll: jest.fn()
      } as unknown as Client

      const adapter = getTypeMatchClient(mockClientInstance)
      expect(adapter.branding).toBeNull()
    })
  })

  describe('toNotificationMessage', () => {
    it('strips volatile activity-only fields from message', () => {
      const activityMsg = {
        _id: 'msg-1',
        _class: 'MsgClass',
        text: 'hello',
        attachedTo: 'doc-123',
        attachedToClass: 'DocClass',
        editedOn: 12345,
        replies: [],
        repliedPersons: [],
        reactions: [],
        isPinned: false,
        lastReply: 'reply-1',
        otherStableField: 'stable-value'
      } as unknown as ActivityMessage

      const notificationMsg = toNotificationMessage(activityMsg)

      expect(notificationMsg).toEqual({
        _id: 'msg-1',
        _class: 'MsgClass',
        text: 'hello',
        attachedTo: 'doc-123',
        attachedToClass: 'DocClass',
        otherStableField: 'stable-value'
      })
      expect(notificationMsg).not.toHaveProperty('editedOn')
      expect(notificationMsg).not.toHaveProperty('reactions')
    })
  })

  describe('isChatMessage', () => {
    it('returns true if message class derives from ChatMessage', () => {
      const mockIsDerived = jest.fn().mockReturnValue(true)
      const mockHierarchy = {
        isDerived: mockIsDerived
      } as unknown as Client['hierarchy']
      const msg = { _class: 'MyChatMessageClass' } as unknown as ActivityMessage

      expect(isChatMessage(msg, mockHierarchy)).toBe(true)
      expect(mockIsDerived).toHaveBeenCalledWith('MyChatMessageClass', chunter.class.ChatMessage)
    })

    it('returns false if message class does not derive from ChatMessage', () => {
      const mockIsDerived = jest.fn().mockReturnValue(false)
      const mockHierarchy = {
        isDerived: mockIsDerived
      } as unknown as Client['hierarchy']
      const msg = { _class: 'SomeOtherClass' } as unknown as ActivityMessage

      expect(isChatMessage(msg, mockHierarchy)).toBe(false)
    })
  })

  describe('getAttachments', () => {
    let mockClientInstance: {
      hierarchy: {
        isDerived: jest.Mock
      }
      findAll: jest.Mock
    }

    beforeEach(() => {
      mockClientInstance = {
        hierarchy: {
          isDerived: jest.fn()
        },
        findAll: jest.fn()
      }
    })

    it('returns empty array if message is not a ChatMessage', async () => {
      mockClientInstance.hierarchy.isDerived.mockReturnValue(false)
      const msg = { _id: 'msg-1', attachments: 5 } as unknown as ActivityMessage

      const result = await getAttachments(msg, mockClientInstance as unknown as Client)
      expect(result).toEqual([])
      expect(mockClientInstance.findAll).not.toHaveBeenCalled()
    })

    it('returns empty array if message has 0 attachments', async () => {
      mockClientInstance.hierarchy.isDerived.mockReturnValue(true)
      const msg = { _id: 'msg-1', attachments: 0 } as unknown as ActivityMessage

      const result = await getAttachments(msg, mockClientInstance as unknown as Client)
      expect(result).toEqual([])
      expect(mockClientInstance.findAll).not.toHaveBeenCalled()
    })

    it('returns attachments mapped to BlobType[] on success', async () => {
      mockClientInstance.hierarchy.isDerived.mockReturnValue(true)
      const msg = { _id: 'msg-1', attachments: 2 } as unknown as ActivityMessage
      mockClientInstance.findAll.mockResolvedValue([
        {
          file: 'file-1-id',
          type: 'image/png',
          name: 'img.png',
          size: 1024,
          metadata: { w: 100 },
          extraUnstableField: 'blah'
        },
        {
          file: 'file-2-id',
          type: 'application/pdf',
          name: 'doc.pdf',
          size: 2048,
          metadata: {}
        }
      ])

      const result = await getAttachments(msg, mockClientInstance as unknown as Client)

      expect(mockClientInstance.findAll).toHaveBeenCalledWith(attachment.class.Attachment, { attachedTo: 'msg-1' })
      expect(result).toEqual([
        {
          file: 'file-1-id',
          type: 'image/png',
          name: 'img.png',
          size: 1024,
          metadata: { w: 100 }
        },
        {
          file: 'file-2-id',
          type: 'application/pdf',
          name: 'doc.pdf',
          size: 2048,
          metadata: {}
        }
      ])
    })
  })
})

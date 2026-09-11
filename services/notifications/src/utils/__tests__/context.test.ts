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
  hasMessageNotification,
  hasReactionNotificationByMessage,
  hasMentionNotificationByMessage,
  hasReactionNotification,
  hasUnreadReactionByMessage,
  hasUnreadReaction,
  hasUnreadMentionByMessage,
  hasUnreadMessage,
  getNotificationsByMessage,
  getMentionNotification,
  getLastNotify,
  getMode,
  isMuted,
  getCreateContextTx
} from '../context'
import { emptyResult } from '../result'
import { DocNotifyContext, DocNotificationSetting } from '@hcengineering/notification'
import { ActivityMessage, Reaction } from '@hcengineering/activity'
import { Ref, AccountUuid, TxFactory, Doc, Class, Space } from '@hcengineering/core'
import { ObjectDisplayData } from '../../types'
import { Receiver } from '@hcengineering/server-notification'

describe('context utils', () => {
  describe('notification presence checks', () => {
    let mockContext: DocNotifyContext

    beforeEach(() => {
      mockContext = {
        latestNotifications: [
          { type: 'message', messageId: 'msg-1' as Ref<ActivityMessage> },
          { type: 'reaction', messageId: 'msg-2' as Ref<ActivityMessage>, id: 'react-1' as Ref<Reaction> },
          { type: 'mention', messageId: 'msg-3' as Ref<ActivityMessage> },
          { type: 'common' }
        ]
      } as unknown as DocNotifyContext
    })

    it('hasMessageNotification returns true if message type with messageId matches', () => {
      expect(hasMessageNotification(mockContext, 'msg-1' as Ref<ActivityMessage>)).toBe(true)
      expect(hasMessageNotification(mockContext, 'msg-999' as Ref<ActivityMessage>)).toBe(false)
    })

    it('hasReactionNotificationByMessage returns true if reaction type with messageId matches', () => {
      expect(hasReactionNotificationByMessage(mockContext, 'msg-2' as Ref<ActivityMessage>)).toBe(true)
      expect(hasReactionNotificationByMessage(mockContext, 'msg-1' as Ref<ActivityMessage>)).toBe(false)
    })

    it('hasMentionNotificationByMessage returns true if mention type with messageId matches', () => {
      expect(hasMentionNotificationByMessage(mockContext, 'msg-3' as Ref<ActivityMessage>)).toBe(true)
      expect(hasMentionNotificationByMessage(mockContext, 'msg-1' as Ref<ActivityMessage>)).toBe(false)
    })

    it('hasReactionNotification returns true if reaction type with id matches', () => {
      expect(hasReactionNotification(mockContext, 'react-1' as Ref<Reaction>)).toBe(true)
      expect(hasReactionNotification(mockContext, 'react-999' as Ref<Reaction>)).toBe(false)
    })
  })

  describe('unread state checks', () => {
    let mockContext: DocNotifyContext

    beforeEach(() => {
      mockContext = {
        unreadReactions: [
          { attachedTo: 'msg-1' as Ref<ActivityMessage>, id: 'react-1' as Ref<Reaction> },
          { attachedTo: 'msg-2' as Ref<ActivityMessage>, id: 'react-2' as Ref<Reaction> }
        ],
        unreadMentions: [],
        unreadMessages: [
          { id: 'msg-3' as Ref<ActivityMessage>, createdOn: 50, mentioned: true, notified: true },
          { id: 'msg-4' as Ref<ActivityMessage>, createdOn: 100 },
          { id: 'msg-5' as Ref<ActivityMessage>, createdOn: 200 }
        ]
      } as unknown as DocNotifyContext
    })

    it('hasUnreadReactionByMessage returns true if unread reaction attachedTo matches', () => {
      expect(hasUnreadReactionByMessage(mockContext, 'msg-1' as Ref<ActivityMessage>)).toBe(true)
      expect(hasUnreadReactionByMessage(mockContext, 'msg-999' as Ref<ActivityMessage>)).toBe(false)
    })

    it('hasUnreadReaction returns true if unread reaction id matches', () => {
      expect(hasUnreadReaction(mockContext, 'react-1' as Ref<Reaction>)).toBe(true)
      expect(hasUnreadReaction(mockContext, 'react-999' as Ref<Reaction>)).toBe(false)
    })

    it('hasUnreadMentionByMessage returns true if unread mention messageId matches', () => {
      expect(hasUnreadMentionByMessage(mockContext, 'msg-3' as Ref<ActivityMessage>)).toBe(true)
      expect(hasUnreadMentionByMessage(mockContext, 'msg-999' as Ref<ActivityMessage>)).toBe(false)
    })

    it('hasUnreadMessage returns true if unread message id matches and is an unread message id', () => {
      expect(hasUnreadMessage(mockContext, 'msg-4' as Ref<ActivityMessage>)).toBe(true)
      expect(hasUnreadMessage(mockContext, 'msg-999' as Ref<ActivityMessage>)).toBe(false)
    })
  })

  describe('notification queries', () => {
    it('getNotificationsByMessage returns non-common notifications with messageId', () => {
      const mockContext = {
        latestNotifications: [
          { type: 'message', messageId: 'msg-1' as Ref<ActivityMessage> },
          { type: 'reaction', messageId: 'msg-1' as Ref<ActivityMessage> },
          { type: 'common', messageId: 'msg-1' as Ref<ActivityMessage> },
          { type: 'message', messageId: 'msg-2' as Ref<ActivityMessage> }
        ]
      } as unknown as DocNotifyContext

      const result = getNotificationsByMessage(mockContext, 'msg-1' as Ref<ActivityMessage>)
      expect(result).toEqual([
        { type: 'message', messageId: 'msg-1' },
        { type: 'reaction', messageId: 'msg-1' }
      ])
    })

    it('getMentionNotification returns mention notification matching messageId', () => {
      const mockContext = {
        latestNotifications: [
          { type: 'message', messageId: 'msg-1' as Ref<ActivityMessage> },
          { type: 'mention', messageId: 'msg-1' as Ref<ActivityMessage> },
          { type: 'mention', messageId: null }
        ]
      } as unknown as DocNotifyContext

      expect(getMentionNotification(mockContext, 'msg-1' as Ref<ActivityMessage>)).toEqual({
        type: 'mention',
        messageId: 'msg-1'
      })
      expect(getMentionNotification(mockContext, null)).toEqual({ type: 'mention', messageId: null })
      expect(getMentionNotification(mockContext, 'msg-999' as Ref<ActivityMessage>)).toBeUndefined()
    })
  })

  describe('context state helpers', () => {
    it('getLastNotify returns max createdOn or 0', () => {
      const context1 = {
        latestNotifications: [{ createdOn: 10 }, { createdOn: 25 }, { createdOn: 5 }]
      } as unknown as DocNotifyContext
      expect(getLastNotify(context1)).toBe(25)

      const context2 = { latestNotifications: [] } as unknown as DocNotifyContext
      expect(getLastNotify(context2)).toBe(0)
    })

    it('getMode returns correct mode or default value', () => {
      const docSettings = [
        { account: 'user-1' as AccountUuid, mode: 'mentions' },
        { account: 'user-2' as AccountUuid, mode: 'mute' }
      ] as unknown as DocNotificationSetting[]

      expect(getMode(docSettings, 'user-1' as AccountUuid)).toBe('mentions')
      expect(getMode(docSettings, 'user-2' as AccountUuid)).toBe('mute')
      expect(getMode(docSettings, 'user-3' as AccountUuid)).toBe('all')
    })

    it('isMuted checks if mode is mute', () => {
      expect(isMuted('mute')).toBe(true)
      expect(isMuted('all')).toBe(false)
      expect(isMuted('mentions')).toBe(false)
    })
  })

  describe('context transaction builders', () => {
    let mockFactory: {
      createTxUpdateDoc: jest.Mock
      createTxCreateDoc: jest.Mock
    }

    beforeEach(() => {
      mockFactory = {
        createTxUpdateDoc: jest.fn().mockImplementation((cls, spc, id, payload) => ({
          _id: 'tx-update-1',
          cls,
          spc,
          objectId: id,
          payload
        })),
        createTxCreateDoc: jest.fn().mockImplementation((cls, spc, payload, id) => ({
          _id: 'tx-create-1',
          cls,
          spc,
          payload,
          objectId: id
        }))
      }
    })

    describe('getCreateContextTx', () => {
      it('creates a create transaction and registers it', () => {
        const result = emptyResult()
        const receiver = {
          account: 'receiver-acc' as AccountUuid,
          space: 'receiver-space' as Ref<Space>
        } as unknown as Receiver
        const display = {
          objectTitle: 'Title',
          objectIdentifier: 'ID-1',
          objectIcon: 'icon-ref',
          objectLabel: 'label-ref'
        } as unknown as ObjectDisplayData

        const tx = getCreateContextTx(
          'new-ctx-id' as Ref<DocNotifyContext>,
          'doc-1' as Ref<Doc>,
          'DocClass' as Ref<Class<Doc>>,
          'doc-space' as Ref<Space>,
          receiver,
          result,
          mockFactory as unknown as TxFactory,
          display
        )

        expect(mockFactory.createTxCreateDoc).toHaveBeenCalledWith(
          expect.anything(), // DocNotifyContext class ref
          'receiver-space',
          {
            ...display,
            user: 'receiver-acc' as AccountUuid,
            objectId: 'doc-1',
            objectClass: 'DocClass',
            objectSpace: 'doc-space',
            latestNotifications: [],
            unreadReactions: [],
            unreadMentions: [],
            unreadCommons: [],
            unreadMessages: [],
            unreadCount: 0,
            lastNotify: 0
          },
          'new-ctx-id'
        )

        expect(result.createContextTx).toEqual([tx])
      })
    })
  })
})

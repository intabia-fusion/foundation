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

import { emptyResult, getResultTxes, isEmptyResult, getNotifiedUsers, getEmptyTxCache } from '../result'
import { Result } from '../../types'
import { TxCUD, Doc, AccountUuid, TxCreateDoc, TxUpdateDoc, TxRemoveDoc } from '@hcengineering/core'
import { DocNotifyContext, AppPushNotification, QueueNotificationMessage } from '@hcengineering/notification'
import { UserMentionInfo } from '@hcengineering/activity'

describe('result utils', () => {
  describe('emptyResult', () => {
    it('should return a Result object with empty arrays', () => {
      const res = emptyResult()
      expect(res).toEqual({
        updateContextTx: [],
        createContextTx: [],
        createAppPushNotificationTx: [],
        queueMessages: [],
        createUserMentionInfoTx: [],
        updateUserMentionInfoTx: [],
        removeUserMentionInfoTx: []
      })
    })
  })

  describe('getResultTxes', () => {
    it('should return combined tx arrays sorted by modifiedOn ascending', () => {
      const mockTx = (id: string, modifiedOn: number): TxCUD<Doc> =>
        ({
          _id: id,
          _class: 'test',
          space: 'test-space',
          modifiedOn
        }) as unknown as TxCUD<Doc>

      const result: Result = {
        ...emptyResult(),
        createContextTx: [
          mockTx('c1', 20) as unknown as TxCreateDoc<DocNotifyContext>,
          mockTx('c2', 10) as unknown as TxCreateDoc<DocNotifyContext>
        ],
        updateContextTx: [mockTx('u1', 5) as unknown as TxUpdateDoc<DocNotifyContext>],
        createUserMentionInfoTx: [mockTx('cum1', 25) as unknown as TxCreateDoc<UserMentionInfo>],
        updateUserMentionInfoTx: [mockTx('uum1', 2) as unknown as TxUpdateDoc<UserMentionInfo>],
        removeUserMentionInfoTx: [mockTx('rum1', 30) as unknown as TxRemoveDoc<UserMentionInfo>],
        createAppPushNotificationTx: [mockTx('apn1', 1) as unknown as TxCreateDoc<AppPushNotification>]
      }

      const txes = getResultTxes(result)
      const expectedOrder = ['apn1', 'uum1', 'u1', 'c2', 'c1', 'cum1', 'rum1']
      expect(txes.map((t) => t._id)).toEqual(expectedOrder)
    })

    it('should return an empty array if all tx lists are empty', () => {
      const result = emptyResult()
      const txes = getResultTxes(result)
      expect(txes).toEqual([])
    })
  })

  describe('isEmptyResult', () => {
    it('should return true for emptyResult', () => {
      expect(isEmptyResult(emptyResult())).toBe(true)
    })

    it('should return false if any tx array or queueMessages is not empty', () => {
      const res1 = emptyResult()
      res1.createContextTx.push({} as unknown as TxCreateDoc<DocNotifyContext>)
      expect(isEmptyResult(res1)).toBe(false)

      const res2 = emptyResult()
      res2.queueMessages.push({ account: 'user1' as AccountUuid } as unknown as QueueNotificationMessage)
      expect(isEmptyResult(res2)).toBe(false)

      const res3 = emptyResult()
      res3.updateUserMentionInfoTx.push({} as unknown as TxUpdateDoc<UserMentionInfo>)
      expect(isEmptyResult(res3)).toBe(false)
    })
  })

  describe('getNotifiedUsers', () => {
    it('should extract unique and non-unique accounts from queueMessages', () => {
      const result: Result = {
        ...emptyResult(),
        queueMessages: [
          { account: 'user1' as AccountUuid },
          { account: 'user2' as AccountUuid },
          { account: 'user1' as AccountUuid }
        ] as unknown as QueueNotificationMessage[]
      }

      expect(getNotifiedUsers(result)).toEqual(['user1', 'user2', 'user1'])
    })

    it('should return an empty array if queueMessages is empty', () => {
      expect(getNotifiedUsers(emptyResult())).toEqual([])
    })
  })

  describe('getEmptyTxCache', () => {
    it('should return initialized maps for TxCache', () => {
      const cache = getEmptyTxCache()
      expect(cache.titleByDoc).toBeInstanceOf(Map)
      expect(cache.urlByDoc).toBeInstanceOf(Map)
      expect(cache.labelByDoc).toBeInstanceOf(Map)
      expect(cache.identifierByDoc).toBeInstanceOf(Map)
      expect(cache.iconByDoc).toBeInstanceOf(Map)
      expect(cache.templates).toBeInstanceOf(Map)

      expect(cache.titleByDoc.size).toBe(0)
    })
  })
})

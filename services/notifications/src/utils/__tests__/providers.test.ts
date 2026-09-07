/* eslint-disable import/first */
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

const mockGetTxOperations = jest.fn()
const mockMatchQuery = jest.fn()

let actualCore: any
const getActualCore = (): any => {
  if (actualCore === undefined) {
    actualCore = jest.requireActual('@hcengineering/core')
  }
  return actualCore
}

jest.mock('@hcengineering/core', () => {
  return new Proxy(
    {},
    {
      get: (target, prop) => {
        if (prop === 'getTxOperations') {
          return mockGetTxOperations
        }
        if (prop === 'matchQuery') {
          return mockMatchQuery
        }
        if (prop === '__esModule') {
          return true
        }
        return getActualCore()[prop as keyof typeof import('@hcengineering/core')]
      }
    }
  ) as unknown as typeof import('@hcengineering/core')
})

import { getAllowedProviders, getMessageNotifyProviders, isMatchedTxType, isTxTrigger } from '../providers'
import notification, { NotificationType, NotificationProvider, TxNotificationType } from '@hcengineering/notification'
import { Client, NotificationSettings } from '../../types'
import { PersonId, Ref, TxCUD, Doc, Class } from '@hcengineering/core'
import { ActivityMessage } from '@hcengineering/activity'
import { Receiver } from '@hcengineering/server-notification'

jest.mock('../../config', () => ({
  __esModule: true,
  default: {
    AllowedNotificationProviders: ['all']
  },
  AllowedNotificationProviders: ['all']
}))

jest.mock('@hcengineering/platform', () => {
  const actual = jest.requireActual('@hcengineering/platform')
  return {
    ...actual,
    getResource: jest.fn()
  }
})

describe('providers utils', () => {
  let mockClient: Client
  let mockSettings: NotificationSettings
  let mockType: NotificationType

  beforeEach(() => {
    mockClient = {
      hierarchy: {
        isDerived: jest.fn(),
        hasClass: jest.fn().mockReturnValue(true),
        getBaseClass: jest.fn().mockImplementation((cls) => cls),
        hasMixin: jest.fn().mockReturnValue(false),
        findAttribute: jest.fn()
      },
      model: {
        findAllSync: jest.fn()
      },
      txFactory: 'tx-factory-mock',
      ctx: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
      branding: null,
      findAll: jest.fn()
    } as unknown as Client

    mockSettings = {
      settingsByProvider: new Map(),
      typesByProvider: new Map()
    } as unknown as NotificationSettings

    mockType = {
      _id: 'type-1',
      defaultEnabled: true
    } as unknown as NotificationType

    jest.clearAllMocks()
  })

  describe('getAllowedProviders', () => {
    it('returns allowed providers based on settings and default values', () => {
      const mockProviders = [
        { _id: 'provider-1' as Ref<NotificationProvider>, defaultEnabled: true },
        { _id: 'provider-2' as Ref<NotificationProvider>, defaultEnabled: false }
      ]
      ;(mockClient.model.findAllSync as jest.Mock).mockReturnValue(mockProviders)

      const allowed = getAllowedProviders(mockClient, mockSettings, ['social-1' as PersonId], mockType)
      expect(allowed).toEqual(['provider-1'])
    })

    it('returns empty array if settings disable the provider', () => {
      const mockProviders = [{ _id: 'provider-1' as Ref<NotificationProvider>, defaultEnabled: true }]
      ;(mockClient.model.findAllSync as jest.Mock).mockReturnValue(mockProviders)

      // User disabled provider-1
      mockSettings.settingsByProvider.set(
        'provider-1' as Ref<NotificationProvider>,
        [{ createdBy: 'social-1' as PersonId, enabled: false }] as any
      )

      const allowed = getAllowedProviders(mockClient, mockSettings, ['social-1' as PersonId], mockType)
      expect(allowed).toEqual([])
    })

    it('returns provider if user settings explicitly enable type when type is default-disabled', () => {
      const mockProviders = [{ _id: 'provider-1' as Ref<NotificationProvider>, defaultEnabled: true }]
      ;(mockClient.model.findAllSync as jest.Mock).mockReturnValue(mockProviders)

      mockType.defaultEnabled = false

      // User setting explicitly enables this type
      mockSettings.typesByProvider.set(
        'provider-1' as Ref<NotificationProvider>,
        [{ type: 'type-1' as Ref<NotificationType>, createdBy: 'social-1' as PersonId, enabled: true }] as any
      )

      const allowed = getAllowedProviders(mockClient, mockSettings, ['social-1' as PersonId], mockType)
      expect(allowed).toEqual(['provider-1'])
    })

    it('does not return provider if user settings explicitly disable type when type is default-enabled', () => {
      const mockProviders = [{ _id: 'provider-1' as Ref<NotificationProvider>, defaultEnabled: true }]
      ;(mockClient.model.findAllSync as jest.Mock).mockReturnValue(mockProviders)

      mockType.defaultEnabled = true

      // User setting explicitly disables this type
      mockSettings.typesByProvider.set(
        'provider-1' as Ref<NotificationProvider>,
        [{ type: 'type-1' as Ref<NotificationType>, createdBy: 'social-1' as PersonId, enabled: false }] as any
      )

      const allowed = getAllowedProviders(mockClient, mockSettings, ['social-1' as PersonId], mockType)
      expect(allowed).toEqual([])
    })
  })

  describe('isMatchedTxType', () => {
    let mockTx: TxCUD<Doc>
    let mockTxType: TxNotificationType

    beforeEach(() => {
      mockTx = {
        _class: 'TxClass',
        attachedToClass: 'AttachClass',
        objectClass: 'ObjClass'
      } as unknown as TxCUD<Doc>
      mockTxType = {
        txClasses: ['TxClass'],
        attachedToClass: 'AttachClass',
        objectClass: 'ObjClass'
      } as unknown as TxNotificationType
      ;(mockClient.hierarchy.isDerived as jest.Mock).mockReturnValue(true)
    })

    it('returns true if all fields match', () => {
      expect(isMatchedTxType(mockClient, mockTx, mockTxType)).toBe(true)
    })

    it('returns false if class is not in type.txClasses', () => {
      mockTxType.txClasses = ['OtherTxClass'] as unknown as Ref<Class<Doc>>[]
      expect(isMatchedTxType(mockClient, mockTx, mockTxType)).toBe(false)
    })

    it('returns false if attachedToClass does not derive', () => {
      ;(mockClient.hierarchy.isDerived as jest.Mock).mockImplementation(
        (actual: string, expected: string) => !(actual === 'AttachClass' && expected === 'AttachClass')
      )
      expect(isMatchedTxType(mockClient, mockTx, mockTxType)).toBe(false)
    })

    it('checks field values in transaction', () => {
      mockTxType.field = 'name'
      mockGetTxOperations.mockReturnValue({ name: 'new-val' })

      expect(isMatchedTxType(mockClient, mockTx, mockTxType)).toBe(true)
    })

    it('evaluates match query if type.match is specified', () => {
      mockTxType.match = { query: 'test' } as any
      mockMatchQuery.mockReturnValue(['matched-tx'])

      expect(isMatchedTxType(mockClient, mockTx, mockTxType)).toBe(true)
      expect(mockMatchQuery).toHaveBeenCalledWith([mockTx], mockTxType.match, mockTx._class, mockClient.hierarchy, true)
    })
  })

  describe('isTxTrigger', () => {
    let mockTx: TxCUD<Doc>

    beforeEach(() => {
      mockTx = {
        _class: 'TxClass',
        objectClass: 'ObjClass'
      } as unknown as TxCUD<Doc>
    })

    it('returns true if transaction class matches trigger classes', () => {
      const hierarchy = {
        isDerived: jest.fn().mockImplementation((actual, expected) => actual === expected)
      } as any

      expect(isTxTrigger(hierarchy, mockTx, ['ObjClass' as Ref<Class<Doc>>], [])).toBe(true)
      expect(isTxTrigger(hierarchy, mockTx, ['OtherClass' as Ref<Class<Doc>>], [])).toBe(false)
    })
  })

  describe('resolveNotifyProviders (internal call via getTxNotifyProviders / getMessageNotifyProviders)', () => {
    it('resolves message providers correctly', async () => {
      const mockProviders = [{ _id: 'provider-1' as Ref<NotificationProvider>, defaultEnabled: true }]
      ;(mockClient.model.findAllSync as jest.Mock).mockImplementation((cls: any) => {
        if (cls === notification.class.MessageNotificationType) {
          return [
            {
              _id: 'msg-type-1',
              messageClass: 'MessageClass',
              attachedToClass: 'AttachClass',
              objectClass: 'ObjClass',
              defaultEnabled: true
            }
          ]
        }
        if (cls === notification.class.NotificationProvider) {
          return mockProviders
        }
        return []
      })
      ;(mockClient.hierarchy.isDerived as jest.Mock).mockReturnValue(true)

      const message = {
        _class: 'MessageClass',
        attachedToClass: 'AttachClass',
        objectClass: 'ObjClass'
      } as unknown as ActivityMessage
      const doc = { _id: 'doc-1' } as unknown as Doc
      const receiver = { socialIds: ['receiver-social-1' as PersonId] } as unknown as Receiver
      const settings = {
        settingsByProvider: new Map(),
        typesByProvider: new Map()
      } as unknown as NotificationSettings

      const providers = await getMessageNotifyProviders(mockClient, message, doc, receiver, settings, 'all')

      expect(providers).toHaveProperty('provider-1')
      expect(providers['provider-1' as Ref<NotificationProvider>][0]._id).toBe('msg-type-1')
    })

    it('skips providers if mode is mentions and type is not mention', async () => {
      const mockProviders = [{ _id: 'provider-1' as Ref<NotificationProvider>, defaultEnabled: true }]
      ;(mockClient.model.findAllSync as jest.Mock).mockImplementation((cls: any) => {
        if (cls === notification.class.MessageNotificationType) {
          return [
            {
              _id: 'msg-type-1',
              messageClass: 'MessageClass',
              attachedToClass: 'AttachClass',
              objectClass: 'ObjClass',
              isMention: false,
              defaultEnabled: true
            }
          ]
        }
        if (cls === notification.class.NotificationProvider) {
          return mockProviders
        }
        return []
      })
      ;(mockClient.hierarchy.isDerived as jest.Mock).mockReturnValue(true)

      const message = {
        _class: 'MessageClass',
        attachedToClass: 'AttachClass',
        objectClass: 'ObjClass'
      } as unknown as ActivityMessage
      const doc = { _id: 'doc-1' } as unknown as Doc
      const receiver = { socialIds: ['receiver-social-1' as PersonId] } as unknown as Receiver
      const settings = {
        settingsByProvider: new Map(),
        typesByProvider: new Map()
      } as unknown as NotificationSettings

      const providers = await getMessageNotifyProviders(mockClient, message, doc, receiver, settings, 'mentions')

      expect(providers['provider-1' as Ref<NotificationProvider>]).toBeUndefined()
    })
  })
})

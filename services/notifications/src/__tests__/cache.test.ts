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

const mockGetClassCollaborators = jest.fn()
const mockIsDerived = jest.fn()
const mockHasClass = jest.fn()

let actualCore: any
const getActualCore = (): any => {
  actualCore ??= jest.requireActual('@hcengineering/core')
  return actualCore
}

jest.mock('@hcengineering/core', () => {
  return new Proxy(
    {},
    {
      get: (target, prop) => {
        if (prop === 'getClassCollaborators') {
          return mockGetClassCollaborators
        }
        if (prop === '__esModule') {
          return true
        }
        return getActualCore()[prop as keyof typeof import('@hcengineering/core')]
      }
    }
  ) as unknown as typeof import('@hcengineering/core')
})

import {
  Doc,
  Ref,
  Class,
  AccountUuid,
  PersonId,
  Space,
  TxCUD,
  TxCreateDoc,
  TxUpdateDoc,
  TxRemoveDoc,
  UserStatus,
  FindResult,
  WithLookup,
  Collaborator,
  MeasureContext,
  ClassCollaborators
} from '@hcengineering/core'
import notification, {
  DocNotifyContext,
  DocNotificationSetting,
  ReadState,
  PushSubscription,
  PushSubscriptionSetting,
  NotificationProviderSetting,
  NotificationTypeSetting,
  NotificationProvider
} from '@hcengineering/notification'
import contact, { Employee, PersonSpace, SocialIdentity, Person } from '@hcengineering/contact'

import WorkspaceCache from '../cache'
import { Client } from '../types'

describe('WorkspaceCache', () => {
  let mockClient: jest.Mocked<Client>
  let mockCtx: MeasureContext
  let cache: WorkspaceCache
  let core: typeof import('@hcengineering/core').default & {
    systemAccountUuid: typeof import('@hcengineering/core').systemAccountUuid
  }

  beforeAll(() => {
    const actual = getActualCore()

    const mockClassProperties = (obj: Record<string, unknown> | undefined, prefix: string): void => {
      if (obj != null && typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
          obj[key] = `${prefix}.${key}`
        }
      }
    }

    actual.default.class = { ...actual.default.class }
    mockClassProperties(actual.default.class, 'core.class')

    core = {
      ...actual.default,
      systemAccountUuid: actual.systemAccountUuid
    }

    notification.class = { ...notification.class }
    mockClassProperties(notification.class, 'notification.class')

    contact.class = { ...contact.class }
    mockClassProperties(contact.class, 'contact.class')

    contact.mixin = { ...contact.mixin }
    mockClassProperties(contact.mixin, 'contact.mixin')
  })

  beforeEach(() => {
    mockCtx = {
      error: jest.fn(),
      info: jest.fn()
    } as unknown as MeasureContext

    mockClient = {
      ctx: mockCtx,
      workspace: { url: 'ws-url' } as unknown as Client['workspace'],
      storage: {} as unknown as Client['storage'],
      model: {} as unknown as Client['model'],
      hierarchy: {
        isDerived: mockIsDerived,
        hasClass: mockHasClass,
        getBaseClass: jest.fn().mockImplementation((cls) => cls)
      } as unknown as Client['hierarchy'],
      txFactory: {} as unknown as Client['txFactory'],
      branding: { lastNameFirst: true, defaultLanguage: 'ru' } as unknown as Client['branding'],
      findAll: jest.fn(),
      findOne: jest.fn()
    }

    mockIsDerived.mockReset()
    mockIsDerived.mockReturnValue(false)

    mockHasClass.mockReset()
    mockHasClass.mockReturnValue(true)

    cache = new WorkspaceCache(mockCtx, mockClient)
    jest.clearAllMocks()
  })

  describe('getSettings', () => {
    it('loads settings from database on first call and caches them', async () => {
      const mockProviders = [
        { _id: 'p-1', attachedTo: 'p-1-ref' }
      ] as unknown as FindResult<NotificationProviderSetting>
      const mockTypes = [{ _id: 't-1', attachedTo: 't-1-ref' }] as unknown as FindResult<NotificationTypeSetting>

      mockClient.findAll.mockResolvedValueOnce(mockProviders).mockResolvedValueOnce(mockTypes)

      const settings = await cache.getSettings()

      expect(mockClient.findAll).toHaveBeenCalledWith(notification.class.NotificationProviderSetting, {})
      expect(mockClient.findAll).toHaveBeenCalledWith(notification.class.NotificationTypeSetting, {})
      expect(settings.providersSettings).toEqual(mockProviders)
      expect(settings.typesSettings).toEqual(mockTypes)
      expect(settings.settingsByProvider.get('p-1-ref' as Ref<NotificationProvider>)).toEqual(mockProviders)

      // Subsequent call should be loaded from cache
      mockClient.findAll.mockClear()
      const cachedSettings = await cache.getSettings()
      expect(mockClient.findAll).not.toHaveBeenCalled()
      expect(cachedSettings.providersSettings).toEqual(mockProviders)
    })
  })

  describe('getCollaborators', () => {
    it('returns empty array if class collaborators mixin is undefined', async () => {
      mockGetClassCollaborators.mockReturnValue(undefined)
      const result = await cache.getCollaborators('doc-1' as Ref<Doc>, 'DocClass' as Ref<Class<Doc>>)
      expect(result).toEqual([])
    })

    it('fetches collaborators and caches them', async () => {
      mockGetClassCollaborators.mockReturnValue({} as unknown as ClassCollaborators<Doc>)
      const mockCollabs = [{ _id: 'collab-1', attachedTo: 'doc-1' }] as unknown as FindResult<Collaborator>
      mockClient.findAll.mockResolvedValue(mockCollabs)

      const result = await cache.getCollaborators('doc-1' as Ref<Doc>, 'DocClass' as Ref<Class<Doc>>)

      expect(mockClient.findAll).toHaveBeenCalledWith(core.class.Collaborator, { attachedTo: 'doc-1' })
      expect(result).toEqual(mockCollabs)

      // Cached call
      mockClient.findAll.mockClear()
      const cached = await cache.getCollaborators('doc-1' as Ref<Doc>, 'DocClass' as Ref<Class<Doc>>)
      expect(mockClient.findAll).not.toHaveBeenCalled()
      expect(cached).toEqual(mockCollabs)
    })
  })

  describe('getDoc', () => {
    it('fetches and caches document', async () => {
      const mockDoc = { _id: 'doc-1', val: 'test' }
      mockClient.findOne.mockResolvedValue(mockDoc as unknown as WithLookup<Doc>)

      const doc1 = await cache.getDoc('doc-1' as Ref<Doc>, 'DocClass' as Ref<Class<Doc>>)
      expect(mockClient.findOne).toHaveBeenCalledWith('DocClass', { _id: 'doc-1' })
      expect(doc1).toEqual(mockDoc)

      mockClient.findOne.mockClear()
      const doc2 = await cache.getDoc('doc-1' as Ref<Doc>, 'DocClass' as Ref<Class<Doc>>)
      expect(mockClient.findOne).not.toHaveBeenCalled()
      expect(doc2).toEqual(mockDoc)
    })

    it('returns undefined without querying when class is unknown to hierarchy', async () => {
      mockHasClass.mockReturnValue(false)

      const doc = await cache.getDoc('doc-1' as Ref<Doc>, 'MissingClass' as Ref<Class<Doc>>)

      expect(doc).toBeUndefined()
      expect(mockClient.findOne).not.toHaveBeenCalled()
    })
  })

  describe('getContexts', () => {
    it('fetches and caches contexts', async () => {
      const mockContexts = [{ _id: 'ctx-1', objectId: 'doc-1' }] as unknown as FindResult<DocNotifyContext>
      mockClient.findAll.mockResolvedValue(mockContexts)

      const result = await cache.getContexts('doc-1' as Ref<Doc>)
      expect(mockClient.findAll).toHaveBeenCalledWith(notification.class.DocNotifyContext, { objectId: 'doc-1' })
      expect(result).toEqual(mockContexts)

      mockClient.findAll.mockClear()
      const cached = await cache.getContexts('doc-1' as Ref<Doc>)
      expect(mockClient.findAll).not.toHaveBeenCalled()
      expect(cached).toEqual(mockContexts)
    })
  })

  describe('getDocSettings', () => {
    it('fetches and caches notification settings', async () => {
      const mockSettings = [{ _id: 'set-1', attachedTo: 'doc-1' }] as unknown as FindResult<DocNotificationSetting>
      mockClient.findAll.mockResolvedValue(mockSettings)

      const result = await cache.getDocSettings('doc-1' as Ref<Doc>)
      expect(mockClient.findAll).toHaveBeenCalledWith(notification.class.DocNotificationSetting, {
        attachedTo: 'doc-1'
      })
      expect(result).toEqual(mockSettings)

      mockClient.findAll.mockClear()
      const cached = await cache.getDocSettings('doc-1' as Ref<Doc>)
      expect(mockClient.findAll).not.toHaveBeenCalled()
      expect(cached).toEqual(mockSettings)
    })
  })

  describe('getDocSpace', () => {
    it('returns document itself if it is derived from Space', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation((cls: unknown, target: unknown) => cls === 'SpaceClass' && target === core.class.Space)
      const doc = { _id: 'space-1', _class: 'SpaceClass' } as unknown as Doc

      const space = await cache.getDocSpace(doc)
      expect(space).toBe(doc)
    })

    it('fetches and caches space document if attached to a document', async () => {
      const doc = { _id: 'doc-1', space: 'space-1' } as unknown as Doc
      const spaceDoc = { _id: 'space-1', _class: 'SpaceClass' }
      mockClient.findOne.mockResolvedValue(spaceDoc as unknown as WithLookup<Space>)

      const space1 = await cache.getDocSpace(doc)
      expect(mockClient.findOne).toHaveBeenCalledWith(core.class.Space, { _id: 'space-1' }, { limit: 1 })
      expect(space1).toEqual(spaceDoc)
    })
  })

  describe('getDocReadState', () => {
    it('fetches and caches read state for attached doc', async () => {
      const readState = { _id: 'rs-1', attachedTo: 'doc-1' }
      mockClient.findOne.mockResolvedValue(readState as unknown as WithLookup<ReadState>)

      const rs = await cache.getDocReadState('doc-1' as Ref<Doc>)
      expect(mockClient.findOne).toHaveBeenCalledWith(notification.class.ReadState, { attachedTo: 'doc-1' })
      expect(rs).toEqual(readState)

      // Fetch by read state ID directly
      const byId = await cache.getReadState('rs-1' as Ref<ReadState>)
      expect(byId).toEqual(readState)
    })
  })

  describe('findPersonSpace', () => {
    it('fetches and caches person space', async () => {
      const personSpace = { _id: 'ps-1', account: 'acc-1' }
      mockClient.findOne.mockResolvedValue(personSpace as unknown as WithLookup<PersonSpace>)

      const ps = await cache.findPersonSpace('ps-1' as Ref<PersonSpace>)
      expect(mockClient.findOne).toHaveBeenCalledWith(contact.class.PersonSpace, { _id: 'ps-1' })
      expect(ps).toEqual(personSpace)
    })
  })

  describe('getPushSubscriptions', () => {
    it('returns empty array if no subscriptions found', async () => {
      mockClient.findAll.mockResolvedValue([] as unknown as FindResult<PushSubscription>)

      const result = await cache.getPushSubscriptions('acc-1' as AccountUuid)
      expect(result).toEqual([])
    })

    it('fetches and filters subscriptions by enabled setting', async () => {
      const sub1 = { _id: 'sub-1', user: 'acc-1' } as unknown as PushSubscription
      const sub2 = { _id: 'sub-2', user: 'acc-1' } as unknown as PushSubscription
      const setting1 = { attachedTo: 'sub-1', enabled: true } as unknown as PushSubscriptionSetting
      const setting2 = { attachedTo: 'sub-2', enabled: false } as unknown as PushSubscriptionSetting

      mockClient.findAll
        .mockResolvedValueOnce([sub1, sub2] as unknown as FindResult<PushSubscription>)
        .mockResolvedValueOnce([setting1, setting2] as unknown as FindResult<PushSubscriptionSetting>)

      const result = await cache.getPushSubscriptions('acc-1' as AccountUuid)
      expect(result).toEqual([sub1])
    })
  })

  describe('getSender', () => {
    it('resolves system sender immediately', async () => {
      const sender = await cache.getSender(core.account.System)
      expect(sender.socialId).toBe(core.account.System)
      expect(sender.account).toBe(core.systemAccountUuid)
    })

    it('resolves sender utilizing social identity lookup', async () => {
      const socialIdentity = { _id: 'social-1', attachedTo: 'emp-1' }
      const employee = { _id: 'emp-1', personUuid: 'acc-1' }
      const person = { _id: 'person-1', personUuid: 'acc-1' }

      mockClient.findOne
        .mockResolvedValueOnce(socialIdentity as unknown as WithLookup<SocialIdentity>)
        .mockResolvedValueOnce(employee as unknown as WithLookup<Employee>)
        .mockResolvedValueOnce(person as unknown as WithLookup<Person>)

      const sender = await cache.getSender('social-1' as PersonId)
      expect(sender.account).toBe('acc-1')
      expect(sender.person).toEqual(person)
    })
  })

  describe('tx CUD events handling', () => {
    it('ignores transaction if it is register under service transactions', () => {
      const tx = { _id: 'tx-1', _class: core.class.TxCreateDoc } as unknown as TxCUD<Doc>
      cache.tx(tx, true) // registers as service tx
      mockIsDerived.mockClear()

      cache.tx(tx) // should ignore and delete registry
      expect(mockIsDerived).not.toHaveBeenCalled()
    })

    it('handles TxCreateDoc collaborator creation', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'CollabClass' && target === core.class.Collaborator
        )

      const collab = { _id: 'collab-1', _class: 'CollabClass', attachedTo: 'doc-1' }
      const tx = {
        _id: 'tx-2',
        _class: core.class.TxCreateDoc,
        objectId: 'collab-1',
        objectClass: 'CollabClass',
        attributes: collab
      } as unknown as TxCreateDoc<Doc>

      // Seed mock collaborators list into cache
      mockGetClassCollaborators.mockReturnValue({} as unknown as ClassCollaborators<Doc>)
      mockClient.findAll.mockResolvedValue([] as unknown as FindResult<Collaborator>)
      await cache.getCollaborators('doc-1' as Ref<Doc>, 'DocClass' as Ref<Class<Doc>>)

      cache.tx(tx)

      const updated = await cache.getCollaborators('doc-1' as Ref<Doc>, 'DocClass' as Ref<Class<Doc>>)
      expect(updated).toEqual([collab])
    })

    it('handles TxUpdateDoc collaborator updates', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'CollabClass' && target === core.class.Collaborator
        )

      const collab = {
        _id: 'collab-1',
        _class: 'CollabClass',
        attachedTo: 'doc-1',
        name: 'John'
      } as unknown as Collaborator
      const tx = {
        _id: 'tx-3',
        _class: core.class.TxUpdateDoc,
        objectId: 'collab-1',
        objectClass: 'CollabClass',
        operations: { name: 'Johnny' }
      } as unknown as TxUpdateDoc<Doc>

      // Seed collab into cache
      mockGetClassCollaborators.mockReturnValue({} as unknown as ClassCollaborators<Doc>)
      mockClient.findAll.mockResolvedValue([collab] as unknown as FindResult<Collaborator>)
      await cache.getCollaborators('doc-1' as Ref<Doc>, 'DocClass' as Ref<Class<Doc>>)

      cache.tx(tx)

      const updated = await cache.getCollaborators('doc-1' as Ref<Doc>, 'DocClass' as Ref<Class<Doc>>)
      expect(updated[0]).toEqual({
        _id: 'collab-1',
        _class: 'CollabClass',
        attachedTo: 'doc-1',
        name: 'Johnny'
      })
    })

    it('handles TxRemoveDoc collaborator removal', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'CollabClass' && target === core.class.Collaborator
        )

      const collab = { _id: 'collab-1', _class: 'CollabClass', attachedTo: 'doc-1' } as unknown as Collaborator
      const tx = {
        _id: 'tx-4',
        _class: core.class.TxRemoveDoc,
        objectId: 'collab-1',
        objectClass: 'CollabClass'
      } as unknown as TxRemoveDoc<Doc>

      // Seed collab into cache
      mockGetClassCollaborators.mockReturnValue({} as unknown as ClassCollaborators<Doc>)
      mockClient.findAll.mockResolvedValue([collab] as unknown as FindResult<Collaborator>)
      await cache.getCollaborators('doc-1' as Ref<Doc>, 'DocClass' as Ref<Class<Doc>>)

      cache.tx(tx)

      const updated = await cache.getCollaborators('doc-1' as Ref<Doc>, 'DocClass' as Ref<Class<Doc>>)
      expect(updated).toEqual([])
    })

    it('handles TxCreateDoc ReadState creation', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'ReadStateClass' && target === notification.class.ReadState
        )

      const readState = { _id: 'rs-1', _class: 'ReadStateClass', attachedTo: 'doc-1' } as unknown as ReadState
      const tx = {
        _id: 'tx-rs',
        _class: core.class.TxCreateDoc,
        objectId: 'rs-1',
        objectClass: 'ReadStateClass',
        attributes: readState
      } as unknown as TxCreateDoc<Doc>

      cache.tx(tx)

      const rs = await cache.getDocReadState('doc-1' as Ref<Doc>)
      expect(rs).toEqual(readState)
    })

    it('handles TxCreateDoc DocNotifyContext creation', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'NotifyCtxClass' && target === notification.class.DocNotifyContext
        )

      const context = { _id: 'ctx-1', _class: 'NotifyCtxClass', objectId: 'doc-1' } as unknown as DocNotifyContext
      const tx = {
        _id: 'tx-ctx',
        _class: core.class.TxCreateDoc,
        objectId: 'ctx-1',
        objectClass: 'NotifyCtxClass',
        attributes: context
      } as unknown as TxCreateDoc<Doc>

      // Seed mock context list into cache
      mockClient.findAll.mockResolvedValue([] as unknown as FindResult<DocNotifyContext>)
      await cache.getContexts('doc-1' as Ref<Doc>)

      cache.tx(tx)

      const updated = await cache.getContexts('doc-1' as Ref<Doc>)
      expect(updated).toEqual([context])
    })

    it('handles TxCreateDoc DocNotificationSetting creation', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) =>
            cls === 'SettingClass' && target === notification.class.DocNotificationSetting
        )

      const setting = { _id: 'set-1', _class: 'SettingClass', attachedTo: 'doc-1' } as unknown as DocNotificationSetting
      const tx = {
        _id: 'tx-set',
        _class: core.class.TxCreateDoc,
        objectId: 'set-1',
        objectClass: 'SettingClass',
        attributes: setting
      } as unknown as TxCreateDoc<Doc>

      // Seed mock settings list into cache
      mockClient.findAll.mockResolvedValue([] as unknown as FindResult<DocNotificationSetting>)
      await cache.getDocSettings('doc-1' as Ref<Doc>)

      cache.tx(tx)

      const updated = await cache.getDocSettings('doc-1' as Ref<Doc>)
      expect(updated).toEqual([setting])
    })

    it('handles TxCreateDoc NotificationProviderSetting creation', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) =>
            cls === 'ProviderSettingClass' && target === notification.class.NotificationProviderSetting
        )

      const providerSetting = {
        _id: 'p-1',
        _class: 'ProviderSettingClass',
        attachedTo: 'p-ref'
      } as unknown as NotificationProviderSetting
      const tx = {
        _id: 'tx-p',
        _class: core.class.TxCreateDoc,
        objectId: 'p-1',
        objectClass: 'ProviderSettingClass',
        attributes: providerSetting
      } as unknown as TxCreateDoc<Doc>

      // Seed settings map
      mockClient.findAll
        .mockResolvedValueOnce([] as unknown as FindResult<NotificationProviderSetting>)
        .mockResolvedValueOnce([] as unknown as FindResult<NotificationTypeSetting>)
      await cache.getSettings()

      cache.tx(tx)

      const settings = await cache.getSettings()
      expect(settings.providersSettings).toEqual([providerSetting])
    })

    it('handles TxCreateDoc NotificationTypeSetting creation', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) =>
            cls === 'TypeSettingClass' && target === notification.class.NotificationTypeSetting
        )

      const typeSetting = {
        _id: 't-1',
        _class: 'TypeSettingClass',
        attachedTo: 't-ref'
      } as unknown as NotificationTypeSetting
      const tx = {
        _id: 'tx-t',
        _class: core.class.TxCreateDoc,
        objectId: 't-1',
        objectClass: 'TypeSettingClass',
        attributes: typeSetting
      } as unknown as TxCreateDoc<Doc>

      // Seed settings map
      mockClient.findAll
        .mockResolvedValueOnce([] as unknown as FindResult<NotificationProviderSetting>)
        .mockResolvedValueOnce([] as unknown as FindResult<NotificationTypeSetting>)
      await cache.getSettings()

      cache.tx(tx)

      const settings = await cache.getSettings()
      expect(settings.typesSettings).toEqual([typeSetting])
    })

    it('handles TxCreateDoc PersonSpace creation', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'PersonSpaceClass' && target === contact.class.PersonSpace
        )

      const personSpace = { _id: 'ps-1', _class: 'PersonSpaceClass', account: 'acc-1' } as unknown as PersonSpace
      const tx = {
        _id: 'tx-ps',
        _class: core.class.TxCreateDoc,
        objectId: 'ps-1',
        objectClass: 'PersonSpaceClass',
        attributes: personSpace
      } as unknown as TxCreateDoc<Doc>

      cache.tx(tx)

      const result = await cache.findPersonSpace('ps-1' as Ref<PersonSpace>)
      expect(result).toEqual(personSpace)
    })

    it('handles TxCreateDoc UserStatus creation', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'UserStatusClass' && target === core.class.UserStatus
        )

      const status = { _id: 'us-1', _class: 'UserStatusClass', user: 'acc-1', online: true } as unknown as UserStatus
      const tx = {
        _id: 'tx-us',
        _class: core.class.TxCreateDoc,
        objectId: 'us-1',
        objectClass: 'UserStatusClass',
        attributes: status
      } as unknown as TxCreateDoc<Doc>

      cache.tx(tx)

      const statuses = await cache.getUserStatuses()
      expect(statuses).toEqual([status])
    })

    it('handles TxUpdateDoc document cache updates', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass', val: 'old' }
      mockClient.findOne.mockResolvedValue(doc as unknown as WithLookup<Doc>)
      await cache.getDoc('doc-1' as Ref<Doc>, 'DocClass' as Ref<Class<Doc>>)

      const tx = {
        _id: 'tx-update-doc',
        _class: core.class.TxUpdateDoc,
        objectId: 'doc-1',
        objectClass: 'DocClass',
        operations: { val: 'new' }
      } as unknown as TxUpdateDoc<Doc>

      cache.tx(tx)

      const updated = await cache.getDoc('doc-1' as Ref<Doc>, 'DocClass' as Ref<Class<Doc>>)
      expect((updated as unknown as { val: string })?.val).toBe('new')
    })

    it('handles TxUpdateDoc ReadState updates', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'ReadStateClass' && target === notification.class.ReadState
        )

      const readState = {
        _id: 'rs-1',
        _class: 'ReadStateClass',
        attachedTo: 'doc-1',
        unread: true
      } as unknown as ReadState
      mockClient.findOne.mockResolvedValue(readState as unknown as WithLookup<ReadState>)
      await cache.getDocReadState('doc-1' as Ref<Doc>)

      const tx = {
        _id: 'tx-update-rs',
        _class: core.class.TxUpdateDoc,
        objectId: 'rs-1',
        objectClass: 'ReadStateClass',
        operations: { unread: false }
      } as unknown as TxUpdateDoc<Doc>

      cache.tx(tx)

      const updated = await cache.getDocReadState('doc-1' as Ref<Doc>)
      expect((updated as unknown as { unread: boolean })?.unread).toBe(false)
    })

    it('handles TxUpdateDoc DocNotifyContext updates', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'NotifyCtxClass' && target === notification.class.DocNotifyContext
        )

      const context = {
        _id: 'ctx-1',
        _class: 'NotifyCtxClass',
        objectId: 'doc-1',
        objectTitle: 'old',
        modifiedOn: 10
      } as unknown as DocNotifyContext
      mockClient.findAll.mockResolvedValue([context] as unknown as FindResult<DocNotifyContext>)
      await cache.getContexts('doc-1' as Ref<Doc>)

      const tx = {
        _id: 'tx-update-ctx',
        _class: core.class.TxUpdateDoc,
        objectId: 'ctx-1',
        objectClass: 'NotifyCtxClass',
        operations: { objectTitle: 'new' },
        modifiedOn: 20
      } as unknown as TxUpdateDoc<Doc>

      cache.tx(tx)

      const updated = await cache.getContexts('doc-1' as Ref<Doc>)
      expect(updated[0].objectTitle).toBe('new')
    })

    it('invalidates DocNotifyContext on outdated update transaction', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'NotifyCtxClass' && target === notification.class.DocNotifyContext
        )

      const context = {
        _id: 'ctx-1',
        _class: 'NotifyCtxClass',
        objectId: 'doc-1',
        objectTitle: 'old',
        modifiedOn: 100
      } as unknown as DocNotifyContext
      mockClient.findAll.mockResolvedValue([context] as unknown as FindResult<DocNotifyContext>)
      await cache.getContexts('doc-1' as Ref<Doc>)

      const tx = {
        _id: 'tx-update-ctx-old',
        _class: core.class.TxUpdateDoc,
        objectId: 'ctx-1',
        objectClass: 'NotifyCtxClass',
        operations: { objectTitle: 'new' },
        modifiedOn: 50 // transaction modifiedOn < cached modifiedOn
      } as unknown as TxUpdateDoc<Doc>

      cache.tx(tx)

      // It should invalidate the cache (i.e. subsequent call triggers findAll again)
      mockClient.findAll.mockClear()
      mockClient.findAll.mockResolvedValue([] as unknown as FindResult<DocNotifyContext>)
      await cache.getContexts('doc-1' as Ref<Doc>)
      expect(mockClient.findAll).toHaveBeenCalled()
    })

    it('handles TxUpdateDoc DocNotificationSetting updates', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) =>
            cls === 'SettingClass' && target === notification.class.DocNotificationSetting
        )

      const setting = {
        _id: 'set-1',
        _class: 'SettingClass',
        attachedTo: 'doc-1',
        enabled: true
      } as unknown as DocNotificationSetting
      mockClient.findAll.mockResolvedValue([setting] as unknown as FindResult<DocNotificationSetting>)
      await cache.getDocSettings('doc-1' as Ref<Doc>)

      const tx = {
        _id: 'tx-update-set',
        _class: core.class.TxUpdateDoc,
        objectId: 'set-1',
        objectClass: 'SettingClass',
        operations: { enabled: false }
      } as unknown as TxUpdateDoc<Doc>

      cache.tx(tx)

      const updated = await cache.getDocSettings('doc-1' as Ref<Doc>)
      expect((updated[0] as unknown as { enabled: boolean }).enabled).toBe(false)
    })

    it('handles TxUpdateDoc NotificationProviderSetting updates', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) =>
            cls === 'ProviderSettingClass' && target === notification.class.NotificationProviderSetting
        )

      const providerSetting = {
        _id: 'p-1',
        _class: 'ProviderSettingClass',
        attachedTo: 'p-ref',
        enabled: true
      } as unknown as NotificationProviderSetting
      mockClient.findAll
        .mockResolvedValueOnce([providerSetting] as unknown as FindResult<NotificationProviderSetting>)
        .mockResolvedValueOnce([] as unknown as FindResult<NotificationTypeSetting>)
      await cache.getSettings()

      const tx = {
        _id: 'tx-update-p',
        _class: core.class.TxUpdateDoc,
        objectId: 'p-1',
        objectClass: 'ProviderSettingClass',
        operations: { enabled: false }
      } as unknown as TxUpdateDoc<Doc>

      cache.tx(tx)

      const settings = await cache.getSettings()
      expect(settings.providersSettings[0].enabled).toBe(false)
    })

    it('handles TxUpdateDoc NotificationTypeSetting updates', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) =>
            cls === 'TypeSettingClass' && target === notification.class.NotificationTypeSetting
        )

      const typeSetting = {
        _id: 't-1',
        _class: 'TypeSettingClass',
        attachedTo: 't-ref',
        enabled: true
      } as unknown as NotificationTypeSetting
      mockClient.findAll
        .mockResolvedValueOnce([] as unknown as FindResult<NotificationProviderSetting>)
        .mockResolvedValueOnce([typeSetting] as unknown as FindResult<NotificationTypeSetting>)
      await cache.getSettings()

      const tx = {
        _id: 'tx-update-t',
        _class: core.class.TxUpdateDoc,
        objectId: 't-1',
        objectClass: 'TypeSettingClass',
        operations: { enabled: false }
      } as unknown as TxUpdateDoc<Doc>

      cache.tx(tx)

      const settings = await cache.getSettings()
      expect(settings.typesSettings[0].enabled).toBe(false)
    })

    it('handles TxUpdateDoc PersonSpace updates', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'PersonSpaceClass' && target === contact.class.PersonSpace
        )

      const personSpace = {
        _id: 'ps-1',
        _class: 'PersonSpaceClass',
        account: 'acc-1',
        space: 'old-space'
      } as unknown as PersonSpace
      mockClient.findOne.mockResolvedValue(personSpace as unknown as WithLookup<PersonSpace>)
      await cache.findPersonSpace('ps-1' as Ref<PersonSpace>)

      const tx = {
        _id: 'tx-update-ps',
        _class: core.class.TxUpdateDoc,
        objectId: 'ps-1',
        objectClass: 'PersonSpaceClass',
        operations: { space: 'new-space' }
      } as unknown as TxUpdateDoc<Doc>

      cache.tx(tx)

      const updated = await cache.findPersonSpace('ps-1' as Ref<PersonSpace>)
      expect(updated?.space).toBe('new-space')
    })

    it('handles TxUpdateDoc UserStatus updates', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'UserStatusClass' && target === core.class.UserStatus
        )

      const status = { _id: 'us-1', _class: 'UserStatusClass', user: 'acc-1', online: false } as unknown as UserStatus
      mockClient.findAll.mockResolvedValue([status] as unknown as FindResult<UserStatus>)
      await cache.getUserStatuses()

      const tx = {
        _id: 'tx-update-us',
        _class: core.class.TxUpdateDoc,
        objectId: 'us-1',
        objectClass: 'UserStatusClass',
        operations: { online: true }
      } as unknown as TxUpdateDoc<Doc>

      cache.tx(tx)

      const statuses = await cache.getUserStatuses()
      expect(statuses[0].online).toBe(true)
    })

    it('handles TxUpdateDoc Person updates', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation((cls: unknown, target: unknown) => cls === 'PersonClass' && target === contact.class.Person)

      const socialIdentity = { _id: 'social-1', attachedTo: 'emp-1' } as unknown as SocialIdentity
      const employee = { _id: 'emp-1', personUuid: 'acc-1' } as unknown as Employee
      const person = { _id: 'person-1', personUuid: 'acc-1', name: 'OldName' } as unknown as Person

      mockClient.findOne
        .mockResolvedValueOnce(socialIdentity as unknown as WithLookup<SocialIdentity>)
        .mockResolvedValueOnce(employee as unknown as WithLookup<Employee>)
        .mockResolvedValueOnce(person as unknown as WithLookup<Person>)

      await cache.getSender('social-1' as PersonId)

      const tx = {
        _id: 'tx-update-p',
        _class: core.class.TxUpdateDoc,
        objectId: 'person-1',
        objectClass: 'PersonClass',
        operations: { name: 'NewName' }
      } as unknown as TxUpdateDoc<Doc>

      cache.tx(tx)

      const sender = await cache.getSender('social-1' as PersonId)
      expect(sender.person?.name).toBe('NewName')
    })

    it('handles TxRemoveDoc ReadState removal', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'ReadStateClass' && target === notification.class.ReadState
        )

      const readState = { _id: 'rs-1', _class: 'ReadStateClass', attachedTo: 'doc-1' } as unknown as ReadState
      mockClient.findOne.mockResolvedValue(readState as unknown as WithLookup<ReadState>)
      await cache.getDocReadState('doc-1' as Ref<Doc>)

      const tx = {
        _id: 'tx-remove-rs',
        _class: core.class.TxRemoveDoc,
        objectId: 'rs-1',
        objectClass: 'ReadStateClass'
      } as unknown as TxRemoveDoc<Doc>

      cache.tx(tx)

      mockClient.findOne.mockClear()
      mockClient.findOne.mockResolvedValue(undefined)
      const removed = await cache.getDocReadState('doc-1' as Ref<Doc>)
      expect(removed).toBeUndefined()
    })

    it('handles TxRemoveDoc DocNotifyContext removal', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'NotifyCtxClass' && target === notification.class.DocNotifyContext
        )

      const context = { _id: 'ctx-1', _class: 'NotifyCtxClass', objectId: 'doc-1' } as unknown as DocNotifyContext
      mockClient.findAll.mockResolvedValue([context] as unknown as FindResult<DocNotifyContext>)
      await cache.getContexts('doc-1' as Ref<Doc>)

      const tx = {
        _id: 'tx-remove-ctx',
        _class: core.class.TxRemoveDoc,
        objectId: 'ctx-1',
        objectClass: 'NotifyCtxClass'
      } as unknown as TxRemoveDoc<Doc>

      cache.tx(tx)

      const contexts = await cache.getContexts('doc-1' as Ref<Doc>)
      expect(contexts).toEqual([])
    })

    it('handles TxRemoveDoc DocNotificationSetting removal', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) =>
            cls === 'SettingClass' && target === notification.class.DocNotificationSetting
        )

      const setting = { _id: 'set-1', _class: 'SettingClass', attachedTo: 'doc-1' } as unknown as DocNotificationSetting
      mockClient.findAll.mockResolvedValue([setting] as unknown as FindResult<DocNotificationSetting>)
      await cache.getDocSettings('doc-1' as Ref<Doc>)

      const tx = {
        _id: 'tx-remove-set',
        _class: core.class.TxRemoveDoc,
        objectId: 'set-1',
        objectClass: 'SettingClass'
      } as unknown as TxRemoveDoc<Doc>

      cache.tx(tx)

      const settings = await cache.getDocSettings('doc-1' as Ref<Doc>)
      expect(settings).toEqual([])
    })

    it('handles TxRemoveDoc NotificationProviderSetting removal', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) =>
            cls === 'ProviderSettingClass' && target === notification.class.NotificationProviderSetting
        )

      const providerSetting = {
        _id: 'p-1',
        _class: 'ProviderSettingClass',
        attachedTo: 'p-ref'
      } as unknown as NotificationProviderSetting
      mockClient.findAll
        .mockResolvedValueOnce([providerSetting] as unknown as FindResult<NotificationProviderSetting>)
        .mockResolvedValueOnce([] as unknown as FindResult<NotificationTypeSetting>)
      await cache.getSettings()

      const tx = {
        _id: 'tx-remove-p',
        _class: core.class.TxRemoveDoc,
        objectId: 'p-1',
        objectClass: 'ProviderSettingClass'
      } as unknown as TxRemoveDoc<Doc>

      cache.tx(tx)

      const settings = await cache.getSettings()
      expect(settings.providersSettings).toEqual([])
    })

    it('handles TxRemoveDoc NotificationTypeSetting removal', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) =>
            cls === 'TypeSettingClass' && target === notification.class.NotificationTypeSetting
        )

      const typeSetting = {
        _id: 't-1',
        _class: 'TypeSettingClass',
        attachedTo: 't-ref'
      } as unknown as NotificationTypeSetting
      mockClient.findAll
        .mockResolvedValueOnce([] as unknown as FindResult<NotificationProviderSetting>)
        .mockResolvedValueOnce([typeSetting] as unknown as FindResult<NotificationTypeSetting>)
      await cache.getSettings()

      const tx = {
        _id: 'tx-remove-t',
        _class: core.class.TxRemoveDoc,
        objectId: 't-1',
        objectClass: 'TypeSettingClass'
      } as unknown as TxRemoveDoc<Doc>

      cache.tx(tx)

      const settings = await cache.getSettings()
      expect(settings.typesSettings).toEqual([])
    })

    it('handles TxRemoveDoc PersonSpace removal', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'PersonSpaceClass' && target === contact.class.PersonSpace
        )

      const personSpace = { _id: 'ps-1', _class: 'PersonSpaceClass', account: 'acc-1' } as unknown as PersonSpace
      mockClient.findOne.mockResolvedValue(personSpace as unknown as WithLookup<PersonSpace>)
      await cache.findPersonSpace('ps-1' as Ref<PersonSpace>)

      const tx = {
        _id: 'tx-remove-ps',
        _class: core.class.TxRemoveDoc,
        objectId: 'ps-1',
        objectClass: 'PersonSpaceClass'
      } as unknown as TxRemoveDoc<Doc>

      cache.tx(tx)

      mockClient.findOne.mockClear().mockResolvedValue(undefined)
      const removed = await cache.findPersonSpace('ps-1' as Ref<PersonSpace>)
      expect(removed).toBeUndefined()
    })

    it('handles TxRemoveDoc UserStatus removal', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'UserStatusClass' && target === core.class.UserStatus
        )

      const status = { _id: 'us-1', _class: 'UserStatusClass', user: 'acc-1' } as unknown as UserStatus
      mockClient.findAll.mockResolvedValue([status] as unknown as FindResult<UserStatus>)
      await cache.getUserStatuses()

      const tx = {
        _id: 'tx-remove-us',
        _class: core.class.TxRemoveDoc,
        objectId: 'us-1',
        objectClass: 'UserStatusClass'
      } as unknown as TxRemoveDoc<Doc>

      cache.tx(tx)

      mockClient.findAll.mockClear().mockResolvedValue([] as unknown as FindResult<UserStatus>)
      const statuses = await cache.getUserStatuses()
      expect(statuses).toEqual([])
    })

    it('handles TxRemoveDoc Person and SocialIdentity removal', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) =>
            (cls === 'PersonClass' && target === contact.class.Person) ||
            (cls === 'SocialIdentityClass' && target === contact.class.SocialIdentity)
        )

      const socialIdentity = {
        _id: 'social-1',
        _class: 'SocialIdentityClass',
        attachedTo: 'emp-1'
      } as unknown as SocialIdentity
      const employee = { _id: 'emp-1', personUuid: 'acc-1' } as unknown as Employee
      const person = { _id: 'person-1', _class: 'PersonClass', personUuid: 'acc-1' } as unknown as Person

      mockClient.findOne
        .mockResolvedValueOnce(socialIdentity as unknown as WithLookup<SocialIdentity>)
        .mockResolvedValueOnce(employee as unknown as WithLookup<Employee>)
        .mockResolvedValueOnce(person as unknown as WithLookup<Person>)

      await cache.getSender('social-1' as PersonId)

      // Test Person removal
      const txPerson = {
        _id: 'tx-remove-person',
        _class: core.class.TxRemoveDoc,
        objectId: 'person-1',
        objectClass: 'PersonClass'
      } as unknown as TxRemoveDoc<Doc>

      cache.tx(txPerson)

      // Test SocialIdentity removal
      const txSocial = {
        _id: 'tx-remove-social',
        _class: core.class.TxRemoveDoc,
        objectId: 'social-1',
        objectClass: 'SocialIdentityClass'
      } as unknown as TxRemoveDoc<Doc>

      cache.tx(txSocial)

      mockClient.findOne.mockClear().mockResolvedValue(undefined)
      const sender = await cache.getSender('social-1' as PersonId)
      expect(sender.person).toBeUndefined()
    })

    it('clears push subscriptions cache on PushSubscription CUD events', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === 'PushSubClass' && target === notification.class.PushSubscription
        )

      const sub1 = { _id: 'sub-1', user: 'acc-1' } as unknown as PushSubscription
      mockClient.findAll.mockResolvedValue([sub1] as unknown as FindResult<PushSubscription>)
      await cache.getPushSubscriptions('acc-1' as AccountUuid)

      const tx = {
        _id: 'tx-push-create',
        _class: core.class.TxCreateDoc,
        objectId: 'sub-1',
        objectClass: 'PushSubClass',
        attributes: sub1
      } as unknown as TxCreateDoc<Doc>

      cache.tx(tx)

      mockClient.findAll.mockClear().mockResolvedValue([] as unknown as FindResult<PushSubscription>)
      await cache.getPushSubscriptions('acc-1' as AccountUuid)
      expect(mockClient.findAll).toHaveBeenCalled()
    })
  })

  describe('getReceivers active employee filtering', () => {
    const ACC = 'acc-1' as AccountUuid

    /** Wires the four sequential findAll calls getReceivers performs. */
    const mockReceiverLookups = (employees: unknown[]): void => {
      mockClient.findAll
        .mockResolvedValue([] as unknown as FindResult<Doc>)
        .mockResolvedValueOnce(employees as unknown as FindResult<Employee>)
        .mockResolvedValueOnce([
          { _id: 'space-1', person: 'emp-1', account: ACC }
        ] as unknown as FindResult<PersonSpace>)
        .mockResolvedValueOnce([{ _id: 'social-1', attachedTo: 'emp-1' }] as unknown as FindResult<SocialIdentity>)
        .mockResolvedValueOnce([] as unknown as FindResult<UserStatus>)
    }

    it('requests the active flag so cached records can be re-checked later', async () => {
      mockReceiverLookups([{ _id: 'emp-1', personUuid: ACC, role: 'USER', active: true }])

      await cache.getReceivers([ACC])

      expect(mockClient.findAll).toHaveBeenCalledWith(
        contact.mixin.Employee,
        { personUuid: { $in: [ACC] }, active: true },
        { projection: { _id: 1, personUuid: 1, role: 1, active: 1 } }
      )
    })

    it('returns a receiver for an active employee', async () => {
      mockReceiverLookups([{ _id: 'emp-1', personUuid: ACC, role: 'USER', active: true }])

      const receivers = await cache.getReceivers([ACC])

      expect(receivers).toHaveLength(1)
      expect(receivers[0].account).toBe(ACC)
      expect(receivers[0].employeeRef).toBe('emp-1')
    })

    it('drops an employee that is inactive in the freshly loaded batch', async () => {
      mockReceiverLookups([{ _id: 'emp-1', personUuid: ACC, role: 'USER', active: false }])

      expect(await cache.getReceivers([ACC])).toEqual([])
    })

    it('treats a deactivating TxMixin as removing the receiver', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation((cls: unknown, target: unknown) => cls === 'PersonClass' && target === contact.class.Person)

      mockReceiverLookups([{ _id: 'emp-1', personUuid: ACC, role: 'USER', active: true }])
      expect(await cache.getReceivers([ACC])).toHaveLength(1)

      // The employee is deactivated. The mixin tx carries the Person class,
      // since Employee is a mixin over Person.
      cache.tx({
        _id: 'tx-deactivate',
        _class: core.class.TxMixin,
        objectId: 'emp-1',
        objectClass: 'PersonClass',
        mixin: contact.mixin.Employee,
        attributes: { active: false }
      } as unknown as TxCUD<Doc>)

      // Served from cache: no further lookups are issued, and the
      // deactivated employee must not come back as a receiver.
      mockClient.findAll.mockClear()
      expect(await cache.getReceivers([ACC])).toEqual([])
      expect(mockClient.findAll).not.toHaveBeenCalledWith(contact.mixin.Employee, expect.anything(), expect.anything())
    })

    it('treats a deactivating TxUpdateDoc on the mixin as removing the receiver', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation(
          (cls: unknown, target: unknown) => cls === contact.mixin.Employee && target === contact.class.Person
        )

      mockReceiverLookups([{ _id: 'emp-1', personUuid: ACC, role: 'USER', active: true }])
      expect(await cache.getReceivers([ACC])).toHaveLength(1)

      cache.tx({
        _id: 'tx-deactivate-update',
        _class: core.class.TxUpdateDoc,
        objectId: 'emp-1',
        objectClass: contact.mixin.Employee,
        operations: { active: false }
      } as unknown as TxCUD<Doc>)

      expect(await cache.getReceivers([ACC])).toEqual([])
    })

    it('keeps the receiver when an unrelated field changes', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation((cls: unknown, target: unknown) => cls === 'PersonClass' && target === contact.class.Person)

      mockReceiverLookups([{ _id: 'emp-1', personUuid: ACC, role: 'USER', active: true }])
      expect(await cache.getReceivers([ACC])).toHaveLength(1)

      cache.tx({
        _id: 'tx-rename',
        _class: core.class.TxUpdateDoc,
        objectId: 'emp-1',
        objectClass: 'PersonClass',
        operations: { name: 'NewName' }
      } as unknown as TxCUD<Doc>)

      expect(await cache.getReceivers([ACC])).toHaveLength(1)
    })

    it('reactivates the receiver when active is set back to true', async () => {
      jest
        .mocked(mockIsDerived)
        .mockImplementation((cls: unknown, target: unknown) => cls === 'PersonClass' && target === contact.class.Person)

      mockReceiverLookups([{ _id: 'emp-1', personUuid: ACC, role: 'USER', active: true }])
      expect(await cache.getReceivers([ACC])).toHaveLength(1)

      cache.tx({
        _id: 'tx-off',
        _class: core.class.TxUpdateDoc,
        objectId: 'emp-1',
        objectClass: 'PersonClass',
        operations: { active: false }
      } as unknown as TxCUD<Doc>)
      expect(await cache.getReceivers([ACC])).toEqual([])

      cache.tx({
        _id: 'tx-on',
        _class: core.class.TxUpdateDoc,
        objectId: 'emp-1',
        objectClass: 'PersonClass',
        operations: { active: true }
      } as unknown as TxCUD<Doc>)
      expect(await cache.getReceivers([ACC])).toHaveLength(1)
    })
  })
})

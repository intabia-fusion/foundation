//
// Copyright © 2026 Intabia Fusion.
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

import core, {
  type Account,
  type AccountUuid,
  AccountRole,
  type Class,
  type Doc,
  type DocumentQuery,
  type FindResult,
  MeasureMetricsContext,
  type Person as GlobalPerson,
  type PersonId,
  type PersonUuid,
  type Ref,
  type SocialId,
  SocialIdType,
  type Tx,
  type TxApplyIf,
  type TxApplyResult,
  type TxCreateDoc,
  type TxMixin,
  type TxResult,
  type WithLookup,
  toFindResult
} from '@hcengineering/core'
import contact, { AvatarType, type Person, type SocialIdentity, type SocialIdentityRef } from '..'

interface Scenario {
  personExistsInitially?: boolean
  employeeExistsInitially?: boolean
  applyTxAlwaysFails?: boolean
  personAppearsAfterAttempts?: number
}

const TEST_UUID = 'test-uuid' as PersonUuid
const TEST_ACCOUNT_UUID = TEST_UUID as AccountUuid
const mockSocialId = 'test-social-id-1' as PersonId

function makeSocialId (): SocialId {
  return {
    _id: mockSocialId,
    type: SocialIdType.EMAIL,
    value: 'test@example.com',
    key: 'email:test@example.com',
    verifiedOn: Date.now()
  }
}

function makeTestAccount (): Account {
  return {
    uuid: TEST_ACCOUNT_UUID,
    primarySocialId: mockSocialId,
    role: AccountRole.User,
    socialIds: [mockSocialId],
    fullSocialIds: [makeSocialId()]
  }
}

const testGlobalPerson: GlobalPerson = {
  uuid: TEST_UUID,
  firstName: 'Test',
  lastName: 'User'
}

function createMockClient (scenario: Scenario = {}): {
  findOne: jest.Mock
  findAll: jest.Mock
  tx: jest.Mock
  getTxCallCount: () => number
} {
  const {
    personExistsInitially = false,
    employeeExistsInitially = false,
    applyTxAlwaysFails = false,
    personAppearsAfterAttempts
  } = scenario

  let txCallCount = 0
  let personExists = personExistsInitially
  const employeeExists = employeeExistsInitially

  const mockPerson: Person = {
    _id: 'test-person-id' as Ref<Person>,
    _class: contact.class.Person,
    space: contact.space.Contacts,
    personUuid: TEST_UUID,
    name: 'Test User',
    avatarType: AvatarType.COLOR,
    modifiedOn: Date.now(),
    modifiedBy: mockSocialId,
    createdBy: mockSocialId
  }

  const findOne = jest.fn(
    async <T extends Doc>(_class: Ref<Class<T>>, query: DocumentQuery<T>): Promise<WithLookup<T> | undefined> => {
      if (_class === contact.class.Person && (query as DocumentQuery<Person>)?.personUuid === TEST_UUID) {
        return personExists ? (mockPerson as unknown as WithLookup<T>) : undefined
      }
      if (_class === contact.mixin.Employee) {
        return employeeExists ? ({ ...mockPerson, active: true } as unknown as WithLookup<T>) : undefined
      }
      if (_class === contact.class.SocialIdentity) {
        return undefined
      }
      return undefined
    }
  )

  const findAll = jest.fn(async <T extends Doc>(): Promise<FindResult<T>> => {
    return toFindResult<T>([])
  })

  const tx = jest.fn(async (tx: Tx): Promise<TxResult> => {
    if (tx._class === core.class.TxApplyIf) {
      txCallCount++

      if (personAppearsAfterAttempts !== undefined && txCallCount >= personAppearsAfterAttempts) {
        personExists = true
      }

      const success = !applyTxAlwaysFails
      if (success) {
        personExists = true
      }

      const result: TxApplyResult = { success, serverTime: 0 }
      return result
    }
    return {}
  })

  return {
    findOne,
    findAll,
    tx,
    getTxCallCount: () => txCallCount
  }
}

describe('ensureEmployee retry logic', () => {
  const testCtx = new MeasureMetricsContext('test', {})

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('should succeed without retry when TxApplyIf succeeds', async () => {
    const client = createMockClient({ applyTxAlwaysFails: false })
    const { ensureEmployeeForPerson } = await import('../utils')
    const account = makeTestAccount()

    try {
      await ensureEmployeeForPerson(testCtx, account, account, client, account.fullSocialIds, testGlobalPerson)
    } catch (e) {
      // Expected - Hierarchy not available
    }

    // 3 TxApplyIf calls: Person + SocialIdentity + Employee mixin
    expect(client.getTxCallCount()).toBe(3)
  })

  it('should not call TxApplyIf for person when person exists initially', async () => {
    const client = createMockClient({ personExistsInitially: true })
    const { ensureEmployeeForPerson } = await import('../utils')
    const account = makeTestAccount()

    try {
      await ensureEmployeeForPerson(testCtx, account, account, client, account.fullSocialIds, testGlobalPerson)
    } catch (e) {
      // Expected
    }

    // 2 TxApplyIf calls: SocialIdentity + Employee mixin (person exists, no create)
    expect(client.getTxCallCount()).toBe(2)
    expect(client.findOne).toHaveBeenCalledWith(contact.class.Person, { personUuid: TEST_UUID })
  })

  it('should retry when TxApplyIf fails and person appears after retries', async () => {
    const client = createMockClient({ applyTxAlwaysFails: true, personAppearsAfterAttempts: 2 })
    const { ensureEmployeeForPerson } = await import('../utils')
    const account = makeTestAccount()

    try {
      await ensureEmployeeForPerson(testCtx, account, account, client, account.fullSocialIds, testGlobalPerson)
    } catch (e) {
      // Expected
    }

    expect(client.getTxCallCount()).toBeGreaterThanOrEqual(2)
  })

  it('should return null after exhausting all retries when person never appears', async () => {
    const client = createMockClient({ applyTxAlwaysFails: true })
    const { ensureEmployeeForPerson } = await import('../utils')
    const account = makeTestAccount()

    const result = await ensureEmployeeForPerson(
      testCtx,
      account,
      account,
      client,
      account.fullSocialIds,
      testGlobalPerson
    )

    expect(result).toBeNull()
    // 4 calls: maxRetries + 1 (initial attempt + 3 retries)
    expect(client.getTxCallCount()).toBe(4)
  })

  it('should handle missing global person gracefully', async () => {
    const client = createMockClient()
    const { ensureEmployeeForPerson } = await import('../utils')
    const account = makeTestAccount()

    const result = await ensureEmployeeForPerson(testCtx, account, account, client, account.fullSocialIds, undefined)

    expect(result).toBeNull()
  })
})

// Shared-state mock for simulating concurrent ensureEmployeeForPerson calls.
interface PersonRecord {
  _id: Ref<Person>
  _class: Ref<Class<Person>>
  personUuid: PersonUuid
  name: string
  avatarType: AvatarType
}

interface SocialIdentityRecord {
  _id: SocialIdentityRef
  _class: Ref<Class<SocialIdentity>>
  type: SocialIdType
  value: string
  key: string
  attachedTo: Ref<Person>
  verifiedOn: number | null
  isDeleted: boolean
}

interface EmployeeRecord {
  _id: Ref<Person>
  active: boolean
  role: 'USER' | 'GUEST'
}

interface SharedState {
  persons: Map<Ref<Person>, PersonRecord>
  socialIds: Map<SocialIdentityRef, SocialIdentityRecord>
  employees: Map<Ref<Person>, EmployeeRecord>
  txLog: Array<{ type: string }>
}

function createConcurrentMockClient (
  state: SharedState,
  failSocialIdentityApply = false,
  failEmployeeApply = false
): Pick<ReturnType<typeof createMockClient>, 'findOne' | 'findAll' | 'tx'> {
  const reject: TxApplyResult = { success: false, serverTime: 0 }
  const accept: TxApplyResult = { success: true, serverTime: 0 }

  const findOne = jest.fn(
    async <T extends Doc>(_class: Ref<Class<T>>, query: DocumentQuery<T>): Promise<WithLookup<T> | undefined> => {
      if (_class === contact.class.Person) {
        const q = query as DocumentQuery<Person>
        if (q?.personUuid !== undefined) {
          for (const p of state.persons.values()) {
            if (p.personUuid === q.personUuid) return p as unknown as WithLookup<T>
          }
        }
        return undefined
      }
      if (_class === contact.class.SocialIdentity) {
        const q = query as DocumentQuery<SocialIdentity>
        const idClause = q?._id
        if (typeof idClause === 'object' && idClause !== null && '$in' in idClause) {
          const ids = (idClause as { $in: SocialIdentityRef[] }).$in
          for (const id of ids) {
            const found = state.socialIds.get(id)
            if (found !== undefined) return found as unknown as WithLookup<T>
          }
        }
        return undefined
      }
      if (_class === contact.mixin.Employee) {
        const q = query as DocumentQuery<Doc>
        const id = q?._id as Ref<Person> | undefined
        if (id === undefined) return undefined
        return (state.employees.get(id) as unknown as WithLookup<T> | undefined) ?? undefined
      }
      return undefined
    }
  )

  const findAll = jest.fn(
    async <T extends Doc>(_class: Ref<Class<T>>, query: DocumentQuery<T>): Promise<FindResult<T>> => {
      if (_class === contact.class.SocialIdentity) {
        const q = query as DocumentQuery<SocialIdentity>
        const idClause = q?._id
        if (typeof idClause === 'object' && idClause !== null && '$in' in idClause) {
          const ids = (idClause as { $in: SocialIdentityRef[] }).$in
          const out: SocialIdentityRecord[] = []
          for (const id of ids) {
            const found = state.socialIds.get(id)
            if (found !== undefined) out.push(found)
          }
          return toFindResult<T>(out as unknown as T[])
        }
      }
      return toFindResult<T>([])
    }
  )

  const tx = jest.fn(async (tx: Tx): Promise<TxResult> => {
    state.txLog.push({ type: tx._class })

    if (tx._class === core.class.TxApplyIf) {
      const applyTx = tx as TxApplyIf
      for (const nm of applyTx.notMatch ?? []) {
        if (nm._class === contact.class.Person) {
          const q = nm.query as DocumentQuery<Person>
          if (q?.personUuid !== undefined) {
            for (const p of state.persons.values()) {
              if (p.personUuid === q.personUuid) {
                return reject
              }
            }
          }
        }
        if (nm._class === contact.class.SocialIdentity) {
          const q = nm.query as DocumentQuery<SocialIdentity>
          const id = q?._id as SocialIdentityRef | undefined
          if (id !== undefined) {
            if (failSocialIdentityApply || state.socialIds.has(id)) {
              return reject
            }
          }
        }
        if (nm._class === contact.mixin.Employee) {
          const q = nm.query
          const id = q?._id as Ref<Person> | undefined
          if (id !== undefined) {
            if (failEmployeeApply) {
              return reject
            }
            const existing = state.employees.get(id)
            if (existing?.active === true) {
              return reject
            }
          }
        }
      }

      for (const innerTx of applyTx.txes ?? []) {
        applyInnerTx(state, innerTx)
      }
      return accept
    }

    if (tx._class === core.class.TxCreateDoc) {
      applyInnerTx(state, tx)
    }
    return {}
  })

  return { findOne, findAll, tx }
}

function applyInnerTx (state: SharedState, innerTx: Tx): void {
  if (innerTx._class === core.class.TxCreateDoc) {
    const create = innerTx as TxCreateDoc<Doc>
    if (create.objectClass === contact.class.Person) {
      const attrs = create.attributes as unknown as { personUuid: PersonUuid, name: string, avatarType: AvatarType }
      state.persons.set(create.objectId as Ref<Person>, {
        _id: create.objectId as Ref<Person>,
        _class: contact.class.Person,
        personUuid: attrs.personUuid,
        name: attrs.name,
        avatarType: attrs.avatarType
      })
      return
    }
    if (create.objectClass === contact.class.SocialIdentity) {
      const attrs = create.attributes as unknown as {
        type: SocialIdType
        value: string
        key: string
        attachedTo: Ref<Person>
        verifiedOn?: number | null
        isDeleted?: boolean
      }
      state.socialIds.set(create.objectId as SocialIdentityRef, {
        _id: create.objectId as SocialIdentityRef,
        _class: contact.class.SocialIdentity,
        type: attrs.type,
        value: attrs.value,
        key: attrs.key,
        attachedTo: attrs.attachedTo,
        verifiedOn: attrs.verifiedOn ?? null,
        isDeleted: attrs.isDeleted ?? false
      })
      return
    }
    return
  }
  if (innerTx._class === core.class.TxMixin) {
    const mx = innerTx as TxMixin<Doc, Doc>
    if (mx.mixin === contact.mixin.Employee) {
      const attrs = mx.attributes as unknown as { active: boolean, role: 'USER' | 'GUEST' }
      state.employees.set(mx.objectId as Ref<Person>, {
        _id: mx.objectId as Ref<Person>,
        active: attrs.active,
        role: attrs.role
      })
    }
  }
}

describe('ensureEmployeeForPerson concurrency', () => {
  const testCtx = new MeasureMetricsContext('test', {})
  const sid1 = 'sid-1' as PersonId
  const sidRef = sid1 as unknown as SocialIdentityRef

  function makeAccount (): Account {
    return {
      uuid: 'uuid-1' as AccountUuid,
      primarySocialId: sid1,
      role: AccountRole.User,
      socialIds: [sid1],
      fullSocialIds: [
        {
          _id: sid1,
          type: SocialIdType.EMAIL,
          value: 'a@b.com',
          key: 'email:a@b.com',
          verifiedOn: Date.now()
        }
      ]
    }
  }

  const globalPerson: GlobalPerson = {
    uuid: 'uuid-1' as PersonUuid,
    firstName: 'A',
    lastName: 'B'
  }

  function makeState (): SharedState {
    return {
      persons: new Map(),
      socialIds: new Map(),
      employees: new Map(),
      txLog: []
    }
  }

  it('parallel calls create single person and single social identity', async () => {
    const state = makeState()
    const client = createConcurrentMockClient(state)
    const { ensureEmployeeForPerson } = await import('../utils')
    const account = makeAccount()

    const results = await Promise.all([
      ensureEmployeeForPerson(testCtx, account, account, client, account.fullSocialIds, globalPerson),
      ensureEmployeeForPerson(testCtx, account, account, client, account.fullSocialIds, globalPerson),
      ensureEmployeeForPerson(testCtx, account, account, client, account.fullSocialIds, globalPerson)
    ])

    expect(state.persons.size).toBe(1)
    expect(state.socialIds.size).toBe(1)
    expect(state.employees.size).toBe(1)
    expect(new Set(results).size).toBe(1)
    expect(results[0]).not.toBeNull()
  })

  it('social identity applyIf rejection does not throw and continues', async () => {
    const state = makeState()
    // Pre-populate unconfirmed social id attached to a different person
    state.socialIds.set(sidRef, {
      _id: sidRef,
      _class: contact.class.SocialIdentity,
      type: SocialIdType.EMAIL,
      value: 'a@b.com',
      key: 'email:a@b.com',
      attachedTo: 'other-person' as Ref<Person>,
      verifiedOn: null,
      isDeleted: false
    })
    const client = createConcurrentMockClient(state)
    const { ensureEmployeeForPerson } = await import('../utils')
    const account = makeAccount()

    const result = await ensureEmployeeForPerson(testCtx, account, account, client, account.fullSocialIds, globalPerson)
    expect(result).not.toBeNull()
  })

  it('employee mixin applyIf rejection is tolerated (another call created it)', async () => {
    const state = makeState()
    const client = createConcurrentMockClient(state, false, true)
    const { ensureEmployeeForPerson } = await import('../utils')
    const account = makeAccount()

    const result = await ensureEmployeeForPerson(testCtx, account, account, client, account.fullSocialIds, globalPerson)
    expect(result).not.toBeNull()
  })

  it('createEmployee=false skips employee mixin creation', async () => {
    const state = makeState()
    const client = createConcurrentMockClient(state)
    const { ensureEmployeeForPerson } = await import('../utils')
    const account = makeAccount()

    const result = await ensureEmployeeForPerson(
      testCtx,
      account,
      account,
      client,
      account.fullSocialIds,
      globalPerson,
      { createEmployee: false }
    )

    expect(result).not.toBeNull()
    expect(state.employees.size).toBe(0)
    expect(state.persons.size).toBe(1)
    expect(state.socialIds.size).toBe(1)
  })

  it('roleOverride=GUEST applies guest role to employee', async () => {
    const state = makeState()
    const client = createConcurrentMockClient(state)
    const { ensureEmployeeForPerson } = await import('../utils')
    const account = makeAccount()

    await ensureEmployeeForPerson(testCtx, account, account, client, account.fullSocialIds, globalPerson, {
      roleOverride: 'GUEST'
    })

    expect(state.employees.size).toBe(1)
    const emp = [...state.employees.values()][0]
    expect(emp.role).toBe('GUEST')
  })
})

describe('ensureEmployeeForPerson phone hint', () => {
  const testCtx = new MeasureMetricsContext('test', {})
  const sid = 'sid-phone-1' as PersonId

  function makeAccount (): Account & { fullSocialIds: SocialId[] } {
    return {
      uuid: 'uuid-phone' as AccountUuid,
      primarySocialId: sid,
      role: AccountRole.User,
      socialIds: [sid],
      fullSocialIds: [
        {
          _id: sid,
          type: SocialIdType.EMAIL,
          value: 'a@b.com',
          key: 'email:a@b.com',
          verifiedOn: Date.now()
        }
      ]
    }
  }

  function createdChannels (client: { tx: jest.Mock }): Array<{ provider: unknown, value: unknown }> {
    return client.tx.mock.calls
      .map(([tx]) => tx as TxCreateDoc<Doc>)
      .filter((tx) => tx._class === core.class.TxCreateDoc && tx.objectClass === contact.class.Channel)
      .map((tx) => tx.attributes as unknown as { provider: unknown, value: unknown })
      .map(({ provider, value }) => ({ provider, value }))
  }

  it('creates a Phone channel from the global person phone hint', async () => {
    const client = createConcurrentMockClient({
      persons: new Map(),
      socialIds: new Map(),
      employees: new Map(),
      txLog: []
    })
    const { ensureEmployeeForPerson } = await import('../utils')
    const account = makeAccount()

    await ensureEmployeeForPerson(testCtx, account, account, client, account.fullSocialIds, {
      uuid: 'uuid-phone' as PersonUuid,
      firstName: 'A',
      lastName: 'B',
      phoneHint: '+79000000011'
    })

    expect(createdChannels(client as any)).toEqual([{ provider: contact.channelProvider.Phone, value: '+79000000011' }])
  })

  it('creates no channel when the person has no phone hint', async () => {
    const client = createConcurrentMockClient({
      persons: new Map(),
      socialIds: new Map(),
      employees: new Map(),
      txLog: []
    })
    const { ensureEmployeeForPerson } = await import('../utils')
    const account = makeAccount()

    await ensureEmployeeForPerson(testCtx, account, account, client, account.fullSocialIds, {
      uuid: 'uuid-phone' as PersonUuid,
      firstName: 'A',
      lastName: 'B'
    })

    expect(createdChannels(client as any)).toEqual([])
  })
})

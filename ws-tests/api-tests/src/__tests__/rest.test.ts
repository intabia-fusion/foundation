//
// Copyright © 2025 Hardcore Engineering Inc.
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
  createRestClient,
  createRestTxOperations,
  getWorkspaceToken,
  loadServerConfig,
  type RestClient,
  type WorkspaceToken
} from '@hcengineering/api-client'
import core, {
  buildSocialIdString,
  generateId,
  MeasureMetricsContext,
  type PersonId,
  type PersonUuid,
  pickPrimarySocialId,
  SocialIdType,
  systemAccountUuid,
  type Ref,
  type SocialId,
  type Space,
  type TxCreateDoc,
  type TxOperations
} from '@hcengineering/core'
import { type AccountClient, getClient as getAccountClient } from '@hcengineering/account-client'
import chunter from '@hcengineering/chunter'
import contact, { ensureEmployee, type SocialIdentityRef, type Person } from '@hcengineering/contact'
import { generateToken } from '@hcengineering/server-token'

describe('rest-api-server', () => {
  const testCtx = new MeasureMetricsContext('test', {})
  const wsName = 'api-tests'
  let apiWorkspace1: WorkspaceToken
  let apiWorkspace2: WorkspaceToken
  let accountClient: AccountClient
  let adminAccountClient: AccountClient

  beforeAll(async () => {
    const config = await loadServerConfig('http://localhost:8083')

    apiWorkspace1 = await getWorkspaceToken(
      'http://localhost:8083',
      {
        email: 'user1',
        password: '1234',
        workspace: wsName
      },
      config
    )

    apiWorkspace2 = await getWorkspaceToken(
      'http://localhost:8083',
      {
        email: 'user1',
        password: '1234',
        workspace: wsName + '-cr'
      },
      config
    )

    accountClient = getAccountClient(config.ACCOUNTS_URL, apiWorkspace1.token)
    adminAccountClient = getAccountClient(
      config.ACCOUNTS_URL,
      generateToken(systemAccountUuid, undefined, { service: 'workspace', admin: 'true' }, 'secret')
    )
    const person = await accountClient.getPerson()
    const socialIds: SocialId[] = await accountClient.getSocialIds(true)

    // Ensure employee is created
    await ensureEmployee(
      testCtx,
      {
        uuid: apiWorkspace1.info.account,
        role: apiWorkspace1.info.role,
        primarySocialId: pickPrimarySocialId(socialIds)._id,
        socialIds: socialIds.map((si) => si._id),
        fullSocialIds: socialIds
      },
      connect(),
      socialIds,
      async () => person
    )

    await ensureEmployee(
      testCtx,
      {
        uuid: apiWorkspace2.info.account,
        role: apiWorkspace2.info.role,
        primarySocialId: pickPrimarySocialId(socialIds)._id,
        socialIds: socialIds.map((si) => si._id),
        fullSocialIds: socialIds
      },
      connect(apiWorkspace2),
      socialIds,
      async () => person
    )
  }, 10000)

  function connect (ws?: WorkspaceToken, asSystem = false): RestClient {
    const tok = ws ?? apiWorkspace1
    const token = asSystem ? generateToken(systemAccountUuid, tok.workspaceId, undefined, 'secret') : tok.token

    return createRestClient(tok.endpoint, tok.workspaceId, token)
  }

  async function connectTx (ws?: WorkspaceToken): Promise<TxOperations> {
    const tok = ws ?? apiWorkspace1
    return await createRestTxOperations(tok.endpoint, tok.workspaceId, tok.token)
  }

  it('get account', async () => {
    const conn = connect()
    const account = await conn.getAccount()

    expect(account.primarySocialId).toEqual(expect.any(String))
    expect(account.role).toBe('USER')
    // expect(account.space).toBe(core.space.Model)
    // expect(account.modifiedBy).toBe(core.account.System)
    // expect(account.createdBy).toBe(core.account.System)
    // expect(typeof account.modifiedOn).toBe('number')
    // expect(typeof account.createdOn).toBe('number')
  })

  it('find spaces', async () => {
    const conn = connect()
    const spaces = await conn.findAll(core.class.Space, {})
    expect(spaces.length).toBeGreaterThanOrEqual(20)
    const personSpace = spaces.find((it) => it.name === 'Pesonal space' && it.private)
    expect(personSpace).not.toBeNull()
  })

  it('find spaces limit', async () => {
    const conn = connect()
    const spaces = await conn.findAll(core.class.Space, {}, { limit: 5 })
    expect(spaces.length).toBe(5)
  })
  it('find spaces by-name', async () => {
    const conn = connect()
    const spaces = await conn.findAll(
      contact.class.PersonSpace,
      { name: 'Personal space' },
      {
        lookup: {
          person: contact.class.Person
        }
      }
    )
    console.log('SPACES', JSON.stringify(spaces))
    // There should be exactly 1 PersonSpace per account.
    // If more than 1 appears it indicates a race condition in ensureEmployee / OnEmployeeCreate
    // where multiple Person documents are created for the same account UUID.
    expect(spaces.length).toBe(1)
    expect(spaces[0].name).toBe('Personal space')
    expect(spaces[0].$lookup?.person?.name).toBe('Appleseed,John')
  })

  it('no duplicate persons for same account', async () => {
    const conn = connect()
    const persons = await conn.findAll(contact.class.Person, { personUuid: apiWorkspace1.info.account as any })
    // Each account should map to exactly one Person in a workspace
    expect(persons.length).toBe(1)
  })

  it('single employee mixin per person', async () => {
    const conn = await connectTx()
    const persons = await conn.findAll(contact.class.Person, { personUuid: apiWorkspace1.info.account as any })
    expect(persons.length).toBe(1)

    const employees = await conn.findAll(contact.mixin.Employee, { _id: persons[0]._id as any })
    expect(employees.length).toBe(1)
    expect(employees[0].active).toBe(true)
    expect(employees[0].role).toBe('USER')
  })

  it('single personal space per account', async () => {
    const conn = connect()
    const personalSpaces = await conn.findAll(contact.class.PersonSpace, {
      account: apiWorkspace1.info.account as any
    })
    expect(personalSpaces.length).toBe(1)
    expect(personalSpaces[0].name).toBe('Personal space')
    expect(personalSpaces[0].private).toBe(true)
  })

  it('employee mixin matches person', async () => {
    const txConn = await connectTx()
    const persons = await txConn.findAll(contact.class.Person, { personUuid: apiWorkspace1.info.account as any })
    expect(persons.length).toBe(1)
    const personId = persons[0]._id

    // Employee mixin should reference the same Person document
    const employee = await txConn.findOne(contact.mixin.Employee, { _id: personId as any })
    expect(employee).not.toBeNull()
    expect(employee?._id).toBe(personId)
    expect(employee?.active).toBe(true)

    // PersonSpace should reference the same Person
    const conn = connect()
    const personalSpaces = await conn.findAll(contact.class.PersonSpace, {
      person: personId as any
    })
    expect(personalSpaces.length).toBe(1)
    expect(personalSpaces[0].account).toBe(apiWorkspace1.info.account)
  })

  it('find channels', async () => {
    const conn = connect()
    const spaces = await conn.findAll(chunter.class.Channel, {})
    expect(spaces.length).toBeGreaterThanOrEqual(2)
    expect(spaces.find((it) => it._id === 'chunter:space:General')).not.toBeNull()
  })

  it('find avg', async () => {
    const conn = connect()
    await checkFindPerformance(conn)
  }, 120000)

  it('find avg-europe', async () => {
    const conn = connect(apiWorkspace2)
    await checkFindPerformance(conn)
  }, 120000)

  it('add space', async () => {
    const conn = connect()
    const account = await conn.getAccount()
    const spaceName = generateId()
    const tx: TxCreateDoc<Space> = {
      _class: core.class.TxCreateDoc,
      space: core.space.Tx,
      _id: generateId(),
      objectSpace: core.space.Model,
      modifiedBy: account.primarySocialId,
      modifiedOn: Date.now(),
      attributes: {
        name: spaceName,
        description: '',
        private: false,
        archived: false,
        members: [],
        autoJoin: false
      },
      objectClass: core.class.Space,
      objectId: generateId()
    }
    await conn.tx(tx)
    const spaces = await conn.findAll(core.class.Space, {})
    expect(spaces.filter((it) => it.name === spaceName).length).toBe(1)
  })

  it('get-model', async () => {
    const conn = connect()
    const { hierarchy, model } = await conn.getModel()

    const dsc = hierarchy.getDescendants(core.class.Space)
    expect(dsc.length).toBeGreaterThan(10)
    expect(model.getObject(core.class.Space)).not.toBeNull()
  })

  it('tx-client', async () => {
    const conn = await connectTx()

    const employee = await conn.findAll(contact.mixin.Employee, {}, { limit: 5 })

    expect(employee.length).toBeGreaterThanOrEqual(1)
    expect(employee[0].active).toBe(true)
  })

  describe('ensure-person', () => {
    const expectPerson = async (
      conn: RestClient,
      socialType: SocialIdType,
      socialValue: string,
      uuid: PersonUuid,
      socialId: PersonId,
      localPerson: string
    ): Promise<void> => {
      const globalPerson = await adminAccountClient.findPersonBySocialKey(
        buildSocialIdString({ type: socialType, value: socialValue })
      )

      expect(globalPerson).toBe(uuid)

      const person = await conn.findOne(contact.class.Person, { _id: localPerson as Ref<Person>, personUuid: uuid })

      expect(person).not.toBeNull()

      const socialIdObj = await conn.findOne(contact.class.SocialIdentity, {
        type: socialType,
        value: socialValue,
        attachedTo: person?._id,
        _id: socialId as SocialIdentityRef
      })

      expect(socialIdObj).not.toBeNull()
    }

    it('ensure-person', async () => {
      const socialType = SocialIdType.TELEGRAM
      const socialValue = '123456789'
      const first = 'John'
      const last = 'Doe'
      const conn = connect()
      const { uuid, socialId, localPerson } = await conn.ensurePerson(socialType, socialValue, first, last)

      await expectPerson(conn, socialType, socialValue, uuid, socialId, localPerson)
    })

    it('ensure-person as system', async () => {
      const socialType = SocialIdType.GITHUB
      const socialValue = 'eodnhoj'
      const first = 'John'
      const last = 'Doe'
      const conn = connect(apiWorkspace1, true)

      const { uuid, socialId, localPerson } = await conn.ensurePerson(socialType, socialValue, first, last)

      await expectPerson(conn, socialType, socialValue, uuid, socialId, localPerson)
    })
  })
})

async function checkFindPerformance (conn: RestClient): Promise<void> {
  // limit=1: other test suites keep adding spaces to the shared workspace, an unbounded
  // findAll would measure the accumulated payload size instead of the round trip.
  const findSpace = async (): Promise<void> => {
    const spaces = await conn.findAll(core.class.Space, {}, { limit: 1 })
    expect(spaces.length).toBe(1)
  }

  // Warmup to stabilize JIT / connection caches
  for (let i = 0; i < 20; i++) {
    await findSpace()
  }

  // Shared CI runners are noisy: take the best of several rounds instead of a single measurement
  const attempts = 200
  const rounds = process.env.CI === 'true' ? 3 : 1
  const maxAvgMs = process.env.CI === 'true' ? 20 : 10

  let best = Number.MAX_VALUE
  for (let round = 0; round < rounds; round++) {
    let total = 0
    for (let i = 0; i < attempts; i++) {
      const st = performance.now()
      await findSpace()
      total += performance.now() - st
    }
    best = Math.min(best, total / attempts)
    if (best < maxAvgMs) break
  }
  expect(best).toBeLessThan(maxAvgMs)
}

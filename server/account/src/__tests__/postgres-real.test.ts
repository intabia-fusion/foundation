/**
 * A set of tests against a real database, once per flavor configured in realDbFlavors.
 */

import { generateUuid, SocialIdType, type AccountUuid, type PersonId } from '@hcengineering/core'
import { shutdownPostgres, type PostgresClientReference } from '@hcengineering/postgres'
import { type PostgresAccountDB } from '../collections/postgres/postgres'
import { type SocialId } from '../types'
import { createAccount, normalizeValue } from '../utils'
import { clearTables, openRealDb, realDbFlavors } from './realDbFlavors'

jest.setTimeout(90000)

// Children first — every one of these has an FK to workspace.
// Children before parents; social_id/account_events/user_profile all reference person.
const PERSON_TABLES = ['social_id', 'account_events', 'user_profile', 'account_passwords', 'account', 'person']

const WORKSPACE_TABLES = [
  'invite',
  'workspace_members',
  'workspace_status',
  'workspace_permissions',
  'integrations',
  'subscription',
  'workspace'
]

describe.each(realDbFlavors)('real-account [$flavor]', ({ flavor, adminUri, dbUri }) => {
  let dbUuid: string
  let dbClient: PostgresClientReference
  let accountDb: PostgresAccountDB

  const users = [
    {
      name: 'user1',
      uuid: generateUuid() as AccountUuid,
      email: 'user1@example.com',
      firstName: 'Jon',
      lastName: 'Doe'
    },
    {
      name: 'user2',
      uuid: generateUuid() as AccountUuid,
      email: 'user2@example.com',
      firstName: 'Pavel',
      lastName: 'Siaro'
    }
  ]

  async function addSocialId (
    account: PostgresAccountDB,
    user: (typeof users)[0],
    type: SocialIdType,
    value: string
  ): Promise<PersonId> {
    const normalizedValue = normalizeValue(value)
    const newSocialId = {
      type,
      value: normalizedValue,
      personUuid: user.uuid
    }
    return await account.socialId.insertOne(newSocialId)
  }

  async function prepareAccounts (account: PostgresAccountDB): Promise<void> {
    for (const user of users) {
      const ex = await account.account.findOne({ uuid: user.uuid })
      if (ex == null) {
        await account.person.insertOne({ uuid: user.uuid, firstName: user.firstName, lastName: user.lastName })
        await createAccount(account, user.uuid, true)
        await addSocialId(account, user, SocialIdType.EMAIL, user.email)
      }
    }
  }

  // One reused database per flavor: migrations run once (and are skipped on later runs), and nothing
  // is ever dropped — a DROP DATABASE on cockroach queues a 300s GC job per call.
  beforeAll(async () => {
    const db = await openRealDb('accountdb', { flavor, adminUri, dbUri })
    dbUuid = db.dbUuid
    dbClient = db.dbRef
    accountDb = db.account

    // The database outlives the run, so clear the previous run's fixtures before seeding.
    await clearTables(dbClient, dbUuid, [...WORKSPACE_TABLES, ...PERSON_TABLES])
    await prepareAccounts(accountDb)
  })

  // Workspaces carry a unique url, so they must not survive into the next test. Persons and accounts
  // stay: prepareAccounts already re-creates them only when missing.
  beforeEach(async () => {
    await clearTables(dbClient, dbUuid, WORKSPACE_TABLES)
  })

  afterAll(async () => {
    dbClient.close()
    await shutdownPostgres()
  })

  it('Check accounts', async () => {
    const user1 = await accountDb.account.findOne({ uuid: users[0].uuid })
    expect(user1).not.toBeNull()
    expect(user1).toBeDefined()
  })

  it('Check social ids', async () => {
    const user1 = await accountDb.account.findOne({ uuid: users[0].uuid })
    expect(user1).not.toBeNull()
    expect(user1).toBeDefined()

    const socialIds = await accountDb.socialId.find({ personUuid: user1?.uuid })
    expect(socialIds).not.toBeNull()
    expect(socialIds).toBeDefined()
    expect(socialIds.length).toEqual(2)

    const em = socialIds.find((it) => it.type === SocialIdType.EMAIL) as SocialId
    expect(em).toBeDefined()
    expect(em.key).toEqual('email:user1@example.com')
  })

  it('List accounts', async () => {
    const users = await accountDb.listAccounts()
    expect(users.length).toBe(2)
  })

  it('check invites', async () => {
    const wsUuid = await accountDb.createWorkspace(
      {
        url: 'test-ws',
        name: 'test-ws',
        allowGuestSignUp: true,
        allowReadOnlyGuest: true
      },
      {
        isDisabled: false,
        mode: 'active',
        versionMajor: 0,
        versionMinor: 7,
        versionPatch: 0
      }
    )
    const inviteLink = await accountDb.invite.insertOne({
      workspaceUuid: wsUuid,
      expiresOn: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).getTime()
    })
    expect(inviteLink).toBeDefined()
  })
})

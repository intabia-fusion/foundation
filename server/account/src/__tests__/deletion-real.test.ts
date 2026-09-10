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

/**
 * Identity purge invariants against a real database, once per flavor in realDbFlavors.
 *
 * Deleting an account drops the account and everything it carried, retires its social ids (the row
 * stays so the identifier is never reissued, the value is mangled so it stops resolving), strips
 * the person row that workspace rows still reference, and leaves the email free for a new signup.
 * Workspaces already deleted must not block any of it.
 */

import {
  AccountRole,
  generateUuid,
  MeasureMetricsContext,
  newMetrics,
  SocialIdType,
  type AccountUuid,
  type PersonUuid,
  type WorkspaceUuid
} from '@hcengineering/core'
import { shutdownPostgres, type PostgresClientReference } from '@hcengineering/postgres'
import { type PostgresAccountDB } from '../collections/postgres/postgres'
import { createAccount, normalizeValue, signUpByEmail } from '../utils'
import { clearTables, openRealDb, realDbFlavors } from './realDbFlavors'

jest.setTimeout(90000)

// Children before parents: workspace rows reference person via created_by/billing_account, and
// social_id/account_events/user_profile all reference person.
const ALL_TABLES = [
  'invite',
  'workspace_members',
  'workspace_status',
  'workspace_permissions',
  'workspace',
  'social_id',
  'account_events',
  'user_profile',
  'account_passwords',
  'account',
  'person'
]

describe.each(realDbFlavors)('deletion-real [$flavor]', ({ flavor, adminUri, dbUri }) => {
  let dbUuid: string
  let dbClient: PostgresClientReference
  let db: PostgresAccountDB

  const ctx = new MeasureMetricsContext('test', {}, {}, newMetrics())
  const branding = null

  let seq = 0

  async function makeAccount (email: string): Promise<AccountUuid> {
    const uuid = generateUuid() as AccountUuid
    await db.person.insertOne({ uuid, firstName: 'Jon', lastName: 'Doe' })
    await createAccount(db, uuid, true)
    await db.socialId.insertOne({ type: SocialIdType.EMAIL, value: normalizeValue(email), personUuid: uuid })
    return uuid
  }

  async function makeWorkspace (createdBy: AccountUuid, mode: 'active' | 'deleted'): Promise<WorkspaceUuid> {
    const url = `del-ws-${seq++}`
    return await db.createWorkspace(
      { url, name: url, createdBy, allowGuestSignUp: false, allowReadOnlyGuest: false },
      { isDisabled: mode === 'deleted', mode, versionMajor: 0, versionMinor: 7, versionPatch: 0 }
    )
  }

  beforeAll(async () => {
    const opened = await openRealDb('deldb', { flavor, adminUri, dbUri })
    dbUuid = opened.dbUuid
    dbClient = opened.dbRef
    db = opened.account
  })

  beforeEach(async () => {
    await clearTables(dbClient, dbUuid, ALL_TABLES)
  })

  afterAll(async () => {
    dbClient.close()
    await shutdownPostgres()
  })

  it('deleteAccount drops the account and strips the person', async () => {
    const email = 'purge@example.com'
    const uuid = await makeAccount(email)

    await db.deleteAccount(uuid)

    expect(await db.account.findOne({ uuid })).toBeNull()
    expect(await db.userProfile.findOne({ personUuid: uuid })).toBeNull()

    // The person row survives - workspace rows reference it - but carries nothing any more.
    const person = await db.person.findOne({ uuid })
    expect(person).not.toBeNull()
    expect(person?.firstName).toEqual('')
    expect(person?.lastName).toEqual('')
  })

  it('retires every social id instead of dropping it', async () => {
    const email = 'retire@example.com'
    const uuid = await makeAccount(email)

    await db.deleteAccount(uuid)

    const socialIds = await db.socialId.find({ personUuid: uuid })
    expect(socialIds.length).toBeGreaterThan(0)
    for (const sid of socialIds) {
      expect(sid.isDeleted).toBe(true)
      expect(sid.verifiedOn ?? null).toBeNull()
      expect(sid.value).toContain('#')
    }
    // The identifier is retired, so nothing resolves by the plain value any more.
    expect(await db.socialId.findOne({ type: SocialIdType.EMAIL, value: normalizeValue(email) })).toBeNull()
  })

  it('frees the email for a fresh signup after the account is deleted', async () => {
    const email = 'reuse@example.com'
    const uuid = await makeAccount(email)

    await db.deleteAccount(uuid)

    const signedUp = await signUpByEmail(ctx, db, branding, email, 'password', 'New', 'Owner', true)
    expect(signedUp.account).not.toEqual(uuid)
  })

  it('keeps other people workspaces and only drops the membership', async () => {
    const owner = await makeAccount('owner@example.com')
    const member = await makeAccount('member@example.com')
    const ws = await makeWorkspace(owner, 'active')
    await db.assignWorkspace(owner, ws, AccountRole.Owner)
    await db.assignWorkspace(member, ws, AccountRole.User)

    await db.deleteAccount(member)

    expect(await db.workspace.findOne({ uuid: ws })).not.toBeNull()
    const members = await db.getWorkspaceMembers(ws)
    expect(members.map((it) => it.person as PersonUuid)).toEqual([owner])
  })

  it('is not blocked by the tombstone of an already deleted workspace', async () => {
    const uuid = await makeAccount('tombstone@example.com')
    const ws = await makeWorkspace(uuid, 'deleted')
    await db.assignWorkspace(uuid, ws, AccountRole.Owner)

    await db.deleteAccount(uuid)

    expect(await db.account.findOne({ uuid })).toBeNull()
    expect(await db.workspace.findOne({ uuid: ws })).not.toBeNull()
    expect(await db.getWorkspaceMembers(ws)).toHaveLength(0)
  })
})

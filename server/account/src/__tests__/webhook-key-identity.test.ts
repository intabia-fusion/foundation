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
  AccountRole,
  SocialIdType,
  type AccountUuid,
  type MeasureContext,
  type WorkspaceUuid
} from '@hcengineering/core'
import { generateToken } from '@hcengineering/server-token'

import { createApiKey, revokeApiKey } from '../operations'
import { getApiKeyAccounts, verifyApiKey } from '../serviceOperations'
import { type AccountDB } from '../types'

// An in-memory social_id row, close enough to the real one for pickPrimarySocialId-relevant fields.
interface SocialIdRow {
  _id: string
  type: string
  personUuid: AccountUuid
  verifiedOn?: number
}

describe('webhook key identity (FUSIO-1151)', () => {
  const mockCtx = { error: jest.fn(), info: jest.fn(), warn: jest.fn() } as unknown as MeasureContext
  const workspace = '11111111-1111-4111-8111-111111111111' as WorkspaceUuid
  const owner = '22222222-2222-4222-8222-222222222222' as AccountUuid

  const ownerToken = generateToken(owner, workspace, undefined)
  // getApiKeyAccounts is a service call, gated on the caller being a trusted service.
  const transactorToken = generateToken(owner, workspace, { service: 'transactor' })
  // verifyApiKey is a service call too, allowed for the webhook pod.
  const webhookToken = generateToken(owner, workspace, { service: 'webhook' })

  function makeDb (): { db: AccountDB, socialIdRows: Map<string, SocialIdRow> } {
    const socialIdRows = new Map<string, SocialIdRow>()
    const integrationSecretRows: Array<Record<string, any>> = []
    let nextId = 1

    // Every field of the query must match - that is what makes the `secret` compare-and-swap work.
    const matching = (query: Record<string, unknown>): Array<Record<string, any>> =>
      integrationSecretRows.filter((row) => Object.entries(query).every(([k, v]) => row[k] === v))

    const db = {
      workspace: { findOne: jest.fn().mockResolvedValue({ uuid: workspace, name: 'WS', url: 'ws' }) },
      getWorkspaceRole: jest.fn().mockResolvedValue(AccountRole.Owner),
      // No owners -> sendApiKeyCreatedEmail short-circuits on an empty email list.
      getWorkspaceMembers: jest.fn().mockResolvedValue([]),
      ensurePerson: jest.fn().mockImplementation(async (type: string, value: string) => {
        const uuid = `person-${value}` as AccountUuid
        const socialId = `webhook-social-${value}`
        socialIdRows.set(socialId, { _id: socialId, type, personUuid: uuid })
        return { uuid, socialId }
      }),
      socialId: {
        insertOne: jest.fn().mockImplementation(async (data: Partial<SocialIdRow>) => {
          const id = `huly-social-${nextId++}`
          socialIdRows.set(id, {
            _id: id,
            type: data.type as string,
            personUuid: data.personUuid as AccountUuid,
            verifiedOn: data.verifiedOn
          })
          return id
        }),
        update: jest.fn().mockImplementation(async (query: { _id: string }, ops: Partial<SocialIdRow>) => {
          const row = socialIdRows.get(query._id)
          if (row != null) Object.assign(row, ops)
        }),
        findOne: jest.fn().mockImplementation(async (query: { _id: string }) => socialIdRows.get(query._id) ?? null),
        find: jest.fn().mockResolvedValue([])
      },
      account: { insertOne: jest.fn() },
      accountEvent: { insertOne: jest.fn() },
      userProfile: { insertOne: jest.fn() },
      assignWorkspace: jest.fn(),
      integration: { insertOne: jest.fn() },
      unassignWorkspace: jest.fn(),
      integrationSecret: {
        // Copies, like a real row read: a caller must not observe a concurrent update through its own row.
        find: jest.fn().mockImplementation(async () => integrationSecretRows.map((r) => ({ ...r }))),
        insertOne: jest.fn().mockImplementation(async (row: { socialId: string, secret: string }) => {
          integrationSecretRows.push(row)
        }),
        findOne: jest.fn().mockImplementation(async (query: Record<string, unknown>) => {
          const row = matching(query)[0]
          return row !== undefined ? { ...row } : null
        }),
        update: jest.fn().mockImplementation(async (query: Record<string, unknown>, ops: Record<string, unknown>) => {
          for (const row of matching(query)) Object.assign(row, ops)
        })
      }
    } as unknown as AccountDB

    return { db, socialIdRows }
  }

  test('the webhook social id is verified, the auto Huly id is not', async () => {
    const { db, socialIdRows } = makeDb()

    const result = await createApiKey(mockCtx, db, null, ownerToken, { name: 'ci', ops: ['chat:post'] })

    const webhookRow = [...socialIdRows.values()].find((r) => r.type === SocialIdType.WEBHOOK)
    const hulyRow = [...socialIdRows.values()].find((r) => r.type === SocialIdType.HULY)

    expect(result.info.personal).toBeUndefined()
    expect(webhookRow?.verifiedOn).toBeGreaterThan(0)
    expect(hulyRow?.verifiedOn).toBeUndefined()
  })

  test('a revoke landing mid-verify is not erased by the lastUsed write that follows it', async () => {
    const { db } = makeDb()
    const created = await createApiKey(mockCtx, db, null, ownerToken, { name: 'ci', ops: ['chat:post'] })

    // verifyApiKey reads the secret row, then the social id, then writes lastUsed back. Revoking from
    // inside that social-id read puts a concurrent revoke exactly in the window between read and write.
    const socialIdFindOne = db.socialId.findOne as jest.Mock
    const original = socialIdFindOne.getMockImplementation() as (q: any) => Promise<any>
    socialIdFindOne.mockImplementationOnce(async (query: any) => {
      await revokeApiKey(mockCtx, db, null, ownerToken, { keyId: created.info.keyId })
      return await original(query)
    })

    const check = await verifyApiKey(mockCtx, db, null, webhookToken, { key: created.key })
    expect(check).not.toBeNull()

    // The key must be dead now: the stale write lost the compare-and-swap on `secret`.
    expect(await verifyApiKey(mockCtx, db, null, webhookToken, { key: created.key })).toBeNull()
  })

  test('the created integration account is reported by getApiKeyAccounts (kept out of the seat count)', async () => {
    const { db, socialIdRows } = makeDb()

    await createApiKey(mockCtx, db, null, ownerToken, { name: 'ci', ops: ['chat:post'] })
    const webhookRow = [...socialIdRows.values()].find((r) => r.type === SocialIdType.WEBHOOK)

    // getApiKeyAccounts is exactly what SeatLimitsMiddleware.resolveIntegrationAccounts calls through
    // the account-client provider - being in this list is what makes seatEligible() return false.
    const integrationAccounts = await getApiKeyAccounts(mockCtx, db, null, transactorToken, { workspace })

    expect(integrationAccounts).toEqual([webhookRow?.personUuid])
  })
})

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

import { AccountRole, type AccountUuid, type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import { generateToken } from '@hcengineering/server-token'

import { type ApiKeySecret, hashApiKey } from '../apiKeys'
import { createApiKey, listApiKeys, revokeApiKey } from '../operations'
import { type AccountDB, type Workspace } from '../types'

describe('personal API keys', () => {
  const mockCtx = { error: jest.fn(), info: jest.fn(), warn: jest.fn() } as unknown as MeasureContext
  const workspace = '11111111-1111-4111-8111-111111111111' as WorkspaceUuid
  const owner = '22222222-2222-4222-8222-222222222222' as AccountUuid
  const memberA = '33333333-3333-4333-8333-333333333333' as AccountUuid
  const memberB = '44444444-4444-4444-8444-444444444444' as AccountUuid
  const guest = '55555555-5555-4555-8555-555555555555' as AccountUuid

  const ownerToken = generateToken(owner, workspace, undefined)
  const memberAToken = generateToken(memberA, workspace, undefined)
  const memberBToken = generateToken(memberB, workspace, undefined)
  const guestToken = generateToken(guest, workspace, undefined)

  const roleByAccount: Record<string, AccountRole> = {
    [owner]: AccountRole.Owner,
    [memberA]: AccountRole.User,
    [memberB]: AccountRole.User,
    [guest]: AccountRole.Guest
  }

  function existingSecret (
    keyId: string,
    createdBy: AccountUuid,
    over: Partial<ApiKeySecret> = {}
  ): { socialId: string, key: string, kind: string, workspaceUuid: WorkspaceUuid, secret: string } {
    const secret: ApiKeySecret = {
      keyId,
      name: keyId,
      masked: 'fus_ws_...abcd',
      ops: [],
      spaces: [],
      createdOn: Date.now(),
      createdBy,
      ...over
    }
    return {
      socialId: `soc-${keyId}`,
      key: hashApiKey(`fus_ws_${keyId}`),
      kind: 'webhook',
      workspaceUuid: workspace,
      secret: JSON.stringify(secret)
    }
  }

  function makeDb (existing: ReturnType<typeof existingSecret>[] = []): AccountDB {
    const wsRow: Partial<Workspace> & { uuid: WorkspaceUuid } = { uuid: workspace, name: 'Test WS', url: 'test-ws' }
    return {
      workspace: { findOne: jest.fn().mockResolvedValue(wsRow) },
      getWorkspaceRole: jest.fn().mockImplementation(async (account: AccountUuid) => roleByAccount[account] ?? null),
      getWorkspaceMembers: jest.fn().mockResolvedValue([{ person: owner, role: AccountRole.Owner }]),
      socialId: {
        // A confirmed social id for "getSocialIds"/"getAccountEmail" - shape does not matter for these tests.
        find: jest
          .fn()
          .mockImplementation(async (query: any) => [
            { _id: `social-${query.personUuid}`, value: `${query.personUuid}@example.com`, createdOn: 1, verifiedOn: 1 }
          ]),
        findOne: jest.fn(),
        insertOne: jest.fn().mockResolvedValue('huly-social-id'),
        update: jest.fn()
      },
      person: { findOne: jest.fn().mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' }) },
      ensurePerson: jest.fn().mockResolvedValue({ uuid: 'key-person-uuid', socialId: 'key-social-id' }),
      account: { insertOne: jest.fn() },
      accountEvent: { insertOne: jest.fn() },
      userProfile: { insertOne: jest.fn() },
      assignWorkspace: jest.fn(),
      unassignWorkspace: jest.fn(),
      integration: { insertOne: jest.fn() },
      integrationSecret: {
        find: jest.fn().mockResolvedValue(existing),
        insertOne: jest.fn(),
        update: jest.fn()
      }
    } as unknown as AccountDB
  }

  test('a non-owner member can create a personal key; a guest cannot', async () => {
    const db = makeDb()

    const result = await createApiKey(mockCtx, db, null, memberAToken, { name: 'my key', ops: [], personal: true })
    expect(result.info.personal).toBe(true)
    expect(result.info.createdBy).toBe(memberA)

    await expect(createApiKey(mockCtx, db, null, guestToken, { name: 'x', ops: [], personal: true })).rejects.toThrow(
      new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    )
  })

  test('a non-owner member cannot create an integration key', async () => {
    const db = makeDb()

    await expect(createApiKey(mockCtx, db, null, memberAToken, { name: 'x', ops: ['issue:create'] })).rejects.toThrow(
      new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    )
  })

  test('unrestricted: true on a personal key drops ops but keeps its spaces', async () => {
    const db = makeDb()

    const result = await createApiKey(mockCtx, db, null, memberAToken, {
      name: 'x',
      ops: ['issue:create', 'chat:post'],
      spaces: ['space-1' as any],
      personal: true,
      unrestricted: true
    })

    expect(result.info.ops).toEqual([])
    // Spaces survive: unlike an operation name, a space is checkable on any write the key makes.
    expect(result.info.spaces).toEqual(['space-1'])
    expect(result.info.unrestricted).toBe(true)
  })

  test('a narrowed personal key (no unrestricted) stores exactly the ops/spaces it was given', async () => {
    const db = makeDb()

    const result = await createApiKey(mockCtx, db, null, memberAToken, {
      name: 'x',
      ops: ['issue:create', 'chat:post'],
      spaces: ['space-1' as any],
      personal: true
    })

    expect(result.info.ops).toEqual(['issue:create', 'chat:post'])
    expect(result.info.spaces).toEqual(['space-1'])
    expect(result.info.unrestricted).toBeUndefined()
  })

  test('unrestricted: true on an integration key is refused with BadRequest', async () => {
    const db = makeDb()

    await expect(
      createApiKey(mockCtx, db, null, ownerToken, { name: 'x', ops: ['issue:create'], unrestricted: true })
    ).rejects.toThrow(new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {})))
  })

  test('invalid ops on a narrowed personal key are refused', async () => {
    const db = makeDb()

    await expect(
      createApiKey(mockCtx, db, null, memberAToken, { name: 'x', ops: ['not:a-real-op' as any], personal: true })
    ).rejects.toThrow(new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {})))
  })

  test('the personal quota is per user: 5 keys by A do not block B or an integration key', async () => {
    const existing = Array.from({ length: 5 }, (_, i) => existingSecret(`a-${i}`, memberA, { personal: true }))
    const db = makeDb(existing)

    await expect(
      createApiKey(mockCtx, db, null, memberAToken, { name: 'one-too-many', ops: [], personal: true })
    ).rejects.toThrow(new PlatformError(new Status(Severity.ERROR, platform.status.ApiKeyLimitReached, { limit: 5 })))

    const forB = await createApiKey(mockCtx, db, null, memberBToken, { name: 'fits', ops: [], personal: true })
    expect(forB.info.createdBy).toBe(memberB)

    const integration = await createApiKey(mockCtx, db, null, ownerToken, { name: 'integration', ops: [] })
    expect(integration.info.personal).toBeUndefined()
  })

  test('integration keys do not consume the personal quota and vice versa', async () => {
    const fiveIntegrationKeys = Array.from({ length: 5 }, (_, i) => existingSecret(`int-${i}`, owner))
    const dbWithIntegrations = makeDb(fiveIntegrationKeys)
    const personalStillFits = await createApiKey(mockCtx, dbWithIntegrations, null, memberAToken, {
      name: 'personal',
      ops: [],
      personal: true
    })
    expect(personalStillFits.info.personal).toBe(true)

    const fivePersonalKeys = Array.from({ length: 5 }, (_, i) =>
      existingSecret(`per-${i}`, memberA, { personal: true })
    )
    const dbWithPersonal = makeDb(fivePersonalKeys)
    const integrationStillFits = await createApiKey(mockCtx, dbWithPersonal, null, ownerToken, {
      name: 'integration',
      ops: []
    })
    expect(integrationStillFits.info.personal).toBeUndefined()
  })

  test('listApiKeys as a member returns only that member personal keys; as Owner returns everything', async () => {
    const existing = [
      existingSecret('int-1', owner),
      existingSecret('per-a', memberA, { personal: true }),
      existingSecret('per-b', memberB, { personal: true })
    ]
    const db = makeDb(existing)

    const asMemberA = await listApiKeys(mockCtx, db, null, memberAToken)
    expect(asMemberA.keys.map((k) => k.keyId)).toEqual(['per-a'])
    expect(asMemberA.personalLimit).toBe(5)

    const asOwner = await listApiKeys(mockCtx, db, null, ownerToken)
    expect(asOwner.keys.map((k) => k.keyId).sort()).toEqual(['int-1', 'per-a', 'per-b'])
  })

  test('a guest is refused from listApiKeys', async () => {
    const db = makeDb()

    await expect(listApiKeys(mockCtx, db, null, guestToken)).rejects.toThrow(
      new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    )
  })

  test('revokeApiKey: a member cannot revoke another member key nor an integration key', async () => {
    const existing = [existingSecret('int-1', owner), existingSecret('per-b', memberB, { personal: true })]
    const db = makeDb(existing)

    await expect(revokeApiKey(mockCtx, db, null, memberAToken, { keyId: 'per-b' })).rejects.toThrow(
      new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    )
    await expect(revokeApiKey(mockCtx, db, null, memberAToken, { keyId: 'int-1' })).rejects.toThrow(
      new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    )
    expect(db.integrationSecret.update).not.toHaveBeenCalled()
  })

  test('revoking own personal key succeeds and never unassigns the caller from the workspace', async () => {
    const existing = [existingSecret('per-a', memberA, { personal: true })]
    const db = makeDb(existing)

    await revokeApiKey(mockCtx, db, null, memberAToken, { keyId: 'per-a' })

    expect(db.integrationSecret.update).toHaveBeenCalled()
    expect(db.unassignWorkspace).not.toHaveBeenCalled()
  })

  test('an owner can revoke any key, including a member personal key', async () => {
    const existing = [existingSecret('per-a', memberA, { personal: true })]
    const db = makeDb(existing)

    await revokeApiKey(mockCtx, db, null, ownerToken, { keyId: 'per-a' })

    expect(db.integrationSecret.update).toHaveBeenCalled()
    expect(db.unassignWorkspace).not.toHaveBeenCalled()
  })
})

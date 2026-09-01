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

jest.mock('../adminOp', () => ({ ...jest.requireActual('../adminOp'), requireAdminOp: jest.fn() }))

/* eslint-disable import/first */
import {
  AccountRole,
  type AccountUuid,
  type MeasureContext,
  type PersonUuid,
  type WorkspaceUuid
} from '@hcengineering/core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import { generateToken } from '@hcengineering/server-token'

import { type ApiKeySecret, hashApiKey } from '../apiKeys'
import { adminUpdateApiKeyLimit } from '../serviceOperations'
import { createApiKey } from '../operations'
import { requireAdminOp } from '../adminOp'
import { type AccountDB, type Workspace } from '../types'
/* eslint-enable import/first */

describe('api key limit per workspace', () => {
  const mockCtx = { error: jest.fn(), info: jest.fn(), warn: jest.fn() } as unknown as MeasureContext
  const workspace = '11111111-1111-4111-8111-111111111111' as WorkspaceUuid
  const owner = '22222222-2222-4222-8222-222222222222' as AccountUuid
  const callerToken = generateToken(owner, workspace, undefined)
  const adminToken = generateToken(owner, workspace, { admin: 'true' })

  function existingSecret (
    keyId: string,
    over: Partial<ApiKeySecret> = {}
  ): { socialId: string, key: string, kind: string, workspaceUuid: WorkspaceUuid, secret: string } {
    const secret: ApiKeySecret = {
      keyId,
      name: keyId,
      masked: 'fus_ws_...abcd',
      ops: [],
      spaces: [],
      createdOn: Date.now(),
      createdBy: owner,
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

  function makeDb (existing: ReturnType<typeof existingSecret>[], maxApiKeys?: number | null): AccountDB {
    const wsRow: Partial<Workspace> & { uuid: WorkspaceUuid } = {
      uuid: workspace,
      name: 'Test WS',
      url: 'test-ws',
      maxApiKeys
    }
    return {
      workspace: { findOne: jest.fn().mockResolvedValue(wsRow), update: jest.fn() },
      getWorkspaceRole: jest.fn().mockResolvedValue(AccountRole.Owner),
      getWorkspaceMembers: jest.fn().mockResolvedValue([]),
      socialId: {
        find: jest.fn().mockResolvedValue([]),
        insertOne: jest.fn().mockResolvedValue('social-id'),
        findOne: jest.fn(),
        update: jest.fn()
      },
      person: { findOne: jest.fn().mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' }) },
      ensurePerson: jest.fn().mockResolvedValue({ uuid: 'key-person-uuid' as PersonUuid, socialId: 'key-social-id' }),
      account: { insertOne: jest.fn() },
      accountEvent: { insertOne: jest.fn() },
      userProfile: { insertOne: jest.fn() },
      assignWorkspace: jest.fn(),
      integration: { insertOne: jest.fn() },
      integrationSecret: {
        find: jest.fn().mockResolvedValue(existing),
        insertOne: jest.fn(),
        update: jest.fn()
      }
    } as unknown as AccountDB
  }

  test('rejects creation once the default limit (5) of active keys is reached', async () => {
    const db = makeDb(Array.from({ length: 5 }, (_, i) => existingSecret(`k${i}`)))

    await expect(createApiKey(mockCtx, db, null, callerToken, { name: 'one-too-many', ops: [] })).rejects.toThrow(
      new PlatformError(new Status(Severity.ERROR, platform.status.ApiKeyLimitReached, { limit: 5 }))
    )
  })

  test('a revoked key frees up a slot', async () => {
    const existing = [
      ...Array.from({ length: 4 }, (_, i) => existingSecret(`k${i}`)),
      existingSecret('revoked', { revokedOn: Date.now() })
    ]
    const db = makeDb(existing)

    const result = await createApiKey(mockCtx, db, null, callerToken, { name: 'fits', ops: [] })
    expect(result.info.name).toBe('fits')
  })

  test('an expired key frees up a slot', async () => {
    const existing = [
      ...Array.from({ length: 4 }, (_, i) => existingSecret(`k${i}`)),
      existingSecret('expired', { expiresOn: Date.now() - 1000 })
    ]
    const db = makeDb(existing)

    const result = await createApiKey(mockCtx, db, null, callerToken, { name: 'fits', ops: [] })
    expect(result.info.name).toBe('fits')
  })

  test('an admin-raised per-workspace limit is honored', async () => {
    const db = makeDb(
      Array.from({ length: 5 }, (_, i) => existingSecret(`k${i}`)),
      10
    )

    const result = await createApiKey(mockCtx, db, null, callerToken, { name: 'fits', ops: [] })
    expect(result.info.name).toBe('fits')
  })

  test('adminUpdateApiKeyLimit writes the override, null resets to the default', async () => {
    const db = makeDb([])

    await adminUpdateApiKeyLimit(mockCtx, db, null, adminToken, { workspace, maxApiKeys: 12, otpCode: '000000' })
    expect(db.workspace.update).toHaveBeenCalledWith({ uuid: workspace }, { maxApiKeys: 12 })
    expect(requireAdminOp).toHaveBeenCalledWith(mockCtx, db, adminToken, 'set_api_key_limit', '000000', workspace)

    await adminUpdateApiKeyLimit(mockCtx, db, null, adminToken, { workspace, maxApiKeys: null, otpCode: '000000' })
    expect(db.workspace.update).toHaveBeenCalledWith({ uuid: workspace }, { maxApiKeys: null })
  })

  test('adminUpdateApiKeyLimit rejects a non-positive limit', async () => {
    const db = makeDb([])

    await expect(
      adminUpdateApiKeyLimit(mockCtx, db, null, adminToken, { workspace, maxApiKeys: 0, otpCode: '000000' })
    ).rejects.toThrow(new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {})))
  })

  test('a failing OTP gate blocks the write', async () => {
    const db = makeDb([])
    ;(requireAdminOp as jest.Mock).mockRejectedValueOnce(
      new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    )

    await expect(
      adminUpdateApiKeyLimit(mockCtx, db, null, adminToken, { workspace, maxApiKeys: 12, otpCode: 'wrong' })
    ).rejects.toThrow(new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {})))
    expect(db.workspace.update).not.toHaveBeenCalled()
  })
})

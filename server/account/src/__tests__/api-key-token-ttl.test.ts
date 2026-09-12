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
  type AccountUuid,
  type MeasureContext,
  type PersonUuid,
  type WorkspaceUuid
} from '@hcengineering/core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import { decodeToken, generateToken } from '@hcengineering/server-token'

import {
  type ApiKeySecret,
  defaultApiKeyTokenTtlMs,
  hashApiKey,
  maxApiKeyTokenTtlMs,
  minApiKeyTokenTtlMs
} from '../apiKeys'
import { type AccountDB } from '../types'

// Only selectWorkspace is faked, to capture the interim token loginWithApiKey hands it - everything
// else (createAccount, publishMembersChanged, generateToken/decodeToken) runs for real.
jest.mock('../utils', () => ({
  ...jest.requireActual('../utils'),
  selectWorkspace: jest.fn().mockResolvedValue({ token: 'final-token' })
}))

// Import the modules under test after the mock is set up
// eslint-disable-next-line import/first
import { createApiKey, loginWithApiKey } from '../operations'
// eslint-disable-next-line import/first
import { selectWorkspace } from '../utils'

const selectWorkspaceMock = selectWorkspace as jest.Mock

describe('api key token ttl', () => {
  const mockCtx = { error: jest.fn(), info: jest.fn(), warn: jest.fn() } as unknown as MeasureContext
  const workspace = '11111111-1111-4111-8111-111111111111' as WorkspaceUuid
  const owner = '22222222-2222-4222-8222-222222222222' as AccountUuid
  const callerToken = generateToken(owner, workspace, undefined)

  const mockDb = {
    workspace: { findOne: jest.fn().mockResolvedValue({ uuid: workspace, name: 'Test WS', url: 'test-ws' }) },
    getWorkspaceRole: jest.fn().mockResolvedValue(AccountRole.Owner),
    getWorkspaceMembers: jest.fn().mockResolvedValue([]),
    socialId: {
      find: jest.fn().mockResolvedValue([]),
      insertOne: jest.fn().mockResolvedValue('huly-social-id'),
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
      find: jest.fn().mockResolvedValue([]),
      insertOne: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn()
    }
  } as unknown as AccountDB

  beforeEach(() => {
    jest.clearAllMocks()
    selectWorkspaceMock.mockResolvedValue({ token: 'final-token' })
    ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: workspace, name: 'Test WS', url: 'test-ws' })
    ;(mockDb.getWorkspaceRole as jest.Mock).mockResolvedValue(AccountRole.Owner)
  })

  describe('createApiKey', () => {
    test('rejects tokenTtlMs shorter than 1 day', async () => {
      await expect(
        createApiKey(mockCtx, mockDb, null, callerToken, { name: 'ci', ops: [], tokenTtlMs: minApiKeyTokenTtlMs - 1 })
      ).rejects.toThrow(new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {})))
    })

    test('rejects tokenTtlMs longer than 90 days', async () => {
      await expect(
        createApiKey(mockCtx, mockDb, null, callerToken, { name: 'ci', ops: [], tokenTtlMs: maxApiKeyTokenTtlMs + 1 })
      ).rejects.toThrow(new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {})))
    })

    test('accepts the boundary values', async () => {
      const min = await createApiKey(mockCtx, mockDb, null, callerToken, {
        name: 'ci-min',
        ops: [],
        tokenTtlMs: minApiKeyTokenTtlMs
      })
      expect(min.info.tokenTtlMs).toBe(minApiKeyTokenTtlMs)

      const max = await createApiKey(mockCtx, mockDb, null, callerToken, {
        name: 'ci-max',
        ops: [],
        tokenTtlMs: maxApiKeyTokenTtlMs
      })
      expect(max.info.tokenTtlMs).toBe(maxApiKeyTokenTtlMs)
    })

    test('defaults to defaultApiKeyTokenTtlMs when omitted', async () => {
      const result = await createApiKey(mockCtx, mockDb, null, callerToken, { name: 'ci', ops: [] })
      expect(result.info.tokenTtlMs).toBe(defaultApiKeyTokenTtlMs)
    })
  })

  describe('loginWithApiKey', () => {
    function secretRow (over: Partial<ApiKeySecret> = {}): {
      workspaceUuid: WorkspaceUuid
      key: string
      socialId: string
      secret: string
    } {
      const secret: ApiKeySecret = {
        keyId: 'k1',
        name: 'ci',
        masked: 'fus_ws_...abcd',
        ops: [],
        spaces: [],
        createdOn: Date.now(),
        createdBy: owner,
        ...over
      }
      return {
        workspaceUuid: workspace,
        key: hashApiKey('fus_ws_secret'),
        socialId: 'soc-1',
        secret: JSON.stringify(secret)
      }
    }

    test('issued token exp matches the key-configured ttl', async () => {
      const tokenTtlMs = 3 * 24 * 60 * 60 * 1000 // 3 days, mid-range custom value
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue(secretRow({ tokenTtlMs }))
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({
        personUuid: '33333333-3333-4333-8333-333333333333' as PersonUuid
      })

      const before = Date.now()
      await loginWithApiKey(mockCtx, mockDb, null, 'caller-token', { key: 'fus_ws_secret' })
      const after = Date.now()

      expect(selectWorkspaceMock).toHaveBeenCalledTimes(1)
      const interimToken = selectWorkspaceMock.mock.calls[0][3] as string
      const decoded = decodeToken(interimToken)

      expect(decoded.exp).toBeDefined()
      expect(decoded.exp as number).toBeGreaterThanOrEqual(Math.floor((before + tokenTtlMs) / 1000))
      expect(decoded.exp as number).toBeLessThanOrEqual(Math.floor((after + tokenTtlMs) / 1000))
      expect(decoded.extra?.apikey).toBe('k1')
    })

    test('falls back to defaultApiKeyTokenTtlMs for legacy secrets missing the field', async () => {
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue(secretRow({ tokenTtlMs: undefined }))
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({
        personUuid: '33333333-3333-4333-8333-333333333333' as PersonUuid
      })

      const before = Date.now()
      await loginWithApiKey(mockCtx, mockDb, null, 'caller-token', { key: 'fus_ws_secret' })
      const after = Date.now()

      const interimToken = selectWorkspaceMock.mock.calls[0][3] as string
      const decoded = decodeToken(interimToken)

      expect(decoded.exp as number).toBeGreaterThanOrEqual(Math.floor((before + defaultApiKeyTokenTtlMs) / 1000))
      expect(decoded.exp as number).toBeLessThanOrEqual(Math.floor((after + defaultApiKeyTokenTtlMs) / 1000))
    })
  })
})

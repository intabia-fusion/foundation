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
import { generateToken } from '@hcengineering/server-token'

import { createApiKey } from '../operations'
import { type AccountDB, type Workspace } from '../types'

describe('API key incoming flag', () => {
  const mockCtx = { error: jest.fn(), info: jest.fn(), warn: jest.fn() } as unknown as MeasureContext
  const workspace = '11111111-1111-4111-8111-111111111111' as WorkspaceUuid
  const owner = '22222222-2222-4222-8222-222222222222' as AccountUuid

  const ownerToken = generateToken(owner, workspace, undefined)

  function makeDb (): AccountDB {
    const wsRow: Partial<Workspace> & { uuid: WorkspaceUuid } = { uuid: workspace, name: 'Test WS', url: 'test-ws' }
    return {
      workspace: { findOne: jest.fn().mockResolvedValue(wsRow) },
      getWorkspaceRole: jest.fn().mockResolvedValue(AccountRole.Owner),
      getWorkspaceMembers: jest.fn().mockResolvedValue([{ person: owner, role: AccountRole.Owner }]),
      socialId: {
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
        find: jest.fn().mockResolvedValue([]),
        insertOne: jest.fn(),
        update: jest.fn()
      }
    } as unknown as AccountDB
  }

  test('incoming: true is stored on the key', async () => {
    const db = makeDb()

    const result = await createApiKey(mockCtx, db, null, ownerToken, {
      name: 'x',
      ops: ['issue:create'],
      incoming: true
    })

    expect(result.info.incoming).toBe(true)
  })

  test('incoming is absent when not asked for', async () => {
    const db = makeDb()

    const result = await createApiKey(mockCtx, db, null, ownerToken, { name: 'x', ops: ['issue:create'] })

    expect(result.info.incoming).toBeUndefined()
  })
})

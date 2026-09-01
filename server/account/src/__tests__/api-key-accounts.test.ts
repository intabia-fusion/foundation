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

import { type AccountUuid, type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import { decodeTokenVerbose } from '@hcengineering/server-token'

import { type ApiKeySecret } from '../apiKeys'
import { getApiKeyAccounts } from '../serviceOperations'
import { type AccountDB } from '../types'

jest.mock('@hcengineering/server-token', () => ({
  decodeTokenVerbose: jest.fn()
}))

describe('getApiKeyAccounts', () => {
  const mockCtx = { error: jest.fn(), info: jest.fn(), warn: jest.fn() } as unknown as MeasureContext
  const workspace = 'ws-uuid' as WorkspaceUuid
  const integrationAccount = 'integration-account-uuid' as AccountUuid
  const personalAccount = 'personal-account-uuid' as AccountUuid

  function makeSecret (over: Partial<ApiKeySecret>): ApiKeySecret {
    return {
      keyId: 'key-id',
      name: 'key',
      masked: 'fus_ws_...abcd',
      ops: [],
      spaces: [],
      createdOn: Date.now(),
      createdBy: integrationAccount,
      ...over
    }
  }

  beforeEach(() => {
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({ extra: { service: 'transactor' } })
  })

  test('excludes personal keys, keeps integration keys', async () => {
    const rows = [
      { socialId: 'soc-integration', secret: JSON.stringify(makeSecret({})) },
      { socialId: 'soc-personal', secret: JSON.stringify(makeSecret({ personal: true })) }
    ]
    const db = {
      integrationSecret: { find: jest.fn().mockResolvedValue(rows) },
      socialId: {
        findOne: jest
          .fn()
          .mockImplementation(async ({ _id }: { _id: string }) =>
            _id === 'soc-integration' ? { _id, personUuid: integrationAccount } : { _id, personUuid: personalAccount }
          )
      }
    } as unknown as AccountDB

    const result = await getApiKeyAccounts(mockCtx, db, null, 'token', { workspace })

    expect(result).toEqual([integrationAccount])
  })
})

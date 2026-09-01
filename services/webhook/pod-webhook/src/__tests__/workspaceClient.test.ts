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

jest.mock('@hcengineering/account-client', () => ({
  getClient: jest.fn(() => ({
    selectWorkspace: jest.fn().mockResolvedValue({
      endpoint: 'ws://transactor.local',
      collaboratorEndpoint: 'http://collab.local'
    })
  }))
}))
jest.mock('@hcengineering/api-client', () => ({ createRestClient: jest.fn() }))

/* eslint-disable import/first */
import { SocialIdType } from '@hcengineering/core'
import { createRestClient } from '@hcengineering/api-client'
import { getTransactorTarget, type KeyGrant } from '../workspaceClient'
/* eslint-enable import/first */

const newCtx = (): any => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })

const config: any = { AccountsUrl: 'http://accounts.local' }

function grant (overrides: Partial<KeyGrant> = {}): KeyGrant {
  return {
    keyId: 'key_1',
    name: 'ci',
    personUuid: '33333333-3333-4333-8333-333333333333' as any,
    ops: ['chat:post'],
    spaces: [],
    ...overrides
  }
}

describe('getTransactorTarget', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  test('materializes the integration person once and caches it for a later call with the same key', async () => {
    const ensurePerson = jest.fn().mockResolvedValue({ uuid: 'person_1', socialId: 'social_1', localPerson: 'p1' })
    ;(createRestClient as jest.Mock).mockReturnValue({ ensurePerson })

    const ctx = newCtx()
    const workspace = '44444444-4444-4444-8444-444444444444' as any
    await getTransactorTarget(ctx, config, workspace, grant())
    await getTransactorTarget(ctx, config, workspace, grant())

    expect(ensurePerson).toHaveBeenCalledTimes(1)
    expect(ensurePerson).toHaveBeenCalledWith(SocialIdType.WEBHOOK, 'key_1', 'ci', '')
  })

  test('a failed ensurePerson call does not fail target resolution', async () => {
    const ensurePerson = jest.fn().mockRejectedValue(new Error('forbidden'))
    ;(createRestClient as jest.Mock).mockReturnValue({ ensurePerson })

    const ctx = newCtx()
    const workspace = '55555555-5555-4555-8555-555555555555' as any
    const target = await getTransactorTarget(ctx, config, workspace, grant())

    expect(target.transactorUrl).toBe('http://transactor.local')
    expect(ctx.warn).toHaveBeenCalled()
  })
})

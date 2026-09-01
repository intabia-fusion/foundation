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

import type { LoginInfoWithWorkspaces } from '@hcengineering/account-client'
import type { Account, WorkspaceIds } from '@hcengineering/core'
import type { OneSecondCounters } from '@hcengineering/server-core'
import type { Token } from '@hcengineering/server-token'

import { ClientSession } from '../client'

function makeToken (extra?: Record<string, string>): Token {
  return { account: 'acc-1', workspace: 'ws-1', extra } as unknown as Token
}

describe('ClientSession api key grant caching', () => {
  const workspace = {} as unknown as WorkspaceIds
  const account = {} as unknown as Account
  const info = {} as unknown as LoginInfoWithWorkspaces
  const counters = {} as unknown as OneSecondCounters

  it('a key with operations writes only through the ops API', () => {
    const token = makeToken({ apikey: 'key-1', apiops: 'issue:create', apispaces: 'space-1' })
    const session = new ClientSession(token, workspace, account, info, false, counters)

    expect((session as any).apiKeyCached).toEqual({ canWrite: true, opsOnly: true, spaces: ['space-1'] })
  })

  it('a key without operations cannot write at all', () => {
    const token = makeToken({ apikey: 'key-2', apispaces: 'space-2' })
    const session = new ClientSession(token, workspace, account, info, false, counters)

    expect((session as any).apiKeyCached).toEqual({ canWrite: false, opsOnly: true, spaces: ['space-2'] })
  })

  it('extra.apiall writes through any API, still narrowed by its spaces', () => {
    const token = makeToken({ apikey: 'key-1', apiall: '1', apispaces: 'space-3' })
    const session = new ClientSession(token, workspace, account, info, false, counters)

    expect((session as any).apiKeyCached).toEqual({ canWrite: true, opsOnly: false, spaces: ['space-3'] })
  })

  it('no extra.apikey produces no apiKey grant', () => {
    const token = makeToken({})
    const session = new ClientSession(token, workspace, account, info, false, counters)

    expect((session as any).apiKeyCached).toBeUndefined()
  })
})

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
import type { ClientSessionCtx, OneSecondCounters } from '@hcengineering/server-core'
import type { Token } from '@hcengineering/server-token'

import { ClientSession } from '../client'

function makeToken (extra?: Record<string, string>): Token {
  return { account: 'acc-1', workspace: 'ws-1', extra } as unknown as Token
}

describe('ClientSession.includeSessionContext', () => {
  it('a plain RPC does not inherit opsApi', () => {
    const workspace = {} as unknown as WorkspaceIds
    const account = {} as unknown as Account
    const info = {} as unknown as LoginInfoWithWorkspaces
    const counters = {} as unknown as OneSecondCounters
    const session = new ClientSession(makeToken(), workspace, account, info, false, counters)

    // /api/v1/ops is the only place that sets opsApi on contextData, after this call returns.
    const ctx = {
      ctx: {},
      pipeline: { context: { modelDb: {} } },
      socialStringsToUsers: new Map()
    } as unknown as ClientSessionCtx

    session.includeSessionContext(ctx)

    expect((ctx.ctx as any).contextData.opsApi).toBeUndefined()
  })
})

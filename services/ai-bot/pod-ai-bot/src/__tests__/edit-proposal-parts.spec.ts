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

import type { ReqCtx } from '../utils/tools'

// workspaceClient.ts pulls in config.ts, which throws without these.
process.env.ACCOUNTS_URL = 'http://account:3000'
process.env.SERVER_SECRET = 'secret'
process.env.FIRST_NAME = 'Julia'
process.env.LAST_NAME = 'AI'
process.env.STORAGE_CONFIG = 'minio'
process.env.CHUNK_STORAGE_CONFIG = 'minio'
/* eslint-disable @typescript-eslint/no-var-requires */
const { WorkspaceClient } = require('../workspace/workspaceClient') as typeof import('../workspace/workspaceClient')
/* eslint-enable @typescript-eslint/no-var-requires */

const target = { targetId: 'doc' as any, targetClass: 'cls' as any, targetAttr: 'content' }

// postEditProposal only reaches into the client for the current document text, so a stub of that
// one method is enough to drive the staging logic.
function client (current?: string): any {
  return { currentTargetMarkdown: async () => current }
}

async function post (host: any, ctx: ReqCtx, markdown: string, hasMore = false): Promise<boolean> {
  return await WorkspaceClient.prototype.postEditProposal.call(host, ctx, target, markdown, hasMore)
}

function makeCtx (): ReqCtx {
  return { objectId: 'o' as any, objectClass: 'c' as any, space: 's' as any, collection: 'replies' }
}

describe('postEditProposal parts', () => {
  it('appends the next part instead of replacing the staged document', async () => {
    const host = client()
    const ctx = makeCtx()

    await post(host, ctx, '# Title\n\nfirst', true)
    await post(host, ctx, ' second', true)
    await post(host, ctx, ' third')

    const pending = ctx.pending as any
    expect(pending.markdown).toBe('# Title\n\nfirst second third')
    expect(pending.awaitingMore).toBe(false)
  })

  it('replaces the staged document when the previous call was final', async () => {
    const host = client()
    const ctx = makeCtx()

    await post(host, ctx, 'first version')
    await post(host, ctx, 'second version')

    expect((ctx.pending as any).markdown).toBe('second version')
  })

  it('keeps staging intermediate parts even when they match the current document', async () => {
    // The no-op guard must not fire mid-document: an early part naturally equals nothing useful.
    const host = client('whole document')
    const ctx = makeCtx()

    const posted = await post(host, ctx, 'whole ', true)

    expect(posted).toBe(true)
    expect((ctx.pending as any).awaitingMore).toBe(true)
  })

  it('reports a no-op only once the joined document matches the current one', async () => {
    const host = client('one two')
    const ctx = makeCtx()

    await post(host, ctx, 'one', true)
    const posted = await post(host, ctx, ' two')

    expect(posted).toBe(false)
    expect(ctx.pending).toBeUndefined()
  })

  it('marks the proposal complete on the last part', async () => {
    const host = client()
    const ctx = makeCtx()

    await post(host, ctx, 'body', true)
    expect((ctx.pending as any).awaitingMore).toBe(true)

    await post(host, ctx, ' end')
    expect((ctx.pending as any).awaitingMore).toBe(false)
    expect((ctx.pending as any).proposedMarkup).toContain('body end')
  })
})

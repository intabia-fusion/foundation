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
import core, {
  type AccountUuid,
  type Doc,
  type DocumentQuery,
  type FindResult,
  MeasureMetricsContext,
  type Ref,
  type Space,
  type Tx
} from '@hcengineering/core'
import type { Middleware, PipelineContext, TxMiddlewareResult } from '@hcengineering/server-core'
import { ApiKeyPermissionsMiddleware } from '../apiKeyPermissions'

// Space membership/public-space access is checked by SpaceSecurityMiddleware for every session;
// this middleware only narrows ops/spaces, so a bare context is enough here.
const anyContext = {} as unknown as PipelineContext

const SPACE_A = 'spaceA' as Ref<Space>
const SPACE_B = 'spaceB' as Ref<Space>
const ACCOUNT = 'account1' as AccountUuid

function createTx (space: Ref<Space>): Tx {
  return {
    _class: core.class.TxCreateDoc,
    objectSpace: space,
    objectClass: core.class.Doc,
    objectId: 'doc1'
  } as unknown as Tx
}

// next-middleware: records what reached it so tests can assert pass-through vs rejection.
function makeNext (): { next: Middleware, txCalled: () => boolean, lastQuery: () => DocumentQuery<Doc> | undefined } {
  let txCalled = false
  let lastQuery: DocumentQuery<Doc> | undefined
  const next = {
    tx: async (): Promise<TxMiddlewareResult> => {
      txCalled = true
      return {}
    },
    findAll: async (_ctx: any, _class: any, query: DocumentQuery<Doc>): Promise<FindResult<Doc>> => {
      lastQuery = query
      return [] as unknown as FindResult<Doc>
    }
  } as unknown as Middleware
  return { next, txCalled: () => txCalled, lastQuery: () => lastQuery }
}

interface ApiKeyGrant { canWrite: boolean, opsOnly: boolean, spaces: Ref<Space>[] }

// A key narrowed to named operations, as loginWithApiKey mints it for a webhook integration.
function opsKey (spaces: Ref<Space>[] = []): ApiKeyGrant {
  return { canWrite: true, opsOnly: true, spaces }
}

function makeCtx (apiKey?: ApiKeyGrant, opsApi: boolean = false, account: AccountUuid = ACCOUNT): any {
  const ctx = new MeasureMetricsContext('test', {})
  ;(ctx as any).contextData = { apiKey, opsApi, account: { uuid: account } }
  return ctx
}

async function runTx (
  mw: ApiKeyPermissionsMiddleware,
  apiKey: ApiKeyGrant | undefined,
  tx: Tx,
  opsApi: boolean = true
): Promise<{ rejected: boolean }> {
  try {
    await mw.tx(makeCtx(apiKey, opsApi), [tx])
    return { rejected: false }
  } catch {
    return { rejected: true }
  }
}

describe('ApiKeyPermissionsMiddleware', () => {
  const ctx = new MeasureMetricsContext('test', {})

  it('read-only key rejects any write', async () => {
    const { next, txCalled } = makeNext()
    const mw = await ApiKeyPermissionsMiddleware.create(ctx, anyContext, next)

    const readOnly = { canWrite: false, opsOnly: true, spaces: [] }
    expect((await runTx(mw, readOnly, createTx(SPACE_A))).rejected).toBe(true)
    expect(txCalled()).toBe(false)
  })

  it('key narrowed to operations writes through the ops route only', async () => {
    const { next, txCalled } = makeNext()
    const mw = await ApiKeyPermissionsMiddleware.create(ctx, anyContext, next)

    expect((await runTx(mw, opsKey(), createTx(SPACE_A), false)).rejected).toBe(true)
    expect(txCalled()).toBe(false)
    expect((await runTx(mw, opsKey(), createTx(SPACE_A), true)).rejected).toBe(false)
    expect(txCalled()).toBe(true)
  })

  it('unrestricted key writes through the raw API, still scoped to its spaces', async () => {
    const { next } = makeNext()
    const mw = await ApiKeyPermissionsMiddleware.create(ctx, anyContext, next)
    const apiKey = { canWrite: true, opsOnly: false, spaces: [SPACE_A] }

    expect((await runTx(mw, apiKey, createTx(SPACE_A), false)).rejected).toBe(false)
    expect((await runTx(mw, apiKey, createTx(SPACE_B), false)).rejected).toBe(true)
  })

  it('key scoped to spaces writes into its own space, rejects others', async () => {
    const { next, txCalled } = makeNext()
    const mw = await ApiKeyPermissionsMiddleware.create(ctx, anyContext, next)
    const apiKey = opsKey([SPACE_A])

    expect((await runTx(mw, apiKey, createTx(SPACE_A))).rejected).toBe(false)
    expect(txCalled()).toBe(true)
    expect((await runTx(mw, apiKey, createTx(SPACE_B))).rejected).toBe(true)
  })

  it('reads are not narrowed: project types and persons live outside the key spaces', async () => {
    const { next, lastQuery } = makeNext()
    const mw = await ApiKeyPermissionsMiddleware.create(ctx, anyContext, next)

    const query: DocumentQuery<Doc> = { name: 'x' } as unknown as DocumentQuery<Doc>
    await mw.findAll(makeCtx({ canWrite: false, opsOnly: true, spaces: [SPACE_A] }), core.class.Doc, query)

    expect(lastQuery()).toBe(query)
  })

  it('a trigger-derived tx is not judged against the key spaces', async () => {
    const { next, txCalled } = makeNext()
    const mw = await ApiKeyPermissionsMiddleware.create(ctx, anyContext, next)

    const derived = { ...createTx(SPACE_B), space: core.space.DerivedTx }
    expect((await runTx(mw, opsKey([SPACE_A]), derived)).rejected).toBe(false)
    expect(txCalled()).toBe(true)
  })

  it('undefined grant (non-key session) lets a write through', async () => {
    const { next, txCalled } = makeNext()
    const mw = await ApiKeyPermissionsMiddleware.create(ctx, anyContext, next)

    // client.ts caches no grant for a token without extra.apikey, so ctx.contextData.apiKey is undefined.
    await mw.tx(makeCtx(undefined), [createTx(SPACE_A)])
    expect(txCalled()).toBe(true)
  })

  it('token without extra.apikey passes through unchanged', async () => {
    const { next, txCalled, lastQuery } = makeNext()
    const mw = await ApiKeyPermissionsMiddleware.create(ctx, anyContext, next)

    await mw.tx(makeCtx(undefined), [createTx(SPACE_B)])
    expect(txCalled()).toBe(true)

    const query: DocumentQuery<Doc> = { name: 'x' } as unknown as DocumentQuery<Doc>
    await mw.findAll(makeCtx(undefined), core.class.Doc, query)
    expect(lastQuery()).toBe(query)
  })
})

//
// Copyright © 2026 Intabia Fusion
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
  type Class,
  type Doc,
  generateId,
  type Ref,
  type Space,
  type TxCUD,
  TxFactory,
  toFindResult
} from '@hcengineering/core'
import type { Middleware } from '@hcengineering/server-core'
import { SpaceSecurityMiddleware } from '../../spaceSecurity'
import { bench, describeBench } from '@hcengineering/measurements'
import { type BenchHarness, createHarness, makeNextMiddleware, makeSpaces } from './harness'

describeBench('SpaceSecurityMiddleware.findAll bench', () => {
  const userAcc = 'bench-user' as AccountUuid

  async function setup (spaceCount: number): Promise<{
    mw: SpaceSecurityMiddleware
    targetClass: Ref<Class<Doc>>
    ctx: any
  }> {
    const spaces = makeSpaces(spaceCount, userAcc)
    const h = createHarness({ spaces })
    const next = makeNextMiddleware(h, {
      findAll: async <T extends Doc>(
        _c: any,
        _cls: Ref<Class<T>>,
        _q: any,
        _o?: any
      ): Promise<ReturnType<typeof toFindResult<T>>> => {
        if (_cls === core.class.Space) {
          return toFindResult((h as any).seededSpaces as unknown as T[])
        }
        return toFindResult<T>([])
      }
    })
    const mw = await SpaceSecurityMiddleware.create(h.ctx, h.pipelineContext, next as unknown as Middleware)
    // Pre-init security state so findAll bench doesn't measure init.
    await (mw as any).init(h.ctx)
    return { mw, targetClass: core.class.Space as Ref<Class<Doc>>, ctx: h.ctx }
  }

  for (const n of [10, 100, 1000]) {
    it(`findAll on user-visible doc, ${n} spaces`, async () => {
      const { mw, targetClass, ctx } = await setup(n)
      const q = { archived: false }
      await bench(`spaceSecurity findAll (spaces=${n})`, async () => {
        await mw.findAll(ctx, targetClass, q as any, undefined)
      })
    })
  }

  it('findAll with $in[space] - 100 ids in query', async () => {
    const { mw, targetClass, ctx } = await setup(1000)
    const ids: Ref<Space>[] = []
    for (const id of (mw as any).spacesMap.keys()) {
      ids.push(id)
      if (ids.length >= 100) break
    }
    const q: any = { space: { $in: ids } }
    await bench('spaceSecurity findAll($in=100, spaces=1000)', async () => {
      await mw.findAll(ctx, targetClass, q, undefined)
    })
  })

  it('findAll with lookup - filterLookup pass (50 spaces visible)', async () => {
    const { mw, targetClass, ctx } = await setup(200)
    const visible: Ref<Space>[] = []
    for (const id of (mw as any).spacesMap.keys()) {
      visible.push(id)
      if (visible.length >= 20) break
    }
    // Patch next.findAll to return docs with $lookup payload so filterLookup runs.
    const original = (mw as any).next.findAll
    ;(mw as any).next.findAll = async <T extends Doc>(_c: any, _cls: any, _q: any, _o: any) => {
      if (_cls === core.class.Space) {
        // still feed seeded spaces for init/group calls
        return original(_c, _cls, _q, _o)
      }
      const docs: any[] = []
      for (let i = 0; i < 50; i++) {
        docs.push({
          _id: 'doc-' + i,
          _class: _cls,
          space: visible[i % visible.length],
          modifiedOn: 0,
          modifiedBy: core.account.System,
          $lookup: {
            space: {
              _id: visible[i % visible.length],
              _class: core.class.Space,
              space: core.space.Space,
              members: [],
              private: false,
              archived: false,
              name: 'l',
              description: '',
              modifiedBy: core.account.System,
              modifiedOn: 0
            }
          }
        })
      }
      return toFindResult(docs as T[])
    }
    const opts: any = { lookup: { space: core.class.Space } }
    await bench('spaceSecurity findAll(lookup=50)', async () => {
      await mw.findAll(ctx, targetClass, {} as any, opts)
    })
  })
})

describeBench('SpaceSecurityMiddleware.tx bench', () => {
  const userAcc = 'bench-user' as AccountUuid
  const txFactory = new TxFactory(core.account.System)
  const derivedFactory = new TxFactory(core.account.System, true)

  async function setupTx (
    spaceCount: number
  ): Promise<{ mw: SpaceSecurityMiddleware, h: BenchHarness, writable: Ref<Space> }> {
    const spaces = makeSpaces(spaceCount, userAcc)
    const h = createHarness({ spaces })
    const next = makeNextMiddleware(h)
    const mw = await SpaceSecurityMiddleware.create(h.ctx, h.pipelineContext, next as unknown as Middleware)
    // Pre-init so tx bench measures the write check, not the space load.
    await (mw as any).init(h.ctx)
    return { mw, h, writable: spaces[0]._id }
  }

  function makeBatch (factory: TxFactory, space: Ref<Space>, count: number): TxCUD<Doc>[] {
    const txes: TxCUD<Doc>[] = []
    for (let i = 0; i < count; i++) {
      txes.push(factory.createTxCreateDoc(core.class.Doc, space, {} as any, generateId()))
    }
    return txes
  }

  for (const n of [10, 100, 1000]) {
    it(`tx write into a member space, batch=10, ${n} spaces`, async () => {
      const { mw, h, writable } = await setupTx(n)
      const txes = makeBatch(txFactory, writable, 10)
      await bench(`spaceSecurity tx member-write (batch=10, spaces=${n})`, async () => {
        await mw.tx(h.ctx, txes)
      })
    })
  }

  // Early return in checkWriteAccess: delta against member-write is the check's own cost.
  it('tx derived - DerivedTx bypass baseline, batch=10, 1000 spaces', async () => {
    const { mw, h, writable } = await setupTx(1000)
    const txes = makeBatch(derivedFactory, writable, 10)
    await bench('spaceSecurity tx derived-bypass (batch=10, spaces=1000)', async () => {
      await mw.tx(h.ctx, txes)
    })
  })

  // PlatformError captures a stack per rejected tx - much dearer than an allowed one.
  it('tx rejected with Forbidden, batch=1, 1000 spaces', async () => {
    const { mw, h } = await setupTx(1000)
    const txes = makeBatch(txFactory, generateId(), 1)
    await bench('spaceSecurity tx forbidden (batch=1, spaces=1000)', async () => {
      await mw.tx(h.ctx, txes).catch(() => {})
    })
  })

  it('tx write wrapped in TxApplyIf, batch=10, 1000 spaces', async () => {
    const { mw, h, writable } = await setupTx(1000)
    const applyTx = txFactory.createTxApplyIf(
      core.space.Tx,
      undefined,
      [],
      [],
      makeBatch(txFactory, writable, 10),
      undefined
    )
    await bench('spaceSecurity tx applyIf-write (inner=10, spaces=1000)', async () => {
      await mw.tx(h.ctx, [applyTx])
    })
  })

  // handleBroadcast runs the same processTx, so the write check landed on this path too.
  it('handleBroadcast over 100 derived txes, 1000 spaces', async () => {
    const { mw, h, writable } = await setupTx(1000)
    const txes = makeBatch(derivedFactory, writable, 100)
    h.ctx.contextData.broadcast.txes = txes as any
    await bench('spaceSecurity handleBroadcast (txes=100, spaces=1000)', async () => {
      // processed set is per-request; reset so every iteration walks all 100 txes
      h.ctx.contextData.contextCache.set('processed', new Set())
      await mw.handleBroadcast(h.ctx)
    })
  })
})

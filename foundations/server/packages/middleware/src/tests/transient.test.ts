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
  type Class,
  ClassifierKind,
  type Doc,
  DOMAIN_TRANSIENT,
  generateId,
  Hierarchy,
  MeasureMetricsContext,
  type MeasureContext,
  ModelDb,
  type Ref,
  type Space,
  TxFactory,
  type Tx,
  type WorkspaceIds,
  type WorkspaceUuid
} from '@hcengineering/core'
import type { IntlString } from '@hcengineering/platform'
import { createInMemoryAdapter, type DbAdapter, type PipelineContext } from '@hcengineering/server-core'
import { TransientMiddleware } from '../transient'

interface TransientDoc extends Doc {
  payload: string
}

const transientClass = 'test:class:Transient' as Ref<Class<TransientDoc>>
const transientSpace = 'test:space:Transient' as Ref<Space>

class FakeAdapter {
  store = new Map<Ref<Doc>, Doc>()
  loadCalls = 0
  cleanCalls = 0

  put (doc: Doc): void {
    this.store.set(doc._id, doc)
  }

  load = async (_ctx: MeasureContext, _domain: string, ids: Ref<Doc>[]): Promise<Doc[]> => {
    this.loadCalls++
    const out: Doc[] = []
    for (const id of ids) {
      const v = this.store.get(id)
      if (v !== undefined) out.push(v)
    }
    return out
  }

  clean = async (_ctx: MeasureContext, _domain: string, ids: Ref<Doc>[]): Promise<void> => {
    this.cleanCalls++
    for (const id of ids) {
      this.store.delete(id)
    }
  }
}

async function createMiddleware (ttl: number): Promise<{
  mw: TransientMiddleware
  adapter: FakeAdapter
  broadcasts: Tx[][]
  ctx: MeasureContext
  pipelineContext: PipelineContext
}> {
  const ctx = new MeasureMetricsContext('test', {})
  const hierarchy = new Hierarchy()
  const modelDb = new ModelDb(hierarchy)

  // We don't need to populate the model — tests drive ttlObjectMap directly.
  // Stub findAllSync so the constructor's TransientTTL lookup doesn't need a real model.
  ;(modelDb as any).findAllSync = (): any[] => []
  void ttl

  const adapter = new FakeAdapter()
  const broadcasts: Tx[][] = []

  const pipelineContext: PipelineContext = {
    workspace: { uuid: 'test-ws' as any, url: 'test', dataId: 'test' as any },
    hierarchy,
    modelDb,
    branding: null,
    adapterManager: {
      getAdapter: (_domain: string, _required: boolean): DbAdapter => adapter as unknown as DbAdapter
    } as any,
    storageAdapter: {} as any,
    contextVars: {},
    lastTx: '',
    lastHash: '',
    broadcastEvent: async (_c: MeasureContext, txes: Tx[]): Promise<void> => {
      broadcasts.push(txes)
    }
  }

  const mw = await TransientMiddleware.create(ctx, pipelineContext, undefined)
  return { mw, adapter, broadcasts, ctx, pipelineContext }
}

async function flush (): Promise<void> {
  // reduceCalls schedules the actual op asynchronously; flush microtasks until it settles.
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('TransientMiddleware.checkTTL', () => {
  let env: Awaited<ReturnType<typeof createMiddleware>>

  afterEach(async () => {
    await env?.mw.close()
  })

  it('removes expired entries from ttlObjectMap after processing', async () => {
    env = await createMiddleware(2)
    const id = generateId<TransientDoc>()
    const doc: TransientDoc = {
      _id: id,
      _class: transientClass,
      space: transientSpace,
      modifiedOn: Date.now(),
      modifiedBy: core.account.System,
      payload: 'p'
    }
    env.adapter.put(doc)

    const map = (env.mw as any).ttlObjectMap as Map<Ref<Doc>, number>
    map.set(id, Date.now() / 1000 - 10) // already expired

    await (env.mw as any).checkTTL()
    await flush()

    expect(map.has(id)).toBe(false)
    expect(env.adapter.store.has(id)).toBe(false)
    expect(env.broadcasts.length).toBe(1)
    expect(env.broadcasts[0].length).toBe(1)
    expect(env.broadcasts[0][0]._class).toBe(core.class.TxRemoveDoc)
  })

  it('does not re-broadcast on repeated checkTTL ticks for same expired doc', async () => {
    env = await createMiddleware(2)
    const id = generateId<TransientDoc>()
    const doc: TransientDoc = {
      _id: id,
      _class: transientClass,
      space: transientSpace,
      modifiedOn: Date.now(),
      modifiedBy: core.account.System,
      payload: 'p'
    }
    env.adapter.put(doc)

    const map = (env.mw as any).ttlObjectMap as Map<Ref<Doc>, number>
    map.set(id, Date.now() / 1000 - 10)

    await (env.mw as any).checkTTL()
    await flush()
    await (env.mw as any).checkTTL()
    await flush()
    await (env.mw as any).checkTTL()
    await flush()

    expect(env.broadcasts.length).toBe(1)
    expect(env.adapter.loadCalls).toBe(1)
    expect(env.adapter.cleanCalls).toBe(1)
  })

  it('skips load/clean/broadcast when no entries are expired', async () => {
    env = await createMiddleware(2)
    const id = generateId<TransientDoc>()
    const map = (env.mw as any).ttlObjectMap as Map<Ref<Doc>, number>
    map.set(id, Date.now() / 1000 + 100) // far in the future

    await (env.mw as any).checkTTL()
    await flush()

    expect(env.broadcasts.length).toBe(0)
    expect(env.adapter.loadCalls).toBe(0)
    expect(env.adapter.cleanCalls).toBe(0)
    expect(map.has(id)).toBe(true)
  })

  it('does not broadcast when expired doc was already removed by client', async () => {
    env = await createMiddleware(2)
    const id = generateId<TransientDoc>()
    // Doc is NOT in adapter.store (already removed externally).
    const map = (env.mw as any).ttlObjectMap as Map<Ref<Doc>, number>
    map.set(id, Date.now() / 1000 - 10)

    await (env.mw as any).checkTTL()
    await flush()

    expect(env.broadcasts.length).toBe(0)
    expect(map.has(id)).toBe(false)
  })

  it('resolves dbProvider lazily when adapterManager is not yet initialized at construction time', async () => {
    // Reproduces production wiring: DBAdapterMiddleware is created AFTER TransientMiddleware
    // in the pipeline, so context.adapterManager is undefined when TransientMiddleware is constructed.
    const ctx = new MeasureMetricsContext('test', {})
    const hierarchy = new Hierarchy()
    const modelDb = new ModelDb(hierarchy)
    ;(modelDb as any).findAllSync = (): any[] => []

    const adapter = new FakeAdapter()
    const broadcasts: Tx[][] = []

    const pipelineContext: PipelineContext = {
      workspace: { uuid: 'test-ws' as any, url: 'test', dataId: 'test' as any },
      hierarchy,
      modelDb,
      branding: null,
      // Not set yet — mimics real pipeline order.
      adapterManager: undefined,
      storageAdapter: {} as any,
      contextVars: {},
      lastTx: '',
      lastHash: '',
      broadcastEvent: async (_c: MeasureContext, txes: Tx[]): Promise<void> => {
        broadcasts.push(txes)
      }
    }

    const mw = await TransientMiddleware.create(ctx, pipelineContext, undefined)

    // Now simulate DBAdapterMiddleware wiring adapterManager after construction.
    pipelineContext.adapterManager = {
      getAdapter: (_domain: string, _required: boolean): DbAdapter => adapter as unknown as DbAdapter
    } as any

    const id = generateId<TransientDoc>()
    const doc: TransientDoc = {
      _id: id,
      _class: transientClass,
      space: transientSpace,
      modifiedOn: Date.now(),
      modifiedBy: core.account.System,
      payload: 'p'
    }
    adapter.put(doc)

    const map = (mw as any).ttlObjectMap as Map<Ref<Doc>, number>
    map.set(id, Date.now() / 1000 - 10)

    // Before the fix: dbProvider was resolved once in constructor (undefined) and never retried,
    // so this call would be a no-op. After the fix: checkTTL resolves dbProvider lazily.
    await (mw as any).checkTTL()
    await flush()

    expect(map.has(id)).toBe(false)
    expect(adapter.store.has(id)).toBe(false)
    expect(broadcasts.length).toBe(1)

    await mw.close()
  })

  it('integration with real InMemoryAdapter: clean removes docs so findAll no longer returns them', async () => {
    // Regression: InMemoryAdapter used to inherit a no-op `clean` from DummyDbAdapter,
    // so TransientMiddleware.checkTTL broadcast TxRemoveDoc but the doc stayed in modeldb forever.
    const ctx = new MeasureMetricsContext('test', {})
    const hierarchy = new Hierarchy()
    const modelDb = new ModelDb(hierarchy)
    ;(modelDb as any).findAllSync = (): any[] => []

    const txFactory = new TxFactory(core.account.System)
    const objTx = txFactory.createTxCreateDoc(
      core.class.Class,
      core.space.Model,
      { label: 'Obj' as IntlString, kind: ClassifierKind.CLASS },
      core.class.Obj
    )
    const docTx = txFactory.createTxCreateDoc(
      core.class.Class,
      core.space.Model,
      { label: 'Doc' as IntlString, extends: core.class.Obj, kind: ClassifierKind.CLASS },
      core.class.Doc
    )
    const transientClassTx = txFactory.createTxCreateDoc(
      core.class.Class,
      core.space.Model,
      { label: 'Transient' as IntlString, extends: core.class.Doc, kind: ClassifierKind.CLASS },
      transientClass
    )
    hierarchy.tx(objTx)
    hierarchy.tx(docTx)
    hierarchy.tx(transientClassTx)

    const ws: WorkspaceIds = {
      uuid: 'test-ws' as WorkspaceUuid,
      url: 'test',
      dataId: 'test' as any
    }
    const adapter = await createInMemoryAdapter(ctx, hierarchy, '', ws)

    const broadcasts: Tx[][] = []
    const pipelineContext: PipelineContext = {
      workspace: { uuid: 'test-ws' as any, url: 'test', dataId: 'test' as any },
      hierarchy,
      modelDb,
      branding: null,
      adapterManager: {
        getAdapter: (_domain: string, _required: boolean): DbAdapter => adapter
      } as any,
      storageAdapter: {} as any,
      contextVars: {},
      lastTx: '',
      lastHash: '',
      broadcastEvent: async (_c: MeasureContext, txes: Tx[]): Promise<void> => {
        broadcasts.push(txes)
      }
    }

    const mw = await TransientMiddleware.create(ctx, pipelineContext, undefined)

    // Populate the adapter through the public transaction API.
    const id = generateId<TransientDoc>()
    await adapter.tx(ctx, txFactory.createTxCreateDoc(transientClass, transientSpace, { payload: 'p' }, id))

    // Sanity: doc is visible before TTL fires.
    const beforeFind = await adapter.findAll(ctx, transientClass, {})
    expect(beforeFind).toHaveLength(1)

    const map = (mw as any).ttlObjectMap as Map<Ref<Doc>, number>
    map.set(id, Date.now() / 1000 - 10)

    await (mw as any).checkTTL()
    await flush()

    // Key assertion: after clean the doc must be gone from the adapter
    // (not just broadcast-removed on clients).
    const afterFind = await adapter.findAll(ctx, transientClass, {})
    expect(afterFind).toHaveLength(0)
    expect(await adapter.load(ctx, DOMAIN_TRANSIENT, [id])).toHaveLength(0)
    expect(broadcasts.length).toBe(1)

    await mw.close()
  })

  it('ttlChecker interval starts even when adapterManager is undefined at construction', async () => {
    // Before the fix: setInterval was gated behind `if (this.dbProvider !== undefined)`,
    // so if adapterManager was not yet set, the interval never started and TTL expiry never fired.
    const ctx = new MeasureMetricsContext('test', {})
    const hierarchy = new Hierarchy()
    const modelDb = new ModelDb(hierarchy)
    ;(modelDb as any).findAllSync = (): any[] => []

    const pipelineContext: PipelineContext = {
      workspace: { uuid: 'test-ws' as any, url: 'test', dataId: 'test' as any },
      hierarchy,
      modelDb,
      branding: null,
      adapterManager: undefined,
      storageAdapter: {} as any,
      contextVars: {},
      lastTx: '',
      lastHash: '',
      broadcastEvent: async (): Promise<void> => {}
    }

    const mw = await TransientMiddleware.create(ctx, pipelineContext, undefined)
    expect((mw as any).ttlChecker).toBeDefined()
    await mw.close()
    expect((mw as any).ttlChecker).toBeUndefined()
  })
})

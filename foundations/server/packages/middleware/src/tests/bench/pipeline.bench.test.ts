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
  type Doc,
  Hierarchy,
  MeasureMetricsContext,
  type MeasureContext,
  ModelDb,
  type Ref,
  toFindResult,
  TxFactory
} from '@hcengineering/core'
import {
  BaseMiddleware,
  createPipeline,
  type Middleware,
  type MiddlewareCreator,
  type PipelineContext,
  type TxMiddlewareResult,
  wireShortcuts
} from '@hcengineering/server-core'
import { bench, describeBench } from '@hcengineering/measurements'

/**
 * Passthrough middleware that doesn't override any pipeline method.
 * Mimics middleware like `Identity`, `ContextName`, `Modified`, etc. which
 * don't override findAll - they should be entirely skipped by shortcut wiring.
 */
class NoopMiddleware extends BaseMiddleware implements Middleware {
  static async create (
    ctx: MeasureContext,
    context: PipelineContext,
    next: Middleware | undefined
  ): Promise<Middleware> {
    return new NoopMiddleware(context, next)
  }
}

/**
 * Terminal middleware that responds to findAll and tx.
 */
class TerminalMiddleware extends BaseMiddleware implements Middleware {
  static async create (
    ctx: MeasureContext,
    context: PipelineContext,
    next: Middleware | undefined
  ): Promise<Middleware> {
    return new TerminalMiddleware(context, next)
  }

  override findAll<T extends Doc>(): Promise<ReturnType<typeof toFindResult<T>>> {
    return Promise.resolve(toFindResult<T>([]))
  }

  override tx (): Promise<TxMiddlewareResult> {
    return Promise.resolve({})
  }
}

function buildContext (): PipelineContext {
  const hierarchy = new Hierarchy()
  const modelDb = new ModelDb(hierarchy)
  const pipelineContext: PipelineContext = {
    workspace: { uuid: 'bench-ws' as any, url: 'b', dataId: 'b' as any },
    hierarchy,
    modelDb,
    branding: null as any,
    adapterManager: {} as any,
    storageAdapter: {} as any,
    contextVars: {},
    lastTx: '',
    lastHash: '',
    broadcastEvent: async () => {}
  }
  return pipelineContext
}

async function buildPipeline (noopCount: number): Promise<{ head: Middleware }> {
  const ctx = new MeasureMetricsContext('bench', {})
  const creators: MiddlewareCreator[] = []
  const noopCreate = NoopMiddleware.create.bind(NoopMiddleware)
  const termCreate = TerminalMiddleware.create.bind(TerminalMiddleware)
  for (let i = 0; i < noopCount; i++) creators.push(noopCreate)
  creators.push(termCreate)
  const ctxBuilt = buildContext()
  await createPipeline(ctx, creators, ctxBuilt)
  // Pipeline implementation hides head; head shortcut already wired internally.
  const head = (ctxBuilt as any).head as Middleware
  return { head }
}

/**
 * Forcibly re-wire shortcuts so each `nextXxx` falls back to `next`.
 * Used to measure the non-shortcut baseline against the same chain.
 */
function unwire (head: Middleware): void {
  let cur: Middleware | undefined = head
  while (cur !== undefined) {
    const n = (cur as any).next as Middleware | undefined
    const m = cur as any
    m.nextFindAll = n
    m.nextTx = n
    m.nextGroupBy = n
    m.nextSearchFulltext = n
    m.nextLoadModel = n
    m.nextHandleBroadcast = n
    m.nextDomainRequest = n
    m.nextCloseSession = n
    cur = n
  }
}

describeBench('pipeline shortcut wiring bench', () => {
  const ctx = new MeasureMetricsContext('bench', {}) as any
  const factory = new TxFactory(core.account.System)
  const testClass = 'bench:Item' as Ref<Class<Doc>>

  for (const noopCount of [5, 15, 30]) {
    it(`findAll through ${noopCount} no-op middlewares (wired)`, async () => {
      const { head } = await buildPipeline(noopCount)
      await bench(`pipeline findAll wired (noops=${noopCount})`, async () => {
        await head.findAll(ctx, testClass, {}, undefined)
      })
    })

    it(`findAll through ${noopCount} no-op middlewares (unwired baseline)`, async () => {
      const { head } = await buildPipeline(noopCount)
      unwire(head)
      await bench(`pipeline findAll UNWIRED (noops=${noopCount})`, async () => {
        await head.findAll(ctx, testClass, {}, undefined)
      })
    })

    it(`findAll wired again after re-wire (noops=${noopCount})`, async () => {
      // Re-wire to confirm wireShortcuts is symmetric.
      const { head } = await buildPipeline(noopCount)
      unwire(head)
      wireShortcuts(head)
      await bench(`pipeline findAll RE-wired (noops=${noopCount})`, async () => {
        await head.findAll(ctx, testClass, {}, undefined)
      })
    })

    it(`tx through ${noopCount} no-op middlewares (wired)`, async () => {
      const { head } = await buildPipeline(noopCount)
      const tx = factory.createTxCreateDoc(testClass, 'bench:S' as any, { name: 'x' } as any)
      await bench(`pipeline tx wired (noops=${noopCount})`, async () => {
        await head.tx(ctx, [tx])
      })
    })

    it(`tx through ${noopCount} no-op middlewares (unwired baseline)`, async () => {
      const { head } = await buildPipeline(noopCount)
      unwire(head)
      const tx = factory.createTxCreateDoc(testClass, 'bench:S' as any, { name: 'x' } as any)
      await bench(`pipeline tx UNWIRED (noops=${noopCount})`, async () => {
        await head.tx(ctx, [tx])
      })
    })
  }
})

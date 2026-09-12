//
// Copyright © 2022 Hardcore Engineering Inc.
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

import { Analytics } from '@hcengineering/analytics'
import {
  toFindResult,
  withContext,
  type Class,
  type Doc,
  type DocumentQuery,
  type Domain,
  type DomainParams,
  type DomainResult,
  type FindOptions,
  type FindResult,
  type LoadModelResponse,
  type MeasureContext,
  type OperationDomain,
  type Ref,
  type SearchOptions,
  type SearchQuery,
  type SearchResult,
  type SessionData,
  type Timestamp,
  type Tx,
  type TxResult
} from '@hcengineering/core'
import { BaseMiddleware, emptyBroadcastResult } from './base'
import { type Middleware, type MiddlewareCreator, type Pipeline, type PipelineContext } from './types'

/**
 * Methods that participate in shortcut wiring.
 * For each method we precompute the next middleware down the chain that
 * actually overrides it, so provideXxx() skips no-op delegations.
 */
const SHORTCUT_METHODS = [
  ['findAll', 'nextFindAll'],
  ['tx', 'nextTx'],
  ['groupBy', 'nextGroupBy'],
  ['searchFulltext', 'nextSearchFulltext'],
  ['loadModel', 'nextLoadModel'],
  ['handleBroadcast', 'nextHandleBroadcast'],
  ['domainRequest', 'nextDomainRequest'],
  ['closeSession', 'nextCloseSession']
] as const

function overridesMethod (mw: Middleware, method: string): boolean {
  const fn = (mw as any)[method]
  const base = (BaseMiddleware.prototype as any)[method]
  if (typeof fn !== 'function' || typeof base !== 'function') return false
  return fn !== base
}

/**
 * After buildChain produced a linked list (head -> ... -> tail) where each
 * middleware refers to the next one via `this.next`, walk each method and set
 * `mw[nextFooKey]` to the first downstream middleware that overrides `foo`.
 *
 * Pipeline builders should pass the full chain array (head-to-tail) so we
 * don't depend on a non-public `.next` field that custom middleware may not
 * expose. If only `head` is provided, we walk `.next` defensively and bail
 * out (leaving shortcuts at their constructor defaults) when an opaque
 * middleware breaks the chain - this preserves correct delegation through
 * non-BaseMiddleware adapters.
 *
 * Middlewares that don't extend BaseMiddleware (no shortcut fields) are left
 * untouched - they continue to use their own `next` reference.
 */
export function wireShortcuts (headOrChain: Middleware | Middleware[] | undefined): void {
  if (headOrChain === undefined) return

  let chain: Middleware[]
  if (Array.isArray(headOrChain)) {
    if (headOrChain.length === 0) return
    chain = headOrChain
  } else {
    // Fallback path: walk `.next`. If a non-BaseMiddleware appears mid-chain
    // and doesn't expose `.next`, treat it as a barrier: stop walking AND
    // skip wiring entirely, since we cannot see what lies beyond it. Wiring
    // partial visibility would overwrite valid pointers with undefined.
    chain = []
    let cur: Middleware | undefined = headOrChain
    while (cur !== undefined) {
      chain.push(cur)
      const nextRef: unknown = (cur as { next?: Middleware }).next
      if (nextRef === undefined && !(cur instanceof BaseMiddleware)) {
        // Opaque tail-like middleware — can't verify it's the tail. Refuse to wire to avoid
        // overwriting safe defaults.
        return
      }
      cur = nextRef as Middleware | undefined
    }
  }

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i]
    if (!(entry instanceof BaseMiddleware)) continue
    const mw = entry as unknown as Record<string, unknown>
    for (const [method, nextKey] of SHORTCUT_METHODS) {
      let target: Middleware | undefined
      for (let j = i + 1; j < chain.length; j++) {
        if (overridesMethod(chain[j], method)) {
          target = chain[j]
          break
        }
      }
      mw[nextKey] = target
    }
  }
}

/**
 * @public
 */
export async function createPipeline (
  ctx: MeasureContext,
  constructors: MiddlewareCreator[],
  context: PipelineContext
): Promise<Pipeline> {
  return await PipelineImpl.create(ctx, constructors, context)
}

class PipelineImpl implements Pipeline {
  private head: Middleware | undefined

  private readonly middlewares: Middleware[] = []

  private constructor (readonly context: PipelineContext) {}

  static async create (
    ctx: MeasureContext,
    constructors: MiddlewareCreator[],
    context: PipelineContext
  ): Promise<PipelineImpl> {
    const pipeline = new PipelineImpl(context)

    pipeline.head = await pipeline.buildChain(ctx, constructors, pipeline.context)
    // Pass the materialized chain array (head-to-tail) instead of `head` to
    // avoid relying on the non-public `.next` field for traversal.
    wireShortcuts(pipeline.middlewares)
    context.head = pipeline.head
    return pipeline
  }

  @withContext('build-chain')
  private async buildChain (
    ctx: MeasureContext,
    constructors: MiddlewareCreator[],
    context: PipelineContext
  ): Promise<Middleware | undefined> {
    let current: Middleware | undefined
    for (let index = constructors.length - 1; index >= 0; index--) {
      const element = constructors[index]
      try {
        const newCur = await element(ctx, context, current)
        if (newCur != null) {
          this.middlewares.push(newCur)
        }
        current = newCur ?? current
      } catch (err: any) {
        ctx.error('failed to initialize pipeline', { err, workspace: context.workspace })
        // We need to call close for all items.
        await this.close()
        throw err
      }
    }
    this.middlewares.reverse()

    return current
  }

  findAll<T extends Doc>(
    ctx: MeasureContext,
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<FindResult<T>> {
    return this.head?.findAll(ctx, _class, query, options) ?? Promise.resolve(toFindResult([]))
  }

  loadModel (ctx: MeasureContext, lastModelTx: Timestamp, hash?: string): Promise<Tx[] | LoadModelResponse> {
    return this.head?.loadModel(ctx, lastModelTx, hash) ?? Promise.resolve([])
  }

  groupBy<T, P extends Doc>(
    ctx: MeasureContext,
    domain: Domain,
    field: string,
    query?: DocumentQuery<P>
  ): Promise<Map<T, number>> {
    return this.head?.groupBy(ctx, domain, field, query) ?? Promise.resolve(new Map())
  }

  searchFulltext (ctx: MeasureContext, query: SearchQuery, options: SearchOptions): Promise<SearchResult> {
    return this.head?.searchFulltext(ctx, query, options) ?? Promise.resolve({ docs: [] })
  }

  tx (ctx: MeasureContext, tx: Tx[]): Promise<TxResult> {
    return this.head?.tx(ctx, tx) ?? Promise.resolve({})
  }

  handleBroadcast (ctx: MeasureContext<SessionData>): Promise<void> {
    return this.head?.handleBroadcast(ctx) ?? emptyBroadcastResult
  }

  domainRequest<T>(
    ctx: MeasureContext<SessionData>,
    domain: OperationDomain,
    params: DomainParams
  ): Promise<DomainResult<T>> {
    return this.head?.domainRequest(ctx, domain, params) ?? Promise.resolve({ domain, value: undefined })
  }

  closeSession (ctx: MeasureContext<SessionData>, sessionId: string): Promise<void> {
    return this.head?.closeSession(ctx, sessionId) ?? Promise.resolve()
  }

  async close (): Promise<void> {
    for (const mw of this.middlewares) {
      try {
        await mw.close()
      } catch (err: any) {
        Analytics.handleError(err)
      }
    }
  }
}

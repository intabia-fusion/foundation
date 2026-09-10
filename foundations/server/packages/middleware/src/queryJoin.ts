//
// Copyright © 2024 Hardcore Engineering Inc.
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

import {
  type LoadModelResponse,
  type MeasureContext,
  type SessionData,
  type Timestamp,
  type Tx
} from '@hcengineering/core'
import { BaseMiddleware, type Middleware, type PipelineContext } from '@hcengineering/server-core'

interface Query {
  key: string
  result: object | Promise<object> | undefined
  callbacks: number
  max: number
}
/**
 * @public
 */
export class QueryJoiner {
  private readonly queries: Map<string, Query> = new Map<string, Query>()

  async query<T>(ctx: MeasureContext, key: string, retrieve: (ctx: MeasureContext) => Promise<T>): Promise<T> {
    // Will find a query or add + 1 to callbacks
    const q = this.getQuery(key)
    try {
      q.result ??= retrieve(ctx)
      if (q.result instanceof Promise) {
        q.result = await q.result
      }

      return q.result as T
    } finally {
      q.callbacks--

      this.removeFromQueue(q)
    }
  }

  private getQuery (key: string): Query {
    const query = this.queries.get(key)
    if (query === undefined) {
      const q: Query = {
        key,
        result: undefined,
        callbacks: 1,
        max: 1
      }
      this.queries.set(key, q)
      return q
    }

    query.callbacks++
    query.max++
    return query
  }

  private removeFromQueue (q: Query): void {
    if (q.callbacks === 0) {
      this.queries.delete(q.key)
    }
  }
}

/**
 * @public
 */
export class QueryJoinMiddleware extends BaseMiddleware implements Middleware {
  private readonly joiner: QueryJoiner

  private constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)
    this.joiner = new QueryJoiner()
  }

  // Only loadModel is safe to join across users since it returns the same data for all.
  // findAll, searchFulltext, groupBy are per-user (security is applied at the DB level)
  // and must not be deduplicated.
  loadModel (
    ctx: MeasureContext<SessionData>,
    lastModelTx: Timestamp,
    hash?: string
  ): Promise<Tx[] | LoadModelResponse> {
    return this.joiner.query(ctx, `model-${lastModelTx}${hash ?? ''}`, async (ctx) => {
      return await this.provideLoadModel(ctx, lastModelTx, hash)
    })
  }

  static async create (
    ctx: MeasureContext,
    context: PipelineContext,
    next: Middleware | undefined
  ): Promise<QueryJoinMiddleware> {
    return new QueryJoinMiddleware(context, next)
  }
}

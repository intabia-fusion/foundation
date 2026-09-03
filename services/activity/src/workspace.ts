/* eslint-disable @typescript-eslint/unbound-method */
//
// Copyright © 2026 Intabia Fusion Inc.
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
  type DocumentQuery,
  type FindOptions,
  type FindResult,
  type Hierarchy,
  type MeasureContext,
  type ModelDb,
  type Ref,
  type Timestamp,
  type Tx,
  type TxCUD,
  TxFactory,
  type WithLookup,
  type WorkspaceInfoWithStatus,
  type Branding
} from '@hcengineering/core'
import { type RestClient } from '@hcengineering/api-client'
import { type StorageAdapter } from '@hcengineering/storage'
import { PlatformError, unknownError } from '@hcengineering/platform'
import { createPipeline, type MiddlewareCreator, type Pipeline, type PipelineContext } from '@hcengineering/server-core'
import { getConfig } from '@hcengineering/server-pipeline'
import {
  ContextNameMiddleware,
  DBAdapterInitMiddleware,
  DBAdapterMiddleware,
  DomainFindMiddleware,
  DomainTxMiddleware,
  LowLevelMiddleware,
  ModelMiddleware
} from '@hcengineering/middleware'
import activity, { type DocUpdateMessage } from '@hcengineering/activity'

import config from './config'
import WsCache, { CACHE_TTL_MS } from './cache'
import { type Client } from './types'
import { ActivityMessagesHandler } from './activity'

class Workspace {
  private readonly cache: WsCache

  private inProgress = false
  private lastTxDate: Timestamp | undefined = undefined

  private readonly txFactory = new TxFactory(core.account.System, true)
  private readonly client: Client

  private constructor (
    private readonly ctx: MeasureContext,
    private readonly ws: WorkspaceInfoWithStatus,
    private readonly pipeline: Pipeline,
    private readonly hierarchy: Hierarchy,
    private readonly model: ModelDb,
    private readonly rest: RestClient,
    private readonly storage: StorageAdapter,
    private readonly branding: Branding | undefined,
    recentMessages: DocUpdateMessage[] = [],
    logicalTime?: number
  ) {
    this.client = this.getClient()
    this.cache = new WsCache(this.ctx, this.client, recentMessages, logicalTime)
  }

  async tx (tx: TxCUD<Doc>): Promise<void> {
    try {
      this.inProgress = true

      const domain = this.hierarchy.getDomain(tx.objectClass)

      if (domain === 'model') {
        // addTxes keeps the hierarchy in step, applying it here too would double $push/$inc.
        this.model.addTxes(this.ctx, [tx], true)
      }

      this.cache.tx(tx)

      if (this.hierarchy.isDerived(tx.objectClass, activity.class.ActivityMessage)) return

      const res: TxCUD<Doc>[] = await ActivityMessagesHandler(tx, this.getClient(), this.cache)

      if (res.length > 0) {
        this.lastTxDate = tx.createdOn ?? tx.modifiedOn
        const silent = tx.meta?.silent
        await this.applyTxes(res.map((it) => (silent !== undefined ? { ...it, meta: { ...it.meta, silent } } : it)))
      }
    } finally {
      this.inProgress = false
    }
  }

  private async applyTxes (txes: TxCUD<Doc>[]): Promise<void> {
    const txApply = this.txFactory.createTxApplyIf(
      core.space.DerivedTx,
      config.ServiceId,
      [],
      [],
      txes,
      undefined,
      true
    )
    try {
      await this.rest.tx(txApply)
    } catch (e) {
      console.error(e)
      this.ctx.error('Failed to send tx apply', { tx: txApply })
      throw e
    }
  }

  private getClient (): Client {
    return {
      ctx: this.ctx,
      txFactory: this.txFactory,
      workspace: this.ws,
      storage: this.storage,
      hierarchy: this.hierarchy,
      model: this.model,
      branding: this.branding,
      findAll: async <T extends Doc>(
        _class: Ref<Class<T>>,
        query: DocumentQuery<T>,
        options?: FindOptions<T>
      ): Promise<FindResult<T>> => {
        return await this.pipeline.findAll(this.ctx, _class, query, options)
      },
      findOne: async <T extends Doc>(
        _class: Ref<Class<T>>,
        query: DocumentQuery<T>,
        options?: FindOptions<T>
      ): Promise<WithLookup<T> | undefined> => {
        return (await this.pipeline.findAll(this.ctx, _class, query, { ...options, limit: 1 }))[0]
      }
    }
  }

  public isInProgress (): boolean {
    return this.inProgress
  }

  public getLastTxDate (): Timestamp | undefined {
    return this.lastTxDate
  }

  static async create (
    ctx: MeasureContext,
    ws: WorkspaceInfoWithStatus,
    hierarchy: Hierarchy,
    modelDb: ModelDb,
    sysModel: Tx[],
    storage: StorageAdapter,
    rest: RestClient,
    branding: Branding | undefined,
    logicalTime: number
  ): Promise<Workspace> {
    const dbConf = getConfig(ctx, config.DbUrl, ctx, {
      disableTriggers: true,
      externalStorage: storage
    })

    const middlewares: MiddlewareCreator[] = [
      LowLevelMiddleware.create,
      ContextNameMiddleware.create,
      DomainFindMiddleware.create,
      DomainTxMiddleware.create,
      DBAdapterInitMiddleware.create,
      ModelMiddleware.create(sysModel),
      DBAdapterMiddleware.create(dbConf)
    ]

    const context: PipelineContext = {
      workspace: {
        uuid: ws.uuid,
        url: ws.url
      },
      branding: branding ?? null,
      modelDb,
      hierarchy,
      storageAdapter: storage,
      contextVars: {}
    }
    const pipeline = await createPipeline(ctx, middlewares, context)

    const defaultAdapter = pipeline.context.adapterManager?.getDefaultAdapter()
    if (defaultAdapter === undefined) {
      throw new PlatformError(unknownError('Default adapter should be set'))
    }

    if (pipeline.context.lowLevelStorage === undefined) {
      throw new Error('Low level storage is not defined')
    }

    const cutoff = logicalTime - CACHE_TTL_MS
    const recentMessages = await pipeline.findAll(
      ctx,
      activity.class.DocUpdateMessage,
      { createdOn: { $gte: cutoff } },
      {}
    )

    return new Workspace(ctx, ws, pipeline, hierarchy, modelDb, rest, storage, branding, recentMessages, logicalTime)
  }

  async close (): Promise<void> {
    this.cache.close()
    try {
      await this.pipeline.close()
    } catch (e) {
      this.ctx.error('Error during close workspace', { e })
    }
  }
}

export default Workspace

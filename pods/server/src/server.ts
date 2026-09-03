/* eslint-disable @typescript-eslint/unbound-method */
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

import {
  type BrandingMap,
  generateId,
  type MeasureContext,
  type Ref,
  type Tx,
  type WorkspaceUuid
} from '@hcengineering/core'
import { buildStorageFromConfig } from '@hcengineering/server-storage'

import { startSessionManager } from '@hcengineering/server'
import {
  LimitCategory,
  type PlanLimits,
  type PlatformQueue,
  QueueTopic,
  QueueWorkspaceEvent,
  type QueueWorkspaceLimitsMessage,
  type SessionManager,
  type StorageConfiguration
} from '@hcengineering/server-core'

import {
  createServerPipeline,
  matchLastTxLoader,
  registerAdapterFactory,
  registerDestroyFactory,
  registerLastTxLoader,
  registerServerPlugins,
  registerStringLoaders,
  registerTxAdapterFactory
} from '@hcengineering/server-pipeline'
import {
  createPostgreeDestroyAdapter,
  createPostgresAdapter,
  createPostgresTxAdapter,
  loadLastTxCache,
  shutdownPostgres
} from '@hcengineering/postgres'
import { LIMITS_PROVIDER_VAR, MEMBERS_VERSION_KEY, PLAN_LIMITS_MAP_KEY } from '@hcengineering/middleware'
import { readFileSync } from 'node:fs'
import { AccountLimitsProvider } from './limitsProvider'
import { startHttpServer } from './server_http'

const model = JSON.parse(readFileSync(process.env.MODEL_JSON ?? 'model.json').toString()) as Tx[]

registerStringLoaders()

// Register close on process exit.
process.on('exit', () => {
  shutdownPostgres().catch((err) => {
    console.error(err)
  })
})
/**
 * @public
 */
export function start (
  metrics: MeasureContext,
  dbUrl: string,
  opt: {
    queue: PlatformQueue
    fulltextUrl: string
    storageConfig: StorageConfiguration
    port: number
    brandingMap: BrandingMap

    enableCompression?: boolean

    accountsUrl: string

    profiling?: {
      start: () => void
      stop: () => Promise<string | undefined>
    }
  }
): { shutdown: () => Promise<void>, sessionManager: SessionManager } {
  registerTxAdapterFactory('postgresql', createPostgresTxAdapter, true)
  registerAdapterFactory('postgresql', createPostgresAdapter, true)
  registerLastTxLoader('postgresql', loadLastTxCache)
  registerDestroyFactory('postgresql', createPostgreeDestroyAdapter, true)

  // Prepare statements are controlled via POSTGRES_OPTIONS (e.g. {"prepare": true}).
  // The old DB_PREPARE env var is removed; do not rely on it.

  registerServerPlugins()

  const externalStorage = buildStorageFromConfig(opt.storageConfig)

  // Shared across all per-workspace pipelines in this process; updated live by the consumer below.
  const planLimitsMap = new Map<WorkspaceUuid, PlanLimits>()
  // Bumped on each membership change so SeatLimitsMiddleware rebuilds its seat set without restart.
  const membersVersion = new Map<WorkspaceUuid, number>()
  const limitsProvider = new AccountLimitsProvider(opt.accountsUrl)

  const limitsConsumer =
    opt.queue != null
      ? opt.queue.createBatchConsumer<QueueWorkspaceLimitsMessage>(
        metrics.newChild('payment-limits-consumer', {}, { span: false }),
        QueueTopic.Workspace,
          `transactor-limits-${generateId()}`, // unique per-process group: every replica keeps its own map, must get all events
          async (ctx, msgs) => {
            for (const m of msgs) {
              const v = m.value
              if (v.type !== QueueWorkspaceEvent.LimitsChanged) continue
              if (v.category === LimitCategory.Plan) {
                // Plan/limits changed: refresh the snapshot so middlewares pick it up without restart.
                try {
                  planLimitsMap.set(m.workspace, await limitsProvider.getPlanLimits(m.workspace))
                  ctx.info('plan limits refreshed', { workspace: m.workspace })
                } catch (err: any) {
                  ctx.error('failed to refresh plan limits', { workspace: m.workspace, err })
                }
              } else if (v.category === LimitCategory.Members) {
                // Membership changed: bump the version so seat middleware rebuilds its set on next tx.
                membersVersion.set(m.workspace, (membersVersion.get(m.workspace) ?? 0) + 1)
              }
            }
          },
          { batchSize: 100, batchTimeout: 500 }
      )
      : undefined

  // Seed each workspace's context.lastTx on cold build so a restart with no data change
  // reconnects clients as Reconnected, not Refresh (full LiveQuery refetch). Empty until loaded = safe.
  const lastTxCache = new Map<string, Ref<Tx>>()
  // Feature-detect: backends that registered a loader fill the cache; others skip -> Refresh.
  const lastTxLoader = matchLastTxLoader(dbUrl)
  if (lastTxLoader !== undefined) void lastTxLoader(metrics, dbUrl, lastTxCache)

  const pipelineFactory = createServerPipeline(
    metrics,
    dbUrl,
    model,
    {
      ...opt,
      externalStorage,
      queue: opt.queue,
      pipelineContextVars: {
        [LIMITS_PROVIDER_VAR]: limitsProvider,
        [PLAN_LIMITS_MAP_KEY]: planLimitsMap,
        [MEMBERS_VERSION_KEY]: membersVersion,
        lastTxCache
      }
    },
    {}
  )

  const sessionManager = startSessionManager(metrics, {
    pipelineFactory,
    brandingMap: opt.brandingMap,
    enableCompression: opt.enableCompression,
    accountsUrl: opt.accountsUrl,
    profiling: opt.profiling,
    queue: opt.queue
  })
  const shutdown = startHttpServer(metrics, sessionManager, opt.port, opt.accountsUrl, externalStorage)
  return {
    shutdown: async () => {
      await limitsConsumer?.close()
      await externalStorage.close()
      await sessionManager.closeWorkspaces(metrics)
      await shutdown()
    },
    sessionManager
  }
}

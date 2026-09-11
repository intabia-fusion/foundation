//
// Copyright © 2026 Hardcore Engineering Inc.
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

import { MeasureContext, newMetrics, Tx } from '@hcengineering/core'
import { getPlatformQueue } from '@hcengineering/kafka'
import { setMetadata } from '@hcengineering/platform'
import serverClient from '@hcengineering/server-client'
import serverCore, { initStatisticsContext, QueueTopic } from '@hcengineering/server-core'
import serverToken from '@hcengineering/server-token'
import { configureAnalytics, createOpenTelemetryMetricsContext, SplitLogger } from '@hcengineering/analytics-service'
import { Analytics } from '@hcengineering/analytics'
import { join } from 'path'
import { readFileSync } from 'fs'
import {
  registerAdapterFactory,
  registerDestroyFactory,
  registerTxAdapterFactory,
  registerServerPlugins,
  registerStringLoaders
} from '@hcengineering/server-pipeline'
import {
  createPostgreeDestroyAdapter,
  createPostgresAdapter,
  createPostgresTxAdapter,
  shutdownPostgres
} from '@hcengineering/postgres'
import { withRetry } from '@hcengineering/retry'

import { Worker } from './worker'
import config from './config'

void main().catch((err) => {
  getCtx().error('Service initialization failed', { err })
})

process.on('exit', () => {
  shutdownPostgres().catch((err) => {
    getCtx().error('Failed to shutdown postgres properly', { err })
  })
})
async function main (): Promise<void> {
  registerServerPlugins()
  registerStringLoaders()
  setMetadata(serverToken.metadata.Secret, config.Secret)
  setMetadata(serverToken.metadata.Service, config.ServiceId)
  setMetadata(serverClient.metadata.Endpoint, config.AccountsUrl)
  setMetadata(serverCore.metadata.FrontUrl, config.FrontUrl)

  registerTxAdapterFactory('postgresql', createPostgresTxAdapter, true)
  registerAdapterFactory('postgresql', createPostgresAdapter, true)
  registerDestroyFactory('postgresql', createPostgreeDestroyAdapter, true)

  const ctx = getCtx()
  const queue = getPlatformQueue(config.ServiceId, config.QueueRegion)

  const model = JSON.parse(readFileSync(process.env.MODEL_JSON ?? 'model.json').toString()) as Tx[]
  const worker = new Worker(ctx, model, queue)

  const txConsumer = queue.createConsumer<Tx>(ctx, QueueTopic.Tx, queue.getClientId(), async (ctx, queueMessage) => {
    const ws = queueMessage.workspace
    const tx = queueMessage.value
    try {
      await worker.tx(ctx, ws, tx)
    } catch (e) {
      ctx.error('Failed to process tx message', { e, wsUuid: ws, tx })
      throw e
    }
  })

  const sync = (): Promise<void> => withRetry(() => worker.resolveAiBotAccount())

  // Initial delay of 5 seconds to give other services a head start.
  setTimeout(() => {
    void sync()
  }, 5 * 1000)

  const shutdown = (): void => {
    void worker.close()
    void Promise.all([txConsumer.close()]).then(() => queue.shutdown().then(() => process.exit()))
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  process.on('uncaughtException', (error: any) => {
    ctx.error('Uncaught exception', { error })
  })
  process.on('unhandledRejection', (error: any) => {
    ctx.error('Unhandled rejection', { error })
  })
}

function getCtx (): MeasureContext {
  configureAnalytics(config.ServiceId, process.env.VERSION ?? '0.7.0')
  Analytics.setTag('application', config.ServiceId)
  return initStatisticsContext(config.ServiceId, {
    factory: () =>
      createOpenTelemetryMetricsContext(
        config.ServiceId,
        {},
        {},
        newMetrics(),
        new SplitLogger(config.ServiceId, {
          root: join(process.cwd(), 'logs'),
          enableConsole: (process.env.ENABLE_CONSOLE ?? 'true') === 'true'
        })
      )
  })
}

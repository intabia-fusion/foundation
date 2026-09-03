//
// Copyright © 2025 Hardcore Engineering Inc.
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
import { configureAnalytics, createOpenTelemetryMetricsContext, SplitLogger } from '@hcengineering/analytics-service'
import { newMetrics } from '@hcengineering/core'
import { getPlatformQueue } from '@hcengineering/kafka'
import { setMetadata } from '@hcengineering/platform'
import serverClient from '@hcengineering/server-client'
import {
  initStatisticsContext,
  LimitCategory,
  QueueTopic,
  QueueWorkspaceEvent,
  type QueueWorkspaceLimitsMessage,
  type QueueWorkspaceMessage,
  StorageConfig
} from '@hcengineering/server-core'
import serverToken from '@hcengineering/server-token'
import { join } from 'path'

import config from './config'
import { createDb } from './db/postgres'
import { LimitsEngine } from './limits'
import { createPoolNotifier } from './notify'
import { createServer, listen } from './server'
import { type BillingMessage, type BillingUsageMessage, BillingMessageKind } from './types'
import { UsageWorker } from './usage'
import { storageConfigFromEnv } from '@hcengineering/server-storage'

const setupMetadata = (): void => {
  setMetadata(serverToken.metadata.Secret, config.Secret)
  setMetadata(serverToken.metadata.Service, 'billing')
  setMetadata(serverClient.metadata.Endpoint, config.AccountsUrl)
}

export const main = async (): Promise<void> => {
  setupMetadata()

  configureAnalytics('billing', process.env.VERSION ?? '0.7.0')
  Analytics.setTag('application', 'billing')

  const metricsContext = initStatisticsContext('billing', {
    factory: () =>
      createOpenTelemetryMetricsContext(
        'billing',
        {},
        {},
        newMetrics(),
        new SplitLogger('billing', {
          root: join(process.cwd(), 'logs'),
          enableConsole: (process.env.ENABLE_CONSOLE ?? 'true') === 'true'
        })
      )
  })

  const db = await createDb(metricsContext, config.DbUrl)
  const storageConfigs: StorageConfig[] = storageConfigFromEnv().storages.filter((p) => p.kind === 'datalake')

  const queue = getPlatformQueue('billing', config.QueueRegion)
  const workspaceProducer = queue.getProducer<QueueWorkspaceLimitsMessage>(metricsContext, QueueTopic.Workspace)
  const engine = new LimitsEngine(db, config.AccountsUrl, storageConfigs, workspaceProducer)

  // Mail producer for provider-pool threshold alerts (80%/100%).
  const mailProducer = queue.getProducer<{ type: 'email', data: any }>(metricsContext, QueueTopic.NotificationQueue)
  const notifier = createPoolNotifier(mailProducer, config.AdminEmails)

  const worker = new UsageWorker(
    db,
    storageConfigs,
    config,
    async (ctx, workspace) => {
      await engine.recomputeWorkspace(ctx, workspace)
    },
    notifier
  )

  // Single billing topic: usage deltas + LiveKit records (session/egress/participant) + AI registry, routed by `kind`.
  const usageConsumer = queue.createBatchConsumer<BillingMessage>(
    metricsContext,
    QueueTopic.BillingUsage,
    'billing-limits',
    async (ctx, msgs, queue) => {
      // LiveKit records/registry go straight to their tables; usage deltas are collected and applied as one batch.
      const usage: BillingUsageMessage[] = []
      for (const msg of msgs) {
        const value = msg.value
        try {
          // Missing kind = Usage (in-flight messages from before the upgrade).
          if (value.kind === 'session') {
            await db.setLiveKitSessions(ctx, value.data)
          } else if (value.kind === 'egress') {
            await db.setLiveKitEgress(ctx, value.data)
          } else if (value.kind === 'participant') {
            await db.pushParticipantSessions(ctx, value.data)
          } else if (value.kind === BillingMessageKind.AiRegistry) {
            // Guard against poison messages: invalid entries would retry forever if thrown.
            if (!Array.isArray(value.entries)) {
              ctx.error('invalid AiRegistry message: entries is not an array', { workspace: msg.workspace })
              continue
            }
            await db.replaceAiModelRegistry(ctx, value.entries)
          } else if (value.kind === BillingMessageKind.AiTokensDetail) {
            if (!Array.isArray(value.data)) {
              ctx.error('invalid AiTokensDetail message: data is not an array', { workspace: msg.workspace })
              continue
            }
            await db.pushAiTokensData(ctx, value.data)
          } else {
            usage.push(value)
          }
        } catch (err: any) {
          // rethrow to trigger consumer retry: billing events drive limit enforcement, must not be silently dropped
          ctx.error('failed to process billing message', { workspace: msg.workspace, kind: value.kind, err })
          throw err
        }
      }
      if (usage.length === 0) return
      try {
        // Aggregate per workspace/metric. Rethrow so an accumulate (dedup-write) failure retries;
        // apply failures are best-effort, corrected by the hourly reconcile (see processUsageBatch).
        await engine.processUsageBatch(ctx, usage, queue.heartbeat)
      } catch (err: any) {
        ctx.error('failed to process usage batch', { size: usage.length, err })
        throw err
      }
    },
    { batchSize: 100, batchTimeout: 1000, sessionTimeout: 120000 }
  )

  // Plan changes (published by account-service) re-evaluate volume limits without a restart.
  const planConsumer = queue.createBatchConsumer<QueueWorkspaceMessage>(
    metricsContext,
    QueueTopic.Workspace,
    'billing-plan',
    async (ctx, msgs, queue) => {
      // A plan or membership change may target a workspace the periodic loop skips until visited;
      // recompute now so the Usage bar seat count refreshes immediately.
      const workspaces = msgs
        .filter((m) => {
          if (m.value.type !== QueueWorkspaceEvent.LimitsChanged) return false
          const category = (m.value as QueueWorkspaceLimitsMessage).category
          return category === LimitCategory.Plan || category === LimitCategory.Members
        })
        .map((m) => m.workspace)
      if (workspaces.length > 0) {
        await worker.recomputeWorkspacesNow(ctx, workspaces, queue.heartbeat)
      }
    },
    { batchSize: 50, batchTimeout: 500, sessionTimeout: 120000 }
  )

  // Publish already-exhausted states on startup (best-effort, non-blocking)
  void engine.startupScan(metricsContext).catch((err) => {
    metricsContext.error('startup limits scan failed', { err })
  })

  await worker.schedule(metricsContext)

  const { app, close } = await createServer(metricsContext, db, storageConfigs, config)
  const server = listen(app, config.Port)

  const shutdown = (): void => {
    void usageConsumer.close()
    void planConsumer.close()
    void workspaceProducer.close()
    void worker.close()
    close()
    server.close(() => process.exit())
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('uncaughtException', (e) => {
    console.error(e)
  })
  process.on('unhandledRejection', (e) => {
    console.error(e)
  })
}

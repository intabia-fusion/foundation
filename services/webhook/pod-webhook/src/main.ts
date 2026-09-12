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
import { Analytics } from '@hcengineering/analytics'
import { configureAnalytics, createOpenTelemetryMetricsContext, SplitLogger } from '@hcengineering/analytics-service'
import { getClient } from '@hcengineering/account-client'
import { newMetrics, systemAccountUuid } from '@hcengineering/core'
import { getPlatformQueue } from '@hcengineering/kafka'
import { setMetadata } from '@hcengineering/platform'
import { QueueTopic } from '@hcengineering/server-core'
import serverToken, { generateToken } from '@hcengineering/server-token'
import { join } from 'path'

import config from './config'
import { startConsumer } from './consumer'
import { startDeliveryConsumer } from './delivery'
import type { EmailNotification } from './notify'
import { createServer } from './server'
import { WebhookStore } from './store'
import type { WebhookJobMessage } from './types'
import { startTxTranslator } from './txTranslator'

export const main = async (): Promise<void> => {
  setMetadata(serverToken.metadata.Secret, config.Secret)
  setMetadata(serverToken.metadata.Service, 'webhook')

  configureAnalytics('webhook', process.env.VERSION ?? '0.7.0')
  Analytics.setTag('application', 'webhook')

  const ctx = createOpenTelemetryMetricsContext(
    'webhook',
    {},
    {},
    newMetrics(),
    new SplitLogger('webhook', {
      root: join(process.cwd(), 'logs'),
      enableConsole: (process.env.ENABLE_CONSOLE ?? 'true') === 'true'
    })
  )

  // Static service token signed with SECRET — rotating SECRET requires restarting this pod.
  const serviceToken = generateToken(systemAccountUuid, undefined, { service: 'webhook' })
  const accountClient = getClient(config.AccountsUrl, serviceToken)

  const queue = getPlatformQueue('webhook')
  // No broker auto-create — this pod owns both topics, so create them on boot (idempotent).
  // QueueTopic.TimeMachine (retries) is NOT created here — that's time-machine's own topic.
  await queue.createTopic(QueueTopic.Webhook, 10)
  await queue.createTopic(QueueTopic.WebhookDelivery, 10)
  const producer = queue.getProducer<WebhookJobMessage>(ctx, QueueTopic.Webhook)
  const notifyProducer = queue.getProducer<EmailNotification>(ctx, QueueTopic.NotificationQueue)

  const store = new WebhookStore()
  const { app, close } = createServer(ctx, config, accountClient, producer, store)
  const consumer = startConsumer(ctx, config, queue, store)
  const deliveryConsumer = startDeliveryConsumer(ctx, config, queue, notifyProducer)
  const txTranslator = startTxTranslator(ctx, config, queue)

  const server = app.listen(config.Port, () => {
    ctx.info(`Webhook service listening on port ${config.Port}`)
  })

  const shutdown = (): void => {
    void (async () => {
      try {
        close()
        await Promise.allSettled([
          consumer.close(),
          deliveryConsumer.close(),
          txTranslator.close(),
          producer.close(),
          notifyProducer.close(),
          queue.shutdown()
        ])
      } finally {
        server.close(() => process.exit())
      }
    })()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('uncaughtException', (err) => {
    ctx.error('uncaughtException', { err })
  })
  process.on('unhandledRejection', (err) => {
    ctx.error('unhandledRejection', { err })
  })
}

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
import { newMetrics, systemAccountUuid, type WorkspaceUuid } from '@hcengineering/core'
import { getPlatformQueue } from '@hcengineering/kafka'
import { setMetadata } from '@hcengineering/platform'
import serverClient from '@hcengineering/server-client'
import serverToken, { generateToken } from '@hcengineering/server-token'
import { getClient, type SubscriptionData } from '@hcengineering/account-client'
import {
  QueueTopic,
  type QueueSubscriptionMessage,
  type QueuePaymentOperationMessage,
  type QueueTbankWebhookMessage,
  subscriptionEvents
} from '@hcengineering/server-core'
import { join } from 'path'
import TbankPayments from './tbank'
import { createMockTbank } from './mockTbank'

import config from './config'
import { createServer, processWebhook } from './server'
import { SubscriptionStorage } from './storage'
import { startScheduler } from './scheduler'

const setupMetadata = (): void => {
  setMetadata(serverToken.metadata.Secret, config.Secret)
  setMetadata(serverToken.metadata.Service, 'tbank-subscriptions')
  setMetadata(serverClient.metadata.Endpoint, config.AccountsUrl)
}
// No license gate here: tbank-subscriptions sits behind pod-payment (internal), which already refuses
// to start in community. If payment is down, no traffic reaches this pod.

export const main = async (): Promise<void> => {
  setupMetadata()

  configureAnalytics('tbank-subscriptions', process.env.VERSION ?? '0.7.0')
  Analytics.setTag('application', 'tbank-subscriptions')

  const metricsContext = createOpenTelemetryMetricsContext(
    'tbank-subscriptions',
    {},
    {},
    newMetrics(),
    new SplitLogger('tbank-subscriptions', {
      root: join(process.cwd(), 'logs'),
      enableConsole: (process.env.ENABLE_CONSOLE ?? 'true') === 'true'
    })
  )

  // Custom logger: SDK default `console` dumps full payloads (CardId/RebillId) to stdout on debug. Drop it.
  const mockPair =
    config.TbankMock === true
      ? createMockTbank({
        terminalKey: config.TbankTerminalKey ?? 'mock-terminal',
        webhookUrl: `http://localhost:${config.Port}/api/v1/webhooks/tbank`,
        checkoutBase: `${config.FrontUrl}/_tbank_subscriptions`,
        info: (msg, data) => {
          metricsContext.info(msg, data)
        }
      })
      : undefined
  const tbankVerboseLogging = process.env.TBANK_DEBUG_LOG === 'true'
  const tbank =
    mockPair?.tbank ??
    new TbankPayments({
      merchantId: config.TbankTerminalKey,
      secret: config.TbankPassword,
      apiUrl: config.TbankUrl,
      logger: {
        debug: (message: string, data) => {
          metricsContext.info(message, tbankVerboseLogging ? data : {})
        },
        error: (message: string, data?: any) => {
          // If not verbose logging keep reason/url, drop raw response body which may echo payload.
          metricsContext.error(message, {
            ...(tbankVerboseLogging ? data : { reason: data?.reason, url: data?.url })
          })
        }
      }
    })

  // Static service token signed with SECRET — rotating SECRET requires restarting this pod.
  const serviceToken = generateToken(systemAccountUuid, undefined, { service: 'payment' })
  const accountClient = getClient(config.AccountsUrl, serviceToken)

  const queue = getPlatformQueue('tbank-subscriptions')
  const producer = queue.getProducer<QueueSubscriptionMessage>(metricsContext, QueueTopic.Subscription)
  const publish = async (data: SubscriptionData): Promise<void> => {
    await producer.send(metricsContext, data.workspaceUuid, [subscriptionEvents.upserted(data, 'tbank', 'webhook')])
  }

  // Durable payment-operation audit: publish to the ledger topic; the account service is the consumer.
  const opProducer = queue.getProducer<QueuePaymentOperationMessage>(metricsContext, QueueTopic.PaymentOperation)
  const publishOperation = async (op: Record<string, any>): Promise<void> => {
    await opProducer.send(metricsContext, op.workspaceUuid ?? op.paymentId ?? 'unknown', [
      op as QueuePaymentOperationMessage
    ])
  }

  const storage = new SubscriptionStorage(accountClient, publish, publishOperation)

  // Inbound webhook queue: the HTTP handler verifies + enqueues; the consumer below rechecks and applies.
  // Partition by PaymentId so all webhooks for one payment stay ordered on a single partition.
  // No broker auto-create — this pod owns the topic, so create it on boot (idempotent).
  await queue.createTopic(QueueTopic.TbankWebhook, 10)
  const webhookProducer = queue.getProducer<QueueTbankWebhookMessage>(metricsContext, QueueTopic.TbankWebhook)
  const enqueueWebhook = async (notification: Record<string, any>, verified: boolean): Promise<void> => {
    const paymentId = String(notification.PaymentId ?? 'unknown')
    await webhookProducer.send(
      metricsContext,
      '00000000-0000-0000-0000-000000000000' as WorkspaceUuid, // placeholder: real workspace resolved in processWebhook
      [{ notification, verified, receivedAt: Date.now() }],
      paymentId
    )
  }

  // Single consumer of the inbound-webhook topic. A throw retries the SAME message locally forever
  // (this kafka wrapper does no broker redelivery), so throw only on retriable failures (bank/storage
  // transient). A programming error (TypeError/RangeError) can never succeed on retry — log and return
  // so one poison webhook can't wedge its partition.
  const webhookConsumer = queue.createConsumer<QueueTbankWebhookMessage>(
    metricsContext,
    QueueTopic.TbankWebhook,
    'tbank-webhook-processor',
    async (ctx, msg) => {
      try {
        await processWebhook(ctx, config, tbank, storage, msg.value.notification, msg.value.verified)
      } catch (err: any) {
        const poison = err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError
        ctx.error(poison ? 'Poison TBank webhook dropped' : 'Failed to process TBank webhook, will retry', {
          paymentId: msg.value.notification?.PaymentId,
          err
        })
        if (!poison) throw err // retry; processWebhook is idempotent (dedup guards on PaymentId)
      }
    }
  )

  const { app, close } = await createServer(metricsContext, config, tbank, storage, enqueueWebhook, mockPair?.mock)

  const server = app.listen(config.Port, () => {
    console.log(`TBank subscriptions service listening on port ${config.Port}`)
  })

  const scheduler = startScheduler(metricsContext, tbank, storage, config, config.SchedulerIntervalMinutes)

  const shutdown = (): void => {
    // Drain an in-flight renewal, then flush producers/consumers BEFORE exit so the last enqueued
    // webhook/audit messages aren't dropped. Await every close; exit only once they've all settled.
    void (async () => {
      try {
        await scheduler.close()
        close()
        await Promise.allSettled([webhookConsumer.close(), webhookProducer.close(), producer.close(), queue.shutdown()])
      } finally {
        server.close(() => process.exit())
      }
    })()
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

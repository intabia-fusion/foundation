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
import { newMetrics, systemAccountUuid, type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import { getPlatformQueue } from '@hcengineering/kafka'
import { setMetadata } from '@hcengineering/platform'
import serverClient from '@hcengineering/server-client'
import {
  initStatisticsContext,
  QueueTopic,
  QueueWorkspaceEvent,
  type QueueWorkspaceMessage,
  type QueueWorkspacePurchaseMessage,
  type QueueSubscriptionMessage,
  QueueSubscriptionEvent,
  subscriptionEvents,
  workspaceEvents,
  type QueuePaymentOperationMessage
} from '@hcengineering/server-core'
import { SubscriptionType, type SubscriptionData } from '@hcengineering/account-client'
import { getAccountClient, isFinalizedUserCancel } from './utils'
import type { SubscriptionPublisher } from './providers'
import serverToken, { generateToken } from '@hcengineering/server-token'
import { join } from 'path'
import config from './config'
import { createServer, listen } from './server'

// account is the single license-key holder. Ask it whether payment may run: dev always yes, licensed
// per key, community no. Refusing here (before HTTP) stops anyone standing up a paid SaaS on our
// bundle without our sign-off. Fail closed on an unreachable account only outside dev.
const assertPaymentAllowed = async (): Promise<void> => {
  const token = generateToken(systemAccountUuid, undefined, { service: 'payment' })
  let info
  try {
    info = await getAccountClient(config.AccountsUrl, token).getLicenseInfo()
  } catch (err) {
    console.error('Failed to resolve license from account, refusing to start payment:', err)
    process.exit(1)
  }
  if (info.edition === 'dev' || info.canRunPayment) return
  console.error(`Payment service is not permitted for this license (edition: ${info.edition}). Exiting.`)
  process.exit(1)
}

const setupMetadata = (): void => {
  setMetadata(serverToken.metadata.Secret, config.Secret)
  setMetadata(serverToken.metadata.Service, 'payment')
  setMetadata(serverClient.metadata.Endpoint, config.AccountsUrl)
}

export const main = async (): Promise<void> => {
  setupMetadata()
  await assertPaymentAllowed()

  configureAnalytics('payment', process.env.VERSION ?? '0.7.0')
  Analytics.setTag('application', 'payment')

  const metricsContext = initStatisticsContext('payment', {
    factory: () =>
      createOpenTelemetryMetricsContext(
        'payment',
        {},
        {},
        newMetrics(),
        new SplitLogger('payment', {
          root: join(process.cwd(), 'logs'),
          enableConsole: (process.env.ENABLE_CONSOLE ?? 'true') === 'true'
        })
      )
  })

  // The queue is REQUIRED: provider events are durable through it and pod-payment is the single writer.
  const queue = getPlatformQueue('payment')
  const producer = queue.getProducer<QueueSubscriptionMessage>(metricsContext, QueueTopic.Subscription)
  const publish: SubscriptionPublisher = async (ctx, data, trigger, canceled) => {
    const msg =
      canceled === true
        ? subscriptionEvents.canceled(data, data.provider, trigger)
        : subscriptionEvents.upserted(data, data.provider, trigger)
    await producer.send(ctx, data.workspaceUuid, [msg])
  }

  // Durable payment-operation audit for mock/polar/stripe (tbank publishes its own, see pod-tbank-subscriptions).
  const opProducer = queue.getProducer<QueuePaymentOperationMessage>(metricsContext, QueueTopic.PaymentOperation)
  const logOperation = async (ctx: MeasureContext, sub: SubscriptionData, canceled: boolean): Promise<void> => {
    if (sub.provider === 'tbank') return
    try {
      await opProducer.send(ctx, sub.workspaceUuid, [
        {
          provider: sub.provider,
          operation: canceled ? 'cancel' : 'webhook',
          status: sub.status,
          subscriptionId: sub.id,
          paymentId: sub.providerSubscriptionId,
          orderId: sub.providerSubscriptionId,
          workspaceUuid: sub.workspaceUuid,
          accountUuid: sub.accountUuid,
          // Provider pods stamp the originating intent on the subscription; reuse it so a free/trial
          // activation lands in the same action as the plan change that triggered it.
          actionId: sub.providerData?.actionId as string | undefined,
          actor: sub.provider === 'free' || sub.provider === 'trial' ? 'system' : 'provider',
          amount: sub.amount,
          raw: { plan: sub.plan, seats: sub.providerData?.quantity, type: sub.type },
          at: Date.now()
        }
      ])
    } catch {
      /* audit is best-effort */
    }
  }

  // Announce a confirmed one-time purchase (generic). The owning pod (e.g. aibot) consumes
  // PurchaseActivated on QueueTopic.Workspace, applies the SKU effect, and marks the purchase consumed.
  const wsPurchaseProducer = queue.getProducer<QueueWorkspacePurchaseMessage>(metricsContext, QueueTopic.Workspace)
  const publishPurchaseActivated = async (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    sku: string,
    purchaseId: string,
    effect?: string,
    quantity?: number
  ): Promise<void> => {
    await wsPurchaseProducer.send(ctx, workspace, [
      workspaceEvents.purchaseActivated(sku, purchaseId, effect, quantity)
    ])
  }

  const { app, ensureInitialSubscription, createFreeIfNoActiveTier, persistSubscription, close } = await createServer(
    metricsContext,
    config,
    publish,
    logOperation,
    publishPurchaseActivated
  )
  const server = listen(app, config.Port)

  let queueClose: (() => Promise<void>) | undefined
  {
    // 1) Workspace creation -> provision the initial tier (trial when configured, else free).
    // Up (workspace opened in a transactor) covers workspaces that predate this provisioning or
    // whose Created event was missed; ensureInitialSubscription is a no-op when a tier exists.
    const wsConsumer = queue.createBatchConsumer<QueueWorkspaceMessage>(
      metricsContext,
      QueueTopic.Workspace,
      'payment-free-tier',
      async (ctx, msgs) => {
        for (const msg of msgs) {
          if (msg.value.type !== QueueWorkspaceEvent.Created && msg.value.type !== QueueWorkspaceEvent.Up) continue
          await ensureInitialSubscription(msg.workspace)
        }
      },
      { batchSize: 20, batchTimeout: 500 }
    )
    // 2) Provider subscription events (stripe/polar/tbank webhook+reconcile+scheduler). This is the
    // SINGLE writer to the account DB for async provider events: bake limits + upsert via persistSubscription.
    // Idempotent (account dedups by provider+id), so redeliveries/replays are safe.
    const subConsumer = queue.createBatchConsumer<QueueSubscriptionMessage>(
      metricsContext,
      QueueTopic.Subscription,
      'payment-subscription-writer',
      async (ctx, msgs) => {
        for (const msg of msgs) {
          try {
            const sub = msg.value.subscription as SubscriptionData
            // Admin cancel initiates the free fallback, pod-payment is the sole holder of the free-plan config.
            if (msg.value.type === QueueSubscriptionEvent.AdminCanceled) {
              if (sub.type === SubscriptionType.Tier) {
                await createFreeIfNoActiveTier(
                  sub.workspaceUuid,
                  sub.providerData?.actionId as string | undefined,
                  sub.plan
                )
              }
              continue
            }
            await persistSubscription(sub)
            await logOperation(ctx, sub, msg.value.type === QueueSubscriptionEvent.Canceled)
            // After a user initiated canceling finalized, we create free subscription.
            if (isFinalizedUserCancel(sub)) {
              // Falling back to free is part of the cancel the user just made — same action.
              await createFreeIfNoActiveTier(sub.workspaceUuid, sub.providerData?.actionId as string | undefined)
            }
          } catch (err: any) {
            ctx.error('failed to persist subscription event', {
              provider: msg.value.provider,
              trigger: msg.value.trigger,
              err
            })
            throw err // let the consumer retry rather than silently drop the event
          }
        }
      },
      { batchSize: 20, batchTimeout: 500 }
    )
    queueClose = async () => {
      await wsConsumer.close()
      await subConsumer.close()
      await producer.close()
      await opProducer.close()
    }
  }

  const shutdown = (): void => {
    void queueClose?.()
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

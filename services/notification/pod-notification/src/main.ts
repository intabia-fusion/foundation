//
// Copyright © 2023 Hardcore Engineering Inc.
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

import { notEmpty } from '@hcengineering/core'
import core, { systemAccountUuid, type Ref } from '@hcengineering/core'
import notification, {
  PushSubscription,
  type PushData,
  QueueNotificationMessage,
  PUSH_NOTIFICATION_TITLE_SIZE,
  PUSH_NOTIFICATION_BODY_SIZE,
  truncate
} from '@hcengineering/notification'
import { getPlatformQueue } from '@hcengineering/kafka'
import { QueueTopic } from '@hcengineering/server-core'
import { setMetadata } from '@hcengineering/platform'
import { withRetry, DelayStrategyFactory } from '@hcengineering/retry'
import serverClient, { getTransactorEndpoint } from '@hcengineering/server-client'
import serverToken, { generateToken } from '@hcengineering/server-token'
import { createRestClient } from '@hcengineering/api-client'
import webpush, { WebPushError } from 'web-push'

import config from './config'
import { apnsConfigured, Delivery, fcmConfigured, PushKind, pushTarget, sendApns, sendFcm } from './mobile'
import { getCtx } from './utils'

const errorMessages = ['expired', 'Unregistered', 'No such subscription', 'VapidPkHashMismatch']

/**
 * Native clients subscribe with a device token instead of a Web Push endpoint,
 * so the transport is chosen per subscription. The caller is unaware of the
 * split: it still posts one list and deletes whatever comes back dead.
 */
export async function sendPushToSubscription (
  subscriptions: PushSubscription[],
  data: PushData
): Promise<Ref<PushSubscription>[]> {
  const promises = subscriptions.map(async (subscription) => {
    const target = pushTarget(subscription.endpoint)
    if (target.kind === PushKind.Apns) {
      if (apnsConfigured() && (await sendApns(target.token, data)) === Delivery.Gone) {
        return subscription._id
      }
      return null
    }
    if (target.kind === PushKind.Fcm) {
      if (fcmConfigured() && (await sendFcm(target.token, data)) === Delivery.Gone) {
        return subscription._id
      }
      return null
    }
    try {
      await webpush.sendNotification(subscription, JSON.stringify(data), {
        TTL: config.TTL,
        headers: {
          Urgency: 'high'
        }
      })
      return null
    } catch (err: any) {
      console.error(`Failed to send push notification to subscription ${subscription._id}:`, err)
      if (err instanceof WebPushError) {
        const bodyStr = err.body != null ? JSON.stringify(err.body) : ''
        if (errorMessages.some((p) => bodyStr.includes(p))) {
          return subscription._id
        }
      }
      return null
    }
  })
  const results = await Promise.all(promises)
  return results.filter(notEmpty)
}

export const main = async (): Promise<void> => {
  if (config.PushPublicKey !== undefined && config.PushPrivateKey !== undefined) {
    try {
      const subj = config.PushSubject ?? 'mailto:hey@huly.io'
      console.log('Setting VAPID details', subj, config.PushPublicKey.length, config.PushPrivateKey.length)
      webpush.setVapidDetails(config.PushSubject ?? 'mailto:hey@huly.io', config.PushPublicKey, config.PushPrivateKey)
    } catch (err: any) {
      console.error(err)
    }
  }

  setMetadata(serverClient.metadata.Endpoint, config.AccountsUrl)
  setMetadata(serverToken.metadata.Secret, config.Secret)
  setMetadata(serverToken.metadata.Service, config.ServiceId)

  const ctx = getCtx()
  const queue = getPlatformQueue(config.ServiceId, config.QueueRegion)

  const consumer = queue.createConsumer<QueueNotificationMessage>(
    ctx,
    QueueTopic.UserNotifications,
    queue.getClientId(),
    async (ctx, queueMessage) => {
      try {
        await withRetry(
          async () => {
            const value = queueMessage.value
            const shouldPush = (value.providers[notification.providers.PushNotificationProvider]?.length ?? 0) > 0
            if (shouldPush) {
              const failedSubscriptionIds = await sendPushToSubscription(value.pushSubscriptions, {
                tag: value.id,
                title: truncate(value.title, PUSH_NOTIFICATION_TITLE_SIZE),
                body: truncate(value.body, PUSH_NOTIFICATION_BODY_SIZE),
                domain: value.domain,
                url: value.url
              })

              if (failedSubscriptionIds.length > 0) {
                try {
                  const token = generateToken(systemAccountUuid, queueMessage.workspace, { service: config.ServiceId })
                  const endpoint = await getTransactorEndpoint(token)
                  const restClient = createRestClient(endpoint, queueMessage.workspace, token)

                  for (const subId of failedSubscriptionIds) {
                    try {
                      await restClient.removeDoc(notification.class.PushSubscription, core.space.Workspace, subId)
                      ctx.info(
                        `Successfully removed invalid push subscription ${subId} from workspace ${queueMessage.workspace}`
                      )
                    } catch (removeErr: any) {
                      ctx.error(`Failed to remove expired subscription ${subId}:`, { removeErr })
                    }
                  }
                } catch (clientErr: any) {
                  ctx.error('Failed to initialize RestClient or fetch transactor endpoint for cleanup:', { clientErr })
                }
              }
            }
          },
          {
            maxRetries: 3,
            isRetryable: () => true,
            delayStrategy: DelayStrategyFactory.exponentialBackoff({
              initialDelayMs: 1000,
              maxDelayMs: 5000,
              backoffFactor: 2.0
            })
          },
          'process-notification'
        )
      } catch (e: any) {
        ctx.error('Failed to process notification after retries, acknowledging poison message:', { e })
      }
    }
  )

  const shutdown = async (): Promise<void> => {
    try {
      await consumer.close()
    } catch (e) {
      console.error('Error closing consumer during shutdown:', e)
    } finally {
      process.exit(0)
    }
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })
  process.on('uncaughtException', (e) => {
    console.error('Uncaught Exception:', e)
    process.exit(1)
  })
  process.on('unhandledRejection', (e) => {
    console.error('Unhandled Rejection:', e)
    process.exit(1)
  })
}

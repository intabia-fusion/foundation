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

import core, { SortingOrder, type MeasureContext, type Ref } from '@hcengineering/core'
import {
  QueueTopic,
  type ConsumerHandle,
  type PlatformQueue,
  type PlatformQueueProducer
} from '@hcengineering/server-core'
import type { RestClient } from '@hcengineering/api-client'
import setting, { type WebhookEndpoint } from '@hcengineering/setting'

import type { Config } from './config'
import { type EmailNotification, notifyOwnerDisabled } from './notify'
import { backoffDelayMs, MAX_ATTEMPTS, scheduleRetry } from './retry'
import { buildDeliveryHeaders } from './signature'
import { safeFetch, SsrfError } from './ssrf'
import { bumpWebhookStat } from './stats'
import type { WebhookDeliveryMessage } from './types'
import { getSystemTransactorTarget } from './workspaceClient'

const CONSUMER_GROUP = 'webhook-delivery-consumer'

// Retry on request timeout/conflict/too-early/rate-limited and any 5xx, same as the plan's list.
// Everything else (including other 4xx and 3xx - no redirects are ever followed) is permanent.
const RETRYABLE_STATUS = new Set([408, 409, 425, 429])
function isRetryableStatus (status: number): boolean {
  return RETRYABLE_STATUS.has(status) || (status >= 500 && status < 600)
}

export function startDeliveryConsumer (
  ctx: MeasureContext,
  config: Config,
  queue: PlatformQueue,
  notifyProducer: PlatformQueueProducer<EmailNotification>
): ConsumerHandle {
  return queue.createConsumer<WebhookDeliveryMessage>(
    ctx,
    QueueTopic.WebhookDelivery,
    CONSUMER_GROUP,
    async (ctx, msg) => {
      await processDelivery(ctx, config, queue, notifyProducer, msg.value)
    }
  )
}

export async function processDelivery (
  ctx: MeasureContext,
  config: Config,
  queue: PlatformQueue,
  notifyProducer: PlatformQueueProducer<EmailNotification>,
  job: WebhookDeliveryMessage
): Promise<void> {
  const target = await getSystemTransactorTarget(config, job.workspace)
  const endpoint = await target.rest.findOne(setting.class.WebhookEndpoint, { _id: job.endpointId })
  if (endpoint === undefined || !endpoint.enabled) {
    // Recipient was deleted or disabled after this delivery was queued - nothing to retry into.
    ctx.info('webhook delivery skipped: endpoint missing or disabled', {
      deliveryId: job.deliveryId,
      endpointId: job.endpointId
    })
    return
  }

  const timestampSec = Math.floor(Date.now() / 1000)
  const body = JSON.stringify({ ...job.event, webhookId: job.deliveryId, webhookTimestamp: timestampSec })
  const headers = buildDeliveryHeaders(endpoint, job.deliveryId, timestampSec, body, job.attempt)

  try {
    const res = await safeFetch(endpoint.url, {
      method: 'POST',
      headers,
      body,
      timeoutMs: config.WebhookDeliveryTimeoutMs,
      maxResponseBytes: config.WebhookMaxResponseBytes,
      allowInsecureHttp: config.AllowInsecureWebhookHttp,
      devAllowedHosts: config.DevAllowedWebhookHosts,
      blockedHosts: config.BlockedWebhookHosts
    })

    if (res.status >= 200 && res.status < 300) {
      await onSuccess(ctx, target.rest, endpoint, job, res.status)
      return
    }

    const reason = `http ${res.status}`
    ctx.warn('webhook delivery got a non-2xx response', {
      deliveryId: job.deliveryId,
      endpointId: endpoint._id,
      status: res.status
    })
    if (isRetryableStatus(res.status)) {
      await retryOrFinalize(ctx, config, queue, notifyProducer, target.rest, target.token, endpoint, job, reason)
    } else {
      await finalizeFailure(ctx, config, notifyProducer, target.rest, target.token, endpoint, job, reason)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.error('webhook delivery failed', {
      deliveryId: job.deliveryId,
      endpointId: endpoint._id,
      attempt: job.attempt,
      error: message
    })

    if (err instanceof SsrfError) {
      // The recipient's own configured address is unsafe - retrying changes nothing about that.
      await finalizeFailure(ctx, config, notifyProducer, target.rest, target.token, endpoint, job, message)
    } else {
      // Network error or timeout - worth retrying.
      await retryOrFinalize(ctx, config, queue, notifyProducer, target.rest, target.token, endpoint, job, message)
    }
  }
}

async function onSuccess (
  ctx: MeasureContext,
  rest: RestClient,
  endpoint: WebhookEndpoint,
  job: WebhookDeliveryMessage,
  status: number
): Promise<void> {
  await rest.updateDoc(setting.class.WebhookEndpoint, core.space.Workspace, endpoint._id, {
    failureCount: 0,
    lastError: '',
    lastDeliveryOn: Date.now()
  })
  await recordDeliveryOutcome(rest, endpoint._id, { deliveryId: job.deliveryId, attempt: job.attempt, status })
  await bumpWebhookStat(ctx, rest, 'out', endpoint._id, job.event.type)
}

const MAX_DELIVERY_HISTORY = 20

/** Appends one row to the endpoint's "recent deliveries" list and trims it back to
 * MAX_DELIVERY_HISTORY - a debugging aid, not the source of truth for endpoint health (that's the
 * failureCount/lastError update next to every call site of this function). One row per finished
 * delivery (success or gave-up-retrying), not per retry attempt - keeps write cost to what already
 * happens today (one updateDoc per terminal outcome) roughly doubled, not multiplied by MAX_ATTEMPTS. */
export async function recordDeliveryOutcome (
  rest: RestClient,
  endpointId: Ref<WebhookEndpoint>,
  entry: { deliveryId: string, attempt: number, status?: number, error?: string }
): Promise<void> {
  await rest.createDoc(setting.class.WebhookDelivery, core.space.Workspace, { endpoint: endpointId, ...entry })
  const recent = await rest.findAll(
    setting.class.WebhookDelivery,
    { endpoint: endpointId },
    { sort: { createdOn: SortingOrder.Descending }, limit: MAX_DELIVERY_HISTORY + 1 }
  )
  if (recent.length > MAX_DELIVERY_HISTORY) {
    await rest.removeDoc(setting.class.WebhookDelivery, core.space.Workspace, recent[recent.length - 1]._id)
  }
}

async function retryOrFinalize (
  ctx: MeasureContext,
  config: Config,
  queue: PlatformQueue,
  notifyProducer: PlatformQueueProducer<EmailNotification>,
  rest: RestClient,
  token: string,
  endpoint: WebhookEndpoint,
  job: WebhookDeliveryMessage,
  reason: string
): Promise<void> {
  if (job.attempt >= MAX_ATTEMPTS) {
    await finalizeFailure(
      ctx,
      config,
      notifyProducer,
      rest,
      token,
      endpoint,
      job,
      `${reason} (gave up after ${job.attempt + 1} attempts)`
    )
    return
  }

  const nextJob: WebhookDeliveryMessage = { ...job, attempt: job.attempt + 1 }
  try {
    await scheduleRetry(
      ctx,
      queue,
      job.workspace,
      QueueTopic.WebhookDelivery,
      job.deliveryId,
      backoffDelayMs(job.attempt),
      nextJob
    )
  } catch (scheduleErr) {
    const scheduleMessage = scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr)
    await finalizeFailure(
      ctx,
      config,
      notifyProducer,
      rest,
      token,
      endpoint,
      job,
      `${reason} (retry scheduling failed: ${scheduleMessage})`
    )
  }
}

// A delivery failed for good (retries spent, or never retryable) - bump the failure counter and, past
// the threshold, disable the endpoint and notify its owner.
async function finalizeFailure (
  ctx: MeasureContext,
  config: Config,
  notifyProducer: PlatformQueueProducer<EmailNotification>,
  rest: RestClient,
  token: string,
  endpoint: WebhookEndpoint,
  job: WebhookDeliveryMessage,
  reason: string
): Promise<void> {
  // $inc, not a write of the count read together with the endpoint: deliveries run in parallel and
  // would all store the same value, so the auto-disable threshold would never be reached.
  await rest.updateDoc(setting.class.WebhookEndpoint, core.space.Workspace, endpoint._id, {
    $inc: { failureCount: 1 },
    lastError: reason
  })
  const current = await rest.findOne(setting.class.WebhookEndpoint, { _id: endpoint._id })
  const failureCount = current?.failureCount ?? (endpoint.failureCount ?? 0) + 1
  const disable = failureCount >= config.WebhookDisableAfterFailures
  if (disable) {
    await rest.updateDoc(setting.class.WebhookEndpoint, core.space.Workspace, endpoint._id, { enabled: false })
  }
  await recordDeliveryOutcome(rest, endpoint._id, { deliveryId: job.deliveryId, attempt: job.attempt, error: reason })

  ctx.warn('webhook delivery gave up', {
    deliveryId: job.deliveryId,
    endpointId: endpoint._id,
    failureCount,
    disabled: disable,
    reason
  })

  if (disable) {
    await notifyOwnerDisabled(ctx, config.AccountsUrl, token, job.workspace, notifyProducer, endpoint, reason)
  }
}

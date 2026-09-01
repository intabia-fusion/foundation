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

import { generateId, type MeasureContext } from '@hcengineering/core'
import { jsonToMarkup } from '@hcengineering/text-core'
import { markdownToMarkup } from '@hcengineering/text-markdown'
import { QueueTopic, type ConsumerHandle, type PlatformQueue } from '@hcengineering/server-core'
import type { RestClient } from '@hcengineering/api-client'

import type { Config } from './config'
import { isKnownOperation, markdownFields } from './operations'
import { backoffDelayMs, MAX_ATTEMPTS, scheduleRetry } from './retry'
import { bumpWebhookStat } from './stats'
import type { WebhookStore } from './store'
import type { WebhookJobMessage } from './types'
import { getTransactorTarget, type TransactorTarget } from './workspaceClient'

const CONSUMER_GROUP = 'webhook-consumer'

export function startConsumer (
  ctx: MeasureContext,
  config: Config,
  queue: PlatformQueue,
  store: WebhookStore
): ConsumerHandle {
  return queue.createConsumer<WebhookJobMessage>(ctx, QueueTopic.Webhook, CONSUMER_GROUP, async (ctx, msg) => {
    await processJob(ctx, config, queue, store, msg.value)
  })
}

// Handles every markdown field the action declares: `blob` ones are uploaded and replaced by a
// `Ref<Blob>` under `refField`, `inline` ones converted in place. The transactor cannot upload.
async function prepareBody (
  rest: RestClient,
  action: WebhookJobMessage['action'],
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const fields = markdownFields[action]
  if (fields === undefined) return payload

  const body = { ...payload }
  for (const [field, spec] of Object.entries(fields)) {
    const value = body[field]
    if (typeof value !== 'string') continue
    if (spec.kind === 'inline') {
      body[field] = jsonToMarkup(markdownToMarkup(value))
    } else if (spec.kind === 'blob') {
      body[spec.refField] = await rest.uploadMarkup(spec.objectClass, generateId(), field, value, 'markdown')
      body[field] = undefined // JSON.stringify drops undefined-valued properties, no dynamic delete needed
    }
    // 'raw': already markdown, forwarded unchanged - the transactor converts and uploads it itself.
  }
  return body
}

// Carries the transactor's HTTP status so processJob can tell a permanent 4xx (bad payload, forbidden
// action) from a transient failure worth retrying - a plain Error can't distinguish the two.
class TransactorHttpError extends Error {
  constructor (
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

async function callTransactor (
  target: TransactorTarget,
  workspace: WebhookJobMessage['workspace'],
  action: WebhookJobMessage['action'],
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const url = `${target.transactorUrl}/api/v1/ops/${action}/${workspace}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` },
    body: JSON.stringify(body),
    // A hung transactor would otherwise block this consumer handler, and with it the whole partition.
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new TransactorHttpError(res.status, `transactor ops call failed: ${res.status} ${text}`)
  }
  return await res.json()
}

export async function processJob (
  ctx: MeasureContext,
  config: Config,
  queue: PlatformQueue,
  store: WebhookStore,
  job: WebhookJobMessage
): Promise<void> {
  try {
    // job.action is already typed ApiKeyOperation - cast so the guard checks it defensively (queue
    // messages aren't runtime-verified) without TS narrowing it to `never` in the throw below.
    if (!isKnownOperation(job.action as unknown)) {
      throw new Error(`unknown action: "${job.action as string}"`)
    }

    const target = await getTransactorTarget(ctx, config, job.workspace, job)
    const body = await prepareBody(target.rest, job.action, job.payload)
    const result = await callTransactor(target, job.workspace, job.action, body, config.TransactorTimeoutMs)

    store.markDone(job.jobId, result)
    await bumpWebhookStat(ctx, target.rest, 'in', job.keyId, job.action)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.error('webhook job failed', { jobId: job.jobId, action: job.action, attempt: job.attempt, error: message })

    // 4xx is a permanent failure (bad payload, forbidden action) - retrying won't fix it, so fail now
    // instead of burning the full backoff schedule. 5xx and network/timeout errors still retry below.
    if (err instanceof TransactorHttpError && err.status >= 400 && err.status < 500) {
      store.markFailed(job.jobId, message)
      return
    }

    await retryOrFail(ctx, queue, store, job, message)
  }
}

async function retryOrFail (
  ctx: MeasureContext,
  queue: PlatformQueue,
  store: WebhookStore,
  job: WebhookJobMessage,
  message: string
): Promise<void> {
  // Reached only for retryable failures now (5xx, network errors, timeouts) - 4xx is filtered out in
  // processJob above and fails immediately without going through this backoff schedule.
  if (job.attempt >= MAX_ATTEMPTS) {
    store.markFailed(job.jobId, `${message} (gave up after ${job.attempt + 1} attempts)`)
    return
  }

  const nextJob: WebhookJobMessage = { ...job, attempt: job.attempt + 1 }
  try {
    await scheduleRetry(ctx, queue, job.workspace, QueueTopic.Webhook, job.jobId, backoffDelayMs(job.attempt), nextJob)
    // Job stays 'queued' - it comes back through QueueTopic.Webhook once the delay elapses.
  } catch (scheduleErr) {
    // ponytail: time-machine is off in prod. If scheduling the retry fails, fail the job outright
    // rather than leave it stuck in 'queued' forever.
    const scheduleMessage = scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr)
    store.markFailed(job.jobId, `${message} (retry scheduling failed: ${scheduleMessage})`)
  }
}

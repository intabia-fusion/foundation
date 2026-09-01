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
import {
  AccountRole,
  generateId,
  type MeasureContext,
  type PersonId,
  type Ref,
  type WorkspaceUuid
} from '@hcengineering/core'
import { getClient as getAccountClient, type AccountClient } from '@hcengineering/account-client'
import { SlidingWindowRateLimitter, type RateLimitInfo } from '@hcengineering/rpc'
import type { PlatformQueueProducer } from '@hcengineering/server-core'
import { decodeToken } from '@hcengineering/server-token'
import setting, { type WebhookEndpoint } from '@hcengineering/setting'
import cors from 'cors'
import { createHash } from 'crypto'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'

import type { Config } from './config'
import { recordDeliveryOutcome } from './delivery'
import { sendError } from './errors'
import { isKnownOperation } from './operations'
import { buildDeliveryHeaders } from './signature'
import { safeFetch } from './ssrf'
import { WebhookStore } from './store'
import type { WebhookEvent, WebhookJobMessage } from './types'
import { getSystemTransactorTarget } from './workspaceClient'

const BODY_LIMIT = '1mb'

export function createServer (
  ctx: MeasureContext,
  config: Config,
  accountClient: AccountClient,
  producer: PlatformQueueProducer<WebhookJobMessage>,
  store: WebhookStore = new WebhookStore()
): { app: Express, close: () => void } {
  const app = express()
  const perKeyHeaderLimiter = new SlidingWindowRateLimitter(config.RateLimitMax, config.RateLimitWindowMs)
  // A key in the path leaks whole into logs and is meant for narrow-scoped use - stricter than the header form.
  const perKeyPathLimiter = new SlidingWindowRateLimitter(config.RateLimitPathMax, config.RateLimitWindowMs)
  const perIpLimiter = new SlidingWindowRateLimitter(config.RateLimitMax, config.RateLimitWindowMs)

  app.set('trust proxy', 1) // client IP for the per-source rate limit comes from X-Forwarded-For
  app.use(cors())
  app.use(express.json({ limit: BODY_LIMIT }))

  app.post(
    '/api/v1/webhook/action',
    wrap(async (req, res) => {
      await handleIngest(ctx, accountClient, producer, store, perKeyHeaderLimiter, perIpLimiter, 'header', req, res)
    })
  )

  app.post(
    '/api/v1/webhook/k/:key',
    wrap(async (req, res) => {
      await handleIngest(ctx, accountClient, producer, store, perKeyPathLimiter, perIpLimiter, 'path', req, res)
    })
  )

  app.get(
    '/api/v1/webhook/job/:id',
    wrap(async (req, res) => {
      await handleJobStatus(accountClient, store, req, res)
    })
  )

  // Owner-only, session-token authenticated (unlike the two ingest routes above, which verify an API
  // key) - the settings page's "send test event" button. Same origin as Backup.svelte's BackupUrl:
  // the browser hits this pod directly with its own token, no transactor round trip needed.
  app.post(
    '/api/v1/webhook/:workspace/test/:endpointId',
    wrap(async (req, res) => {
      await handleTestSend(config, req, res)
    })
  )

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  app.use((_req, res) => {
    sendError(res, 404, 'not_found')
  })

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    // express.json({ limit }) rejects an oversized body with this error before any route handler runs.
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      sendError(res, 413, 'payload_too_large')
      return
    }
    ctx.error('webhook: unhandled request error', { err })
    sendError(res, 500, 'internal_error')
  })

  return { app, close: () => {} }
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next)
  }

function bearerToken (req: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '')
  return match?.[1]
}

function logCall (
  ctx: MeasureContext,
  keyId: string | undefined,
  action: unknown,
  via: 'header' | 'path',
  result: string
): void {
  // Never log the key itself, only the keyId it resolved to (undefined when the key didn't verify).
  ctx.info('webhook call', { keyId, action, via, result, time: Date.now() })
}

function applyRateLimitHeaders (res: Response, info: RateLimitInfo): void {
  const { remaining, limit, reset, retryAfter } = info
  res.setHeader('Retry-After', `${Math.max(Math.round((retryAfter ?? 0) / 1000), 1)}`)
  res.setHeader('Retry-After-ms', `${retryAfter ?? 1000}`)
  res.setHeader('X-RateLimit-Limit', `${limit}`)
  res.setHeader('X-RateLimit-Remaining', `${remaining}`)
  res.setHeader('X-RateLimit-Reset', `${reset}`)
}

async function handleIngest (
  ctx: MeasureContext,
  accountClient: AccountClient,
  producer: PlatformQueueProducer<WebhookJobMessage>,
  store: WebhookStore,
  perKeyLimiter: SlidingWindowRateLimitter,
  perIpLimiter: SlidingWindowRateLimitter,
  keySource: 'header' | 'path',
  req: Request,
  res: Response
): Promise<void> {
  const key = keySource === 'path' ? req.params.key : bearerToken(req)

  if (key === undefined || key.length === 0) {
    logCall(ctx, undefined, undefined, keySource, 'unauthorized')
    sendError(res, 401, 'unauthorized')
    return
  }

  // Before verifyApiKey, so an unknown key cannot drive unbounded calls into the account service.
  // Keyed on the presented credential rather than on the keyId it resolves to, which is not known yet;
  // an over-limit key is stopped here and never touches the source-IP budget it shares with everyone
  // else behind that address.
  const keyLimit = perKeyLimiter.checkRateLimit(createHash('sha256').update(key).digest('hex'))
  if (keyLimit.remaining === 0) {
    logCall(ctx, undefined, undefined, keySource, 'rate_limited')
    applyRateLimitHeaders(res, keyLimit)
    sendError(res, 429, 'rate_limited')
    return
  }

  const check = await accountClient.verifyApiKey(key).catch((err) => {
    ctx.error('webhook: verifyApiKey failed', { err })
    return null
  })
  if (check === null) {
    // Only a credential that did not verify burns the shared per-IP budget - that is the guessing case.
    const ipLimit = perIpLimiter.checkRateLimit(req.ip ?? 'unknown')
    if (ipLimit.remaining === 0) {
      logCall(ctx, undefined, undefined, keySource, 'rate_limited')
      applyRateLimitHeaders(res, ipLimit)
      sendError(res, 429, 'rate_limited')
      return
    }
    logCall(ctx, undefined, undefined, keySource, 'unauthorized')
    sendError(res, 401, 'unauthorized')
    return
  }
  if (!check.incoming) {
    // Same response as an unknown key - a caller must not be able to tell "wrong key" apart from
    // "valid key, but not permitted on ingest routes". Only our own log tells the two apart.
    logCall(ctx, check.keyId, undefined, keySource, 'incoming_disabled')
    sendError(res, 401, 'unauthorized')
    return
  }
  // No workspace in the path to check against - the key itself identifies it.
  const workspace = check.workspace

  const body = (req.body ?? {}) as Record<string, unknown>
  const action = body.action
  const space = body.space
  // `action` validity is checked against the operations registry (src/operations.ts) - the same
  // registry the consumer executes against, so the facade and the execution can't drift apart.
  if (!isKnownOperation(action) || typeof space !== 'string' || space.length === 0) {
    logCall(ctx, check.keyId, action, keySource, 'invalid_payload')
    sendError(res, 400, 'invalid_payload')
    return
  }

  // Right check only: `space` is the caller's project/channel id, not a Ref<Space>. Resolving it and
  // checking it against check.spaces is the consumer's job, once it has the workspace model loaded.
  if (!check.ops.includes(action)) {
    logCall(ctx, check.keyId, action, keySource, 'forbidden')
    sendError(res, 403, 'forbidden')
    return
  }

  const idempotencyKey = req.header('idempotency-key')
  if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
    const existing = store.getIdempotentJob(check.keyId, idempotencyKey)
    if (existing !== undefined) {
      logCall(ctx, check.keyId, action, keySource, 'replayed')
      res.status(202).json({ jobId: existing.jobId })
      return
    }
  }

  const jobId = `wh_${generateId()}`
  const message: WebhookJobMessage = {
    jobId,
    workspace,
    keyId: check.keyId,
    name: check.name,
    socialId: check.socialId,
    personUuid: check.personUuid,
    action,
    ops: check.ops,
    spaces: check.spaces,
    payload: body,
    receivedAt: Date.now(),
    attempt: 0
  }

  // Tracked before it is queued: the consumer runs in this same pod against this same store, so a job
  // enqueued first can be executed - and marked done - before the record it marks even exists.
  store.createJob(jobId, workspace, check.keyId)
  try {
    await producer.send(ctx, workspace, [message], workspace)
  } catch (err) {
    store.dropJob(jobId)
    ctx.error('webhook: failed to enqueue job', { err, keyId: check.keyId })
    logCall(ctx, check.keyId, action, keySource, 'internal_error')
    sendError(res, 500, 'internal_error')
    return
  }

  if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
    store.putIdempotencyKey(check.keyId, idempotencyKey, jobId)
  }

  logCall(ctx, check.keyId, action, keySource, 'queued')
  res.status(202).json({ jobId })
}

async function handleJobStatus (
  accountClient: AccountClient,
  store: WebhookStore,
  req: Request,
  res: Response
): Promise<void> {
  const key = bearerToken(req)
  if (key === undefined || key.length === 0) {
    sendError(res, 401, 'unauthorized')
    return
  }

  const check = await accountClient.verifyApiKey(key).catch(() => null)
  if (check === null) {
    sendError(res, 401, 'unauthorized')
    return
  }

  // keyId as well as workspace: one key must not read another key's job result or error text.
  const job = store.getJob(req.params.id)
  if (job === undefined || job.workspace !== check.workspace || job.keyId !== check.keyId) {
    sendError(res, 404, 'not_found')
    return
  }

  res.status(200).json({
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    result: job.result,
    error: job.error
  })
}

// Synchronous, not queued: a test has to show its own result, and doesn't touch failureCount/
// lastError/enabled - a bad test send shouldn't count against (or auto-disable) a real endpoint.
// It's still logged into the same "recent deliveries" history real deliveries use.
async function handleTestSend (config: Config, req: Request, res: Response): Promise<void> {
  const workspace = req.params.workspace as WorkspaceUuid
  const token = bearerToken(req)
  if (token === undefined || token.length === 0) {
    sendError(res, 401, 'unauthorized')
    return
  }

  let decoded
  try {
    decoded = decodeToken(token)
  } catch {
    sendError(res, 401, 'unauthorized')
    return
  }
  if (decoded.workspace !== workspace) {
    sendError(res, 401, 'unauthorized')
    return
  }

  // Owner only, matching the settings category this is called from - the endpoint is read with the
  // pod's own system token below, so the caller's own read rights would not gate anything.
  try {
    const info = await getAccountClient(config.AccountsUrl, token).getLoginWithWorkspaceInfo()
    if (info.workspaces[workspace]?.role !== AccountRole.Owner) {
      sendError(res, 403, 'forbidden')
      return
    }
  } catch {
    sendError(res, 401, 'unauthorized')
    return
  }

  const endpointId = req.params.endpointId as Ref<WebhookEndpoint>
  const target = await getSystemTransactorTarget(config, workspace)
  const endpoint = await target.rest.findOne(setting.class.WebhookEndpoint, { _id: endpointId })
  if (endpoint === undefined) {
    sendError(res, 404, 'not_found')
    return
  }

  const deliveryId = `test_${generateId()}`
  const timestampSec = Math.floor(Date.now() / 1000)
  const event: WebhookEvent = {
    action: 'create',
    type: 'webhook.test',
    actor: decoded.account as unknown as PersonId,
    data: { message: 'This is a test event sent from the workspace settings page.' },
    organizationId: workspace
  }
  const body = JSON.stringify({ ...event, webhookId: deliveryId, webhookTimestamp: timestampSec })
  const headers = buildDeliveryHeaders(endpoint, deliveryId, timestampSec, body, 0)

  try {
    const result = await safeFetch(endpoint.url, {
      method: 'POST',
      headers,
      body,
      timeoutMs: config.WebhookDeliveryTimeoutMs,
      maxResponseBytes: config.WebhookMaxResponseBytes,
      allowInsecureHttp: config.AllowInsecureWebhookHttp,
      devAllowedHosts: config.DevAllowedWebhookHosts,
      blockedHosts: config.BlockedWebhookHosts
    })
    await recordDeliveryOutcome(target.rest, endpoint._id, { deliveryId, attempt: 0, status: result.status })
    res.status(200).json({ delivered: result.status >= 200 && result.status < 300, status: result.status })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordDeliveryOutcome(target.rest, endpoint._id, { deliveryId, attempt: 0, error: message })
    res.status(200).json({ delivered: false, error: message })
  }
}

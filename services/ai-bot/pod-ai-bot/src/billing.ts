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
import { groupByArray, MeasureContext, systemAccountUuid, WorkspaceUuid } from '@hcengineering/core'
import { generateToken } from '@hcengineering/server-token'
import { type PlatformQueueProducer } from '@hcengineering/server-core'
import {
  getClient as getBillingClient,
  type BillingClient,
  AiTranscriptData,
  AiTokensData,
  type AiModelRegistryEntry,
  type ProviderPool
} from '@hcengineering/billing-client'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import { withRetry } from '@hcengineering/retry'
import { v4 as uuid } from 'uuid'

import config, { type AIProviderConfig } from './config'
import { type WindowUsage } from './workspace/windowLimit'
import { resolveAsrModel } from './transcription/asrRegistry'

/** Mirrors BillingMessageKind in pod-billing. Missing kind = Usage (back-compat). */
export enum BillingMessageKind {
  Usage = 'usage',
  AiRegistry = 'ai-registry',
  AiTokensDetail = 'ai-tokens-detail'
}

/** Mirrors BillingUsageMessage in pod-billing (single billing-usage topic, discriminated by `kind`). */
export interface BillingUsageMessage {
  kind?: BillingMessageKind.Usage
  workspace: WorkspaceUuid
  metric: 'tokens' | 'transcript'
  amount: number
  /** Idempotency key. */
  ref: string
}

/** Mirrors AiModelRegistryMessage in pod-billing: replace-all model catalog. */
export interface AiModelRegistryMessage {
  kind: BillingMessageKind.AiRegistry
  entries: AiModelRegistryEntry[]
}

/** Mirrors AiTokensDetailMessage in pod-billing: per-(provider, model, level, client) spend. */
export interface AiTokensDetailMessage {
  kind: BillingMessageKind.AiTokensDetail
  data: AiTokensData[]
}

export type BillingQueueMessage = BillingUsageMessage | AiModelRegistryMessage | AiTokensDetailMessage

// Set from queue.ts after queue init; undefined = no-op.
let usageProducer: PlatformQueueProducer<BillingQueueMessage> | undefined

export function setUsageProducer (producer: PlatformQueueProducer<BillingQueueMessage>): void {
  usageProducer = producer
}

// Set from queue.ts so pushTokensData can feed the local pool counter for immediate enforcement.
let poolLimitsRef: PoolLimits | undefined

export function setPoolLimitsRef (pools: PoolLimits): void {
  poolLimitsRef = pools
}

interface DeepgramRequest {
  request_id: string
  path: string
  created: string
  response?: {
    details?: {
      usd?: number
      duration?: number
      metadata?: Record<string, any>
      tags?: string[]
    }
    code: number
    completed: string
  }
}

interface DeepgramRequestsResponse {
  page: number
  limit: number
  requests?: DeepgramRequest[]
}

export interface TranscriptData {
  workspace: WorkspaceUuid
  day: string
  requestId: string
  startTime: string
  durationSeconds: number
  usd: number
}

async function fetchDeepgramRequests (
  ctx: MeasureContext,
  start?: Date,
  end?: Date,
  page?: number
): Promise<DeepgramRequestsResponse> {
  const url = new URL(`https://api.deepgram.com/v1/projects/${config.DeepgramProjectId}/requests`)
  if (start != null) {
    url.searchParams.set('start', start.toISOString())
  }
  if (end != null) {
    url.searchParams.set('end', end.toISOString())
  }

  if (page != null) {
    url.searchParams.set('page', page.toString())
  }

  url.searchParams.set('limit', '100')

  const res = await fetch(url, {
    headers: { Authorization: `Token ${config.DeepgramApiKey}` }
  })

  if (!res.ok) {
    const text = await res.text()
    ctx.error('Failed to fetch deepgram requests', { status: res.status, text })
    throw new Error(`Failed to fetch deepgram requests ${res.status}: ${text}`)
  }

  return await res.json()
}

function extractExtra (path: string): Record<string, any> {
  try {
    const query = path.split('?')[1]
    if (query == null) return {}
    const params = new URLSearchParams(query)
    const extras = params.getAll('extra')
    return Object.fromEntries(extras.map((pair) => pair.split(':', 2)).filter(([k, v]) => k != null && v != null))
  } catch {
    return {}
  }
}

function extractWorkspace (req: DeepgramRequest): WorkspaceUuid | undefined {
  const metadata = req.response?.details?.metadata ?? {}
  if (metadata?.workspace != null && metadata.workspace !== '') return metadata.workspace
  const extra = extractExtra(req.path ?? '')
  const ws = extra.workspace

  if (ws == null) return undefined
  if (typeof ws !== 'string') return undefined
  if (ws.trim() === '') return undefined
  return ws as WorkspaceUuid
}

async function fetchLastData (ctx: MeasureContext, billingClient: BillingClient): Promise<AiTranscriptData | undefined> {
  try {
    return await billingClient.getAiTranscriptLastData()
  } catch (e: any) {
    if (e.name === 'NetworkError') {
      throw e
    }

    return undefined
  }
}

export async function updateDeepgramBilling (ctx: MeasureContext): Promise<void> {
  if (config.DeepgramApiKey === '' || config.DeepgramProjectId === '' || config.DeepgramTag === '') return
  ctx.info('Starting deepgram billing update')

  const token = generateToken(systemAccountUuid, undefined, { service: 'ai-bot' })
  const billingClient = getBillingClient(config.BillingUrl, token)

  const lastData = await withRetry(() => fetchLastData(ctx, billingClient))
  ctx.info('Last deepgram request', lastData)

  const start = lastData != null ? new Date(lastData.lastStartTime) : undefined
  const end = new Date()
  let page = 0

  const data: TranscriptData[] = []

  while (true) {
    const res = await withRetry(() => fetchDeepgramRequests(ctx, start, end, page))
    const requests = res.requests ?? []

    for (const req of requests) {
      if (lastData != null && lastData.lastRequestId === req.request_id) continue

      const tags = req.response?.details?.tags ?? []
      if (!tags.includes(config.DeepgramTag)) continue
      const workspace = extractWorkspace(req)
      if (workspace == null) continue

      const endTime = req.response?.completed
      const durationSeconds = req.response?.details?.duration
      const usd = req.response?.details?.usd

      if (endTime == null || durationSeconds == null || usd == null) {
        continue
      }

      const day = new Date(req.created)
      day.setHours(0, 0, 0, 0)

      data.push({
        workspace,
        day: day.toISOString(),
        requestId: req.request_id,
        startTime: req.created,
        durationSeconds,
        usd
      })
    }

    if (requests.length < res.limit) break

    page++
  }

  const groupped = groupByArray(data, (it) => `${it.workspace}:${it.day}`)
  const requestData: AiTranscriptData[] = []

  for (const [, values] of groupped.entries()) {
    if (values.length === 0) continue

    const last = values.reduce((a, b) => (new Date(a.startTime).getTime() > new Date(b.startTime).getTime() ? a : b))

    const totalDurationSeconds = values.reduce((sum, it) => sum + (it.durationSeconds ?? 0), 0)
    const totalUsd = values.reduce((sum, it) => sum + (it.usd ?? 0), 0)

    const req: AiTranscriptData = {
      workspace: values[0].workspace,
      day: values[0].day,
      lastRequestId: last.requestId,
      lastStartTime: last.startTime,
      durationSeconds: totalDurationSeconds,
      usd: totalUsd
    }
    requestData.push(req)
  }

  if (requestData.length > 0) {
    await billingClient.postAiTranscriptData(requestData)
  }

  ctx.info('Finished deepgram billing update')
}

export async function pushTranscriptDuration (
  ctx: MeasureContext,
  workspace: WorkspaceUuid,
  durationSec: number,
  ref?: string
): Promise<void> {
  if (usageProducer === undefined) return
  try {
    await usageProducer.send(ctx, workspace, [
      // ref must be deterministic for retry idempotency (billing dedups by it)
      {
        kind: BillingMessageKind.Usage,
        workspace,
        metric: 'transcript',
        amount: durationSec,
        ref: `transcript-${workspace}-${ref ?? uuid()}`
      }
    ])
  } catch (e) {
    ctx.error('Failed to push transcript duration to billing-usage', { workspace, durationSec, e })
  }
}

/** Admin-stats-only per-model ASR detail (no pool enforcement); doesn't touch the usage limit. */
export async function pushTranscriptUsageRecord (
  ctx: MeasureContext,
  workspace: WorkspaceUuid,
  durationSec: number,
  clientId?: string,
  asrLevel?: string
): Promise<void> {
  if (config.BillingUrl === '' || durationSec <= 0) return

  let providerId = ''
  let model = ''
  let level = asrLevel ?? config.AsrDefaultLevel
  if (config.AsrProviders.length > 0) {
    try {
      // clientId (which clisr worker served) is passed separately, empty for direct providers.
      const resolved = resolveAsrModel(level, config.AsrProviders)
      providerId = resolved.provider.id
      model = resolved.model.model
      level = resolved.level
    } catch (e) {
      ctx.error('Failed to resolve ASR model for transcript usage stats', { e })
    }
  }

  try {
    const token = generateToken(systemAccountUuid, undefined, { service: 'ai-bot' })
    const billingClient = getBillingClient(config.BillingUrl, token)
    await billingClient.postTranscriptUsage([
      { workspace, durationSeconds: durationSec, date: new Date().toISOString(), providerId, model, level, clientId }
    ])
  } catch (e) {
    ctx.error('Failed to post per-model transcript usage to billing REST', { e })
  }
}

/** billedTokens = (prompt+completion) * tokenMultiplier (rounded up). */
export function tokensRecord (
  workspace: WorkspaceUuid,
  promptTokens: number,
  completionTokens: number,
  multiplier: number,
  reason: string,
  modelId?: string,
  date: string = new Date().toISOString(),
  providerId?: string,
  level?: string,
  clientId?: string
): AiTokensData {
  const billed = Math.ceil((promptTokens + completionTokens) * multiplier)
  return {
    workspace,
    reason,
    tokens: billed,
    rawTokens: promptTokens + completionTokens,
    date,
    providerId,
    model: modelId,
    level,
    clientId
  }
}

/**
 * Push a single billing record if total tokens > 0.
 * usage undefined = no-op (API returned no usage).
 */
export function billUsage (
  ctx: MeasureContext,
  workspace: WorkspaceUuid,
  usage: { promptTokens: number, completionTokens: number } | undefined,
  meta: { multiplier: number, modelId: string, providerId: string, level: string },
  reason: string,
  date?: string,
  clientId?: string
): void {
  if (usage === undefined) return
  const total = Math.ceil((usage.promptTokens + usage.completionTokens) * meta.multiplier)
  if (total <= 0) return
  void pushTokensData(ctx, [
    tokensRecord(
      workspace,
      usage.promptTokens,
      usage.completionTokens,
      meta.multiplier,
      reason,
      meta.modelId,
      date,
      meta.providerId,
      meta.level,
      clientId
    )
  ])
}

const WINDOW_CACHE_TTL_MS = 30 * 1000
const WINDOW_CACHE_STALE_MS = 5 * 60 * 1000
const windowCache = new Map<WorkspaceUuid, { at: number, value: WindowUsage }>()

/** Drop a workspace's cached window (billing published a limits change). */
export function invalidateWorkspaceWindows (workspace: WorkspaceUuid): void {
  windowCache.delete(workspace)
}

// Catalog effect aibot owns. account/payment are domain-agnostic; aibot decides what a purchase does.
const ADD_AI_TOKENS_EFFECT = 'add-ai-tokens'

// Apply a confirmed token grant from a PurchaseActivated event; ignores effects other pods own.
// Idempotent (billing dedups by grantId); marks the purchase consumed in account after.
export async function applyPurchase (
  ctx: MeasureContext,
  workspace: WorkspaceUuid,
  purchaseId: string,
  effect: string | undefined,
  quantity: number | undefined
): Promise<void> {
  if (effect !== ADD_AI_TOKENS_EFFECT) return
  if (quantity === undefined || quantity <= 0) {
    ctx.error('add-ai-tokens purchase without an amount, ignoring', { workspace, purchaseId })
    return
  }
  const token = generateToken(systemAccountUuid, workspace, { service: 'ai-bot' })
  const billingClient = getBillingClient(config.BillingUrl, token)
  const { applied } = await billingClient.addAiTokens(workspace, purchaseId, quantity)
  invalidateWorkspaceWindows(workspace)
  if (applied) {
    // Bookkeeping only, and package grants carry no purchase row at all: never fail the handler
    // over it, or Kafka would redeliver an already-granted top-up forever.
    const account = getAccountClient(config.AccountsURL, token)
    try {
      await withRetry(() => account.updatePurchaseStatus(purchaseId, 'consumed'))
    } catch (err: any) {
      ctx.warn('failed to mark purchase consumed; tokens are already granted', { workspace, purchaseId, err })
    }
  }
}

// Fetch the per-workspace monthly billed-token window from billing, cached for 30s.
// On outage the last known value is reused; with none, reports unavailable (never unmetered).
export async function getWorkspaceWindows (ctx: MeasureContext, workspace: WorkspaceUuid): Promise<WindowUsage> {
  // Billing not configured (dev/self-hosted): unmetered by design, not an outage.
  if (config.BillingUrl === '') {
    return { month: { used: 0, limit: 0 }, balance: 0, plan: 'unknown', isFree: false, hasPackages: false }
  }
  const cached = windowCache.get(workspace)
  if (cached !== undefined && Date.now() - cached.at < WINDOW_CACHE_TTL_MS) {
    return cached.value
  }
  try {
    const token = generateToken(systemAccountUuid, workspace, { service: 'ai-bot' })
    const billingClient = getBillingClient(config.BillingUrl, token)
    const w = await billingClient.getWorkspaceTokenWindows(workspace)
    const value: WindowUsage = {
      month: { used: w.month.used, limit: w.month.limit },
      balance: w.balance ?? 0,
      plan: w.plan,
      isFree: w.isFree ?? false,
      hasPackages: w.hasPackages
    }
    const now = Date.now()
    // Evict well past the TTL, not at it: an expired entry is still the stale-if-error fallback
    // below. A workspace idle this long does not need one.
    for (const [key, entry] of windowCache) {
      if (now - entry.at > WINDOW_CACHE_STALE_MS) windowCache.delete(key)
    }
    windowCache.set(workspace, { at: now, value })
    return value
  } catch (e) {
    ctx.error('Failed to fetch token windows', { workspace, e })
    // Stale-if-error: keep serving on the last known window rather than cutting AI off on a blip.
    if (cached !== undefined) return cached.value
    return {
      month: { used: 0, limit: 0 },
      balance: 0,
      plan: 'unknown',
      isFree: false,
      hasPackages: false,
      unavailable: true
    }
  }
}

export async function pushTokensData (ctx: MeasureContext, data: AiTokensData[], ref?: string): Promise<void> {
  // Local pool counter, measured in raw provider tokens (multiplier only scales the user's monthly limit).
  if (poolLimitsRef !== undefined) {
    for (const d of data) {
      if (d.providerId !== undefined && d.model !== undefined) {
        poolLimitsRef.addUsage(d.providerId, d.model, d.rawTokens ?? d.tokens)
      }
    }
  }
  if (usageProducer === undefined) return
  const workspace = data[0]?.workspace
  if (workspace === undefined) return
  try {
    // Both messages go on the same partition key, so the per-model detail cannot outrun the
    // delta that drives enforcement. Durable: no silent loss when billing is down.
    const total = data.reduce((sum, d) => sum + d.tokens, 0)
    const messages: BillingQueueMessage[] = [{ kind: BillingMessageKind.AiTokensDetail, data }]
    if (total > 0) {
      messages.unshift({
        kind: BillingMessageKind.Usage,
        workspace,
        metric: 'tokens',
        amount: total,
        ref: ref ?? uuid()
      })
    }
    await usageProducer.send(ctx, workspace, messages)
  } catch (e) {
    ctx.error('Failed to push tokens data to billing-usage', { e })
  }
}

function adminBillingClient (): BillingClient {
  const token = generateToken(systemAccountUuid, undefined, { service: 'ai-bot' })
  return getBillingClient(config.BillingUrl, token)
}

function buildRegistryEntries (providers: AIProviderConfig[]): AiModelRegistryEntry[] {
  const entries: AiModelRegistryEntry[] = []
  for (const provider of providers) {
    for (const [level, model] of Object.entries(provider.levels)) {
      if (model === undefined) continue
      entries.push({ providerId: provider.id, model: model.model, level, label: model.label })
    }
  }
  return entries
}

// Publish this pod's (provider, model, level) catalog so the admin UI can set per-model
// pool limits before any spend exists. Best-effort.
export async function pushModelRegistry (ctx: MeasureContext, providers: AIProviderConfig[]): Promise<void> {
  if (usageProducer === undefined) return
  const entries = buildRegistryEntries(providers)
  if (entries.length === 0) return
  try {
    // Fixed partition key: registry is global, not per-workspace.
    await usageProducer.send(ctx, 'ai-registry' as WorkspaceUuid, [{ kind: BillingMessageKind.AiRegistry, entries }])
    ctx.info('Published AI model registry to billing queue', { count: entries.length })
  } catch (e) {
    ctx.error('Failed to publish AI model registry to billing queue', { e })
  }
}

// Self-heal: the initial push can race a not-yet-joined billing consumer (Kafka `latest`
// drops it). Republish on poll if any of our (provider, model) pairs are missing there.
async function syncModelRegistry (ctx: MeasureContext, providers: AIProviderConfig[]): Promise<void> {
  const local = buildRegistryEntries(providers)
  if (local.length === 0) return
  try {
    const remote = await adminBillingClient().listAiModelRegistry()
    const have = new Set(remote.map((e) => `${e.providerId} ${e.model}`))
    const missing = local.some((e) => !have.has(`${e.providerId} ${e.model}`))
    if (missing) {
      ctx.info('AI model registry out of sync with billing; republishing', {
        local: local.length,
        remote: remote.length
      })
      await pushModelRegistry(ctx, providers)
    }
  } catch (e) {
    // billing unreachable: pool poll already logs this, registry sync is best-effort.
  }
}

/** Global per-(provider, model) pool guard. Fail-open: unreachable billing never blocks LLM usage. */
export class PoolLimits {
  // "providerId model" -> purchased budget (0/absent = untracked, no pool).
  private purchased = new Map<string, number>()
  // Locally-accumulated spend since the last fetch: immediate self-blocking without
  // waiting for billing's recompute. Fetch overwrites with billing's absolute.
  private used = new Map<string, number>()
  // Pools billing flagged exhausted (from fetch or the Kafka pool-exhausted event).
  private exhausted = new Set<string>()
  private timer: any | undefined
  private closed = false
  // Provider registry, for the registry self-heal on each poll (set in start()).
  private providers: AIProviderConfig[] = []
  // Fraction of the pool still free below which we poll more aggressively.
  private static readonly LOW_REMAINING = 0.1

  private key (providerId: string, model: string): string {
    return `${providerId} ${model}`
  }

  // True when the model's own pool OR its whole-provider pool is exhausted.
  isBlocked (providerId: string, model: string): boolean {
    return this.blockedKey(this.key(providerId, model)) || this.blockedKey(this.key(providerId, ''))
  }

  private blockedKey (key: string): boolean {
    if (this.exhausted.has(key)) return true
    const cap = this.purchased.get(key)
    return cap !== undefined && cap > 0 && (this.used.get(key) ?? 0) >= cap
  }

  // Resolve (providerId, level) -> model via the registry, then check the pool.
  isBlockedByLevel (providers: AIProviderConfig[], providerId: string, level: string): boolean {
    const model = providers.find((p) => p.id === providerId)?.levels[level]?.model ?? ''
    return this.isBlocked(providerId, model)
  }

  // Count freshly-spent raw (provider-billed) tokens against the local budget between fetches.
  addUsage (providerId: string, model: string, rawTokens: number): void {
    if (rawTokens <= 0) return
    const key = this.key(providerId, model)
    this.used.set(key, (this.used.get(key) ?? 0) + rawTokens)
  }

  async refresh (ctx: MeasureContext): Promise<{ lowRemaining: boolean, ok?: boolean }> {
    if (config.BillingUrl === '') return { lowRemaining: false }
    let pools: ProviderPool[]
    try {
      pools = await adminBillingClient().getAiPools()
    } catch (e) {
      ctx.error('Failed to fetch AI pools; leaving enforcement fail-open', { e })
      return { lowRemaining: false, ok: false }
    }
    const nextExhausted = new Set<string>()
    const nextPurchased = new Map<string, number>()
    const nextUsed = new Map<string, number>()
    let lowRemaining = false
    for (const pool of pools) {
      if (pool.kind === 'local' || pool.purchasedTokens <= 0) continue
      const key = this.key(pool.providerId, pool.model)
      nextPurchased.set(key, pool.purchasedTokens)
      // Billing's absolute wins over the local estimate (corrects drift/dedup).
      nextUsed.set(key, pool.usedTokens)
      if (pool.exhausted || pool.usedTokens >= pool.purchasedTokens) {
        nextExhausted.add(key)
      } else if ((pool.purchasedTokens - pool.usedTokens) / pool.purchasedTokens < PoolLimits.LOW_REMAINING) {
        lowRemaining = true
      }
    }
    this.exhausted = nextExhausted
    this.purchased = nextPurchased
    this.used = nextUsed
    if (nextExhausted.size > 0) {
      ctx.info('AI pools exhausted (enforcement active)', { keys: [...nextExhausted] })
    }
    // billing reachable now: make sure it has our model registry (initial push may have
    // raced its consumer join).
    await syncModelRegistry(ctx, this.providers)
    return { lowRemaining }
  }

  // Poll on startup, then on an interval that tightens when any pool is running low.
  start (ctx: MeasureContext, providers: AIProviderConfig[], baseIntervalMs: number, lowIntervalMs: number): void {
    this.providers = providers
    const tick = async (): Promise<void> => {
      if (this.closed) return
      const { lowRemaining, ok } = await this.refresh(ctx)
      if (this.closed) return
      // Retry quickly while billing is unreachable (e.g. still booting) so the pool
      // state isn't stuck empty (fail-open) for a whole base interval.
      const next = ok === false ? lowIntervalMs : lowRemaining ? lowIntervalMs : baseIntervalMs
      this.timer = setTimeout(() => {
        void tick()
      }, next)
    }
    // Retry the first fetch in the background (doesn't block the caller/pod startup);
    // then hand off to the periodic tick.
    void (async () => {
      const retryMs = 3000
      while (!this.closed) {
        const { ok } = await this.refresh(ctx)
        if (ok !== false) break
        await new Promise((resolve) => setTimeout(resolve, retryMs))
      }
      if (!this.closed) {
        this.timer = setTimeout(() => {
          void tick()
        }, baseIntervalMs)
      }
    })()
  }

  close (): void {
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
  }
}

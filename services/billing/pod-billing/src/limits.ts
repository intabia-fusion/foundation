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
  isArchivingMode,
  isDeletingMode,
  type MeasureContext,
  systemAccountUuid,
  type WorkspaceUuid
} from '@hcengineering/core'
import {
  type AccountClient,
  getClient,
  grantsPlan,
  type Subscription,
  SubscriptionStatus,
  SubscriptionType
} from '@hcengineering/account-client'
import {
  LimitCategory as SCLimitCategory,
  LimitStatus,
  type PlatformQueueProducer,
  type QueueWorkspaceLimitsMessage,
  type StorageConfig,
  workspaceEvents
} from '@hcengineering/server-core'
import { generateToken } from '@hcengineering/server-token'

import { collectDatalakeStats } from './billing'
import billingConfig from './config'
import { type BillingDB, type BillingUsageMessage, type LimitCategory, type UsageMetric } from './types'

/**
 * What a finished period takes out of the purchased pack: the monthly grant is spent first, so
 * only the overflow is charged. Staying under the grant costs nothing.
 */
export function packCharge (periodUsage: number, limitMonth: number, pack: number): number {
  if (limitMonth <= 0) return 0 // unlimited grant never overflows
  return Math.min(pack, Math.max(0, periodUsage - limitMonth))
}

/** Computes volume-limit state, persists it, and publishes edge-triggered LimitsChanged events. */
export class LimitsEngine {
  constructor (
    private readonly db: BillingDB,
    private readonly accountsUrl: string,
    private readonly storageConfigs: StorageConfig[],
    private readonly producer: PlatformQueueProducer<QueueWorkspaceLimitsMessage>
  ) {}

  /**
   * Per-event cheap path: bump `used` by amount, flip exhausted on limit crossing. Over-counts
   * over time (deletes/dedup); the hourly worker re-reads absolute usage and corrects the drift.
   */
  async processUsageDelta (ctx: MeasureContext, msg: BillingUsageMessage): Promise<void> {
    const { workspace, metric, amount, ref } = msg

    // Idempotent by ref: a redelivered event must not double-count.
    const isNew = await this.db.accumulateUsageDelta(ctx, workspace, metric, amount, ref)
    if (!isNew) {
      ctx.info('billing-usage duplicate ref, skipping', { workspace, metric, ref })
      return
    }
    if (amount === 0) return
    await this.applyDelta(ctx, workspace, metric, amount)
  }

  /**
   * Dedup+accumulate every ref, then sum new amounts per (workspace, metric) so a burst on one
   * workspace costs one apply instead of N. metric->category is 1:1, so grouping never collides.
   */
  async processUsageBatch (
    ctx: MeasureContext,
    msgs: BillingUsageMessage[],
    heartbeat?: () => Promise<void>
  ): Promise<void> {
    const groups = new Map<string, { workspace: WorkspaceUuid, metric: UsageMetric, amount: number }>()
    for (const { workspace, metric, amount, ref } of msgs) {
      const isNew = await this.db.accumulateUsageDelta(ctx, workspace, metric, amount, ref)
      if (!isNew) {
        ctx.info('billing-usage duplicate ref, skipping', { workspace, metric, ref })
        continue
      }
      if (amount === 0) continue
      const key = `${workspace}:${metric}`
      const g = groups.get(key)
      if (g === undefined) groups.set(key, { workspace, metric, amount })
      else g.amount += amount
    }
    // Ref is already accumulated (dedup) so a batch retry re-applies nothing. Swallow apply failures:
    // the hourly reconcile recomputes limit_state from absolute usage, correcting any missed delta.
    for (const g of groups.values()) {
      try {
        await this.applyDelta(ctx, g.workspace, g.metric, g.amount)
      } catch (err: any) {
        ctx.error('applyDelta failed; limit_state left for the hourly reconcile', {
          workspace: g.workspace,
          metric: g.metric,
          err
        })
      }
      await heartbeat?.()
    }
  }

  /** Apply an aggregated delta to limit_state + usageInfo (edge-triggered LimitsChanged). */
  private async applyDelta (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    metric: UsageMetric,
    amount: number
  ): Promise<void> {
    const category = metricToCategory(metric)
    const subs = await this.accountClient(workspace).getSubscriptions(workspace, false)
    const limitValue = await this.effectiveLimit(ctx, workspace, subs, metric)

    const prev = await this.db.getLimitState(ctx, workspace, category)
    const prevUsed = prev?.used ?? 0
    const used = prevUsed + amount
    const prevExhausted = prev?.exhausted ?? false
    const nowExhausted = limitValue > 0 && used >= limitValue

    if (nowExhausted !== prevExhausted) {
      const status = nowExhausted ? LimitStatus.Exhausted : LimitStatus.Ok
      ctx.info('limit status changed (delta)', { workspace, category, status, used, limitValue })
      await this.producer.send(ctx, workspace, [workspaceEvents.limitsChanged(category as SCLimitCategory, status)])
    }
    await this.db.upsertLimitState(ctx, { workspace, category, used, limitValue, exhausted: nowExhausted })

    // Reflect the increment in the displayed usageInfo so the UI moves without waiting for the tick.
    await this.bumpUsageInfo(ctx, workspace, metric, amount)

    // Tokens: nudge the UI to re-read the window whenever the monthly fill crosses a
    // 5% step, so the indicator stays fresh between the hourly poll.
    if (metric === 'tokens') {
      await this.maybeNotifyWindowStep(ctx, workspace, amount, subs)
    }
  }

  // Takes the caller's `subs`: resolving the plan again here would mean a second account-service
  // round trip on every token delta.
  private async maybeNotifyWindowStep (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    amount: number,
    subs: Subscription[]
  ): Promise<void> {
    try {
      const limitMonth = tokenWindowLimit(subs)
      if (limitMonth <= 0) return
      const pkgs = subs.filter((s) => s.type === SubscriptionType.Package && s.status === SubscriptionStatus.Active)
      const periodStart = getPeriodStartDate(grantPeriodAnchor(latestGrantingTier(subs)?.periodStart, pkgs))
      const stats = await this.db.getAiTokensStats(ctx, workspace, periodStart, new Date())
      const usedNow = stats.map((s) => s.totalTokens).reduce((a, b) => a + b, 0)
      const balance = await this.db.getTokenBalance(ctx, workspace)
      // Step over tier + pack, matching the bar the user actually sees.
      const total = limitMonth + (balance?.remainingTokens ?? 0)
      const stepNow = Math.floor(Math.min(100, (usedNow / total) * 100) / 5)
      const stepPrev = Math.floor(Math.min(100, (Math.max(0, usedNow - amount) / total) * 100) / 5)
      if (stepNow !== stepPrev) {
        await this.producer.send(ctx, workspace, [
          workspaceEvents.limitsChanged(SCLimitCategory.Tokens, LimitStatus.Ok)
        ])
      }
    } catch (err: any) {
      ctx.error('window step notify failed', { workspace, err })
    }
  }

  /** Increment a single usageInfo field on the account (best-effort; the hourly worker rewrites the absolute). */
  private async bumpUsageInfo (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    metric: UsageMetric,
    amount: number
  ): Promise<void> {
    const field = usageField(metric)
    // meetingMinutes deltas arrive in seconds, but usageInfo stores minutes.
    const delta = metric === 'meetingMinutes' ? amount / 60 : amount
    try {
      const account = this.accountClient(workspace)
      const info = (await account.getWorkspaceInfo(false)).usageInfo
      const usage = { ...(info?.usage ?? {}) }
      usage[field] = (usage[field] ?? 0) + delta
      await account.updateUsageInfo({
        usage,
        startTime: info?.startTime ?? Date.now(),
        updateTime: Date.now()
      })
    } catch (err: any) {
      ctx.error('usageInfo bump after delta failed', { workspace, metric, err })
    }
  }

  /** Startup scan: enumerate all active workspaces, publish already-exhausted states. */
  async startupScan (ctx: MeasureContext): Promise<void> {
    const account = this.accountClient(undefined)
    const workspaces = await account.listWorkspaces(undefined, null, undefined)
    ctx.info('startup limits scan', { total: workspaces.length })

    for (const ws of workspaces) {
      if (isArchivingMode(ws.mode) || isDeletingMode(ws.mode)) continue
      try {
        await this.recomputeWorkspace(ctx, ws.uuid)
      } catch (err: any) {
        ctx.error('startup scan failed', { workspace: ws.uuid, err })
      }
    }
  }

  /** Plan changed: re-evaluate all volume metrics so an upgrade lifts exhausted without a restart. */
  async recomputeWorkspace (ctx: MeasureContext, workspace: WorkspaceUuid): Promise<void> {
    // Subscriptions cannot change between the four metrics of one pass - fetch them once instead
    // of paying an account round-trip per metric.
    const subs = await this.accountClient(workspace).getSubscriptions(workspace, false)
    for (const metric of ['tokens', 'transcript', 'storage', 'meetingMinutes'] as UsageMetric[]) {
      try {
        await this.recompute(ctx, workspace, metric, subs)
      } catch (err: any) {
        ctx.error('plan recompute failed', { workspace, metric, err })
      }
    }
  }

  /** Recompute used vs limit for one metric and publish on exhausted-flag flip. */
  private async recompute (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    metric: UsageMetric,
    knownSubs?: Subscription[]
  ): Promise<void> {
    const category = metricToCategory(metric)
    const subs = knownSubs ?? (await this.accountClient(workspace).getSubscriptions(workspace, false))
    // computeUsed absorbs first, so the limit below already reflects the drained balance.
    const used = await this.computeUsed(ctx, workspace, metric, subs)
    const limitValue = await this.effectiveLimit(ctx, workspace, subs, metric)

    const nowExhausted = limitValue > 0 && used >= limitValue
    const prev = await this.db.getLimitState(ctx, workspace, category)
    const prevExhausted = prev?.exhausted ?? false

    if (nowExhausted !== prevExhausted) {
      const status = nowExhausted ? LimitStatus.Exhausted : LimitStatus.Ok
      ctx.info('limit status changed', { workspace, category, status, used, limitValue })
      await this.producer.send(ctx, workspace, [workspaceEvents.limitsChanged(category as SCLimitCategory, status)])
    }

    await this.db.upsertLimitState(ctx, { workspace, category, used, limitValue, exhausted: nowExhausted })
  }

  private async computeUsed (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    metric: UsageMetric,
    subs: Subscription[]
  ): Promise<number> {
    if (metric === 'storage') {
      // storage is absolute, from datalake; ignores billing period
      const stats = await collectDatalakeStats(ctx, workspace, this.storageConfigs)
      return stats.size
    }

    const periodEnd = new Date()
    const tier = latestGrantingTier(subs)

    if (metric === 'tokens') {
      // Same anchor as resolveWorkspacePlan, so limit_state and the token window agree on the period.
      const pkgs = subs.filter((s) => s.type === SubscriptionType.Package && s.status === SubscriptionStatus.Active)
      const periodStart = getPeriodStartDate(grantPeriodAnchor(tier?.periodStart, pkgs))
      const stats = await this.db.getAiTokensStats(ctx, workspace, periodStart, periodEnd)
      // `used` is the full spend and the limit below is grant + pack, so `used >= limit` is still
      // exactly "nothing left".
      await this.settlePreviousPeriod(ctx, workspace, periodStart, tokenWindowLimit(subs))
      return stats.map((s) => s.totalTokens).reduce((a, b) => a + b, 0)
    }

    const periodStart = getPeriodStartDate(tier?.periodStart)
    if (metric === 'meetingMinutes') {
      // limit state keeps seconds, matching the delta unit love sends
      const stats = await this.db.getParticipantMinutes(ctx, workspace, periodStart, periodEnd)
      return stats.totalMinutes * 60
    }

    // transcript (seconds)
    const stats = await this.db.getAiTranscriptStats(ctx, workspace, periodStart, periodEnd)
    return stats.totalDurationSeconds
  }

  /**
   * Tier limit widened by the purchased balance: `used` counts only what the balance did not cover,
   * so `used >= limit` is exactly the "available <= 0" block condition of the two-pool model.
   */
  private async effectiveLimit (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    subs: Subscription[],
    metric: UsageMetric
  ): Promise<number> {
    if (metric !== 'tokens') return getEffectiveLimit(subs, metric)
    // Grant + pack. The AI package's own `tokenLimit` is not added: activating one grants into
    // `token_balance`, so counting it here again would double it.
    const base = tokenWindowLimit(subs)
    if (base === 0) return 0
    const balance = await this.db.getTokenBalance(ctx, workspace)
    return base + (balance?.remainingTokens ?? 0)
  }

  /**
   * Charges the pack for the period that just ended, once. Within a period nothing is written:
   * everything a reader needs is derivable from usage, the grant and the pack.
   *
   * The overflow is measured against today's grant, not the one in force back then - a mid-period
   * seat change therefore undercharges slightly. Deliberate: it errs in the customer's favour and
   * saves storing a per-period limit.
   */
  private async settlePreviousPeriod (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    periodStart: Date,
    limitMonth: number
  ): Promise<void> {
    const balance = await this.db.getTokenBalance(ctx, workspace)
    if (balance === undefined) return

    const prevStart = new Date(balance.periodStart)
    // `period_start` doubles as the idempotency marker: equal means this period is already settled.
    if (prevStart.getTime() >= periodStart.getTime()) return

    const stats = await this.db.getAiTokensStats(ctx, workspace, prevStart, periodStart)
    const prevUsage = stats.map((s) => s.totalTokens).reduce((a, b) => a + b, 0)
    const charge = packCharge(prevUsage, limitMonth, balance.remainingTokens)

    ctx.info('settling token pack for the finished period', { workspace, prevUsage, limitMonth, charge })
    // The write itself re-checks that period_start is still behind: a concurrent settle (or a retry
    // of a committed one) loses the race and skips instead of charging twice, and the decrement is
    // relative so a concurrent grantAiTokens cannot be lost.
    const settled = await this.db.settleTokenBalance(ctx, workspace, charge, null, charge, periodStart.toISOString())
    if (!settled) {
      ctx.info('token pack period already settled, skipping', { workspace })
    }
  }

  private accountClient (workspace: WorkspaceUuid | undefined): AccountClient {
    const token = generateToken(systemAccountUuid, workspace, { service: 'billing' })
    return getClient(this.accountsUrl, token)
  }
}

function metricToCategory (metric: UsageMetric): LimitCategory {
  return metric === 'storage' ? 'disk' : metric
}

/** usageInfo.usage field name for a metric (storage is reported in bytes). */
function usageField (metric: UsageMetric): string {
  return metric === 'storage' ? 'storageBytes' : metric
}

type TierLimits = NonNullable<Subscription['limits']>

/**
 * Effective tier limits: active paid tier's own limits, else the free fallback baked into a tier
 * subscription (unpaid workspace runs on free), else undefined (unlimited).
 */
/** Most recent tier subscription (by createdOn) — the current plan, ignoring superseded ones. */
function latestTier (subs: Subscription[]): Subscription | undefined {
  return subs.filter((s) => s.type === SubscriptionType.Tier).sort((a, b) => (b.createdOn ?? 0) - (a.createdOn ?? 0))[0]
}

/** Latest plan-granting tier (paid or live trial) by createdOn — deterministic on a trial+paid overlap. */
function latestGrantingTier (subs: Subscription[]): Subscription | undefined {
  return subs
    .filter((s) => s.type === SubscriptionType.Tier && grantsPlan(s))
    .sort((a, b) => (b.createdOn ?? 0) - (a.createdOn ?? 0))[0]
}

// One place resolving the effective plan: the latest granting tier uses its own limits; otherwise
// (no tier, expired trial, unpaid) fall back to the free limits baked into the latest tier.
export function resolveTierLimits (subs: Subscription[]): TierLimits | undefined {
  return latestGrantingTier(subs)?.limits ?? latestTier(subs)?.freeLimits ?? undefined
}

/**
 * The monthly AI grant. Deliberately `windowMonthLimit` and not `tokenLimit`: payment bakes the
 * per-seat grant into the former (`resolveLimits`), while plans leave `tokenLimit` at 0 - reading
 * it here made the limit look unlimited and silently disabled token enforcement on per-seat plans.
 * The token window in `handleGetWorkspaceTokenWindows` has always used this field, so this is also
 * what the user sees.
 */
export function tokenWindowLimit (subs: Subscription[]): number {
  return resolveTierLimits(subs)?.windowMonthLimit ?? billingConfig.WindowMonthLimit
}

function getLimitValue (limits: TierLimits | undefined, metric: UsageMetric): number {
  if (limits == null) return 0 // no subscription = unlimited

  if (metric === 'tokens') return limits.tokenLimit ?? 0
  if (metric === 'transcript') return (limits.meetingMinutesLimit ?? 0) * 60 // minutes -> seconds
  if (metric === 'meetingMinutes') return (limits.meetingMinutesLimit ?? 0) * 60 // minutes -> seconds
  return (limits.storageLimitGB ?? 0) * 1e9 // GB -> bytes
}

// Effective limit = tier base + active add-on package (one per ws). Package adds only for its own
// metric (disk package: storageLimitGB>0, tokenLimit 0). Tier 0 = unlimited, package never tightens.
function getEffectiveLimit (subs: Subscription[], metric: UsageMetric): number {
  const base = getLimitValue(resolveTierLimits(subs), metric)
  if (base === 0) return 0 // unlimited tier -> package cannot restrict it

  const pkg = subs.find((s) => s.type === SubscriptionType.Package && s.status === SubscriptionStatus.Active)
  return base + getLimitValue(pkg?.limits, metric)
}

/**
 * Start of the usage window, floored to the hour to match hourly usage buckets. UTC, like the
 * buckets themselves: a local floor drifts by half an hour in zones such as Asia/Kolkata.
 */
export function getPeriodStartDate (periodStart: number | undefined): Date {
  if (periodStart !== undefined) {
    const start = new Date(periodStart)
    start.setUTCMinutes(0, 0, 0)
    return start
  }
  const date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

// Anchor of the AI grant period: the earliest active AI-token package start when there is one, so the
// package quota and the tier window top up on the same date. Falls back to the tier start.
export function grantPeriodAnchor (
  tierStart: number | undefined,
  packages: Array<Pick<Subscription, 'periodStart' | 'limits'>>
): number | undefined {
  const aiStarts = packages
    .filter((p) => (p.limits?.tokenLimit ?? 0) > 0)
    .map((p) => p.periodStart)
    .filter((s): s is number => s !== undefined)
  return aiStarts.length > 0 ? Math.min(...aiStarts) : tierStart
}

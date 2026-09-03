//
// Copyright © 2025 Hardcore Engineering Inc.
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
  type AccountClient,
  type Subscription,
  SubscriptionType,
  getClient,
  grantsPlan,
  memberOccupiesSeat
} from '@hcengineering/account-client'
import {
  type AccountUuid,
  type MeasureContext,
  type UsageStatus,
  type WorkspaceUuid,
  RateLimiter,
  SocialIdType,
  buildSocialIdString,
  isArchivingMode,
  isDeletingMode,
  systemAccountUuid
} from '@hcengineering/core'
import { aiBotAccountEmail } from '@hcengineering/middleware'
import { type StorageConfig } from '@hcengineering/server-core'
import { generateToken } from '@hcengineering/server-token'

import { collectDatalakeStats } from './billing'
import { type Config } from './config'
import { type BillingDB, type ProviderPool } from './types'

// Called when a provider pool newly crosses an 80% or 100% usage threshold.
export type PoolThresholdHandler = (ctx: MeasureContext, pool: ProviderPool, percent: 80 | 100) => Promise<void>

const aiBotSocialKey = buildSocialIdString({ type: SocialIdType.EMAIL, value: aiBotAccountEmail })

export class UsageWorker {
  private canceled: boolean = false
  private promise: Promise<void> = Promise.resolve()
  // aibot account uuid, resolved once — it never occupies a seat, so it is excluded from membersCount.
  private aiBotAccount: AccountUuid | undefined

  constructor (
    private readonly db: BillingDB,
    private readonly storageConfigs: StorageConfig[],
    private readonly config: Config,
    // Re-evaluate limit_state from absolute usage after the displayed usageInfo is refreshed;
    // corrects the over-counting drift accumulated by the per-event delta path. Set by main.
    private readonly reconcileLimits?: (ctx: MeasureContext, workspace: WorkspaceUuid) => Promise<void>,
    private readonly onPoolThreshold?: PoolThresholdHandler
  ) {}

  async close (): Promise<void> {
    this.canceled = true
    await this.promise
  }

  async schedule (ctx: MeasureContext): Promise<void> {
    ctx.info('schedule usage update with interval', { interval: this.config.UsageUpdateInterval })

    this.promise = this.run(ctx)
  }

  private async run (ctx: MeasureContext): Promise<void> {
    while (!this.canceled) {
      try {
        await this.recheckWorkspaces(ctx)
      } catch (err: any) {
        ctx.error('failed to recheck workspaces', { error: err })
      }

      try {
        // Retention: dedup refs only guard against queue redelivery, no need to keep them forever.
        await this.db.cleanupUsageDeltaDedup(ctx, 30)
      } catch (err: any) {
        ctx.error('failed to cleanup usage delta dedup', { error: err })
      }

      try {
        await this.recomputeProviderPools(ctx)
      } catch (err: any) {
        ctx.error('failed to recompute provider pools', { error: err })
      }

      if (!this.canceled) {
        await new Promise((resolve) => setTimeout(resolve, this.config.UsageUpdateInterval * 1000))
      }
    }
  }

  // Recompute used/exhausted for each purchased provider pool from the token usage
  // table over the pool's own period; fire onPoolThreshold when 80%/100% is crossed.
  async recomputeProviderPools (ctx: MeasureContext): Promise<void> {
    const pools = await this.db.listProviderPools(ctx)
    if (pools.length === 0) return

    const now = new Date()
    for (const pool of pools) {
      if (this.canceled) return
      if (pool.kind === 'local' || pool.purchasedTokens <= 0) continue

      // Usage rows are bucketed to the start of the hour, so floor periodStart to the
      // hour too — otherwise an intra-hour periodStart drops that whole hour's spend.
      const from = new Date(pool.periodStart)
      from.setUTCMinutes(0, 0, 0)
      const totals = await this.db.getProviderTokenTotals(ctx, from, now)
      // Pool counts rawTokens (real provider spend), not totalTokens (billing-multiplied).
      // model '' = whole-provider pool: sum every model under this provider.
      const used =
        pool.model === ''
          ? totals.filter((t) => t.providerId === pool.providerId).reduce((s, t) => s + t.rawTokens, 0)
          : (totals.find((t) => t.providerId === pool.providerId && t.model === pool.model)?.rawTokens ?? 0)

      const {
        pool: updated,
        crossed80,
        crossed100
      } = await this.db.updateProviderPoolState(ctx, pool.providerId, pool.model, used)

      if ((crossed80 || crossed100) && this.onPoolThreshold !== undefined) {
        const percent = crossed100 ? 100 : 80
        try {
          await this.onPoolThreshold(ctx, updated, percent)
          // Only now: an unmarked pool re-notifies next pass instead of losing the alert.
          await this.db.markPoolNotified(ctx, pool.providerId, pool.model, percent)
        } catch (err: any) {
          ctx.error('pool threshold notify failed', { provider: pool.providerId, err })
        }
      }
    }
  }

  async recheckWorkspaces (ctx: MeasureContext): Promise<void> {
    const now = Date.now()
    const account = getAccountClient(this.config.AccountsUrl, undefined)

    // We only need workspaces visited in last day or our update interval (whichever is larger)
    const workspaces = await account.listWorkspaces(
      undefined,
      undefined,
      Math.max(1, Math.round(this.config.UsageUpdateInterval / 86400))
    )

    ctx.info('rechecking workspaces', { count: workspaces.length })

    const limiter = new RateLimiter(10)
    for (const workspace of workspaces) {
      if (this.canceled) {
        throw new Error('Workspace recheck canceled')
      }

      if (isArchivingMode(workspace.mode) || isDeletingMode(workspace.mode)) {
        continue
      }

      const updateTime = workspace.usageInfo?.updateTime ?? 0
      if ((now - updateTime) / 1000 < this.config.UsageUpdateInterval) {
        continue
      }

      await limiter.add(async () => {
        await this.refreshWorkspace(ctx, now, workspace.uuid)
      })
    }
  }

  // Refresh usage + limit state for the given workspaces now (deduped, rate-limited). Picks up
  // brand-new workspaces on plan assignment, which the periodic loop skips until they are visited.
  async recomputeWorkspacesNow (
    ctx: MeasureContext,
    workspaces: WorkspaceUuid[],
    heartbeat?: () => Promise<void>
  ): Promise<void> {
    const now = Date.now()
    const limiter = new RateLimiter(10)
    for (const workspace of new Set(workspaces)) {
      await limiter.add(async () => {
        await this.refreshWorkspace(ctx, now, workspace)
        // Keep consumer membership alive: each workspace refresh is several account/storage round-trips.
        await heartbeat?.()
      })
    }
    await limiter.waitProcessing()
  }

  /** Refresh one workspace's usage statistics then reconcile its limit state (error-isolated). */
  private async refreshWorkspace (ctx: MeasureContext, now: number, workspace: WorkspaceUuid): Promise<void> {
    try {
      await ctx.with(
        'update workspace usage statistics',
        {},
        async (ctx) => {
          await this.updateWorkspaceUsageStatistics(ctx, now, workspace)
          await this.reconcileLimits?.(ctx, workspace)
        },
        { workspace }
      )
    } catch (err: any) {
      ctx.error('failed to update usage statistics for workspace', { workspace, err })
    }
  }

  private async resolveAiBotAccount (account: AccountClient): Promise<AccountUuid | undefined> {
    // Cache only a successful resolve; a miss (not found / transient error) is retried next tick.
    if (this.aiBotAccount != null) return this.aiBotAccount
    try {
      this.aiBotAccount = (await account.findPersonBySocialKey(aiBotSocialKey, true)) as AccountUuid | undefined
    } catch {
      /* retried next tick */
    }
    return this.aiBotAccount
  }

  async updateWorkspaceUsageStatistics (ctx: MeasureContext, now: number, workspace: WorkspaceUuid): Promise<void> {
    const account = getAccountClient(this.config.AccountsUrl, workspace)

    // Include non-active subscriptions: a past_due/readonly tier still defines the billing period
    // for usage accounting (grace period keeps the plan in effect).
    const subscriptions = await account.getSubscriptions(workspace, false)
    const subscription = subscriptions.find((p) => p.type === SubscriptionType.Tier && grantsPlan(p))

    const periodStart = getPeriodStartDate(subscription)
    const periodEnd = new Date(now)

    const liveKitUsage = await ctx.with(
      'get livekit usage',
      {},
      (ctx) => {
        return this.db.getLiveKitStats(ctx, workspace, periodStart, periodEnd)
      },
      { workspace }
    )
    const storageUsage = await ctx.with(
      'get storage usage',
      {},
      (ctx) => {
        return collectDatalakeStats(ctx, workspace, this.storageConfigs)
      },
      { workspace }
    )

    const participantMinutes = await ctx.with(
      'get participant minutes',
      {},
      (ctx) => {
        return this.db.getParticipantMinutes(ctx, workspace, periodStart, periodEnd)
      },
      { workspace }
    )
    const meetingMinutes = participantMinutes.totalMinutes
    const recordingSeconds = liveKitUsage.egress.reduce((acc, egress) => acc + egress.minutes, 0) * 60
    const storageBytes = storageUsage.size

    // Seat count is derived from account ws_members only: a person is there only after real login,
    // so the count matches occupied seats without touching the transactor (aiBot excluded by uuid).
    const aiBotAccount = await this.resolveAiBotAccount(account)
    const membersCount = await ctx.with(
      'get workspace members',
      {},
      async () => {
        try {
          const members = await account.getWorkspaceMembers()
          return members.filter((m) => memberOccupiesSeat(m.person, m.role, aiBotAccount)).length
        } catch (err: any) {
          ctx.error('failed to get workspace members', { workspace, err })
          return 0
        }
      },
      { workspace }
    )

    const usage: UsageStatus = {
      usage: {
        meetingMinutes,
        recordingSeconds,
        storageBytes,
        transcript:
          (await this.db.getAiTranscriptStats(ctx, workspace, periodStart, periodEnd))?.totalDurationSeconds ?? 0,
        tokens: ((await this.db.getAiTokensStats(ctx, workspace, periodStart, periodEnd)) ?? [])
          .map((it) => it.totalTokens)
          .reduce((a, b) => a + b, 0),
        membersCount
      },
      startTime: periodStart.getTime(),
      updateTime: periodEnd.getTime()
    }

    await account.updateUsageInfo(usage)
  }
}

function getPeriodStartDate (subscription: Subscription | undefined): Date {
  if (subscription?.periodStart !== undefined) {
    return new Date(subscription.periodStart)
  }

  // For users without subscription, use past 30 days (start of day)
  const date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  date.setHours(0, 0, 0, 0)
  return date
}

function getAccountClient (accountsUrl: string, workspace: WorkspaceUuid | undefined): AccountClient {
  const token = generateToken(systemAccountUuid, workspace, { service: 'billing' })
  return getClient(accountsUrl, token)
}

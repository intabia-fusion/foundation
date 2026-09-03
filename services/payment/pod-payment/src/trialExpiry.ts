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

import { type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import {
  SubscriptionStatus,
  type AccountClient,
  type Subscription,
  type SubscriptionData,
  type SubscriptionUpsert
} from '@hcengineering/account-client'
import { hasGrantingTier } from './utils'

const TRIAL_EXPIRED = 'TRIAL_EXPIRED'

/** Subscriptions written per bulk call. */
const BATCH_SIZE = 100

/** Assembles the free-tier payload for a workspace; undefined when no free plan is configured. */
export type FreeSubscriptionBuilder = (workspace: WorkspaceUuid) => SubscriptionUpsert | undefined

/** Ledger hook, mirrors the one createServer takes. Best-effort — never fails the sweep. */
export type OperationLogger = (ctx: MeasureContext, sub: SubscriptionData, canceled: boolean) => Promise<void>

/**
 * Sweep expired trials: retire the trial record and move the workspace to the free plan.
 */
export async function expireTrials (
  ctx: MeasureContext,
  accountClient: AccountClient,
  buildFreeSubscription: FreeSubscriptionBuilder | undefined,
  logOperation?: OperationLogger
): Promise<void> {
  const now = Date.now()

  const trials = await accountClient.getSubscriptionsByProvider('trial', [SubscriptionStatus.Trialing], now)

  let expired = 0
  for (let i = 0; i < trials.length; i += BATCH_SIZE) {
    expired += await expireBatch(
      ctx,
      accountClient,
      buildFreeSubscription,
      logOperation,
      trials.slice(i, i + BATCH_SIZE),
      now
    )
  }

  if (expired > 0) {
    ctx.info('expired trials swept', { expired, candidates: trials.length })
  }
}

/** Returns how many trials of this batch were retired. */
async function expireBatch (
  ctx: MeasureContext,
  accountClient: AccountClient,
  buildFreeSubscription: FreeSubscriptionBuilder | undefined,
  logOperation: OperationLogger | undefined,
  batch: Subscription[],
  now: number
): Promise<number> {
  const writes: SubscriptionUpsert[] = []

  for (const sub of batch) {
    // trialEnd is filtered server-side; re-check so a stale/loose server contract cannot expire a live trial.
    if (sub.trialEnd == null || sub.trialEnd > now) continue

    try {
      // Re-read: the user may have bought a paid tier or a second pod may have already swept this one.
      const fresh = await accountClient.getSubscriptions(sub.workspaceUuid, false)
      if (hasGrantingTier(fresh)) continue
    } catch (err: any) {
      ctx.error('failed to check trial workspace', { workspace: sub.workspaceUuid, err })
      continue
    }

    const cancel: SubscriptionUpsert = {
      ...sub,
      status: SubscriptionStatus.Canceled,
      canceledAt: now,
      providerData: { ...sub.providerData, status: TRIAL_EXPIRED, modifiedAt: now }
    }
    writes.push(cancel)

    // No accountUuid passed: account service will put the workspace owner uuid.
    const free = buildFreeSubscription?.(sub.workspaceUuid)
    if (free !== undefined) {
      writes.push(free)
    }
  }

  if (writes.length === 0) return 0

  const results = await accountClient.upsertSubscriptionsBulk(writes)
  // Results come back flat, so map each one back to what it was meant to write.
  const byId = new Map(writes.map((w) => [w.id, w]))

  let expired = 0
  for (const result of results) {
    const write = byId.get(result.id)
    if (write === undefined) continue

    // The cancel is a copy of the trial, so it still carries the trial's plan and trialEnd.
    const isCancel = write.provider === 'trial'
    if (!result.ok) {
      ctx.error(isCancel ? 'failed to expire trial' : 'failed to move expired trial to free plan', {
        workspace: write.workspaceUuid,
        error: result.error
      })
      continue
    }

    await logOperation?.(ctx, write as SubscriptionData, isCancel)

    if (isCancel) {
      ctx.info('trial expired', { workspace: write.workspaceUuid, plan: write.plan, trialEnd: write.trialEnd })
      expired++
    } else {
      ctx.info('free subscription created for workspace', { workspace: write.workspaceUuid, plan: write.plan })
    }
  }

  return expired
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** Milliseconds until the next occurrence of hourUtc:00. Never 0, so a sweep at the hour mark waits a full day. */
export function msUntilHour (hourUtc: number, from: number = Date.now()): number {
  const next = new Date(from)
  next.setUTCHours(hourUtc, 0, 0, 0)
  let delay = next.getTime() - from
  if (delay <= 0) delay += DAY
  return delay
}

/**
 * Run {@link expireTrials} once a day at `hourUtc`, or every `intervalMinutes` when that override is
 * set (dev stands). Returns the stop function.
 *
 * This is deliberately not part of the provider reconciliation loop: a trial belongs to no payment
 * provider (`provider: 'trial'`), there is nothing external to diff against, and for tbank that loop
 * is a no-op (pod-tbank-subscriptions owns it).
 */
export function startTrialExpiry (
  ctx: MeasureContext,
  accountClient: AccountClient,
  buildFreeSubscription: FreeSubscriptionBuilder | undefined,
  schedule: { hourUtc: number, intervalMinutes?: number },
  logOperation?: OperationLogger
): () => void {
  const run = (): void => {
    void expireTrials(ctx, accountClient, buildFreeSubscription, logOperation).catch((err: any) => {
      ctx.error('trial expiry sweep failed', { err })
    })
  }

  const freePlanConfigured = buildFreeSubscription !== undefined
  const { hourUtc, intervalMinutes } = schedule

  if (intervalMinutes !== undefined) {
    const timer = setInterval(run, intervalMinutes * 60 * 1000)
    ctx.info('Trial expiry sweep started (interval override)', { intervalMinutes, freePlanConfigured })
    return () => {
      clearInterval(timer)
    }
  }

  // setInterval alone would drift off the wall clock on restart, so re-arm from the current time
  // after every run.
  let timer: NodeJS.Timeout
  const arm = (): void => {
    timer = setTimeout(() => {
      run()
      arm()
    }, msUntilHour(hourUtc))
  }
  arm()
  ctx.info('Trial expiry sweep scheduled', {
    hourUtc,
    nextInMinutes: Math.round(msUntilHour(hourUtc) / 60000),
    freePlanConfigured
  })

  return () => {
    clearTimeout(timer)
  }
}

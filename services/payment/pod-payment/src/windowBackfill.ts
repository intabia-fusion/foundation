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

import { type MeasureContext } from '@hcengineering/core'
import {
  SubscriptionStatus,
  SubscriptionType,
  type AccountClient,
  type Subscription,
  type SubscriptionData,
  type SubscriptionUpsert
} from '@hcengineering/account-client'

/** Subscriptions written per bulk call. */
const BATCH_SIZE = 100

/** Limits for a subscription as the plan config defines them today. */
export type LimitsResolver = (sub: Subscription) => SubscriptionData['limits'] | undefined

/**
 * Subscriptions written before `windowMonthLimit` was baked in carry no AI window, so the pod falls
 * back to its env default - usually far off the plan. Recompute it from the plan config for every
 * subscription that is missing one, and for those left at 0 by a plan config that had no
 * `windowMonthLimit`.
 */
export async function backfillWindowLimits (
  ctx: MeasureContext,
  accountClient: AccountClient,
  resolveLimits: LimitsResolver
): Promise<number> {
  const subs = await accountClient.getSubscriptionsByProvider(undefined, [
    SubscriptionStatus.Active,
    SubscriptionStatus.PastDue,
    SubscriptionStatus.Trialing
  ])

  ctx.info('AI window backfill started', { candidates: subs.length })

  const writes: SubscriptionUpsert[] = []
  // Skip reasons per plan - they explain the gap between `candidates` and `toUpdate` in the logs.
  // skippedNoWindow covers both an unknown plan and a resolver that declined to compute a window.
  const skippedSet = new Map<string, number>()
  const skippedNoWindow = new Map<string, number>()
  let skippedNotTier = 0
  for (const sub of subs) {
    // The AI window lives on the tier only.
    if (sub.type !== SubscriptionType.Tier) {
      skippedNotTier++
      continue
    }
    const limits = resolveLimits(sub)
    if (limits?.windowMonthLimit == null) {
      skippedNoWindow.set(sub.plan, (skippedNoWindow.get(sub.plan) ?? 0) + 1)
      continue
    }
    // A window that is already set stays as it is.
    // Exception: a window = 0 on a plan that grants a finite window - it was set as 0 by misconfiguration.
    const stored = sub.limits?.windowMonthLimit
    if (stored != null && !(stored === 0 && limits.windowMonthLimit > 0)) {
      skippedSet.set(sub.plan, (skippedSet.get(sub.plan) ?? 0) + 1)
      continue
    }
    ctx.info('AI window backfill: will set', {
      workspace: sub.workspaceUuid,
      plan: sub.plan,
      status: sub.status,
      quantity: sub.providerData?.quantity,
      from: stored,
      to: limits.windowMonthLimit
    })
    // Only the AI token window is rewritten.
    writes.push({
      ...sub,
      limits: { ...sub.limits, windowMonthLimit: limits.windowMonthLimit }
    } as unknown as SubscriptionUpsert)
  }

  ctx.info('AI window backfill plan', {
    candidates: subs.length,
    toUpdate: writes.length,
    skippedNotTier,
    skippedAlreadySet: Object.fromEntries(skippedSet),
    skippedNoWindowFromPlan: Object.fromEntries(skippedNoWindow)
  })

  if (writes.length === 0) {
    ctx.info('AI window backfill: nothing to do', { checked: subs.length })
    return 0
  }

  let updated = 0
  let failed = 0
  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const batch = writes.slice(i, i + BATCH_SIZE)
    const results = await accountClient.upsertSubscriptionsBulk(batch)
    const byId = new Map(batch.map((w) => [w.id, w]))
    for (const result of results) {
      const write = byId.get(result.id)
      if (!result.ok) {
        failed++
        ctx.error('AI window backfill failed for subscription', {
          id: result.id,
          workspace: write?.workspaceUuid,
          plan: write?.plan,
          error: result.error
        })
        continue
      }
      updated++
    }
  }

  ctx.info('AI window backfill done', { checked: subs.length, updated, failed })
  return updated
}

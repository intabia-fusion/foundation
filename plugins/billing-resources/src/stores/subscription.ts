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

import { writable, derived, get } from 'svelte/store'
import { type SubscriptionData, SubscriptionStatus } from '@hcengineering/account-client'
import { type PlanItem, type PackageItem } from '@hcengineering/billing'
import { type UsageStatus, type WorkspaceInfoWithStatus } from '@hcengineering/core'
import { checkUsageAgainstLimits, calculateLimits } from '../utils'

export interface SubscriptionState {
  currentSubscription: SubscriptionData | undefined
  currentPlan: PlanItem | undefined
  // Storage package subscription (grants extra disk).
  currentPackageSubscription: SubscriptionData | undefined
  currentPackage: PackageItem | undefined
  // AI token package subscription (adds billed-token window budget).
  currentAiPackageSubscription: SubscriptionData | undefined
  currentAiPackage: PackageItem | undefined
  workspaceInfo: WorkspaceInfoWithStatus | undefined
  usageInfo: UsageStatus | undefined
  limitExceeded: boolean
  onFreePlan: boolean // on free limits (own free plan, or paid tier no longer granting)
  freePlanOverdue: boolean // on free BECAUSE payment lapsed (readonly/expired) -> show "overdue" hint
  isLimited: boolean // this user is seatless -> read-only
  onTrial: boolean // on a running trial (Trialing tier, trialEnd in the future)
  trialDaysLeft: number // whole days remaining on the trial (0 if not on trial)
}

const initialState: SubscriptionState = {
  currentSubscription: undefined,
  currentPlan: undefined,
  currentPackageSubscription: undefined,
  currentPackage: undefined,
  currentAiPackageSubscription: undefined,
  currentAiPackage: undefined,
  workspaceInfo: undefined,
  usageInfo: undefined,
  limitExceeded: false,
  onFreePlan: false,
  freePlanOverdue: false,
  isLimited: false,
  onTrial: false,
  trialDaysLeft: 0
}

// Main subscription store
export const subscriptionStore = writable<SubscriptionState>(initialState)

export const limitExceeded = derived(subscriptionStore, ($store) => $store.limitExceeded)
export const onFreePlan = derived(subscriptionStore, ($store) => $store.onFreePlan)
export const freePlanOverdue = derived(subscriptionStore, ($store) => $store.freePlanOverdue)
export const isLimited = derived(subscriptionStore, ($store) => $store.isLimited)
export const onTrial = derived(subscriptionStore, ($store) => $store.onTrial)
export const trialDaysLeft = derived(subscriptionStore, ($store) => $store.trialDaysLeft)

/** Resolved numeric limits (0 = unlimited) for the active plan/package, reactive on subscription changes. */
export const planLimits = derived(subscriptionStore, ($s) =>
  calculateLimits($s.currentPlan, $s.currentPackage, $s.currentSubscription, $s.currentPackageSubscription)
)

// Active members counted on server side.
export const seatCount = derived(subscriptionStore, ($s) => $s.usageInfo?.usage.membersCount)

// True when the plan's user limit is reached (0 = unlimited). undefined seats block until known.
export const seatLimitReached = derived([seatCount, planLimits], ([$seats, $limits]) => {
  const limit = $limits?.usersLimit ?? 0
  return limit > 0 && ($seats === undefined || $seats >= limit)
})

export function updateLimitExceeded (limit: boolean): void {
  subscriptionStore.update((store) => ({
    ...store,
    limitExceeded: limit
  }))
}

export function setSubscriptionState (
  subscription: SubscriptionData | undefined,
  plan: PlanItem | undefined,
  workspaceInfo?: WorkspaceInfoWithStatus | undefined,
  packageSubscription?: SubscriptionData | undefined,
  pkg?: PackageItem | undefined,
  // The current (latest) tier subscription regardless of status — used to decide payment/free state.
  // A granting `subscription` may be undefined when the tier is canceled, but the banner still needs it.
  statusTier?: SubscriptionData | undefined,
  aiPackageSubscription?: SubscriptionData | undefined,
  aiPkg?: PackageItem | undefined
): void {
  const usage = workspaceInfo?.usageInfo ?? get(subscriptionStore).usageInfo
  const workspace = workspaceInfo ?? get(subscriptionStore).workspaceInfo
  const tierForStatus = statusTier ?? subscription
  // Free limits are activated:
  //  - when free plan is active (free plan chosen/provisioned after a cancel)
  //  - status = readonly/expired and a free fallback exists
  const now = Date.now()
  // Trial: Trialing tier with a trialEnd. Live while in the future; expired trials fall back to free
  // below (treated like an overdue paid tier), never shown as a live trial.
  const trialEnd = tierForStatus?.status === SubscriptionStatus.Trialing ? tierForStatus.trialEnd : undefined
  const onTrial = trialEnd != null && trialEnd > now
  const trialExpired = trialEnd != null && trialEnd <= now
  const trialDaysLeft = onTrial ? Math.max(0, Math.ceil((trialEnd - now) / (24 * 3600 * 1000))) : 0
  const activeOnFree = tierForStatus?.status === SubscriptionStatus.Active && plan?.free === true
  const overdueOnFree =
    tierForStatus?.status === SubscriptionStatus.ReadOnly ||
    tierForStatus?.status === SubscriptionStatus.Expired ||
    trialExpired
  const hasFree = tierForStatus?.freeLimits != null
  const onFreePlan = activeOnFree || (overdueOnFree && hasFree)
  // tooltip explains overdue as the reason for the free plan
  const freePlanOverdue = overdueOnFree && hasFree

  subscriptionStore.update((store) => ({
    ...store,
    currentSubscription: subscription,
    currentPlan: plan,
    currentPackageSubscription: packageSubscription,
    currentPackage: pkg,
    currentAiPackageSubscription: aiPackageSubscription,
    currentAiPackage: aiPkg,
    usageInfo: usage,
    workspaceInfo: workspace,
    limitExceeded: checkUsageAgainstLimits(usage, plan, pkg, subscription, packageSubscription),
    onFreePlan,
    freePlanOverdue,
    onTrial,
    trialDaysLeft
  }))
}

export function setIsLimited (limited: boolean): void {
  subscriptionStore.update((store) => ({ ...store, isLimited: limited }))
}

export function resetSubscriptionStore (): void {
  subscriptionStore.set(initialState)
}

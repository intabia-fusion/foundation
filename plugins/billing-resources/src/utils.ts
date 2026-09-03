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
import { get } from 'svelte/store'

import login from '@hcengineering/login'
import { getMetadata } from '@hcengineering/platform'
import presentation, { getClient } from '@hcengineering/presentation'
import billing from '@hcengineering/billing'
import contact from '@hcengineering/contact'
import { aiBotEmailSocialKey } from '@hcengineering/ai-bot'
import {
  getClient as getAccountClientRaw,
  type AccountClient,
  type SubscriptionData,
  SubscriptionType,
  grantsPlan,
  GUEST_ROLES
} from '@hcengineering/account-client'
import { getClient as getBillingClientRaw, type BillingClient } from '@hcengineering/billing-client'
import { getClient as getPaymentClientRaw, type PaymentClient } from '@hcengineering/payment-client'
import {
  type UsageStatus,
  type WorkspaceInfoWithStatus,
  type WorkspaceUuid,
  AccountRole,
  getCurrentAccount,
  hasAccountRole
} from '@hcengineering/core'
import { showPopup } from '@hcengineering/ui'
import { type PlanItem, type PackageItem, type PlanConfig, type LocalizedString } from '@hcengineering/billing'

import { setSubscriptionState, updateLimitExceeded, subscriptionStore, setIsLimited } from './stores/subscription'
import SubscriptionsModal from './components/SubscriptionsModal.svelte'

// Scope subscription reads to the active workspace: admin/service tokens return ALL workspaces'
// subscriptions when the uuid is omitted, so an admin would otherwise see other workspaces' plans.
function currentWorkspace (): WorkspaceUuid | undefined {
  return getMetadata(presentation.metadata.WorkspaceUuid)
}

export function getAccountClient (): AccountClient | null {
  const accountsUrl = getMetadata(login.metadata.AccountsUrl) ?? ''
  const token = getMetadata(presentation.metadata.Token) ?? ''
  if (accountsUrl === '' || token === '') {
    return null
  }

  return getAccountClientRaw(accountsUrl, token)
}

// Clients build absolute URLs internally - resolve relative config values against the origin
function absoluteUrl (url: string): string {
  return url.startsWith('/') ? window.location.origin + url : url
}

export function getBillingClient (): BillingClient | null {
  const billingUrl = getMetadata(billing.metadata.BillingURL) ?? ''
  const token = getMetadata(presentation.metadata.Token) ?? ''
  if (billingUrl === '' || token === '') {
    return null
  }
  return getBillingClientRaw(absoluteUrl(billingUrl), token)
}

export function getPaymentClient (): PaymentClient | null {
  const paymentUrl = getMetadata(presentation.metadata.PaymentUrl) ?? ''
  const token = getMetadata(presentation.metadata.Token) ?? ''
  if (paymentUrl === '' || token === '') {
    return null
  }

  return getPaymentClientRaw(absoluteUrl(paymentUrl), token)
}

let _planConfig: PlanConfig | null = null
let _planConfigAt = 0
const PLAN_CONFIG_TTL_MS = 5 * 60 * 1000 // refetch prices at most every 5 min

export function isPlanConfig (v: unknown): v is PlanConfig {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as PlanConfig).plans === 'object' &&
    (v as PlanConfig).plans !== null &&
    typeof (v as PlanConfig).packages === 'object' &&
    (v as PlanConfig).packages !== null
  )
}

async function getPlanConfig (): Promise<PlanConfig> {
  if (_planConfig == null || Date.now() - _planConfigAt > PLAN_CONFIG_TTL_MS) {
    const paymentUrl = getMetadata(presentation.metadata.PaymentUrl) ?? ''
    const res = await fetch(paymentUrl + '/api/v1/plan-config')
    if (!res.ok) {
      console.warn('Failed to load plan config:', res.status)
      return _planConfig ?? { plans: {}, packages: {} }
    }
    const parsed: unknown = await res.json()
    if (!isPlanConfig(parsed)) {
      console.warn('Plan config response has unexpected shape, ignoring')
      return _planConfig ?? { plans: {}, packages: {} }
    }
    _planConfig = parsed
    _planConfigAt = Date.now()
  }
  return _planConfig
}

export async function isLimitExceeded (): Promise<boolean> {
  try {
    const accountClient = getAccountClient()
    if (accountClient == null) return false

    const workspaceInfo = await accountClient.getWorkspaceInfo(false)
    const usageInfo = workspaceInfo?.usageInfo ?? null

    if (usageInfo === null) {
      return false
    }

    const subscriptions = await accountClient.getSubscriptions(currentWorkspace(), false)
    const subscription = subscriptions.find((p) => p.type === SubscriptionType.Tier && grantsPlan(p))
    const activePackages = subscriptions.filter((p) => p.type === SubscriptionType.Package && grantsPlan(p))
    if (subscription == null) {
      return true
    }

    const config = await getPlanConfig()
    const plan = config.plans[subscription.plan] ?? null
    if (plan == null) {
      return true
    }
    const packageSubscription = activePackages.find(
      (p) => (config.packages[p.plan]?.category ?? 'storage') === 'storage'
    )
    const pkg = packageSubscription != null ? (config.packages[packageSubscription.plan] ?? null) : null

    return checkUsageAgainstLimits(usageInfo, plan, pkg ?? undefined, subscription, packageSubscription)
  } catch (error) {
    console.error('Error checking usage limits:', error)
    return false
  }
}

export async function checkWorkspaceLimits (): Promise<void> {
  try {
    const accountClient = getAccountClient()
    if (accountClient == null) {
      updateLimitExceeded(false)
      return
    }

    const workspaceInfo = await accountClient.getWorkspaceInfo(false)
    const usageInfo = workspaceInfo?.usageInfo ?? null

    const subscriptions = await accountClient.getSubscriptions(currentWorkspace(), false)
    const subscription = subscriptions.find((p) => p.type === SubscriptionType.Tier && grantsPlan(p))
    const activePackages = subscriptions.filter((p) => p.type === SubscriptionType.Package && grantsPlan(p))
    // Latest tier regardless of status — drives the payment/free banner even when canceled (non-granting).
    const statusTier = subscriptions
      .filter((p) => p.type === SubscriptionType.Tier)
      .sort((a, b) => (b.createdOn ?? 0) - (a.createdOn ?? 0))[0]
    const config = await getPlanConfig()
    const plan = subscription != null ? (config.plans[subscription.plan] ?? null) : null
    const packageSubscription = activePackages.find(
      (p) => (config.packages[p.plan]?.category ?? 'storage') === 'storage'
    )
    const aiPackageSubscription = activePackages.find((p) => config.packages[p.plan]?.category === 'ai')
    const pkg = packageSubscription != null ? (config.packages[packageSubscription.plan] ?? null) : null
    const aiPkg = aiPackageSubscription != null ? (config.packages[aiPackageSubscription.plan] ?? null) : null

    // Update subscription store
    setSubscriptionState(
      subscription,
      plan ?? undefined,
      workspaceInfo,
      packageSubscription,
      pkg ?? undefined,
      statusTier,
      aiPackageSubscription,
      aiPkg ?? undefined
    )

    // Check limits
    if (usageInfo === null || subscription == null || plan == null) {
      updateLimitExceeded(subscription == null)
      return
    }

    const exceeded = checkUsageAgainstLimits(
      usageInfo,
      plan,
      pkg ?? undefined,
      subscription,
      packageSubscription ?? undefined
    )
    updateLimitExceeded(exceeded)
  } catch (error) {
    console.error('Error checking workspace limits:', error)
    updateLimitExceeded(false)
  }
}

// Limits come ONLY from real data: the subscription's baked limits or the loaded plan-config. No
// fabricated fallbacks — if neither is present (no billing access / not loaded) return null so callers
// show/enforce nothing rather than wrong numbers.
export function calculateLimits (
  plan?: PlanItem,
  pkg?: PackageItem,
  tierSub?: SubscriptionData,
  pkgSub?: SubscriptionData
):
  | {
    storageLimit: number
    trafficLimit: number
    meetingMinutesLimit: number
    tokenLimit: number
    usersLimit: number
  }
  | undefined {
  if (tierSub?.limits == null && plan == null) return undefined

  const baseStorage = tierSub?.limits?.storageLimitGB ?? plan?.storageLimitGB ?? 0
  const pkgStorage = pkgSub?.limits?.storageLimitGB ?? pkg?.storageLimitGB ?? 0

  return {
    storageLimit: baseStorage * 1e9 + pkgStorage * 1e9,
    trafficLimit: (tierSub?.limits?.trafficLimitGB ?? plan?.trafficLimitGB ?? 0) * 1e9,
    meetingMinutesLimit: tierSub?.limits?.meetingMinutesLimit ?? plan?.meetingMinutesLimit ?? 0,
    tokenLimit: (tierSub?.limits?.tokenLimit ?? plan?.tokenLimit ?? 0) * 1000,
    usersLimit: tierSub?.limits?.usersLimit ?? plan?.usersLimit ?? 0
  }
}

export function checkUsageAgainstLimits (
  usageInfo: UsageStatus | undefined,
  plan: PlanItem | undefined,
  pkg?: PackageItem,
  tierSub?: SubscriptionData,
  pkgSub?: SubscriptionData
): boolean {
  if (usageInfo == null) return false
  const limits = calculateLimits(plan, pkg, tierSub, pkgSub)
  if (limits == null) return false // no real limits -> don't flag anything

  const storageUsedBytes = usageInfo.usage.storageBytes ?? 0
  const meetingMinutes = usageInfo.usage.meetingMinutes ?? 0
  const membersCount = usageInfo.usage.membersCount ?? 0

  const { storageLimit, meetingMinutesLimit, usersLimit } = limits
  const usersExceeded = usersLimit > 0 && membersCount > usersLimit

  return storageUsedBytes > storageLimit || meetingMinutes > meetingMinutesLimit || usersExceeded
}

export function resolveLocale (config: PlanConfig, lang: string): PlanConfig {
  const resolve = (s: LocalizedString | undefined): string => {
    if (s == null) return ''
    if (typeof s === 'string') return s
    return s[lang] ?? s.en ?? Object.values(s)[0] ?? ''
  }

  return {
    plans: Object.fromEntries(
      Object.entries(config.plans).map(([k, t]) => [
        k,
        {
          ...t,
          label: resolve(t.label),
          description: resolve(t.description),
          priceMonthlyText: t.priceMonthlyText != null ? resolve(t.priceMonthlyText) : undefined,
          limits: (t.limits ?? []).map((f) => resolve(f)),
          features: (t.features ?? []).map((f) => resolve(f))
        }
      ])
    ),
    packages: Object.fromEntries(
      Object.entries(config.packages).map(([k, p]) => [
        k,
        {
          ...p,
          description: resolve(p.description)
        }
      ])
    ),
    purchasables:
      config.purchasables != null
        ? Object.fromEntries(
          Object.entries(config.purchasables).map(([k, p]) => [k, { ...p, description: resolve(p.description) }])
        )
        : undefined
  }
}

export async function getCurrentSubscription (accountClient: AccountClient): Promise<SubscriptionData | undefined> {
  const subscriptions = await accountClient.getSubscriptions(currentWorkspace())
  return subscriptions.find((p) => p.type === SubscriptionType.Tier)
}

export async function getWorkspaceInfo (): Promise<WorkspaceInfoWithStatus | undefined> {
  const accountClient = getAccountClient()
  if (accountClient == null) return undefined
  return await accountClient.getWorkspaceInfo(false)
}

function rolePriority (role: AccountRole | undefined): number {
  if (role === AccountRole.Owner) return 0
  if (role === AccountRole.Maintainer) return 1
  return 2
}

export async function checkIsLimited (): Promise<void> {
  try {
    const accountClient = getAccountClient()
    const currentAccount = getCurrentAccount()
    if (accountClient == null || currentAccount == null) {
      setIsLimited(false)
      return
    }
    if (currentAccount.role === AccountRole.Admin || GUEST_ROLES.includes(currentAccount.role)) {
      setIsLimited(false)
      return
    }

    const { currentSubscription, currentPlan, currentPackage, currentPackageSubscription, usageInfo } =
      get(subscriptionStore)
    const limits = calculateLimits(currentPlan, currentPackage, currentSubscription, currentPackageSubscription)
    // No real limits (no billing data) -> never enforce read-only.
    if (limits == null) {
      setIsLimited(false)
      return
    }
    const { usersLimit } = limits
    const membersCount = usageInfo?.usage.membersCount ?? 0
    if (usersLimit === 0 || membersCount <= usersLimit) {
      setIsLimited(false)
      return
    }

    // Mirrors server SeatLimitsMiddleware: seats by role priority (Owner, Maintainer, then Users)
    // and employee createdOn; Admin/aibot never occupy a seat.
    const members = await accountClient.getWorkspaceMembers()
    const roleByPerson = new Map(members.map((m) => [m.person as string, m.role]))
    const client = getClient()
    const employees = await client.findAll(contact.mixin.Employee, { active: true })
    const aiIdentity = await client.findOne(contact.class.SocialIdentity, { key: aiBotEmailSocialKey })

    const sorted = [...employees].sort((a, b) => {
      const pa = rolePriority(a.personUuid == null ? undefined : roleByPerson.get(a.personUuid))
      const pb = rolePriority(b.personUuid == null ? undefined : roleByPerson.get(b.personUuid))
      if (pa !== pb) return pa - pb
      return (a.createdOn ?? 0) - (b.createdOn ?? 0)
    })

    let seats = 0
    let seated = false
    for (const emp of sorted) {
      if (seats >= usersLimit) break
      const uuid = emp.personUuid
      if (uuid == null) continue
      if (aiIdentity !== undefined && emp._id === aiIdentity.attachedTo) continue
      const role = roleByPerson.get(uuid)
      if (role === undefined || role === AccountRole.Admin || GUEST_ROLES.includes(role)) continue
      seats++
      if (uuid === currentAccount.uuid) {
        seated = true
        break
      }
    }
    setIsLimited(!seated)
  } catch (err) {
    console.error('checkIsLimited failed:', err)
    setIsLimited(false)
  }
}

export async function upgradePlan (): Promise<void> {
  try {
    const currentAccount = getCurrentAccount()
    if (currentAccount == null) {
      return
    }

    const workspaceInfo = get(subscriptionStore).workspaceInfo ?? (await getWorkspaceInfo())

    const isBillingAccount =
      workspaceInfo?.billingAccount != null
        ? workspaceInfo?.billingAccount === currentAccount.uuid
        : hasAccountRole(currentAccount, AccountRole.Owner)

    showPopup(SubscriptionsModal, { isReadOnly: !isBillingAccount })
  } catch (error) {
    console.error('Failed to show upgrade plan modal:', error)
  }
}

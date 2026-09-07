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

import type { MeasureContext } from '@hcengineering/core'
import type { SubscriptionData } from '@hcengineering/account-client'
import {
  type BillingMailContext,
  type ChargeKind,
  type ExpiredKind,
  type Lang,
  type MailSender,
  type PaymentFailedReason,
  type PaymentSucceededKind,
  type UpcomingKind,
  DEFAULT_LANG,
  DEFAULT_CURRENCY,
  notifyExpired as sharedNotifyExpired,
  notifyPaymentFailed as sharedNotifyPaymentFailed,
  notifyPaymentSucceeded as sharedNotifyPaymentSucceeded,
  notifyReceiptBlocked as sharedNotifyReceiptBlocked,
  notifyUpcoming as sharedNotifyUpcoming,
  buildChargeDescription as sharedBuildChargeDescription,
  resolveLang
} from '@hcengineering/billing-mail'

import type { Config } from './config'
import type { SubscriptionStorage } from './storage'
import { fetchPlanConfig, type PlanConfigLike } from './utils'

export { resolveLang }

const PLAN_LABEL_TIMEOUT_MS = 10_000
const PLAN_CONFIG_TTL_MS = 10 * 60 * 1000 // plan config is static; refresh every 10 min
let planConfigCache: { data: PlanConfigLike, fetchedAt: number } | null = null

/**
 * Get plan/package label from plan-config. Falls back to the raw plan id.
 * This pod fetches over HTTP; pod-payment holds the same config in memory and injects its own
 * resolver — hence the indirection in BillingMailContext.
 */
async function loadPlanConfig (config: Config): Promise<PlanConfigLike | null> {
  if (config.PaymentUrl === undefined) return null
  const now = Date.now()
  if (planConfigCache === null || now - planConfigCache.fetchedAt > PLAN_CONFIG_TTL_MS) {
    // Single best-effort attempt (no retry loop) — a slow/unreachable pod-payment must not block the email.
    const data = await fetchPlanConfig(config.PaymentUrl, { attempts: 1, timeoutMs: PLAN_LABEL_TIMEOUT_MS })
    planConfigCache = { data, fetchedAt: now }
  }
  return planConfigCache.data
}

async function getPlanLabel (config: Config, plan: string, type: string, lang: Lang): Promise<string> {
  try {
    const data = await loadPlanConfig(config)
    // Display name per type: `label` for plans; packages and one-time purchases carry `description`.
    const name =
      type === 'package'
        ? data?.packages?.[plan]?.description
        : type === 'purchase'
          ? data?.purchasables?.[plan]?.description
          : data?.plans?.[plan]?.label
    return name?.[lang] ?? name?.[DEFAULT_LANG] ?? plan
  } catch {
    return plan
  }
}

/** Display currency of the plan/package, mirroring `currencyOf` in @hcengineering/billing. */
async function getPlanCurrency (config: Config, plan: string, type: string): Promise<string> {
  try {
    const data = await loadPlanConfig(config)
    const item =
      type === 'package'
        ? data?.packages?.[plan]
        : type === 'purchase'
          ? data?.purchasables?.[plan]
          : data?.plans?.[plan]
    const currency = item?.currency
    return currency != null && currency !== '' ? currency : DEFAULT_CURRENCY
  } catch {
    return DEFAULT_CURRENCY
  }
}

/** Set once at startup: publishes to the platform notification queue. Undefined disables all mail. */
let sender: MailSender | undefined

/** Wire the queue-backed sender. Called from main() after the producer exists. */
export function setMailSender (send: MailSender | undefined): void {
  sender = send
}

/** Adapt this pod's Config + SubscriptionStorage to what the shared mail package expects. */
function mailContext (storage: SubscriptionStorage, config: Config): BillingMailContext {
  return {
    storage,
    send: sender,
    planLabel: async (plan, type, lang) => await getPlanLabel(config, plan, type, lang),
    planCurrency: async (plan, type) => await getPlanCurrency(config, plan, type),
    frontUrl: config.FrontUrl,
    supportEmail: config.SupportEmail,
    supportUrl: config.SupportUrl,
    billingEmails: config.BillingEmails
  }
}

export async function notifyPaymentFailed (
  ctx: MeasureContext,
  storage: SubscriptionStorage,
  config: Config,
  sub: SubscriptionData,
  reason: PaymentFailedReason
): Promise<void> {
  await sharedNotifyPaymentFailed(ctx, mailContext(storage, config), sub, reason)
}

export async function notifyPaymentSucceeded (
  ctx: MeasureContext,
  storage: SubscriptionStorage,
  config: Config,
  sub: SubscriptionData,
  kind: PaymentSucceededKind,
  chargedAmount?: number
): Promise<void> {
  await sharedNotifyPaymentSucceeded(ctx, mailContext(storage, config), sub, kind, chargedAmount)
}

export async function notifyUpcoming (
  ctx: MeasureContext,
  storage: SubscriptionStorage,
  config: Config,
  sub: SubscriptionData,
  kind: UpcomingKind,
  dueAt: number
): Promise<void> {
  await sharedNotifyUpcoming(ctx, mailContext(storage, config), sub, kind, dueAt)
}

export async function notifyExpired (
  ctx: MeasureContext,
  storage: SubscriptionStorage,
  config: Config,
  sub: SubscriptionData,
  kind: ExpiredKind,
  endedAt: number
): Promise<void> {
  await sharedNotifyExpired(ctx, mailContext(storage, config), sub, kind, endedAt)
}

export async function notifyReceiptBlocked (ctx: MeasureContext, config: Config, sub: SubscriptionData): Promise<void> {
  // Service-only mail: no storage lookups, so the storage side of the context is never touched.
  await sharedNotifyReceiptBlocked(ctx, mailContext(undefined as unknown as SubscriptionStorage, config), sub)
}

export async function buildChargeDescription (
  config: Config,
  plan: string,
  type: string,
  kind: ChargeKind,
  locale: string | null
): Promise<string> {
  return await sharedBuildChargeDescription(
    mailContext(undefined as unknown as SubscriptionStorage, config),
    plan,
    type,
    kind,
    locale
  )
}

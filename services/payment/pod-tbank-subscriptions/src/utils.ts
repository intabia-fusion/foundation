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

import { randomBytes } from 'crypto'
import { type WorkspaceUuid } from '@hcengineering/core'
import {
  type Subscription,
  type SubscriptionData,
  SubscriptionStatus,
  makePlanKey
} from '@hcengineering/account-client'
import TbankPayments, { TBANK_SUCCESS_STATES, TBANK_FAILED_STATES } from './tbank'
import { type BillingPeriod } from './types'

/**
 * Add whole months to a UTC timestamp. Periods land on the same day each month/year.
 * Also: Jan-31 renews on Feb-28/29, Mar-31, ...
 * UTC throughout so the renewal moment is independent of the running pod's timezone.
 *
 * Notice: the anchor day is the UTC day. For payments near midnight UTC the UTC day differs
 * from the merchant's local day (e.g. Mar-1 00:30 MSK is Feb-28 21:30 UTC -> anchor 28, not 1).
 * Only for the ~21:00-24:00 UTC window.
 * If billing must follow a merchant timezone, compute anchorDay in that zone instead (add timezone to config).
 */
export function addMonths (fromMs: number, months: number): number {
  const d = new Date(fromMs)
  const anchorDay = d.getUTCDate()
  // Move to the 1st day so the month shift can't overflow (e.g. Jan-31 + 1 -> Mar-03).
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const daysInTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(anchorDay, daysInTargetMonth))
  return d.getTime()
}

/**
 * Next period end for a billing period: +1 calendar month (monthly) or +12 months / 1 year (yearly).
 */
export function nextPeriodEnd (fromMs: number, period?: BillingPeriod): number {
  return addMonths(fromMs, period === 'yearly' ? 12 : 1)
}

/**
 * Format a timestamp as a TBank RedirectDueDate: ISO 8601 with an explicit offset
 * (yyyy-MM-ddTHH:mm:ss+00:00). We emit UTC, so the offset is always +00:00.
 */
export function formatTbankDueDate (ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

export function verifyWebhookToken (
  tbank: TbankPayments,
  notification: Record<string, any>,
  token: string,
  rawBody?: string
): boolean {
  // Some TBank SDK versions verify signature against raw JSON string
  // Pass rawBody if the SDK supports it, otherwise fall back to notification object
  if (rawBody !== undefined && typeof (tbank as any).verifyNotificationSignatureRaw === 'function') {
    return (tbank as any).verifyNotificationSignatureRaw(rawBody, token)
  }
  return tbank.verifyNotificationSignature(notification, token)
}

export function getPlanKey (type: string, plan: string): string {
  return makePlanKey(plan, type)
}

/**
 * Fingerprint of the exact order (plan:seats:period): same fingerprint = same payable link (reuse),
 * different = another plan (no reuse). Normalized so undefined seats/period equal the defaults.
 */
export function orderFingerprint (plan: string, seats: number, period?: BillingPeriod): string {
  return `${plan}:${seats}:${period ?? 'monthly'}`
}

/**
 * Simple hash function to shorten workspaceUuid into a fixed-length string.
 * Not cryptographically secure — used only for generating short unique order IDs.
 */
function hashWorkspace (uuid: string): string {
  let hash = 0
  for (let i = 0; i < uuid.length; i++) {
    const char = uuid.charCodeAt(i)
    hash = (hash << 5) - hash + char
    // Convert to 32bit integer
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

/** Correlation id for one user/system intent: every ledger row it causes shares it. */
export function newActionId (): string {
  return `act-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

export function buildOrderId (workspaceUuid: WorkspaceUuid, transactionCount: number): string {
  const ws = hashWorkspace(workspaceUuid)
  const ts = Date.now().toString(36)
  // transactionCount is already monotonic per workspace; crypto random removes any residual collision risk.
  const rnd = randomBytes(4).toString('hex')
  return `${ws}-${transactionCount}-${ts}-${rnd}`
}

/**
 * PastDue carries two distinct meanings, disambiguated by providerData.pending.
 * These predicates centralize that invariant so callers don't re-check `pending` ad hoc.
 *
 * isPendingFirstPayment: PastDue + pending:true — a first-payment draft (checkout started,
 *   not yet confirmed; created by buildSubscriptionData before payment). No rebillId, no real
 *   period. Cleaned up as abandoned after 24h.
 * isFailedRenewal: PastDue + pending:false — a real recurrent charge failure on a previously
 *   active subscription. Has rebillId; enters the grace period (access still granted).
 */
export function isPendingFirstPayment (sub: Subscription | SubscriptionData): boolean {
  return sub.status === SubscriptionStatus.PastDue && sub.providerData?.pending === true
}

export function isFailedRenewal (sub: Subscription | SubscriptionData): boolean {
  return sub.status === SubscriptionStatus.PastDue && sub.providerData?.pending !== true
}

export interface PlanPricing {
  // Charge amount in the currency's minor units. Tier: per-seat monthly price; package: flat monthly price.
  amount: number
  // Yearly discount in percent
  yearlyDiscount: number
}

// Minimal subset of pod-payment's plan-config we need to derive charge amounts. Prices are numeric
// major units (tier: per-user; package: flat). Free / contact-sales plans have no price and are skipped.
// Display name: plans carry a localized `label`; packages have no `label`, only a `description`.
export interface PlanConfigLike {
  plans?: Record<string, { priceMonthlyPerUser?: number, yearlyDiscount?: number, label?: Record<string, string> }>
  packages?: Record<string, { priceMonthly?: number, description?: Record<string, string> }>
  // One-time catalog purchases: flat-priced, charged once (no renewal).
  purchasables?: Record<string, { priceMonthly?: number, description?: Record<string, string> }>
}

// TBank Amount is expressed in the currency's minor units; prices in plan-config are whole major units.
const TBANK_CURRENCY_MULTIPLIER = 100

// Major currency units -> minor units, rounded down so the charge never exceeds the advertised price.
function toMinorUnits (majorUnits: number): number {
  return Math.floor(majorUnits * TBANK_CURRENCY_MULTIPLIER)
}

// Clamp a percent discount to [0, 100] so an out-of-range or non-finite config value can't invert or inflate the charge.
function clampDiscount (value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
}

// Build the pricing table keyed by `plan@type` from the shared plan-config. Priced tier/package
// entries only; free / contact-sales plans (no numeric price) are skipped.
export function buildPricingFromPlanConfig (planConfig: PlanConfigLike): Record<string, PlanPricing> {
  const plans: Record<string, PlanPricing> = {}
  for (const [plan, item] of Object.entries(planConfig.plans ?? {})) {
    if (typeof item.priceMonthlyPerUser !== 'number' || item.priceMonthlyPerUser <= 0) continue
    plans[getPlanKey('tier', plan)] = {
      amount: toMinorUnits(item.priceMonthlyPerUser),
      yearlyDiscount: clampDiscount(item.yearlyDiscount)
    }
  }
  for (const [pkg, item] of Object.entries(planConfig.packages ?? {})) {
    if (typeof item.priceMonthly !== 'number' || item.priceMonthly <= 0) continue
    plans[getPlanKey('package', pkg)] = { amount: toMinorUnits(item.priceMonthly), yearlyDiscount: 0 }
  }
  // Purchases are charged through the same checkout, so they need a price entry too.
  for (const [sku, item] of Object.entries(planConfig.purchasables ?? {})) {
    if (typeof item.priceMonthly !== 'number' || item.priceMonthly <= 0) continue
    plans[getPlanKey('purchase', sku)] = { amount: toMinorUnits(item.priceMonthly), yearlyDiscount: 0 }
  }
  return plans
}

export interface FetchPlanConfigOptions {
  attempts?: number
  delayMs?: number
  timeoutMs?: number
}

// Fetch pod-payment's shared /api/v1/plan-config, shaping the URL the same way for every caller.
// Retries a few times by default so tbank can start alongside pod-payment before its HTTP is ready;
// callers that want a single best-effort attempt (e.g. notifications) can pass attempts: 1.
export async function fetchPlanConfig (paymentUrl: string, opts: FetchPlanConfigOptions = {}): Promise<PlanConfigLike> {
  const { attempts = 10, delayMs = 3000, timeoutMs } = opts
  const url = `${paymentUrl.replace(/\/+$/, '')}/api/v1/plan-config`
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : undefined)
      if (!res.ok) throw new Error(`Failed to load plan-config from ${url}: ${res.status}`)
      return (await res.json()) as PlanConfigLike
    } catch (err) {
      lastErr = err
      console.warn(`plan-config load attempt ${i + 1}/${attempts} failed`, err)
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastErr
}

// Fetch the shared plan-config from pod-payment and derive the pricing table.
export async function loadPricing (
  paymentUrl: string,
  attempts = 10,
  delayMs = 3000
): Promise<Record<string, PlanPricing>> {
  const planConfig = await fetchPlanConfig(paymentUrl, { attempts, delayMs })
  return buildPricingFromPlanConfig(planConfig)
}

/**
 * Resolve the per-seat charge for a billing period
 */
export function resolvePerSeatAmount (pricing: PlanPricing, yearly: boolean): number {
  if (!yearly) return pricing.amount
  // Round the discounted monthly price down to whole major units so the yearly total never exceeds list price.
  const monthly = Math.floor((pricing.amount * (1 - pricing.yearlyDiscount / 100)) / 100) * 100
  return monthly * 12
}

export interface RecurrentChargeResult {
  Success: boolean
  PaymentId: string
  Status: string
  ErrorCode: string
  Message: string
}

// TBank fiscal receipt (54-ФЗ). Amounts in kopecks.
// Contact is Email OR Phone (a mandatory receipt requisite); at least one must be present.
export interface TbankReceipt {
  Email?: string
  Phone?: string
  Taxation: string
  Items: Array<{ Name: string, Price: number, Quantity: number, Amount: number, Tax: string }>
}

// Build a single-line receipt for a subscription charge. Prefers email, falls back to phone.
// Returns undefined when neither contact is available — caller must not charge without a receipt (54-ФЗ).
export function buildTbankReceipt (
  contact: { email: string | null, phone: string | null },
  taxation: string,
  vat: string,
  name: string,
  amount: number
): TbankReceipt | undefined {
  const item = { Name: name.slice(0, 128), Price: amount, Quantity: 1, Amount: amount, Tax: vat }
  if (contact.email !== null && contact.email !== '') {
    return { Email: contact.email, Taxation: taxation, Items: [item] }
  }
  if (contact.phone !== null && contact.phone !== '') {
    return { Phone: contact.phone, Taxation: taxation, Items: [item] }
  }
  return undefined
}

/**
 * Charge a subscription's card off-session for `amount`.
 *
 * TBank /v2/Charge takes the amount from the PaymentId (its Init), NOT from RebillId — RebillId is only
 * the saved-card token. So every recurrent charge needs a FRESH Init on the amount to be charged, then
 * Charge against that new PaymentId. Reusing the subscription's original (already-CONFIRMED) provider
 * SubscriptionId as the PaymentId charges the old amount / is rejected — it only "works" under the mock.
 *
 * MIT (merchant-initiated, no customer present): OperationInitiatorType 'R' (recurring), no redirect URLs.
 * Returns the Charge result with its own new PaymentId (use it as lastChargePaymentId).
 */
export async function chargeSubscriptionRecurrent (
  tbank: TbankPayments,
  sub: SubscriptionData,
  amount: number,
  orderId: string,
  description: string,
  receipt: TbankReceipt
): Promise<RecurrentChargeResult> {
  const rebillId = sub.providerData?.rebillId as string | undefined
  if (rebillId === undefined || rebillId === '') {
    throw new Error(`No rebillId on subscription ${sub.id}, cannot charge off-session`)
  }
  // Fresh Init for THIS amount. MIT recurring: no SuccessURL/FailURL (no customer redirect).
  const initResult = await tbank.initPayment({
    Amount: amount,
    OrderId: orderId,
    Description: description,
    CustomerKey: sub.accountUuid,
    Recurrent: 'Y',
    PayType: 'O',
    OperationInitiatorType: 'R',
    Receipt: receipt // Mandatory fiscal receipt (54-ФЗ).
  })
  // Init declined (Success:false) — no PaymentId to charge. Surface as a business fail, not a throw.
  if (!initResult.Success) {
    return {
      Success: false,
      PaymentId: String(initResult.PaymentId ?? ''),
      Status: initResult.Status ?? '',
      ErrorCode: initResult.ErrorCode ?? '',
      Message: initResult.Message ?? 'Init failed'
    }
  }
  const chargeResult = await tbank.chargeRecurrent({
    PaymentId: initResult.PaymentId,
    RebillId: rebillId
  })
  return {
    Success: Boolean(chargeResult.Success),
    PaymentId: String(chargeResult.PaymentId),
    Status: chargeResult.Status ?? '',
    ErrorCode: chargeResult.ErrorCode ?? '',
    Message: chargeResult.Message ?? ''
  }
}

export interface ChargeRecheck {
  outcome: 'charged' | 'failed' | 'unknown'
  paymentId?: string
  status?: string
}

/**
 * After a transport error on charge (outcome unknown), ask TBank whether the money actually moved.
 * CheckOrder(orderId) is authoritative: the orderId is deterministic per renewal, so it finds the
 * payment even if Init/Charge responses were lost. A confirmed payment => charged; a terminal-negative
 * one => failed; anything in-flight or another transport error => still unknown (leave to lease takeover).
 */
export async function recheckChargeOutcome (tbank: TbankPayments, orderId: string): Promise<ChargeRecheck> {
  try {
    const res = await tbank.checkOrder({ OrderId: orderId })
    const payments = res.Payments ?? []
    const confirmed = payments.find((p) => TBANK_SUCCESS_STATES.has(p.Status))
    if (confirmed !== undefined) {
      return { outcome: 'charged', paymentId: String(confirmed.PaymentId), status: confirmed.Status }
    }
    // Every known payment for this order is terminal-negative => the charge did not go through.
    if (payments.length > 0 && payments.every((p) => TBANK_FAILED_STATES.has(p.Status))) {
      return { outcome: 'failed', status: payments[0].Status }
    }
    return { outcome: 'unknown' }
  } catch {
    return { outcome: 'unknown' }
  }
}

/**
 * Build updated subscription data after a successful recurrent charge (scheduler renewal or manual retry).
 */
export function buildRenewedSubscription (sub: SubscriptionData, now: number, paymentId: string): SubscriptionData {
  return {
    ...sub,
    status: SubscriptionStatus.Active,
    periodStart: now,
    periodEnd: nextPeriodEnd(now, sub.providerData?.period as BillingPeriod | undefined),
    providerData: {
      ...sub.providerData,
      modifiedAt: now,
      status: 'ACTIVE',
      retryAttempt: 0,
      retryAfter: 0,
      lastChargeAt: now,
      lastChargePaymentId: paymentId
    }
  }
}

// Past-due data after a failed recurrent charge. retryIntervalMs is the caller's back-off
// (scheduler and manual retry use different intervals).
export function buildFailedChargeSubscription (
  sub: SubscriptionData,
  errorCode: string,
  message: string,
  retryIntervalMs: number
): SubscriptionData {
  const now = Date.now()
  const prevAttempt = (sub.providerData?.retryAttempt as number) ?? 0
  return {
    ...sub,
    status: SubscriptionStatus.PastDue,
    providerData: {
      ...sub.providerData,
      modifiedAt: now,
      status: 'CHARGE_FAILED',
      retryAttempt: prevAttempt + 1,
      retryAfter: now + retryIntervalMs,
      lastChargeError: message,
      lastChargeErrorCode: errorCode
    }
  }
}

// Past-due data after an unexpected error during charge (keeps card + rebillId for retry).
export function buildChargeErrorSubscription (
  sub: SubscriptionData,
  errorMessage: string,
  retryIntervalMs: number
): SubscriptionData {
  const now = Date.now()
  const prevAttempt = (sub.providerData?.retryAttempt as number) ?? 0
  return {
    ...sub,
    status: SubscriptionStatus.PastDue,
    providerData: {
      ...sub.providerData,
      modifiedAt: now,
      status: 'CHARGE_ERROR',
      retryAttempt: prevAttempt + 1,
      retryAfter: now + retryIntervalMs,
      lastChargeError: errorMessage
    }
  }
}

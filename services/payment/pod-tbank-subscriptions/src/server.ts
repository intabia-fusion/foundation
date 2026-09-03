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

import type { MeasureContext, WorkspaceUuid, AccountUuid } from '@hcengineering/core'
import {
  type SubscriptionData,
  SubscriptionStatus,
  SubscriptionType,
  prorateSeats,
  proratePackage,
  type ProrationResult
} from '@hcengineering/account-client'
import express, { type Express, type Request, type Response } from 'express'
import cors from 'cors'
import type TbankPayments from './tbank'
import type { MockTbank } from './mockTbank'

import type { Config } from './config'
import { withServiceToken } from './middleware'
import { SubscriptionStorage } from './storage'
import {
  verifyWebhookToken,
  getPlanKey,
  buildOrderId,
  loadPricing,
  resolvePerSeatAmount,
  isPendingFirstPayment,
  nextPeriodEnd,
  formatTbankDueDate,
  orderFingerprint,
  buildRenewedSubscription,
  buildFailedChargeSubscription,
  chargeSubscriptionRecurrent,
  buildTbankReceipt,
  newActionId,
  type PlanPricing,
  type TbankReceipt
} from './utils'
import {
  notifyPaymentFailed,
  notifyPaymentSucceeded,
  notifyReceiptBlocked,
  buildChargeDescription
} from './notifications'
import type { TbankWebhookNotification, CreateSubscriptionRequest, UpdatePlanRequest, BillingPeriod } from './types'

// Link lifetime = how long the bank keeps the link payable (RedirectDueDate). Lease = heartbeat window
// for the holder pod. Takeover cancels the old link first.
const CHECKOUT_LINK_LIFETIME_MS = 5 * 60 * 1000
const CHECKOUT_LEASE_TIMEOUT_MS = 15 * 60 * 1000
const CHECKOUT_HEARTBEAT_MS = 1000
// Back-off before a manually-retried charge can be retried again. Deliberately shorter than the
// scheduler's RETRY_INTERVAL_MS (24h) — a manual retry is user-initiated, so a tighter window is fine.
const MANUAL_RETRY_INTERVAL_MS = 60 * 60 * 1000

// Shared 409 payloads for the checkout-reclaim tail (see respondAfterReclaim).
const IN_FLIGHT_RESPONSE = { reason: 'in_flight', error: 'Payment is being created, please retry shortly' } as const
const ALREADY_PAID_RESPONSE = {
  reason: 'already_paid',
  error: 'The pending payment has already been processed'
} as const

// Enqueue a signature-verified raw webhook for asynchronous processing by the pod's own consumer.
export type WebhookEnqueue = (notification: Record<string, any>, verified: boolean) => Promise<void>

export async function createServer (
  ctx: MeasureContext,
  config: Config,
  tbank: TbankPayments,
  storage: SubscriptionStorage,
  enqueueWebhook: WebhookEnqueue,
  mock?: MockTbank
): Promise<{ app: Express, close: () => void }> {
  const plans = await loadPricing(config.PaymentUrl)

  const app = express()

  // Restrict CORS to CORS_ORIGIN (comma-separated) when configured; otherwise open cors() (dev/test).
  app.use(
    config.CorsOrigin !== undefined ? cors({ origin: config.CorsOrigin.split(',').map((o) => o.trim()) }) : cors()
  )

  // Use raw body for webhook routes (TBank signature verification needs raw body)
  // Use JSON parsing for all other routes
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/v1/webhooks/')) {
      express.raw({ type: 'application/json' })(req, res, next)
    } else {
      express.json()(req, res, next)
    }
  })

  app.post(
    '/api/v1/subscriptions',
    withServiceToken,
    wrapHandler(ctx, 'createSubscription', async (req, res) => {
      await handleCreateSubscription(ctx, config, tbank, storage, plans, req, res)
    })
  )

  app.get(
    '/api/v1/subscriptions/by-checkout/:checkoutId',
    withServiceToken,
    wrapHandler(ctx, 'getByCheckout', async (req, res) => {
      await handleGetByCheckout(storage, req, res)
    })
  )

  app.get(
    '/api/v1/subscriptions/:id',
    withServiceToken,
    wrapHandler(ctx, 'getSubscription', async (req, res) => {
      await handleGetSubscription(storage, req, res)
    })
  )

  app.post(
    '/api/v1/subscriptions/:id/cancel',
    withServiceToken,
    wrapHandler(ctx, 'cancelSubscription', async (req, res) => {
      await handleCancelSubscription(ctx, tbank, storage, req, res)
    })
  )

  app.post(
    '/api/v1/subscriptions/:id/uncancel',
    withServiceToken,
    wrapHandler(ctx, 'uncancelSubscription', async (req, res) => {
      await handleUncancelSubscription(storage, req, res)
    })
  )

  app.post(
    '/api/v1/subscriptions/:id/updatePlan',
    withServiceToken,
    wrapHandler(ctx, 'updatePlan', async (req, res) => {
      await handleUpdatePlan(ctx, config, tbank, storage, plans, req, res)
    })
  )

  app.post(
    '/api/v1/subscriptions/:id/retry',
    withServiceToken,
    wrapHandler(ctx, 'retryPayment', async (req, res) => {
      await handleRetryPayment(ctx, config, tbank, storage, req, res)
    })
  )

  app.post(
    '/api/v1/webhooks/tbank',
    wrapHandler(ctx, 'webhook', async (req, res) => {
      await handleWebhook(ctx, config, tbank, enqueueWebhook, req, res)
    })
  )

  // Local dev only: mock checkout page + pay/cancel actions (TBANK_MOCK=true).
  if (mock !== undefined) {
    mock.registerRoutes(app)
  }

  const close = (): void => {}
  return { app, close }
}

function wrapHandler (
  ctx: MeasureContext,
  name: string,
  method: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response) => void {
  return (req: Request, res: Response) => {
    method(req, res).catch((err: any) => {
      ctx.error(`Failed to ${name}`, { err })

      if (!res.headersSent) {
        res.status(500).json({ error: err.message })
      }
    })
  }
}

/**
 * Find a subscription by id or providerSubscriptionId.
 * Pod-payment passes providerSubscriptionId as the id parameter,
 * so we need to try both lookups.
 */
async function findSubscription (
  storage: SubscriptionStorage,
  idOrProviderId: string
): Promise<SubscriptionData | null> {
  // Try exact id match first (format: tbank_<paymentId>)
  const byId = await storage.getById(idOrProviderId)
  if (byId !== null) return byId

  // Fallback: search by providerSubscriptionId (the raw paymentId)
  return await storage.getByProviderId(idOrProviderId)
}

/**
 * Cancel a pending checkout's bank link (first, so a concurrent pay is rejected) and free its claim.
 * Shared by forced switch and orphan takeover. true = bank confirmed CANCELED; false = already paid /
 * call failed -> caller must NOT open a new checkout (would double-charge).
 */
// Terminal tbank states where the money never moved: the link is already dead, so there is
// nothing to charge and the claim is safe to free. tbank rejects Cancel on these with an error.
const TBANK_DEAD_LINK_STATES = ['DEADLINE_EXPIRED', 'CANCELED', 'REJECTED']
// tbank ErrorCode 4 = "Изменение статуса не разрешено": Cancel hit a payment that is already in a
// terminal state. The message is localized and names no status, so matching TBANK_DEAD_LINK_STATES
// against the text alone never catches it on the real API — the code is the stable signal.
const TBANK_STATUS_CHANGE_FORBIDDEN = '4'
// Cancel answers with these when it hit a payment whose money had already settled: the call did not
// kill a link, it moved money back. Only reachable by losing the GetState->Cancel race.
const TBANK_REFUNDED_STATES = ['REFUNDED', 'PARTIAL_REFUNDED', 'REVERSED']

async function cancelPendingCheckout (
  ctx: MeasureContext,
  tbank: TbankPayments,
  storage: SubscriptionStorage,
  intentId: string,
  paymentId: string | null | undefined
): Promise<boolean> {
  // Claim won but never issued a charge (no payment_id): nothing to cancel at tbank.
  // Release by intent id — releaseCheckout keys off payment_id and would no-op on NULL.
  if (paymentId == null || paymentId === '') {
    await storage.abandonCheckout(intentId)
    return true
  }
  // Cancel on CONFIRMED = full refund, not a no-op: settled checkout -> release stale claim, skip cancel.
  // AUTHORIZED is a hold: Cancel only releases it, so it goes through the normal path below.
  try {
    const state = await tbank.getPaymentState({ PaymentId: paymentId })
    if (state.Success && state.Status === 'CONFIRMED') {
      ctx.info('Pending checkout already settled, releasing claim without cancel', { paymentId })
      await storage.releaseCheckout(paymentId)
      return true
    }
  } catch (err) {
    // GetState down: proceed to Cancel; a settled payment answers ErrorCode 4 below.
    ctx.warn('GetState before checkout cancel failed, proceeding to cancel', { paymentId, err })
  }
  let dead = false
  try {
    // Deterministic idempotency key: a retried Cancel for this payment returns the existing operation's
    // state instead of issuing a second refund (tbank checks prior Cancels with the same ExternalRequestId).
    const cancelResult = await tbank.cancelPayment({
      PaymentId: paymentId,
      ExternalRequestId: `cancel:${paymentId}`
    })
    // Settled between GetState and Cancel -> tbank refunded it.
    // Log loudly: bank's REFUNDED webhook won't say we triggered it.
    if (TBANK_REFUNDED_STATES.includes(cancelResult.Status)) {
      ctx.error('Cancel refunded an already-settled checkout (race with payment)', {
        paymentId,
        status: cancelResult.Status,
        amount: cancelResult.OriginalAmount
      })
      await storage.logOperation({
        operation: 'refund',
        status: cancelResult.Status,
        paymentId,
        actor: 'system',
        amount: cancelResult.OriginalAmount,
        raw: { reason: 'cancel_race_after_settle', newAmount: cancelResult.NewAmount }
      })
    }
    // Refunded = link spent, claim must be freed.
    dead =
      cancelResult.Status === 'CANCELED' ||
      TBANK_DEAD_LINK_STATES.includes(cancelResult.Status) ||
      TBANK_REFUNDED_STATES.includes(cancelResult.Status)
    if (!dead) {
      // Success:false is returned, not thrown - the catch below never sees ErrorCode 4.
      if (String(cancelResult.ErrorCode ?? '') === TBANK_STATUS_CHANGE_FORBIDDEN) {
        if (cancelResult.Status === 'CONFIRMED') {
          // Settled: keep the draft for the webhook, only free the claim.
          ctx.info('Cancel forbidden (settled), releasing claim', { paymentId, status: cancelResult.Status })
          await storage.releaseCheckout(paymentId)
          return true
        }
        // Dead terminal state: fall through to abandon the draft and release.
        ctx.info('Cancel forbidden (terminal state), releasing', { paymentId, status: cancelResult.Status })
        dead = true
      } else {
        ctx.info('Pending checkout not cancelable', { paymentId, status: cancelResult.Status })
        return false
      }
    }
  } catch (err: any) {
    // tbank refuses to cancel an already-dead payment (e.g. DEADLINE_EXPIRED) — treat as freed.
    const details: string = err?.details ?? err?.message ?? ''
    const statusChangeForbidden = String(err?.code ?? '') === TBANK_STATUS_CHANGE_FORBIDDEN
    if (!statusChangeForbidden && !TBANK_DEAD_LINK_STATES.some((s) => details.includes(s))) throw err
    ctx.info('Pending checkout already dead at tbank, releasing', { paymentId, details, code: err?.code })
  }
  // Abandon the old draft (if still a pending first-payment) and release the claim.
  const oldDraft = await storage.getByProviderId(paymentId)
  if (oldDraft !== null && isPendingFirstPayment(oldDraft)) {
    await storage.upsert({
      ...oldDraft,
      status: SubscriptionStatus.Canceled,
      providerData: { ...oldDraft.providerData, modifiedAt: Date.now(), status: 'ABANDONED', pending: false }
    })
  }
  await storage.releaseCheckout(paymentId)
  return true
}

async function handleCreateSubscription (
  ctx: MeasureContext,
  config: Config,
  tbank: TbankPayments,
  storage: SubscriptionStorage,
  plans: Record<string, PlanPricing>,
  req: Request,
  res: Response
): Promise<void> {
  const { type, plan, workspaceUuid, workspaceUrl, accountUuid, quantity, period, force, recurrent } =
    req.body as CreateSubscriptionRequest

  ctx.info('Creating TBank subscription', { type, plan, workspaceUuid, accountUuid })

  // One user intent = one actionId; every ledger row it causes (charge, webhook, superseded cancel)
  // carries it, so the admin sees the whole story as a single action.
  const actionId = newActionId()
  const planKey = getPlanKey(type, plan)
  const pricing = plans[planKey]
  if (pricing === undefined) {
    res.status(400).json({ error: `Unknown plan: ${planKey}` })
    return
  }
  // A package is flat-priced: never multiply by a client quantity. Per-seat plans charge
  // price-per-seat * seats (validated: positive integer); yearly applies the plan's discount.
  const seats = type === SubscriptionType.Package ? 1 : (quantity ?? 1)
  if (!Number.isInteger(seats) || seats < 1) {
    res.status(400).json({ error: 'Invalid quantity' })
    return
  }
  const perSeatAmount = resolvePerSeatAmount(pricing, period === 'yearly')
  const amount = perSeatAmount * seats
  // Exact order behind this request — a loser reuses the pending URL only on an exact match.
  const fingerprint = orderFingerprint(plan, seats, period)

  // Claim winner opens the payment: heartbeat the lease, then save URL + payment_id (reuse / release).
  const openCheckout = async (intentId: string): Promise<void> => {
    const heartbeat = setInterval(() => {
      void storage.heartbeatCharge(intentId)
    }, CHECKOUT_HEARTBEAT_MS)
    let paymentIssued = false
    try {
      const transactionCount = await storage.getTransactionCount(workspaceUuid)
      const orderId = buildOrderId(workspaceUuid, transactionCount)

      // Payer-facing, localized order description (TBank shows it to the customer + it names the receipt line).
      const locale = await resolveAccountLocale(storage, accountUuid as AccountUuid)
      const description = await buildChargeDescription(config, plan, type, 'purchase', locale)
      // No contact -> no receipt: refuse the checkout (a receipt-less payment violates 54-ФЗ).
      let receipt: TbankReceipt
      try {
        receipt = await resolveReceipt(ctx, storage, config, accountUuid as AccountUuid, description, amount)
      } catch (err) {
        if (err instanceof MissingReceiptContactError) {
          ctx.warn('Checkout blocked: no receipt contact (54-ФЗ)', { workspaceUuid, accountUuid, planKey })
          await storage.abandonCheckout(intentId).catch(() => {})
          res.status(422).json({
            reason: 'no_receipt_contact',
            error: 'A payer email or phone is required to issue a fiscal receipt'
          })
          return
        }
        throw err
      }
      const { paymentId, paymentURL } = await initTbankPayment(
        config,
        tbank,
        amount,
        orderId,
        description,
        accountUuid,
        workspaceUrl,
        receipt,
        recurrent === true
      )

      ctx.info('TBank payment initiated', { orderId, paymentId, planKey, amount, seats, period, recurrent })
      await storage.logOperation({
        operation: 'init_charge',
        status: 'NEW',
        paymentId: String(paymentId),
        orderId,
        workspaceUuid,
        accountUuid,
        actionId,
        actor: 'user',
        amount,
        raw: { plan, type, seats, period, recurrent: recurrent === true }
      })

      // Link the claim to the issued charge and save the URL for reuse before exposing the draft.
      await storage.setCheckoutPayment(intentId, String(paymentId), paymentURL)
      paymentIssued = true

      const subscriptionData = buildSubscriptionData(
        String(paymentId),
        orderId,
        workspaceUuid,
        accountUuid,
        type,
        plan,
        amount,
        accountUuid,
        config.TbankTerminalKey,
        undefined,
        quantity,
        period,
        paymentURL,
        actionId,
        recurrent === true
      )

      await storage.upsert(subscriptionData)

      res.json({ checkoutId: orderId, checkoutUrl: paymentURL })
    } catch (err) {
      // Failed before issuing a payment -> free the claim so a retry gets a clean claim (no 15-min
      // lease wait, no stuck payment_id=null intent).
      if (!paymentIssued) {
        await storage.abandonCheckout(intentId).catch(() => {})
      }
      throw err
    } finally {
      clearInterval(heartbeat)
    }
  }

  // Atomic guard vs parallel purchases for one (workspace, type): only the winner opens a payment.
  await runClaimedCheckout(ctx, tbank, storage, res, { workspaceUuid, type, fingerprint, force }, openCheckout)
}

/**
 * Atomic (workspace, type) checkout guard shared by create and update: only the claim winner opens a
 * payment (openCheckout), losers reuse the winner's URL or get 409. Covers stale-lease takeover, forced
 * switch, link-expiry reissue. `openCheckout(intentId)` issues the tbank link and writes the draft.
 */
export async function runClaimedCheckout (
  ctx: MeasureContext,
  tbank: TbankPayments,
  storage: SubscriptionStorage,
  res: Response,
  params: { workspaceUuid: WorkspaceUuid, type: string, fingerprint: string, force?: boolean },
  openCheckout: (intentId: string) => Promise<void>
): Promise<void> {
  const { workspaceUuid, type, fingerprint, force } = params
  const claim = await storage.claimCheckout(workspaceUuid, type, fingerprint)

  if (claim.claimed) {
    await openCheckout(claim.intentId)
    return
  }

  // Lost the claim. Stale lease -> holder pod died mid-checkout, take over.
  const leaseFresh = claim.heartbeatAt !== undefined && Date.now() - claim.heartbeatAt < CHECKOUT_LEASE_TIMEOUT_MS
  if (!leaseFresh) {
    const wonTakeover = await storage.reclaimStaleCharge(claim.intentId, CHECKOUT_LEASE_TIMEOUT_MS)
    if (wonTakeover) {
      // Cancel the dead holder's charge (or abandon the claim if it never issued one).
      const canceled = await cancelPendingCheckout(ctx, tbank, storage, claim.intentId, claim.paymentId)
      if (!canceled) {
        res.status(409).json(ALREADY_PAID_RESPONSE)
        return
      }
      const reclaim = await storage.claimCheckout(workspaceUuid, type, fingerprint)
      await respondAfterReclaim(res, reclaim, async () => {
        await openCheckout(reclaim.intentId)
      })
      return
    }
  }

  // A different order is being paid for this type. Never hand back the winner's link for the wrong plan.
  if (claim.orderFingerprint !== undefined && claim.orderFingerprint !== fingerprint) {
    if (force !== true) {
      res.status(409).json({ reason: 'other_checkout_active', error: 'A payment for a different plan is in progress' })
      return
    }
    if (claim.paymentId == null || claim.paymentId === '') {
      res.status(409).json(IN_FLIGHT_RESPONSE)
      return
    }
    const canceled = await cancelPendingCheckout(ctx, tbank, storage, claim.intentId, claim.paymentId)
    if (!canceled) {
      res.status(409).json(ALREADY_PAID_RESPONSE)
      return
    }
    const reclaim = await storage.claimCheckout(workspaceUuid, type, fingerprint)
    await respondAfterReclaim(res, reclaim, async () => {
      await openCheckout(reclaim.intentId)
    })
    return
  }

  // Same order (repeat / second tab): reuse the winner's saved URL — unless the link has expired.
  if (claim.paymentUrl !== undefined && claim.paymentUrl !== '') {
    const linkExpired = Date.now() - claim.createdOn >= CHECKOUT_LINK_LIFETIME_MS
    if (!linkExpired) {
      res.json({ checkoutUrl: claim.paymentUrl })
      return
    }
    const freed = await cancelPendingCheckout(ctx, tbank, storage, claim.intentId, claim.paymentId)
    if (!freed) {
      res.status(409).json(ALREADY_PAID_RESPONSE)
      return
    }
    const reclaim = await storage.claimCheckout(workspaceUuid, type, fingerprint)
    await respondAfterReclaim(res, reclaim, async () => {
      await openCheckout(reclaim.intentId)
    })
    return
  }

  res.status(409).json(IN_FLIGHT_RESPONSE)
}

/**
 * Shared tail of the checkout-reclaim ladder: after a reclaim attempt, either open the new checkout,
 * reuse a racing winner's URL, or report in_flight. Identical across all 4 reclaim call sites in
 * handleCreateSubscription; the surrounding conditions that lead here (takeover / forced switch /
 * link expiry) genuinely differ and are NOT merged.
 */
async function respondAfterReclaim (
  res: Response,
  reclaim: { claimed: boolean, paymentUrl?: string, intentId: string },
  openCheckout: () => Promise<void>
): Promise<void> {
  if (reclaim.claimed) {
    await openCheckout()
    return
  }
  if (reclaim.paymentUrl !== undefined && reclaim.paymentUrl !== '') {
    res.json({ checkoutUrl: reclaim.paymentUrl })
    return
  }
  res.status(409).json(IN_FLIGHT_RESPONSE)
}

/**
 * Resolve a subscription via `lookup`, writing the standard 404 response and returning null on miss.
 * Callers do `const sub = await loadSubscriptionOr404(...); if (sub === null) return`.
 */
async function loadSubscriptionOr404<T> (lookup: () => Promise<T | null>, res: Response): Promise<T | null> {
  const found = await lookup()
  if (found === null) {
    res.status(404).json({ error: 'Subscription not found' })
    return null
  }
  return found
}

async function handleGetByCheckout (storage: SubscriptionStorage, req: Request, res: Response): Promise<void> {
  const found = await loadSubscriptionOr404(async () => {
    const sub = await storage.findSubscriptionByCheckoutId(req.params.checkoutId)
    return sub !== null && isPendingFirstPayment(sub) ? null : sub
  }, res)
  if (found === null) return
  res.json(found)
}

async function handleGetSubscription (storage: SubscriptionStorage, req: Request, res: Response): Promise<void> {
  const sub = await loadSubscriptionOr404(async () => await findSubscription(storage, req.params.id), res)
  if (sub === null) return
  res.json(sub)
}

export async function handleCancelSubscription (
  ctx: MeasureContext,
  tbank: TbankPayments,
  storage: SubscriptionStorage,
  req: Request,
  res: Response
): Promise<void> {
  const sub = await loadSubscriptionOr404(async () => await findSubscription(storage, req.params.id), res)
  if (sub === null) return

  // Idempotent: canceling an already-canceled sub is a success, not an error.
  if (sub.status === SubscriptionStatus.Canceled || sub.status === SubscriptionStatus.Expired) {
    res.json(sub)
    return
  }
  // Only a pending first-payment draft is not cancelable (webhook/scheduler abandons it).
  // PastDue/ReadOnly must stay cancelable so a downgrade to free can stop billing retries.
  if (isPendingFirstPayment(sub)) {
    res.status(400).json({ error: 'Subscription is not in a cancelable status' })
    return
  }

  const canceledData = await cancelSubscription(ctx, tbank, storage, sub)
  res.json(canceledData)
}

// Clear the scheduled cancellation
async function handleUncancelSubscription (storage: SubscriptionStorage, req: Request, res: Response): Promise<void> {
  const sub = await findSubscription(storage, req.params.id)
  if (sub === null) {
    res.status(404).json({ error: 'Subscription not found' })
    return
  }

  // Only a scheduled cancel can be reversed
  if (sub.status === SubscriptionStatus.Canceled) {
    res.status(400).json({ error: 'Subscription already canceled, a new checkout is required' })
    return
  }

  const providerData: Record<string, any> = { ...sub.providerData, modifiedAt: Date.now(), status: 'ACTIVE' }
  delete providerData.canceledAt
  delete providerData.willCancelAt
  const uncanceledData: SubscriptionData = {
    ...sub,
    canceledAt: undefined,
    willCancelAt: undefined,
    providerData
  }
  await storage.upsert(uncanceledData)
  res.json(uncanceledData)
}

export async function handleUpdatePlan (
  ctx: MeasureContext,
  config: Config,
  tbank: TbankPayments,
  storage: SubscriptionStorage,
  plans: Record<string, PlanPricing>,
  req: Request,
  res: Response
): Promise<void> {
  const {
    plan: newPlan,
    quantity,
    period,
    recurrent,
    force,
    workspaceUrl: reqWorkspaceUrl
  } = req.body as UpdatePlanRequest
  const sub = await loadSubscriptionOr404(async () => await findSubscription(storage, req.params.id), res)
  if (sub === null) return

  // Consent is per-request; an omitted flag keeps whatever the subscription already had, so operations
  // that don't ask the user again (e.g. a seat-only change) can't silently flip auto-renewal.
  const newRecurrent = recurrent ?? sub.providerData?.recurrent === true

  // One plan change = one action: the new charge, its webhook and the old subscription's cancel
  // all report under this id.
  const actionId = newActionId()

  // Same plan + same seats + same period is a true no-op for a live subscription. A same-plan change
  // of seat count (per-seat) or period is a real update (pro-rata charge), so let it through.
  // Terminally Canceled can always be processed further.
  const curSeats = Number(sub.providerData?.quantity ?? 1)
  const newSeats = sub.type === SubscriptionType.Package ? curSeats : (quantity ?? curSeats)
  const curPeriod = sub.providerData?.period
  const samePlanNoChange = sub.plan === newPlan && newSeats === curSeats && (period ?? curPeriod) === curPeriod
  ctx.info('updatePlan no-op check', {
    curPlan: sub.plan,
    newPlan,
    curSeats,
    newSeats,
    reqQuantity: quantity,
    curPeriod,
    reqPeriod: period,
    status: sub.status,
    samePlanNoChange
  })
  if (samePlanNoChange && sub.status !== SubscriptionStatus.Canceled) {
    res.status(400).json({ error: 'Already on this plan' })
    return
  }

  const planKey = getPlanKey(sub.type, newPlan)
  const pricing = plans[planKey]
  if (pricing === undefined) {
    res.status(400).json({ error: `Unknown plan: ${planKey}` })
    return
  }
  // A package is flat-priced: never multiply by a client quantity. Per-seat plans charge
  // price-per-seat * seats; fall back to current seats so a plain switch keeps the count.
  const seats = sub.type === SubscriptionType.Package ? 1 : (quantity ?? curSeats)
  if (!Number.isInteger(seats) || seats < 1) {
    res.status(400).json({ error: 'Invalid quantity' })
    return
  }
  const perSeatAmount = resolvePerSeatAmount(pricing, period === 'yearly')
  const newAmount = perSeatAmount * seats
  const fingerprint = orderFingerprint(newPlan, seats, period)
  const workspaceUrl = reqWorkspaceUrl ?? ''

  // Pro-rata plan/seat change on a live paid subscription (tier seat change OR package swap).
  //  - charge <= 0 (downgrade / credit covers it): switch in place, no checkout, extend the period.
  //  - charge > 0 (upgrade): send the user to the bank page for the DELTA (explicit consent), while the
  //    draft records the full recurring price + the proration period. Set below, applied in openCheckout.
  const isSeatChange = sub.type === SubscriptionType.Tier && newPlan === sub.plan
  const isPackageChange = sub.type === SubscriptionType.Package
  let checkoutOverride:
  | { chargeAmount: number, recurringAmount: number, periodStart: number, periodEnd: number }
  | undefined
  if (
    (isSeatChange || isPackageChange) &&
    sub.status === SubscriptionStatus.Active &&
    sub.amount != null &&
    sub.periodStart != null &&
    sub.periodEnd != null
  ) {
    const now = Date.now()
    const common = {
      oldAmount: sub.amount,
      periodStart: sub.periodStart,
      periodEnd: sub.periodEnd,
      now,
      newFullPrice: newAmount
    }
    const pro: ProrationResult = isPackageChange
      ? proratePackage(common)
      : prorateSeats({ ...common, oldSeats: curSeats, newSeats: seats })

    if (pro.charge <= 0) {
      // Downgrade / credit covers it: no money moves. Switch in place, extend the period, clear any
      // scheduled cancel. The new full price renews next cycle.
      const updated: SubscriptionData = {
        ...sub,
        plan: newPlan,
        amount: newAmount,
        status: SubscriptionStatus.Active,
        canceledAt: undefined,
        willCancelAt: undefined,
        periodStart: pro.periodStart,
        periodEnd: pro.periodEnd,
        providerData: {
          ...sub.providerData,
          quantity: seats,
          period: period ?? curPeriod,
          recurrent: newRecurrent,
          modifiedAt: now
        }
      }
      await storage.upsert(updated)
      await storage.logOperation({
        operation: 'webhook',
        status: 'active',
        paymentId: sub.providerSubscriptionId,
        orderId: sub.providerData?.orderId as string | undefined,
        subscriptionId: sub.id,
        workspaceUuid: sub.workspaceUuid,
        accountUuid: sub.accountUuid,
        actionId,
        actor: 'user',
        amount: 0,
        raw: { plan: newPlan, seats, kind: 'downgrade', charge: 0, newFullPrice: newAmount }
      })
      ctx.info('Plan change applied without charge', { subId: sub.id, newPlan, seats, newAmount })
      res.json(updated)
      return
    }

    // Upgrade with a positive charge: send the user to the bank page for the DELTA only, so the money
    // is charged with explicit consent.
    // The draft carries the full recurring price + the proration period (see openCheckout override).
    checkoutOverride = {
      chargeAmount: pro.charge,
      recurringAmount: newAmount,
      periodStart: pro.periodStart,
      periodEnd: pro.periodEnd
    }
  }

  // Winner opens the replacement checkout: init tbank link, mark the old sub pending-replacement (do NOT
  // cancel it — the old plan stays active until the new payment lands), pre-create the new pending sub.
  //
  // For a pro-rata UPGRADE the bank page charges only the delta (chargeAmount), but the draft carries the
  // new FULL price (recurringAmount) + the proration-computed period, so renewal bills the full price and
  // the period stays consistent. For a plain purchase/switch all three coincide with newAmount.
  const openCheckout = async (
    intentId: string,
    override?: { chargeAmount: number, recurringAmount: number, periodStart: number, periodEnd: number }
  ): Promise<void> => {
    const chargeAmount = override?.chargeAmount ?? newAmount
    const recurringAmount = override?.recurringAmount ?? newAmount
    const heartbeat = setInterval(() => {
      void storage.heartbeatCharge(intentId)
    }, CHECKOUT_HEARTBEAT_MS)
    let paymentIssued = false
    try {
      const transactionCount = await storage.getTransactionCount(sub.workspaceUuid)
      const orderId = buildOrderId(sub.workspaceUuid, transactionCount)
      const locale = await resolveAccountLocale(storage, sub.accountUuid)
      const description = await buildChargeDescription(config, newPlan, sub.type, 'update', locale)
      // Receipt covers the amount actually charged now (prorated delta), not the full recurring price.
      // No contact -> refuse the checkout (a receipt-less payment violates 54-ФЗ).
      let receipt: TbankReceipt
      try {
        receipt = await resolveReceipt(ctx, storage, config, sub.accountUuid, description, chargeAmount)
      } catch (err) {
        if (err instanceof MissingReceiptContactError) {
          ctx.warn('Plan-update checkout blocked: no receipt contact (54-ФЗ)', {
            subId: sub.id,
            accountUuid: sub.accountUuid,
            newPlan
          })
          await storage.abandonCheckout(intentId).catch(() => {})
          res.status(422).json({
            reason: 'no_receipt_contact',
            error: 'A payer email or phone is required to issue a fiscal receipt'
          })
          return
        }
        throw err
      }
      const { paymentId, paymentURL } = await initTbankPayment(
        config,
        tbank,
        chargeAmount,
        orderId,
        description,
        sub.accountUuid,
        workspaceUrl,
        receipt,
        newRecurrent
      )
      await storage.setCheckoutPayment(intentId, String(paymentId), paymentURL)
      paymentIssued = true
      await storage.logOperation({
        operation: 'init_charge',
        status: 'NEW',
        paymentId: String(paymentId),
        orderId,
        subscriptionId: sub.id,
        workspaceUuid: sub.workspaceUuid,
        accountUuid: sub.accountUuid,
        actionId,
        actor: 'user',
        amount: chargeAmount,
        raw: { plan: newPlan, type: sub.type, seats, period, kind: 'update', recurringAmount, recurrent: newRecurrent }
      })

      // Link+claim first, then drafts: if an upsert below fails the webhook's "any active same-type"
      // fallback still cancels the old sub on payment (see handleWebhook).
      await storage.upsert({
        ...sub,
        providerData: { ...sub.providerData, pendingReplacement: true, replacementPlan: newPlan, actionId }
      })
      const draft = buildSubscriptionData(
        String(paymentId),
        orderId,
        sub.workspaceUuid,
        sub.accountUuid,
        sub.type,
        newPlan,
        recurringAmount, // draft carries the FULL recurring price (what renews), not the delta charged now
        sub.accountUuid,
        config.TbankTerminalKey,
        undefined,
        quantity,
        period,
        paymentURL,
        actionId,
        newRecurrent
      )
      // Carry the proration-computed period so a delta-upgrade keeps the right renewal date (esp. yearly,
      // where the period must NOT reset to a fresh 30 days).
      if (override !== undefined) {
        draft.periodStart = override.periodStart
        draft.periodEnd = override.periodEnd
      }
      await storage.upsert(draft)

      ctx.info('Replacement checkout opened', { oldSubId: sub.id, paymentId, newPlan, seats, chargeAmount })
      res.json({ checkoutId: orderId, checkoutUrl: paymentURL })
    } catch (err) {
      if (!paymentIssued) {
        await storage.abandonCheckout(intentId).catch(() => {})
      }
      throw err
    } finally {
      clearInterval(heartbeat)
    }
  }

  // Same atomic (workspace, type) guard as create: two owners changing seats race for one claim —
  // only the winner opens a checkout, the loser reuses its URL or gets 409. Package = separate type.
  // checkoutOverride is set for a pro-rata upgrade (charge the delta, record the full recurring price).
  await runClaimedCheckout(
    ctx,
    tbank,
    storage,
    res,
    { workspaceUuid: sub.workspaceUuid, type: sub.type, fingerprint, force },
    async (intentId: string) => {
      await openCheckout(intentId, checkoutOverride)
    }
  )
}

export async function handleRetryPayment (
  ctx: MeasureContext,
  config: Config,
  tbank: TbankPayments,
  storage: SubscriptionStorage,
  req: Request,
  res: Response
): Promise<void> {
  const sub = await loadSubscriptionOr404(async () => await findSubscription(storage, req.params.id), res)
  if (sub === null) return

  // Allow manual retry both during grace (PastDue) and after it expired (ReadOnly):
  // the card may have recovered and the user wants to restore access immediately.
  if (sub.status !== SubscriptionStatus.PastDue && sub.status !== SubscriptionStatus.ReadOnly) {
    res.status(400).json({ error: 'Subscription is not in a retryable status' })
    return
  }

  const rebillId = sub.providerData?.rebillId as string | undefined
  if (rebillId === undefined) {
    res.status(400).json({ error: 'No recurring payment method available' })
    return
  }

  ctx.info('Manual retry payment', { subId: sub.id, plan: sub.plan })

  try {
    // Fresh Init on sub.amount + Charge (see chargeSubscriptionRecurrent) — a bare chargeRecurrent on the
    // original providerSubscriptionId charges the old amount / is rejected by tbank.
    const amount = sub.amount ?? 0
    const locale = await resolveAccountLocale(storage, sub.accountUuid)
    const description = await buildChargeDescription(config, sub.plan, sub.type, 'retry', locale)
    const receipt = await resolveReceipt(ctx, storage, config, sub.accountUuid, description, amount)
    const chargeResult = await chargeSubscriptionRecurrent(
      tbank,
      sub,
      amount,
      `retry:${sub.id}:${Date.now()}`,
      description,
      receipt
    )

    if (chargeResult.Success) {
      const renewedData = buildRenewedSubscription(sub, Date.now(), chargeResult.PaymentId)
      await storage.upsert(renewedData)
      ctx.info('Manual retry payment succeeded', { subId: sub.id })
      res.json(renewedData)
    } else {
      const failedData = buildFailedChargeSubscription(
        sub,
        chargeResult.ErrorCode,
        chargeResult.Message,
        MANUAL_RETRY_INTERVAL_MS
      )
      await storage.upsert(failedData)
      ctx.warn('Manual retry payment failed', { subId: sub.id, errorCode: chargeResult.ErrorCode })
      res.status(402).json({ error: chargeResult.Message ?? 'Payment failed' })
    }
  } catch (err: any) {
    if (err instanceof MissingReceiptContactError) {
      ctx.error('Manual retry blocked: no receipt contact', { subId: sub.id })
      // Record the reason on the sub + alert the team (operational 54-ФЗ block).
      const blockedData = buildFailedChargeSubscription(
        sub,
        'NO_RECEIPT_CONTACT',
        'no receipt contact (54-ФЗ)',
        MANUAL_RETRY_INTERVAL_MS
      )
      await storage.upsert(blockedData)
      await notifyReceiptBlocked(ctx, config, blockedData)
      res
        .status(422)
        .json({ reason: 'no_receipt_contact', error: 'A payer email or phone is required to issue a fiscal receipt' })
      return
    }
    ctx.error('Manual retry payment error', { subId: sub.id, err })
    res.status(500).json({ error: err.message ?? 'Internal error' })
  }
}

// HTTP ingress: verify the signature (security barrier — unverified payloads never enter the queue),
// enqueue the raw notification, ack the bank immediately. All effects happen later in processWebhook.
async function handleWebhook (
  ctx: MeasureContext,
  config: Config,
  tbank: TbankPayments,
  enqueueWebhook: WebhookEnqueue,
  req: Request,
  res: Response
): Promise<void> {
  // req.body is a Buffer for webhook routes (raw body parsing)
  const rawBody = req.body as Buffer
  if (rawBody === undefined || rawBody === null || rawBody.length === 0) {
    ctx.error('Invalid TBank webhook body')
    res.status(200).send('OK')
    return
  }

  // Parse JSON from raw body for processing
  let notification: Record<string, any>
  try {
    notification = JSON.parse(rawBody.toString('utf8'))
  } catch {
    ctx.error('Invalid TBank webhook JSON')
    res.status(200).send('OK')
    return
  }

  const verify = !(config.TbankSkipWebhookVerification ?? false)
  if (verify) {
    const token = notification.Token as string | undefined
    if (token === undefined || !verifyWebhookToken(tbank, notification, token, rawBody.toString('utf8'))) {
      ctx.error('Invalid TBank webhook token')
      res.status(200).send('OK')
      return
    }
  }

  // Enqueue for the pod's own consumer. If enqueue fails, do NOT ack — a 500 makes the bank redeliver
  // (its at-least-once delivery), so a queue outage doesn't silently drop the webhook.
  try {
    await enqueueWebhook(notification, verify)
  } catch (err) {
    ctx.error('Failed to enqueue TBank webhook', { paymentId: notification.PaymentId, err })
    res.status(500).send('enqueue failed')
    return
  }
  res.status(200).send('OK')
}

// Consumer: process a verified webhook. Rechecks the payment state against the bank before applying
// money-moved effects, then runs the activation / past-due / abandon logic. Throws on retriable errors
// (storage/bank transient) so the queue retries; returns on terminal outcomes.
export async function processWebhook (
  ctx: MeasureContext,
  config: Config,
  tbank: TbankPayments,
  storage: SubscriptionStorage,
  notification: Record<string, any>,
  verified: boolean
): Promise<void> {
  const typedNotification = notification as unknown as TbankWebhookNotification

  // AUTHORIZED/CONFIRMED webhooks trigger activation — re-verify against the bank via GetState.
  if (verified && (typedNotification.Status === 'AUTHORIZED' || typedNotification.Status === 'CONFIRMED')) {
    try {
      const state = await tbank.getPaymentState({ PaymentId: typedNotification.PaymentId })
      const settled = state.Status === 'AUTHORIZED' || state.Status === 'CONFIRMED'
      if (!state.Success) {
        ctx.warn('TBank GetState returned Success:false, proceeding on verified webhook', {
          paymentId: typedNotification.PaymentId,
          webhookStatus: typedNotification.Status,
          errorCode: state.ErrorCode,
          message: state.Message
        })
      } else if (!settled) {
        ctx.error('TBank webhook status mismatch with GetState, ignoring it', {
          paymentId: typedNotification.PaymentId,
          webhookStatus: typedNotification.Status,
          actualStatus: state.Status
        })
        return
      } else if (typedNotification.Status === 'CONFIRMED' && state.Status === 'AUTHORIZED') {
        // Activate anyway — the webhook is signed and says the money settled; alarm for manual review.
        ctx.error('TBank CONFIRMED webhook but GetState still reports a hold, activating anyway', {
          paymentId: typedNotification.PaymentId,
          webhookStatus: typedNotification.Status,
          actualStatus: state.Status
        })
      }
    } catch (err) {
      // GetState unreachable — do not block activation on a transient bank outage; the signed
      // webhook already passed verification. Log for audit and proceed.
      ctx.warn('TBank GetState recheck failed, proceeding on verified webhook', {
        paymentId: typedNotification.PaymentId,
        err
      })
    }
  }

  const sub = await storage.getByProviderId(typedNotification.PaymentId)

  ctx.info('Processing TBank webhook', {
    paymentId: typedNotification.PaymentId,
    orderId: typedNotification.OrderId,
    status: typedNotification.Status,
    success: typedNotification.Success,
    workspaceUuid: sub?.workspaceUuid
  })

  // Audit every webhook (confirmation / rejection / reversal) with the full notification payload.
  await storage.logOperation({
    operation: 'webhook',
    status: typedNotification.Status,
    paymentId: typedNotification.PaymentId,
    orderId: typedNotification.OrderId,
    subscriptionId: sub?.id,
    workspaceUuid: sub?.workspaceUuid,
    accountUuid: sub?.accountUuid,
    // The intent that opened this checkout, stored on the draft — keeps callback and charge together.
    actionId: sub?.providerData?.actionId as string | undefined,
    actor: 'provider',
    amount: typedNotification.Amount,
    raw: {
      ...(typedNotification as unknown as Record<string, any>),
      plan: sub?.plan,
      seats: sub?.providerData?.quantity
    }
  })

  if (typedNotification.Status === 'AUTHORIZED') {
    ctx.info('TBank AUTHORIZED webhook recorded, waiting for CONFIRMED to activate', {
      paymentId: typedNotification.PaymentId,
      subId: sub?.id
    })
    return
  }

  if (typedNotification.Status === 'CONFIRMED') {
    // BEFORE the sub check and duplicate guard: both return early and would leak the claim.
    // Idempotent DELETE, safe on consumer retry.
    await storage.releaseCheckout(String(typedNotification.PaymentId))

    if (sub === null) {
      ctx.error('TBank webhook received but no pending subscription found', {
        paymentId: typedNotification.PaymentId,
        orderId: typedNotification.OrderId
      })
      return
    }

    // Idempotency guard: TBank delivers webhooks at-least-once
    const appliedPaymentId =
      (sub.providerData?.lastChargePaymentId as string | undefined) ?? // is set by recurrent charges (scheduler/retry)
      (sub.providerData?.paymentId as string | undefined) // is set by the initial checkout
    if (
      sub.status === SubscriptionStatus.Active &&
      sub.providerData?.pending !== true &&
      appliedPaymentId === typedNotification.PaymentId
    ) {
      ctx.info('Duplicate TBank webhook ignored', {
        paymentId: typedNotification.PaymentId,
        status: typedNotification.Status
      })
      return
    }

    const subscriptionData = buildSubscriptionDataFromWebhook(typedNotification, sub)
    await storage.upsert(subscriptionData)
    ctx.info('TBank subscription activated via webhook', {
      paymentId: typedNotification.PaymentId,
      plan: subscriptionData.plan,
      rebillId: typedNotification.RebillId
    })

    // If this is a plan change, cancel the old subscription now that the new one is confirmed.
    // First check for a tbank sub with pendingReplacement flag (normal tbank updateSubscriptionPlan flow).
    // Otherwise, cancel any active subscription of the same type in the workspace
    // (handles provider-mismatch path where a new sub was created via createSubscription).
    // One-time purchases do not replace each other: several may be active at once, and cancelling
    // one detaches the card the tier still renews with.
    const allSubs = (await storage.getAll(subscriptionData.workspaceUuid)).filter(
      (s) => s.type !== SubscriptionType.Purchase
    )
    const oldSub =
      subscriptionData.type === SubscriptionType.Purchase
        ? undefined
        : allSubs.find(
          (s) =>
            (s.provider === 'tbank' && s.providerData?.pendingReplacement === true) ||
              (s.type === subscriptionData.type &&
                s.status === SubscriptionStatus.Active &&
                s.id !== subscriptionData.id)
        )
    if (oldSub !== undefined && oldSub !== null) {
      // Report under the NEW purchase's action: dropping the old plan is part of that same intent.
      await cancelSubscription(
        ctx,
        tbank,
        storage,
        oldSub,
        'PLAN_CHANGE',
        subscriptionData.providerData?.actionId as string | undefined,
        'provider'
      )
      ctx.info('Old subscription canceled after plan change confirmation', {
        oldSubId: oldSub.id,
        newSubId: subscriptionData.id,
        provider: oldSub.provider
      })
    }

    // Release the claim (money settled). Idempotent for duplicate webhooks.
    await storage.releaseCheckout(typedNotification.PaymentId)

    // Receipt email on settled first payment (new sub / plan change).
    await notifyPaymentSucceeded(ctx, storage, config, subscriptionData, 'purchase', typedNotification.Amount)
  } else if (
    typedNotification.Status === 'REJECTED' ||
    typedNotification.Status === 'REVERSED' ||
    typedNotification.Status === 'REFUNDED'
  ) {
    // Idempotency: at-least-once delivery (and consumer retry) re-delivers the same terminal webhook.
    // Once we've recorded this exact status on a non-pending PastDue sub, re-applying only resets
    // retryAfter and risks a duplicate notify — skip it. releaseCheckout below stays (idempotent).
    const alreadyApplied =
      sub !== null &&
      sub.status === SubscriptionStatus.PastDue &&
      sub.providerData?.pending !== true &&
      sub.providerData?.status === typedNotification.Status
    if (sub !== null && !alreadyApplied) {
      // Notify only when an active subscription fails (real renewal/charge failure).
      // Excludes: repeated webhooks on an already-past_due sub, the pending first-payment draft
      // (past_due + pending:true), and late REVERSED/REFUNDED on canceled/expired subscriptions.
      const wasActive = sub.status === SubscriptionStatus.Active
      // Mark as PastDue instead of canceling — keeps card and rebillId for retry
      const now = Date.now()
      const pastDueData: SubscriptionData = {
        ...sub,
        status: SubscriptionStatus.PastDue,
        providerData: {
          ...sub.providerData,
          modifiedAt: now,
          status: typedNotification.Status,
          pending: false,
          retryAttempt: 0,
          retryAfter: now + 60 * 60 * 1000
        }
      }
      await storage.upsert(pastDueData)
      ctx.info('TBank payment failed, subscription marked PastDue', {
        subId: sub.id,
        paymentId: typedNotification.PaymentId,
        status: typedNotification.Status
      })

      // REJECTED = real charge failure -> dunning email. REVERSED/REFUNDED = refund issued
      // (by support/admin) -> no "payment failed" email to the customer.
      if (wasActive && typedNotification.Status === 'REJECTED') {
        await notifyPaymentFailed(ctx, storage, config, pastDueData, 'failed')
      }
    }

    // Release the claim on terminal failure so a retry needn't wait for the lease. Idempotent.
    await storage.releaseCheckout(typedNotification.PaymentId)
  } else if (typedNotification.Status === 'DEADLINE_EXPIRED' || typedNotification.Status === 'CANCELED') {
    // Link expired/canceled before payment: abandon the pending draft + release now (only a
    // still-pending first-payment draft, never an active sub).
    if (sub !== null && isPendingFirstPayment(sub)) {
      const now = Date.now()
      await storage.upsert({
        ...sub,
        status: SubscriptionStatus.Canceled,
        providerData: { ...sub.providerData, modifiedAt: now, status: 'ABANDONED', pending: false }
      })
      ctx.info('TBank checkout link expired/canceled, pending draft abandoned', {
        subId: sub.id,
        paymentId: typedNotification.PaymentId,
        status: typedNotification.Status
      })
    }
    await storage.releaseCheckout(typedNotification.PaymentId)
  }
}

function buildSubscriptionData (
  paymentId: string,
  orderId: string,
  workspaceUuid: WorkspaceUuid,
  accountUuid: string,
  type: string,
  plan: string,
  amount: number,
  customerKey: string,
  terminalKey: string,
  existingSub?: SubscriptionData,
  quantity?: number,
  period?: BillingPeriod,
  paymentUrl?: string,
  actionId?: string,
  recurrent: boolean = false
): SubscriptionData {
  const now = Date.now()
  return {
    id: existingSub?.id ?? `tbank_${paymentId}`,
    workspaceUuid,
    accountUuid: accountUuid as any,
    provider: 'tbank',
    providerSubscriptionId: paymentId,
    providerCheckoutId: orderId,
    type: type as SubscriptionType,
    status: SubscriptionStatus.PastDue,
    plan,
    amount,
    periodStart: existingSub?.periodStart ?? now,
    periodEnd: nextPeriodEnd(now, period),
    providerData: {
      modifiedAt: now,
      status: 'PENDING',
      paymentId,
      orderId,
      customerKey,
      terminalKey,
      pending: true,
      // Intent that opened this checkout — the webhook and any later cancel reuse it in the ledger.
      actionId,
      // Seats purchased for a per-seat plan. undefined for flat plans.
      quantity,
      // Billing period ('monthly' | 'yearly'). undefined defaults to monthly.
      period,
      // Consent to recurring charges. false = one-off: no RebillId, don't renew this subscription.
      recurrent,
      // Checkout URL of the pending TBank payment
      paymentUrl,
      linkExpiresAt: paymentUrl !== undefined ? now + CHECKOUT_LINK_LIFETIME_MS : undefined
    }
  }
}

function buildSubscriptionDataFromWebhook (
  notification: TbankWebhookNotification,
  existingSub: SubscriptionData
): SubscriptionData {
  const now = Date.now()

  return {
    id: existingSub.id,
    workspaceUuid: existingSub.workspaceUuid,
    accountUuid: existingSub.accountUuid,
    provider: 'tbank',
    providerSubscriptionId: notification.PaymentId,
    providerCheckoutId: notification.OrderId,
    type: existingSub.type,
    status: SubscriptionStatus.Active,
    plan: existingSub.plan,
    // The draft carries the FULL recurring price (== notification.Amount for a plain purchase; the delta
    // is smaller for a pro-rata upgrade). Renewal must bill the full price, so trust the draft over the
    // one-time charge amount in the notification.
    amount: existingSub.amount ?? notification.Amount,
    // The draft already carries the resulting period (fresh for a purchase, proration-computed for an
    // upgrade — e.g. a yearly upgrade must keep its far-future end, not reset to 30 days).
    periodStart: existingSub.periodStart ?? now,
    periodEnd:
      existingSub.periodEnd ?? nextPeriodEnd(now, existingSub.providerData?.period as BillingPeriod | undefined),
    providerData: {
      ...existingSub.providerData,
      modifiedAt: now,
      customerKey: notification.CustomerKey ?? existingSub.providerData?.customerKey,
      cardId: notification.CardId,
      pan: notification.Pan,
      rebillId: notification.RebillId,
      paymentId: notification.PaymentId,
      orderId: notification.OrderId,
      // Keep the originating action so a later cancel/renewal still reports under it.
      actionId: existingSub.providerData?.actionId,
      terminalKey: notification.TerminalKey,
      status: notification.Status,
      pending: false,
      // Successful payment clears retry state, so a later failure starts a fresh grace cycle
      // (matches buildRenewedSubscription / manual retry success). Without this a sub recovered
      // from ReadOnly would keep retryAttempt>=MAX and skip straight back to ReadOnly on next fail.
      retryAttempt: 0,
      retryAfter: 0
    }
  }
}

// An unpaid subscription (past_due after a failed charge/refund, or readonly after the grace period)
// has no paid period left to run out. Cancel those immediately.
export function isImmediateCancel (sub: Pick<SubscriptionData, 'status'>): boolean {
  return sub.status === SubscriptionStatus.PastDue || sub.status === SubscriptionStatus.ReadOnly
}

// Paid sub: cancel-at-period-end, scheduler flips it to Canceled at willCancelAt (uncancel stays free).
// Plan change and unpaid subs cancel right away. status arg is only for the plan-change path.
function buildCanceledSubscriptionData (sub: SubscriptionData, status?: string): SubscriptionData {
  const now = Date.now()

  // Immediate cancel. 'CANCELED' is load-bearing: pod-payment keys the free-plan fallback off the
  // (status=Canceled, providerData.status='CANCELED') pair (isFinalizedUserCancel).
  if (status === 'PLAN_CHANGE' || isImmediateCancel(sub)) {
    const providerData: Record<string, any> = {
      ...sub.providerData,
      modifiedAt: now,
      status: status ?? 'CANCELED'
    }
    // Dunning state dies with the subscription
    delete providerData.retryAttempt
    delete providerData.retryAfter
    delete providerData.pending
    return {
      ...sub,
      status: SubscriptionStatus.Canceled,
      canceledAt: now,
      // No scheduled end
      willCancelAt: undefined,
      providerData
    }
  }

  return {
    ...sub,
    // Stays Active; willCancelAt marks the scheduled end of access and blocks renewal.
    status: SubscriptionStatus.Active,
    canceledAt: now,
    willCancelAt: sub.periodEnd,
    providerData: {
      ...sub.providerData,
      modifiedAt: now,
      status: status ?? 'SCHEDULED_CANCEL',
      willCancelAt: sub.periodEnd
    }
  }
}

// Payer locale for the charge Description. Optional, falls back to the default language.
export async function resolveAccountLocale (
  storage: SubscriptionStorage,
  accountUuid: AccountUuid
): Promise<string | null> {
  try {
    return (await storage.getAccountContact(accountUuid)).locale
  } catch {
    return null
  }
}

// Thrown when a fiscal receipt cannot be built (no payer contact, or the contact lookup failed).
// A charge WITHOUT a receipt would violate 54-ФЗ, so callers must abort the payment on this.
export class MissingReceiptContactError extends Error {
  constructor (
    public readonly accountUuid: AccountUuid,
    cause?: string
  ) {
    super(`Cannot build fiscal receipt for ${accountUuid}: no payer contact${cause !== undefined ? ` (${cause})` : ''}`)
    this.name = 'MissingReceiptContactError'
  }
}

// Build the fiscal receipt for a charge from the account's email/phone. Throws MissingReceiptContactError
// if no contact resolves — the payment must not proceed receipt-less (54-ФЗ). A lookup failure also
// throws: better to fail the payment than issue no receipt.
export async function resolveReceipt (
  ctx: MeasureContext,
  storage: SubscriptionStorage,
  config: Config,
  accountUuid: AccountUuid,
  itemName: string,
  amount: number
): Promise<TbankReceipt> {
  let contact: { email: string | null, phone: string | null }
  try {
    const c = await storage.getAccountContact(accountUuid)
    contact = { email: c.email, phone: c.phone }
  } catch (err: any) {
    ctx.error('Receipt contact lookup failed — aborting charge', {
      account: accountUuid,
      err: err?.message ?? String(err)
    })
    throw new MissingReceiptContactError(accountUuid, 'lookup failed')
  }
  const receipt = buildTbankReceipt(contact, config.TbankTaxation, config.TbankVatTax, itemName, amount)
  if (receipt === undefined) {
    ctx.error('No email or phone for account — aborting charge to avoid a receipt-less payment', {
      account: accountUuid
    })
    throw new MissingReceiptContactError(accountUuid)
  }
  return receipt
}

async function initTbankPayment (
  config: Config,
  tbank: TbankPayments,
  amount: number,
  orderId: string,
  description: string,
  accountUuid: string,
  workspaceUrl: string,
  receipt: TbankReceipt,
  recurrent: boolean = false // Recurrent:'Y' -> TBank saves the card and returns a RebillId on the webhook.
): Promise<{ paymentId: number, paymentURL: string }> {
  // RedirectDueDate bounds the link lifetime (TBank default 24h). Lib accepts it (Joi) but omits it
  // from TS types -> extend the param type locally.
  const initParams: Parameters<typeof tbank.initPayment>[0] & { RedirectDueDate: string } = {
    Amount: amount,
    OrderId: orderId,
    Description: description,
    CustomerKey: accountUuid,
    ...(recurrent ? { Recurrent: 'Y' as const } : {}),
    PayType: 'O',
    Language: 'ru',
    RedirectDueDate: formatTbankDueDate(Date.now() + CHECKOUT_LINK_LIFETIME_MS),
    NotificationURL: config.TbankNotificationUrl ?? `${config.FrontUrl}/_tbank_subscriptions/api/v1/webhooks/tbank`,
    SuccessURL: `${config.FrontUrl}/workbench/${workspaceUrl}/setting/setting/billing/subscriptions?payment=success&order_id=${orderId}`,
    FailURL: `${config.FrontUrl}/workbench/${workspaceUrl}/setting/setting/billing/subscriptions?payment=canceled`,
    // Mandatory fiscal receipt (54-ФЗ) — resolveReceipt already guaranteed a contact.
    Receipt: receipt
  }
  const initResult = await tbank.initPayment(initParams)

  return {
    paymentId: initResult.PaymentId,
    paymentURL: initResult.PaymentURL ?? ''
  }
}

// Scheduled cancel keeps the card for a possible uncancel (scheduler removes it at willCancelAt).
// Immediate cancel (PLAN_CHANGE or unpaid past_due/readonly) removes the card now.
async function cancelSubscription (
  ctx: MeasureContext,
  tbank: TbankPayments,
  storage: SubscriptionStorage,
  sub: SubscriptionData,
  status?: string,
  // Intent that caused this cancel. Falls back to the subscription's own action (user-initiated cancel).
  actionId?: string,
  actor: 'user' | 'system' | 'provider' | 'admin' = 'user'
): Promise<SubscriptionData> {
  if (status === 'PLAN_CHANGE' || isImmediateCancel(sub)) {
    await removeSubscriptionCard(ctx, tbank, sub)
  }

  const canceledData = buildCanceledSubscriptionData(sub, status)
  await storage.upsert(canceledData)

  ctx.info('Subscription canceled', { subId: sub.id, status: canceledData.providerData?.status })
  await storage.logOperation({
    operation: 'cancel',
    status: status ?? 'canceled',
    paymentId: sub.providerSubscriptionId,
    // Same orderId as the charge that created this subscription — keeps the ledger chain intact.
    orderId: sub.providerData?.orderId as string | undefined,
    subscriptionId: sub.id,
    workspaceUuid: sub.workspaceUuid,
    accountUuid: sub.accountUuid,
    actionId: actionId ?? (sub.providerData?.actionId as string | undefined),
    actor,
    amount: sub.amount,
    raw: { plan: sub.plan, seats: sub.providerData?.quantity, reason: status }
  })
  return canceledData
}

// Remove the saved card at TBank. Best-effort — a failure is logged, not fatal.
export async function removeSubscriptionCard (
  ctx: MeasureContext,
  tbank: TbankPayments,
  sub: SubscriptionData
): Promise<void> {
  const cardId = sub.providerData?.cardId as string | undefined
  const customerKey = sub.providerData?.customerKey as string | undefined
  if (cardId === undefined || customerKey === undefined) return

  try {
    await tbank.removeCard({ CustomerKey: customerKey, CardId: cardId })
    ctx.info('TBank card removed for canceled subscription', { subId: sub.id, cardId })
  } catch (err) {
    ctx.warn('Failed to remove TBank card during cancel', { subId: sub.id, err })
  }
}

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

import { SubscriptionStatus } from '@hcengineering/account-client'
import { handleUpdatePlan } from '../server'

const DAY = 24 * 3600 * 1000

// A tier subscription of `business`, 3 seats, monthly (the seat-change starting point).
// No periodStart/periodEnd here so the claim-guard tests exercise the checkout path; the
// proration tests below spread in a live paid period + rebillId.
const baseSub: any = {
  id: 'tbank_100',
  provider: 'tbank',
  providerSubscriptionId: '100',
  workspaceUuid: 'ws-1',
  accountUuid: 'acc-1',
  type: 'tier',
  plan: 'business',
  status: 'active',
  amount: 270000,
  providerData: { quantity: 3, period: 'monthly' }
}

const plans = { 'business@tier': { amount: 90000, yearlyDiscount: 15 } } as any

function makeRes (): any {
  const res: any = { statusCode: 200, body: undefined }
  res.status = (c: number) => {
    res.statusCode = c
    return res
  }
  res.json = (b: any) => {
    res.body = b
    return res
  }
  return res
}

function makeCtx (): any {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

function makeStorage (claim: any, sub = baseSub): any {
  return {
    getById: jest.fn().mockResolvedValue(sub),
    getByProviderId: jest.fn().mockResolvedValue(null),
    getTransactionCount: jest.fn().mockResolvedValue(1),
    claimCheckout: jest.fn().mockResolvedValue(claim),
    setCheckoutPayment: jest.fn().mockResolvedValue(undefined),
    heartbeatCharge: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    reclaimStaleCharge: jest.fn().mockResolvedValue(false),
    abandonCheckout: jest.fn().mockResolvedValue(undefined),
    releaseCheckout: jest.fn().mockResolvedValue(undefined),
    logOperation: jest.fn().mockResolvedValue(undefined),
    getAccountContact: jest.fn().mockResolvedValue({ email: 'payer@x.com', phone: null, locale: 'ru' })
  }
}

const tbank: any = {
  initPayment: jest.fn().mockResolvedValue({ PaymentId: 999, PaymentURL: 'https://tbank/pay/999' }),
  chargeRecurrent: jest.fn().mockResolvedValue({ Success: true, PaymentId: 'chg_1', Status: 'CONFIRMED' }),
  cancelPayment: jest.fn().mockResolvedValue({ Success: true, Status: 'CANCELED' }),
  // Default: the held payment is still an unpaid link, so cancelling it is the right move.
  getPaymentState: jest.fn().mockResolvedValue({ Success: true, Status: 'NEW' })
}

// The error shape the tbank SDK throws: message/details are localized, ErrorCode lands on `code`
// (see tbank-payments lib/core/client.js).
function tbankError (code: string, message: string, details: string): Error {
  const err: any = new Error(message)
  err.code = code
  err.details = details
  return err
}
const config: any = { TbankTerminalKey: 'term', TbankTaxation: 'usn_income', TbankVatTax: 'none' }

// Drive handleUpdatePlan with a storage stub + request body; returns the response recorder.
async function run (storage: any, body: any, subPlans = plans): Promise<any> {
  const res = makeRes()
  const req: any = { params: { id: 'tbank_100' }, body }
  await handleUpdatePlan(makeCtx(), config, tbank, storage, subPlans, req, res)
  return res
}

beforeEach(() => {
  tbank.initPayment.mockClear()
  tbank.chargeRecurrent.mockClear()
  tbank.chargeRecurrent.mockResolvedValue({ Success: true, PaymentId: 'chg_1', Status: 'CONFIRMED' })
  tbank.cancelPayment.mockReset()
  tbank.cancelPayment.mockResolvedValue({ Success: true, Status: 'CANCELED' })
  tbank.getPaymentState.mockReset()
  tbank.getPaymentState.mockResolvedValue({ Success: true, Status: 'NEW' })
})

describe('handleUpdatePlan claim guard', () => {
  it('rejects a true no-op (same plan+seats+period) with 400', async () => {
    const storage = makeStorage({ claimed: true, intentId: 'i1' })
    const res = await run(storage, { plan: 'business', quantity: 3, period: 'monthly' })
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('Already on this plan')
    expect(storage.claimCheckout).not.toHaveBeenCalled()
  })

  it('seat change on a sub without a live paid period falls through to a checkout', async () => {
    // baseSub has no periodStart/periodEnd -> proration can't run -> full checkout (winner path).
    const storage = makeStorage({ claimed: true, intentId: 'i1' })
    const res = await run(storage, { plan: 'business', quantity: 6, period: 'monthly' })
    expect(tbank.initPayment).toHaveBeenCalledTimes(1)
    expect(res.body.checkoutUrl).toBe('https://tbank/pay/999')
    // Old sub marked pending-replacement, new pending sub created.
    const marked = storage.upsert.mock.calls.find((c: any[]) => c[0].providerData?.pendingReplacement === true)
    expect(marked).toBeDefined()
    // The charge is audited to the ledger (init_charge, 6 seats * 90000 = 540000 kopecks).
    const logged = storage.logOperation.mock.calls.find((c: any[]) => c[0].operation === 'init_charge')
    expect(logged).toBeDefined()
    expect(logged[0].amount).toBe(540000)
    expect(logged[0].subscriptionId).toBe('tbank_100')
  })

  it('loser with the SAME order reuses the winner URL (no second charge)', async () => {
    const storage = makeStorage({
      claimed: false,
      intentId: 'i1',
      heartbeatAt: Date.now(),
      orderFingerprint: 'business:6:monthly',
      paymentUrl: 'https://tbank/pay/winner',
      paymentId: '500',
      createdOn: Date.now()
    })
    const res = await run(storage, { plan: 'business', quantity: 6, period: 'monthly' })
    expect(tbank.initPayment).not.toHaveBeenCalled() // NO second checkout
    expect(res.body.checkoutUrl).toBe('https://tbank/pay/winner')
  })

  it('loser with a DIFFERENT order and no force gets 409 other_checkout_active', async () => {
    const storage = makeStorage({
      claimed: false,
      intentId: 'i1',
      heartbeatAt: Date.now(),
      orderFingerprint: 'business:9:monthly', // a different seat count is already being paid
      paymentUrl: 'https://tbank/pay/other',
      paymentId: '501',
      createdOn: Date.now()
    })
    const res = await run(storage, { plan: 'business', quantity: 6, period: 'monthly' })
    expect(res.statusCode).toBe(409)
    expect(res.body.reason).toBe('other_checkout_active')
    expect(tbank.initPayment).not.toHaveBeenCalled()
  })

  // Expired unpaid link, same order: cancel old, open new - no 409.
  it('same order with an expired link -> old link cancelled, new checkout opened', async () => {
    const expired = {
      claimed: false,
      intentId: 'i1',
      heartbeatAt: Date.now() - 6 * 60 * 1000,
      orderFingerprint: 'business:6:monthly', // same order as the request below
      paymentUrl: 'https://tbank/pay/expired',
      paymentId: '8958051027',
      createdOn: Date.now() - 6 * 60 * 1000 // older than CHECKOUT_LINK_LIFETIME_MS (5 min)
    }
    const storage = makeStorage(expired)
    storage.claimCheckout.mockResolvedValueOnce(expired).mockResolvedValueOnce({ claimed: true, intentId: 'i2' })
    // An unpaid link: GetState says NEW and tbank accepts the cancel.
    tbank.getPaymentState.mockResolvedValue({ Success: true, Status: 'NEW' })
    tbank.cancelPayment.mockResolvedValue({ Success: true, Status: 'CANCELED' })

    const res = await run(storage, { plan: 'business', quantity: 6, period: 'monthly' })

    expect(storage.releaseCheckout).toHaveBeenCalledWith('8958051027')
    expect(res.statusCode).toBe(200)
    expect(res.body.checkoutUrl).toBe('https://tbank/pay/999')
  })

  // Forced switch has to cancel the stale checkout at tbank first. If that cancel throws, the claim
  // row survives in payment_intent and every later attempt dies on it — the checkout deadlocks itself.
  describe('forced switch over a stale checkout', () => {
    const staleClaim = {
      claimed: false,
      intentId: 'i1',
      heartbeatAt: Date.now(),
      orderFingerprint: 'business:5:monthly', // a different order is holding the claim
      paymentUrl: 'https://tbank/pay/stale',
      paymentId: '8931598935',
      createdOn: Date.now()
    }

    it('tbank refuses the cancel with ErrorCode 4 -> claim released, new checkout opened', async () => {
      const storage = makeStorage(staleClaim)
      // Second claimCheckout (after the release) succeeds.
      storage.claimCheckout.mockResolvedValueOnce(staleClaim).mockResolvedValueOnce({ claimed: true, intentId: 'i2' })
      tbank.cancelPayment.mockRejectedValue(
        tbankError('4', 'Не получится изменить статус платежа', 'Изменение статуса не разрешено.')
      )

      const res = await run(storage, { plan: 'business', quantity: 6, period: 'monthly', force: true })

      // The stale payment_intent row is freed, not left behind.
      expect(storage.releaseCheckout).toHaveBeenCalledWith('8931598935')
      // And the user gets a payable link instead of a 500.
      expect(tbank.initPayment).toHaveBeenCalledTimes(1)
      expect(res.statusCode).toBe(200)
      expect(res.body.checkoutUrl).toBe('https://tbank/pay/999')
    })

    it('a cancel failure that is NOT a dead link still propagates', async () => {
      const storage = makeStorage(staleClaim)
      tbank.cancelPayment.mockRejectedValue(tbankError('9999', 'Внутренняя ошибка', 'Попробуйте позже.'))

      // Unknown failure: do not free a claim whose payment might still be alive.
      await expect(run(storage, { plan: 'business', quantity: 6, period: 'monthly', force: true })).rejects.toThrow(
        'Внутренняя ошибка'
      )
      expect(storage.releaseCheckout).not.toHaveBeenCalled()
      expect(tbank.initPayment).not.toHaveBeenCalled()
    })

    // Cancel on settled = refund -> GetState first, stale claim just released.
    it('held payment already settled -> no cancel call, claim released, new checkout opened', async () => {
      const storage = makeStorage(staleClaim)
      storage.claimCheckout.mockResolvedValueOnce(staleClaim).mockResolvedValueOnce({ claimed: true, intentId: 'i2' })
      tbank.getPaymentState.mockResolvedValue({ Success: true, Status: 'CONFIRMED' })

      const res = await run(storage, { plan: 'business', quantity: 6, period: 'monthly', force: true })

      expect(tbank.cancelPayment).not.toHaveBeenCalled()
      expect(storage.releaseCheckout).toHaveBeenCalledWith('8931598935')
      expect(res.statusCode).toBe(200)
      expect(res.body.checkoutUrl).toBe('https://tbank/pay/999')
    })

    // AUTHORIZED = hold: Cancel releases it without refund, must not be skipped.
    it('held payment is AUTHORIZED -> hold is cancelled before the claim is freed', async () => {
      const storage = makeStorage(staleClaim)
      storage.claimCheckout.mockResolvedValueOnce(staleClaim).mockResolvedValueOnce({ claimed: true, intentId: 'i2' })
      tbank.getPaymentState.mockResolvedValue({ Success: true, Status: 'AUTHORIZED' })
      tbank.cancelPayment.mockResolvedValue({ Success: true, Status: 'CANCELED' })

      const res = await run(storage, { plan: 'business', quantity: 6, period: 'monthly', force: true })

      expect(tbank.cancelPayment).toHaveBeenCalledTimes(1)
      expect(storage.releaseCheckout).toHaveBeenCalledWith('8931598935')
      expect(res.statusCode).toBe(200)
    })

    // GetState outage must not wedge the checkout: fall through to Cancel.
    it('GetState fails -> falls through to Cancel, claim released', async () => {
      const storage = makeStorage(staleClaim)
      storage.claimCheckout.mockResolvedValueOnce(staleClaim).mockResolvedValueOnce({ claimed: true, intentId: 'i2' })
      tbank.getPaymentState.mockRejectedValue(new Error('ECONNRESET'))
      tbank.cancelPayment.mockResolvedValue({ Success: true, Status: 'CANCELED' })

      const res = await run(storage, { plan: 'business', quantity: 6, period: 'monthly', force: true })

      expect(tbank.cancelPayment).toHaveBeenCalledTimes(1)
      expect(storage.releaseCheckout).toHaveBeenCalledWith('8931598935')
      expect(res.statusCode).toBe(200)
    })

    // Settled between GetState and Cancel: refund logged, claim freed.
    it('payment settles between GetState and Cancel -> refund is logged, claim freed', async () => {
      const storage = makeStorage(staleClaim)
      storage.claimCheckout.mockResolvedValueOnce(staleClaim).mockResolvedValueOnce({ claimed: true, intentId: 'i2' })
      tbank.getPaymentState.mockResolvedValue({ Success: true, Status: 'NEW' })
      tbank.cancelPayment.mockResolvedValue({ Success: true, Status: 'REFUNDED', OriginalAmount: 49900 })

      const res = await run(storage, { plan: 'business', quantity: 6, period: 'monthly', force: true })

      const logged = storage.logOperation.mock.calls.find((c: any[]) => c[0].operation === 'refund')
      expect(logged).toBeDefined()
      expect(logged[0]).toMatchObject({ paymentId: '8931598935', status: 'REFUNDED', amount: 49900 })
      expect(storage.releaseCheckout).toHaveBeenCalledWith('8931598935')
      expect(res.statusCode).toBe(200)
    })

    // Success:false is RETURNED by the client, not thrown, so the ErrorCode 4 catch branch never sees it.
    it('cancel declined with ErrorCode 4 in the response body -> claim released', async () => {
      const storage = makeStorage(staleClaim)
      storage.claimCheckout.mockResolvedValueOnce(staleClaim).mockResolvedValueOnce({ claimed: true, intentId: 'i2' })
      tbank.cancelPayment.mockResolvedValue({ Success: false, ErrorCode: '4', Status: 'CONFIRMED' })

      const res = await run(storage, { plan: 'business', quantity: 6, period: 'monthly', force: true })

      expect(storage.releaseCheckout).toHaveBeenCalledWith('8931598935')
      expect(res.statusCode).toBe(200)
    })

    // ErrorCode 4 on a dead (not settled) link: the pending draft is abandoned, not just released.
    it('cancel declined with ErrorCode 4 on an expired link -> draft abandoned, claim released', async () => {
      const storage = makeStorage(staleClaim)
      storage.claimCheckout.mockResolvedValueOnce(staleClaim).mockResolvedValueOnce({ claimed: true, intentId: 'i2' })
      const draft = { status: SubscriptionStatus.PastDue, providerData: { pending: true } }
      storage.getByProviderId = jest.fn().mockResolvedValue(draft)
      tbank.cancelPayment.mockResolvedValue({ Success: false, ErrorCode: '4', Status: 'DEADLINE_EXPIRED' })

      const res = await run(storage, { plan: 'business', quantity: 6, period: 'monthly', force: true })

      const abandoned = storage.upsert.mock.calls.find((c: any[]) => c[0].providerData?.status === 'ABANDONED')
      expect(abandoned).toBeDefined()
      expect(storage.releaseCheckout).toHaveBeenCalledWith('8931598935')
      expect(res.statusCode).toBe(200)
    })

    // Non-terminal state after failed Cancel: link maybe payable -> keep claim, 409.
    it('cancel leaves the payment in a non-terminal state -> 409 already_paid, no second charge', async () => {
      const storage = makeStorage(staleClaim)
      tbank.cancelPayment.mockResolvedValue({ Success: false, ErrorCode: '9999', Status: 'FORM_SHOWED' })

      const res = await run(storage, { plan: 'business', quantity: 6, period: 'monthly', force: true })

      expect(res.statusCode).toBe(409)
      expect(res.body.reason).toBe('already_paid')
      expect(storage.releaseCheckout).not.toHaveBeenCalled()
      expect(tbank.initPayment).not.toHaveBeenCalled()
    })
  })

  it('loser while the winner has not written the URL yet gets 409 in_flight', async () => {
    const storage = makeStorage({ claimed: false, intentId: 'i1', heartbeatAt: Date.now() })
    const res = await run(storage, { plan: 'business', quantity: 6, period: 'monthly' })
    expect(res.statusCode).toBe(409)
    expect(res.body.reason).toBe('in_flight')
    expect(tbank.initPayment).not.toHaveBeenCalled()
  })

  it('a package change is guarded by the same claim (type=package)', async () => {
    const pkgSub = { ...baseSub, type: 'package', plan: '100gb', providerData: { period: 'monthly' } }
    const storage = makeStorage({ claimed: true, intentId: 'i1' }, pkgSub)
    const res = await run(storage, { plan: '500gb' }, { '500gb@package': { amount: 500000, yearlyDiscount: 0 } })
    // Claim uses the subscription's type — package, independent of the tier checkout key.
    expect(storage.claimCheckout).toHaveBeenCalledWith('ws-1', 'package', expect.any(String))
    expect(res.body.checkoutUrl).toBe('https://tbank/pay/999')
  })

  it('package downgrade within paid credit switches in place: no checkout, cancel cleared', async () => {
    const now = Date.now()
    const pkgSub = {
      ...baseSub,
      type: 'package',
      plan: '500gb',
      amount: 1000000,
      periodStart: now - 5 * 24 * 3600 * 1000,
      periodEnd: now + 25 * 24 * 3600 * 1000,
      willCancelAt: now + 25 * 24 * 3600 * 1000,
      providerData: { period: 'monthly' }
    }
    const storage = makeStorage({ claimed: true, intentId: 'i1' }, pkgSub)
    const res = await run(storage, { plan: '100gb' }, { '100gb@package': { amount: 500000, yearlyDiscount: 0 } })
    expect(res.statusCode).toBe(200)
    expect(res.body.checkoutUrl).toBeUndefined()
    expect(res.body.plan).toBe('100gb')
    expect(res.body.amount).toBe(500000)
    expect(res.body.willCancelAt).toBeUndefined()
    expect(tbank.initPayment).not.toHaveBeenCalled()
    expect(storage.claimCheckout).not.toHaveBeenCalled()
    const upserted = storage.upsert.mock.calls[0][0]
    expect(upserted.status).toBe('active')
    expect(upserted.canceledAt).toBeUndefined()
  })

  it('package upgrade WITHOUT a saved card falls through to a checkout', async () => {
    const now = Date.now()
    const pkgSub = {
      ...baseSub,
      type: 'package',
      plan: '100gb',
      amount: 500000,
      periodStart: now - 15 * DAY,
      periodEnd: now + 15 * DAY,
      providerData: { period: 'monthly' } // no rebillId
    }
    const storage = makeStorage({ claimed: true, intentId: 'i1' }, pkgSub)
    const res = await run(storage, { plan: '500gb' }, { '500gb@package': { amount: 1000000, yearlyDiscount: 0 } })
    expect(res.body.checkoutUrl).toBe('https://tbank/pay/999')
    expect(tbank.chargeRecurrent).not.toHaveBeenCalled()
  })
})

describe('handleUpdatePlan proration (live paid sub with a saved card)', () => {
  const now = Date.now()
  // A live business tier: 5 seats @ 90000 = 450000, 30d period, ~15 days left, card saved.
  const liveTier: any = {
    ...baseSub,
    amount: 450000,
    periodStart: now - 15 * DAY,
    periodEnd: now + 15 * DAY,
    providerData: { quantity: 5, period: 'monthly', rebillId: 'reb_1', orderId: 'ord_1' }
  }

  it('seat downgrade: no charge, in place, period extended by the credit', async () => {
    const storage = makeStorage({ claimed: true, intentId: 'i1' }, liveTier)
    const res = await run(storage, { plan: 'business', quantity: 3, period: 'monthly' })
    expect(res.statusCode).toBe(200)
    expect(res.body.checkoutUrl).toBeUndefined()
    expect(tbank.initPayment).not.toHaveBeenCalled()
    expect(tbank.chargeRecurrent).not.toHaveBeenCalled()
    expect(storage.claimCheckout).not.toHaveBeenCalled()
    expect(res.body.amount).toBe(270000) // 3 * 90000, the new full price
    expect(res.body.providerData.quantity).toBe(3)
    expect(res.body.periodEnd).toBeGreaterThan(liveTier.periodEnd) // credit extends it
  })

  it('seat upgrade: opens a checkout charging only the DELTA, draft carries the full recurring price', async () => {
    const storage = makeStorage({ claimed: true, intentId: 'i1' }, liveTier)
    const res = await run(storage, { plan: 'business', quantity: 8, period: 'monthly' })
    expect(res.statusCode).toBe(200)
    expect(res.body.checkoutUrl).toBe('https://tbank/pay/999') // redirect to the bank
    // Only 3 added seats for ~15d: 3 * (450000/5/30) * 15 ~= 135000 (old formula billed 495000).
    // Wall-clock drift shaves a few kopecks off daysLeft, then floors to rubles -> range check.
    expect(tbank.initPayment).toHaveBeenCalledTimes(1)
    const amount = tbank.initPayment.mock.calls[0][0].Amount
    expect(amount).toBeGreaterThan(134000)
    expect(amount).toBeLessThanOrEqual(135000)
    // No off-session charge — the money is taken with explicit consent on the bank page.
    expect(tbank.chargeRecurrent).not.toHaveBeenCalled()
    // The pending draft records the FULL recurring price (720000), not the delta, so renewal bills full.
    const draft = storage.upsert.mock.calls.map((c: any[]) => c[0]).find((s: any) => s.providerData?.pending === true)
    expect(draft.amount).toBe(720000)
    // Renewal date is unchanged — adding seats mid-period must not reset the period to now+30d.
    expect(draft.periodEnd).toBe(liveTier.periodEnd)
    // init_charge is audited at the same delta amount actually charged now.
    const logged = storage.logOperation.mock.calls.find((c: any[]) => c[0].operation === 'init_charge')
    expect(logged[0].amount).toBe(amount)
  })

  it('package upgrade: opens a checkout charging the DELTA, draft carries the full price', async () => {
    const pkgSub = {
      ...liveTier,
      type: 'package',
      plan: '100gb',
      amount: 500000,
      providerData: { period: 'monthly', rebillId: 'reb_1', orderId: 'ord_1' }
    }
    const storage = makeStorage({ claimed: true, intentId: 'i1' }, pkgSub)
    const res = await run(storage, { plan: '500gb' }, { '500gb@package': { amount: 1000000, yearlyDiscount: 0 } })
    expect(res.statusCode).toBe(200)
    expect(res.body.checkoutUrl).toBe('https://tbank/pay/999')
    // Only the price diff for ~15 remaining days: (1000000-500000)/30*15 ~= 250000 (old: 750000).
    // Wall-clock drift shaves a few kopecks, then floors to rubles -> range check.
    const amount = tbank.initPayment.mock.calls[0][0].Amount
    expect(amount).toBeGreaterThan(249000)
    expect(amount).toBeLessThanOrEqual(250000)
    expect(tbank.chargeRecurrent).not.toHaveBeenCalled()
    const draft = storage.upsert.mock.calls.map((c: any[]) => c[0]).find((s: any) => s.providerData?.pending === true)
    expect(draft.amount).toBe(1000000) // full recurring price
    expect(draft.periodEnd).toBe(pkgSub.periodEnd) // renewal date unchanged, not reset to now+30d
  })

  it('yearly seat upgrade: checkout delta, and the draft keeps the yearly period (not reset to 30d)', async () => {
    const now = Date.now()
    // 5 seats yearly, 365d period, ~100 days left.
    const yearlyTier = {
      ...liveTier,
      amount: 4500000,
      periodStart: now - 265 * DAY,
      periodEnd: now + 100 * DAY,
      providerData: { quantity: 5, period: 'yearly', rebillId: 'reb_1', orderId: 'ord_1' }
    }
    const storage = makeStorage({ claimed: true, intentId: 'i1' }, yearlyTier)
    const res = await run(storage, { plan: 'business', quantity: 8, period: 'yearly' })
    expect(res.statusCode).toBe(200)
    expect(res.body.checkoutUrl).toBe('https://tbank/pay/999')
    expect(tbank.chargeRecurrent).not.toHaveBeenCalled()
    const draft = storage.upsert.mock.calls.map((c: any[]) => c[0]).find((s: any) => s.providerData?.pending === true)
    // Yearly upgrade must keep the far-future period end, not reset to now+30d.
    expect(draft.periodEnd).toBe(yearlyTier.periodEnd)
  })
})

describe('handleUpdatePlan recurring-charge consent', () => {
  const now = Date.now()
  // Live per-seat tier with a consented autopay already in place.
  const recurrentSub: any = {
    ...baseSub,
    amount: 450000,
    periodStart: now - 15 * DAY,
    periodEnd: now + 15 * DAY,
    providerData: { quantity: 5, period: 'monthly', rebillId: 'reb_1', orderId: 'ord_1', recurrent: true }
  }

  it('recurrent: true sends Recurrent=Y to Init and records the consent on the draft', async () => {
    const storage = makeStorage({ claimed: true, intentId: 'i1' })
    await run(storage, { plan: 'business', quantity: 6, period: 'monthly', recurrent: true })
    expect(tbank.initPayment.mock.calls[0][0].Recurrent).toBe('Y')
    const draft = storage.upsert.mock.calls.map((c: any[]) => c[0]).find((s: any) => s.providerData?.pending === true)
    expect(draft.providerData.recurrent).toBe(true)
  })

  it('recurrent: false omits Recurrent entirely (one-off payment, no card saved)', async () => {
    const storage = makeStorage({ claimed: true, intentId: 'i1' })
    await run(storage, { plan: 'business', quantity: 6, period: 'monthly', recurrent: false })
    expect(tbank.initPayment.mock.calls[0][0].Recurrent).toBeUndefined()
    const draft = storage.upsert.mock.calls.map((c: any[]) => c[0]).find((s: any) => s.providerData?.pending === true)
    expect(draft.providerData.recurrent).toBe(false)
  })

  it('omitted flag keeps the existing consent (a seat-only change must not cancel autopay)', async () => {
    const storage = makeStorage({ claimed: true, intentId: 'i1' }, recurrentSub)
    // Seat upgrade with no recurrent field in the body.
    await run(storage, { plan: 'business', quantity: 8, period: 'monthly' })
    expect(tbank.initPayment.mock.calls[0][0].Recurrent).toBe('Y')
  })

  it('packages honour the consent too (flat price, seats forced to 1)', async () => {
    const pkgSub = { ...baseSub, type: 'package', plan: '100gb', providerData: { period: 'monthly' } }
    const storage = makeStorage({ claimed: true, intentId: 'i1' }, pkgSub)
    await run(storage, { plan: '500gb', recurrent: false }, { '500gb@package': { amount: 500000, yearlyDiscount: 0 } })
    expect(tbank.initPayment.mock.calls[0][0].Recurrent).toBeUndefined()
    const draft = storage.upsert.mock.calls.map((c: any[]) => c[0]).find((s: any) => s.providerData?.pending === true)
    expect(draft.providerData.recurrent).toBe(false)
  })

  it('no-charge downgrade carries the consent onto the updated subscription', async () => {
    const storage = makeStorage({ claimed: true, intentId: 'i1' }, recurrentSub)
    const res = await run(storage, { plan: 'business', quantity: 3, period: 'monthly' })
    expect(res.statusCode).toBe(200)
    expect(res.body.providerData.recurrent).toBe(true)
  })
})

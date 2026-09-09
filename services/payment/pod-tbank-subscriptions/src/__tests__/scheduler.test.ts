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
import { startScheduler } from '../scheduler'
import { setMailSender } from '../notifications'

const NOW = Date.UTC(2026, 6, 19)

const baseSub: any = {
  id: 'tbank_1',
  provider: 'tbank',
  providerSubscriptionId: '1',
  workspaceUuid: 'ws-1',
  accountUuid: 'acc-1',
  type: 'tier',
  plan: 'business',
  status: SubscriptionStatus.Active,
  amount: 49900,
  periodEnd: NOW - 1000,
  providerData: { rebillId: 'reb_1', period: 'monthly' }
}

function makeCtx (): any {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

// Only getCandidates is driven by the scheduler cycle; other calls in cleanup/grace/scheduledCancel
// loops read the same list, so an empty result there keeps those cycles inert for these tests.
function makeStorage (sub: any, claim: any, extra: Partial<Record<string, any>> = {}): any {
  return {
    getCandidates: jest.fn().mockResolvedValue([sub]),
    getById: jest.fn().mockResolvedValue(sub),
    claimRenewal: jest.fn().mockResolvedValue(claim),
    reclaimStaleCharge: jest.fn().mockResolvedValue(false),
    markCharge: jest.fn().mockResolvedValue(undefined),
    heartbeatCharge: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    logOperation: jest.fn().mockResolvedValue(undefined),
    getAccountContact: jest.fn().mockResolvedValue({ email: 'payer@x.com', phone: null, locale: 'ru' }),
    ...extra
  }
}

const config: any = { GracePeriodDays: 7, TbankTaxation: 'usn_income', TbankVatTax: 'none' }

// Start the scheduler, flush the immediate renewal-cycle microtasks, then close it.
// Returns the ctx so tests can assert logged markers. Accepts a config override for mail-alert tests.
async function runOneTick (tbank: any, storage: any, cfg: any = config): Promise<{ ctx: any }> {
  const ctx = makeCtx()
  const handle = startScheduler(ctx, tbank, storage, cfg, 60)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await handle.close()
  return { ctx }
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] })
  jest.setSystemTime(NOW)
})

afterEach(() => {
  jest.useRealTimers()
})

describe('scheduler renewal claim outcomes', () => {
  test('claim lost, status charged -> chargeRecurrent not called, no upsert (already renewed elsewhere)', async () => {
    const storage = makeStorage(baseSub, { claimed: false, status: 'charged', intentId: 'i1' })
    const tbank: any = { chargeRecurrent: jest.fn() }
    await runOneTick(tbank, storage)
    expect(tbank.chargeRecurrent).not.toHaveBeenCalled()
    expect(storage.upsert).not.toHaveBeenCalled()
    expect(storage.markCharge).not.toHaveBeenCalled()
  })

  test('claim lost, status pending + fresh heartbeat -> skip, no charge', async () => {
    const storage = makeStorage(baseSub, {
      claimed: false,
      status: 'pending',
      intentId: 'i1',
      heartbeatAt: NOW - 500 // well inside LEASE_TIMEOUT_MS (10s)
    })
    const tbank: any = { chargeRecurrent: jest.fn() }
    await runOneTick(tbank, storage)
    expect(tbank.chargeRecurrent).not.toHaveBeenCalled()
    expect(storage.reclaimStaleCharge).not.toHaveBeenCalled()
    expect(storage.upsert).not.toHaveBeenCalled()
  })

  test('claim lost, stale pending lease, reclaim wins -> markCharge charged, renewed, no chargeRecurrent', async () => {
    const storage = makeStorage(
      baseSub,
      { claimed: false, status: 'pending', intentId: 'i1', heartbeatAt: NOW - 20000 },
      { reclaimStaleCharge: jest.fn().mockResolvedValue(true) }
    )
    const tbank: any = { chargeRecurrent: jest.fn() }
    await runOneTick(tbank, storage)
    expect(tbank.chargeRecurrent).not.toHaveBeenCalled()
    expect(storage.markCharge).toHaveBeenCalledWith('i1', 'charged')
    const renewed = storage.upsert.mock.calls.find((c: any[]) => c[0].providerData?.status === 'ACTIVE')
    expect(renewed).toBeDefined()
  })

  test('claim lost, status pending + stale lease, reclaim loses -> nothing changes', async () => {
    const storage = makeStorage(
      baseSub,
      { claimed: false, status: 'pending', intentId: 'i1', heartbeatAt: NOW - 20000 },
      { reclaimStaleCharge: jest.fn().mockResolvedValue(false) }
    )
    const tbank: any = { chargeRecurrent: jest.fn() }
    await runOneTick(tbank, storage)
    expect(tbank.chargeRecurrent).not.toHaveBeenCalled()
    expect(storage.markCharge).not.toHaveBeenCalled()
    expect(storage.upsert).not.toHaveBeenCalled()
  })

  test('successful chargeRecurrent -> markCharge charged, logOperation success, upsert renewed', async () => {
    const storage = makeStorage(baseSub, { claimed: true, status: 'new', intentId: 'i1' })
    const tbank: any = {
      initPayment: jest.fn().mockResolvedValue({ Success: true, PaymentId: 'init_1' }),
      chargeRecurrent: jest.fn().mockResolvedValue({ Success: true, PaymentId: 'pay_1' })
    }
    await runOneTick(tbank, storage)
    expect(storage.markCharge).toHaveBeenCalledWith('i1', 'charged', 'pay_1')
    const logged = storage.logOperation.mock.calls.find((c: any[]) => c[0].operation === 'charge_recurrent')
    expect(logged[0].status).toBe('success')
    expect(logged[0].raw.attempt).toBe(1)
    const renewed = storage.upsert.mock.calls.find((c: any[]) => c[0].providerData?.status === 'ACTIVE')
    expect(renewed).toBeDefined()
  })

  test('renewal Init carries a fiscal receipt when the payer email resolves', async () => {
    const storage = makeStorage(baseSub, { claimed: true, status: 'new', intentId: 'i1' })
    const tbank: any = {
      initPayment: jest.fn().mockResolvedValue({ Success: true, PaymentId: 'init_1' }),
      chargeRecurrent: jest.fn().mockResolvedValue({ Success: true, PaymentId: 'pay_1' })
    }
    await runOneTick(tbank, storage)
    const receipt = tbank.initPayment.mock.calls[0][0].Receipt
    expect(receipt.Email).toBe('payer@x.com')
    expect(receipt.Taxation).toBe('usn_income')
    expect(receipt.Items[0].Amount).toBe(baseSub.amount)
  })

  test('no email -> receipt falls back to the account phone', async () => {
    const storage = makeStorage(
      baseSub,
      { claimed: true, status: 'new', intentId: 'i1' },
      { getAccountContact: jest.fn().mockResolvedValue({ email: null, phone: '+79001234567', locale: 'ru' }) }
    )
    const tbank: any = {
      initPayment: jest.fn().mockResolvedValue({ Success: true, PaymentId: 'init_1' }),
      chargeRecurrent: jest.fn().mockResolvedValue({ Success: true, PaymentId: 'pay_1' })
    }
    await runOneTick(tbank, storage)
    const receipt = tbank.initPayment.mock.calls[0][0].Receipt
    expect(receipt.Phone).toBe('+79001234567')
    expect(receipt.Email).toBeUndefined()
  })

  test('no email and no phone -> abort WITHOUT charging, mark failed, PastDue (54-ФЗ)', async () => {
    const storage = makeStorage(
      baseSub,
      { claimed: true, status: 'new', intentId: 'i1' },
      { getAccountContact: jest.fn().mockResolvedValue({ email: null, phone: null, locale: null }) }
    )
    global.fetch = jest.fn() as any // mail goes to the queue, never over HTTP
    const tbank: any = { initPayment: jest.fn(), chargeRecurrent: jest.fn() }
    const { ctx } = await runOneTick(tbank, storage)
    // Never initiated or charged — no receipt-less payment.
    expect(tbank.initPayment).not.toHaveBeenCalled()
    expect(tbank.chargeRecurrent).not.toHaveBeenCalled()
    // Marked failed (NOT pending): the lease-expiry takeover must not assume-pay this.
    expect(storage.markCharge).toHaveBeenCalledWith('i1', 'failed')
    const failed = storage.upsert.mock.calls.find((c: any[]) => c[0].providerData?.status === 'CHARGE_FAILED')
    expect(failed).toBeDefined()
    expect(failed[0].status).toBe(SubscriptionStatus.PastDue)
    // Operational alert marker is always logged (fires external alerting even without BillingEmails).
    const marker = ctx.error.mock.calls.find((c: any[]) => c[1]?.marker === 'receipt_blocked')
    expect(marker).toBeDefined()
    expect(marker[1].code).toBe('NO_RECEIPT_CONTACT')
  })

  test('no-contact renewal with BillingEmails set -> sends a team alert email', async () => {
    const storage = makeStorage(
      baseSub,
      { claimed: true, status: 'new', intentId: 'i1' },
      { getAccountContact: jest.fn().mockResolvedValue({ email: null, phone: null, locale: null }) }
    )
    const mailConfig = { ...config, MailFrom: 'noreply@x.com', BillingEmails: ['ops@x.com'] }
    const mails: any[] = []
    setMailSender(async (_ctx: any, to: string, msg: any) => {
      mails.push({ to, ...msg })
    })
    const tbank: any = { initPayment: jest.fn(), chargeRecurrent: jest.fn() }
    await runOneTick(tbank, storage, mailConfig)
    // A team alert email was queued for pod-mail; no charge happened.
    expect(tbank.chargeRecurrent).not.toHaveBeenCalled()
    const mail = mails.find((m) => m.to === 'ops@x.com')
    expect(mail).toBeDefined()
    expect(mail.subject).toContain('54-ФЗ')
  })

  test('account lookup throws during receipt build -> abort WITHOUT charging, mark failed, PastDue (not unknown/pending)', async () => {
    // A lookup failure aborts the renewal before any charge. It must NOT leave the intent pending —
    // a pending intent gets assumed-paid by the lease takeover -> a free, receipt-less renewal.
    const storage = makeStorage(
      baseSub,
      { claimed: true, status: 'new', intentId: 'i1' },
      { getAccountContact: jest.fn().mockRejectedValue(new Error('accounts down')) }
    )
    global.fetch = jest.fn() as any // notifyRenewalFailure publishes to the queue, not over HTTP
    const tbank: any = { initPayment: jest.fn(), chargeRecurrent: jest.fn() }
    await runOneTick(tbank, storage)
    expect(tbank.initPayment).not.toHaveBeenCalled()
    expect(tbank.chargeRecurrent).not.toHaveBeenCalled()
    // Marked failed, NOT left pending for a lease-expiry assume-paid takeover.
    expect(storage.markCharge).toHaveBeenCalledWith('i1', 'failed')
    const logged = storage.logOperation.mock.calls.find((c: any[]) => c[0].operation === 'charge_recurrent')
    expect(logged[0].status).toBe('failed') // 'failed', not 'unknown'
    const failed = storage.upsert.mock.calls.find((c: any[]) => c[0].providerData?.status === 'CHARGE_FAILED')
    expect(failed).toBeDefined()
    expect(failed[0].status).toBe(SubscriptionStatus.PastDue)
  })

  test('chargeRecurrent Success=false -> markCharge failed, logOperation failed, PastDue upsert, notify', async () => {
    const storage = makeStorage(baseSub, { claimed: true, status: 'new', intentId: 'i1' })
    const tbank: any = {
      initPayment: jest.fn().mockResolvedValue({ Success: true, PaymentId: 'init_1' }),
      chargeRecurrent: jest.fn().mockResolvedValue({ Success: false, ErrorCode: '111', Message: 'declined' })
    }
    global.fetch = jest.fn() as any // notifyPaymentFailed publishes to the queue: no sender wired here, so nothing is sent
    await runOneTick(tbank, storage)
    expect(storage.markCharge).toHaveBeenCalledWith('i1', 'failed')
    const logged = storage.logOperation.mock.calls.find((c: any[]) => c[0].operation === 'charge_recurrent')
    expect(logged[0].status).toBe('failed')
    expect(logged[0].raw.attempt).toBe(1)
    const failed = storage.upsert.mock.calls.find((c: any[]) => c[0].providerData?.status === 'CHARGE_FAILED')
    expect(failed).toBeDefined()
    expect(failed[0].status).toBe(SubscriptionStatus.PastDue)
  })

  test('chargeRecurrent throws -> markCharge not called, status unknown logged, CHARGE_ERROR upsert', async () => {
    const storage = makeStorage(baseSub, { claimed: true, status: 'new', intentId: 'i1' })
    const tbank: any = {
      initPayment: jest.fn().mockResolvedValue({ Success: true, PaymentId: 'init_1' }),
      chargeRecurrent: jest.fn().mockRejectedValue(new Error('timeout'))
    }
    await runOneTick(tbank, storage)
    expect(storage.markCharge).not.toHaveBeenCalled()
    const logged = storage.logOperation.mock.calls.find((c: any[]) => c[0].operation === 'charge_recurrent')
    expect(logged[0].status).toBe('unknown')
    expect(logged[0].raw).toMatchObject({ message: 'timeout', attempt: 1 })
    const errored = storage.upsert.mock.calls.find((c: any[]) => c[0].providerData?.status === 'CHARGE_ERROR')
    expect(errored).toBeDefined()
  })

  test('heartbeat interval is cleared after the charge settles (no leaked timer)', async () => {
    const storage = makeStorage(baseSub, { claimed: true, status: 'new', intentId: 'i1' })
    const tbank: any = {
      initPayment: jest.fn().mockResolvedValue({ Success: true, PaymentId: 'init_1' }),
      chargeRecurrent: jest.fn().mockResolvedValue({ Success: true, PaymentId: 'pay_1' })
    }
    const setSpy = jest.spyOn(global, 'setInterval')
    const clearSpy = jest.spyOn(global, 'clearInterval')
    await runOneTick(tbank, storage)
    // Every interval id created (heartbeat + the 4 scheduler timers) was passed to clearInterval by close().
    const createdIds = setSpy.mock.results.map((r) => r.value)
    const clearedIds = clearSpy.mock.calls.map((c) => c[0])
    for (const id of createdIds) expect(clearedIds).toContain(id)
    setSpy.mockRestore()
    clearSpy.mockRestore()
  })
})

// A one-off purchase saves no card, so the renewal cycle skips it forever; without this expiry it
// would stay Active past periodEnd indefinitely.
describe('one-off subscription expiry', () => {
  const oneOffTier: any = {
    ...baseSub,
    providerData: { period: 'monthly', recurrent: false }
  }
  // No claim is ever taken: expiry moves no money.
  const noRenewal = { claimed: false, status: 'charged', intentId: 'i1' }

  it('expired one-off tier -> Canceled with the marker pod-payment turns into the free plan', async () => {
    const storage = makeStorage(oneOffTier, noRenewal)
    await runOneTick({}, storage)

    const written = storage.upsert.mock.calls.map((c: any[]) => c[0]).find((s: any) => s.status === 'canceled')
    expect(written).toBeDefined()
    // isFinalizedUserCancel (pod-payment) keys the free-plan fallback off exactly this value.
    expect(written.providerData.status).toBe('CANCELED')
    expect(written.canceledAt).toBe(NOW)
  })

  it('expired one-off package -> Canceled as well (no free-plan fallback applies to packages)', async () => {
    const pkg = { ...oneOffTier, type: 'package', plan: '100gb' }
    const storage = makeStorage(pkg, noRenewal)
    await runOneTick({}, storage)

    const written = storage.upsert.mock.calls.map((c: any[]) => c[0]).find((s: any) => s.status === 'canceled')
    expect(written).toBeDefined()
    expect(written.type).toBe('package')
  })

  it('a one-time purchase is never expired: its effect lives in the purchases table', async () => {
    // AI-token top-ups carry recurrent:false and a meaningless periodEnd, so without a type guard
    // this cycle would cancel them and mail the user that access "ended".
    const purchase = { ...oneOffTier, type: 'purchase', plan: 'ai-tokens-1m' }
    const storage = makeStorage(purchase, noRenewal)
    await runOneTick({}, storage)

    expect(storage.upsert).not.toHaveBeenCalled()
  })

  it('one-off still inside its paid period is left alone', async () => {
    const live = { ...oneOffTier, periodEnd: NOW + 60_000 }
    const storage = makeStorage(live, noRenewal)
    await runOneTick({}, storage)

    expect(storage.upsert).not.toHaveBeenCalled()
  })

  it('a recurring subscription is never expired by this cycle (it renews instead)', async () => {
    // baseSub is recurrent (rebillId, no recurrent:false) and already past periodEnd.
    const storage = makeStorage(baseSub, noRenewal)
    await runOneTick({}, storage)

    const canceled = storage.upsert.mock.calls.map((c: any[]) => c[0]).find((s: any) => s.status === 'canceled')
    expect(canceled).toBeUndefined()
  })

  it('a pending first payment is not expired (its checkout may still complete)', async () => {
    const pending = { ...oneOffTier, providerData: { ...oneOffTier.providerData, pending: true } }
    const storage = makeStorage(pending, noRenewal)
    await runOneTick({}, storage)

    expect(storage.upsert).not.toHaveBeenCalled()
  })

  it('re-fetch showing an extended period aborts the expiry (repurchase race)', async () => {
    const storage = makeStorage(oneOffTier, noRenewal, {
      // Candidate looks expired, but the fresh read has a live period again.
      getById: jest.fn().mockResolvedValue({ ...oneOffTier, periodEnd: NOW + 60_000 })
    })
    await runOneTick({}, storage)

    expect(storage.upsert).not.toHaveBeenCalled()
  })
})

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

import { createServer as createHttpServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { SubscriptionStatus } from '@hcengineering/account-client'
import { createServer, processWebhook } from '../server'

const activeSub: any = {
  id: 'tbank_1',
  provider: 'tbank',
  providerSubscriptionId: 'pay_1',
  workspaceUuid: 'ws-1',
  accountUuid: 'acc-1',
  type: 'tier',
  plan: 'business',
  status: SubscriptionStatus.Active,
  amount: 49900,
  periodEnd: Date.now() + 1000000,
  providerData: { rebillId: 'reb_1', period: 'monthly', pending: false, paymentId: 'pay_1' }
}

function makeStorage (sub: any = null): any {
  return {
    getByProviderId: jest.fn().mockResolvedValue(sub),
    getById: jest.fn().mockResolvedValue(sub),
    getAll: jest.fn().mockResolvedValue(sub !== null ? [sub] : []),
    upsert: jest.fn().mockResolvedValue(undefined),
    logOperation: jest.fn().mockResolvedValue(undefined),
    releaseCheckout: jest.fn().mockResolvedValue(undefined),
    getAccountContact: jest.fn().mockResolvedValue({ email: 'payer@x.com', phone: null, locale: 'ru' }),
    getTransactionCount: jest.fn().mockResolvedValue(0)
  }
}

// GetState mock returns Success:false by default, so processWebhook skips the recheck branch and trusts
// the webhook status as-is. Pass an explicit getState (Success:true) to exercise the recheck path.
function makeTbank (verifyResult = true, getState?: any): any {
  return {
    verifyNotificationSignature: jest.fn().mockReturnValue(verifyResult),
    getPaymentState: jest.fn().mockResolvedValue(getState ?? { Success: false }),
    removeCard: jest.fn().mockResolvedValue({ Success: true })
  }
}

const baseConfig: any = {
  FrontUrl: 'https://front',
  TbankTerminalKey: 'term',
  TbankSkipWebhookVerification: false,
  PaymentUrl: 'https://payment'
}

const newCtx = (): any => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })
const realFetch = global.fetch

// ---- HTTP ingress: only verify + enqueue happen here; effects are the consumer's job. ----
async function startServer (
  config: any,
  tbank: any,
  storage: any,
  enqueue: any
): Promise<{ server: Server, url: string }> {
  const ctx = newCtx()
  // createServer loads the shared plan-config on boot via fetch; stub only that one call, then restore
  // the real fetch so the test's own webhook POST goes over the wire.
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any
  const { app } = await createServer(ctx, config, tbank, storage, enqueue)
  global.fetch = realFetch
  const server = createHttpServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${port}/api/v1/webhooks/tbank` }
}

async function postWebhook (url: string, body: Record<string, any>): Promise<Response> {
  return await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('handleWebhook (HTTP ingress)', () => {
  test('invalid token -> 200 OK, nothing enqueued', async () => {
    const enqueue = jest.fn().mockResolvedValue(undefined)
    const { server, url } = await startServer(baseConfig, makeTbank(false), makeStorage(activeSub), enqueue)
    try {
      const res = await postWebhook(url, { PaymentId: 'pay_1', Status: 'CONFIRMED', Token: 'bad', Amount: 49900 })
      expect(res.status).toBe(200)
      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      server.close()
    }
  })

  test('valid token -> 200 OK, enqueued as verified', async () => {
    const enqueue = jest.fn().mockResolvedValue(undefined)
    const { server, url } = await startServer(baseConfig, makeTbank(true), makeStorage(activeSub), enqueue)
    try {
      const res = await postWebhook(url, { PaymentId: 'pay_1', Status: 'CONFIRMED', Token: 'ok', Amount: 49900 })
      expect(res.status).toBe(200)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ PaymentId: 'pay_1' }), true)
    } finally {
      server.close()
    }
  })

  test('skip-verification -> enqueued as unverified', async () => {
    const enqueue = jest.fn().mockResolvedValue(undefined)
    const cfg = { ...baseConfig, TbankSkipWebhookVerification: true }
    const { server, url } = await startServer(cfg, makeTbank(false), makeStorage(null), enqueue)
    try {
      const res = await postWebhook(url, { PaymentId: 'unknown_pay', Status: 'CONFIRMED', Amount: 100 })
      expect(res.status).toBe(200)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ PaymentId: 'unknown_pay' }), false)
    } finally {
      server.close()
    }
  })

  test('enqueue failure -> 500 so the bank redelivers', async () => {
    const enqueue = jest.fn().mockRejectedValue(new Error('queue down'))
    const { server, url } = await startServer(baseConfig, makeTbank(true), makeStorage(activeSub), enqueue)
    try {
      const res = await postWebhook(url, { PaymentId: 'pay_1', Status: 'CONFIRMED', Token: 'ok', Amount: 49900 })
      expect(res.status).toBe(500)
    } finally {
      server.close()
    }
  })
})

describe('processWebhook (consumer)', () => {
  test('CONFIRMED status mismatch with GetState -> ignored, no upsert', async () => {
    const storage = makeStorage(activeSub)
    const tbank = makeTbank(true, { Success: true, Status: 'REJECTED' })
    await processWebhook(
      newCtx(),
      baseConfig,
      tbank,
      storage,
      { PaymentId: 'pay_1', Status: 'CONFIRMED', Amount: 49900 },
      true
    )
    expect(storage.upsert).not.toHaveBeenCalled()
  })

  // AUTHORIZED is a hold: audited in the ledger, but never activates and never frees the claim.
  test.each([
    ['already settled', 'CONFIRMED'],
    ['still held', 'AUTHORIZED']
  ])('AUTHORIZED webhook (%s) -> recorded only, no activation', async (_name, actualStatus) => {
    const pendingSub = {
      ...activeSub,
      status: SubscriptionStatus.PastDue,
      providerData: { ...activeSub.providerData, pending: true }
    }
    const storage = makeStorage(pendingSub)
    const tbank = makeTbank(true, { Success: true, Status: actualStatus })
    await processWebhook(
      newCtx(),
      baseConfig,
      tbank,
      storage,
      { PaymentId: 'pay_1', Status: 'AUTHORIZED', Amount: 49900 },
      true
    )
    expect(storage.logOperation).toHaveBeenCalledWith(expect.objectContaining({ status: 'AUTHORIZED' }))
    expect(storage.upsert).not.toHaveBeenCalled()
    expect(storage.releaseCheckout).not.toHaveBeenCalled()
  })

  test('CONFIRMED webhook but GetState still reports a hold -> alarms and activates anyway', async () => {
    const pendingSub = {
      ...activeSub,
      status: SubscriptionStatus.PastDue,
      providerData: { ...activeSub.providerData, pending: true }
    }
    const storage = makeStorage(pendingSub)
    const ctx = newCtx()
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any
    try {
      await processWebhook(
        ctx,
        baseConfig,
        makeTbank(true, { Success: true, Status: 'AUTHORIZED' }),
        storage,
        { PaymentId: 'pay_1', Status: 'CONFIRMED', Amount: 49900 },
        true
      )
    } finally {
      global.fetch = realFetch
    }
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('GetState still reports a hold'), expect.anything())
    const activated = storage.upsert.mock.calls.find((c: any[]) => c[0].status === SubscriptionStatus.Active)
    expect(activated).toBeDefined()
  })

  test('CONFIRMED webhook after a recorded AUTHORIZED -> activates and sends the receipt', async () => {
    const pendingSub = {
      ...activeSub,
      status: SubscriptionStatus.PastDue,
      providerData: { ...activeSub.providerData, pending: true }
    }
    const storage = makeStorage(pendingSub)
    const mailConfig = { ...baseConfig, MailUrl: 'http://mail', MailFrom: 'noreply@x.com' }
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any
    try {
      await processWebhook(
        newCtx(),
        mailConfig,
        makeTbank(true, { Success: true, Status: 'CONFIRMED' }),
        storage,
        { PaymentId: 'pay_1', Status: 'CONFIRMED', Amount: 49900, RebillId: 'reb_final' },
        true
      )
    } finally {
      global.fetch = realFetch
    }
    const activated = storage.upsert.mock.calls.find((c: any[]) => c[0].status === SubscriptionStatus.Active)
    expect(activated).toBeDefined()
    expect(activated[0].providerData.rebillId).toBe('reb_final')
    expect(storage.releaseCheckout).toHaveBeenCalled()
  })

  test('GetState Success:false -> warns and activates on the verified webhook alone', async () => {
    const pendingSub = {
      ...activeSub,
      status: SubscriptionStatus.PastDue,
      providerData: { ...activeSub.providerData, pending: true }
    }
    const storage = makeStorage(pendingSub)
    const ctx = newCtx()
    const tbank = makeTbank(true, { Success: false, ErrorCode: '9999', Message: 'Internal error' })
    await processWebhook(
      ctx,
      baseConfig,
      tbank,
      storage,
      { PaymentId: 'pay_1', Status: 'CONFIRMED', Amount: 49900 },
      true
    )
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining('Success:false'), expect.anything())
    const activated = storage.upsert.mock.calls.find((c: any[]) => c[0].status === SubscriptionStatus.Active)
    expect(activated).toBeDefined()
  })

  test('repeat CONFIRMED on already-Active non-pending sub -> idempotent, no upsert', async () => {
    const storage = makeStorage(activeSub)
    await processWebhook(
      newCtx(),
      baseConfig,
      makeTbank(true),
      storage,
      { PaymentId: 'pay_1', Status: 'CONFIRMED', Amount: 49900 },
      true
    )
    expect(storage.upsert).not.toHaveBeenCalled()
  })

  test('REJECTED on wasActive=true -> PastDue and notify attempted', async () => {
    const storage = makeStorage(activeSub)
    const mailConfig = { ...baseConfig, MailUrl: 'http://mail', MailFrom: 'noreply@x.com' }
    // Notify does real HTTP (plan-config + mail) — stub it so the test never hits the network.
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any
    try {
      await processWebhook(
        newCtx(),
        mailConfig,
        makeTbank(true),
        storage,
        { PaymentId: 'pay_1', Status: 'REJECTED', Amount: 49900 },
        true
      )
    } finally {
      global.fetch = realFetch
    }
    const pastDue = storage.upsert.mock.calls.find((c: any[]) => c[0].status === SubscriptionStatus.PastDue)
    expect(pastDue).toBeDefined()
    expect(storage.getAccountContact).toHaveBeenCalled()
  })

  test.each(['REVERSED', 'REFUNDED'])('%s (refund) on Active sub -> PastDue, NO dunning email', async (status) => {
    const storage = makeStorage(activeSub)
    const mailConfig = { ...baseConfig, MailUrl: 'http://mail', MailFrom: 'noreply@x.com' }
    // Guard: if notify regresses back in, the stubbed fetch must be observed instead of a network hang.
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    global.fetch = fetchMock as any
    try {
      await processWebhook(
        newCtx(),
        mailConfig,
        makeTbank(true),
        storage,
        { PaymentId: 'pay_1', Status: status, Amount: 49900 },
        true
      )
    } finally {
      global.fetch = realFetch
    }
    const pastDue = storage.upsert.mock.calls.find((c: any[]) => c[0].status === SubscriptionStatus.PastDue)
    expect(pastDue).toBeDefined()
    expect(storage.getAccountContact).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('REJECTED on a PastDue sub with a DIFFERENT prior status -> upsert, no notify', async () => {
    // First time this REJECTED lands (prior providerData.status was a charge-fail marker, not REJECTED).
    const storage = makeStorage({
      ...activeSub,
      status: SubscriptionStatus.PastDue,
      providerData: { ...activeSub.providerData, status: 'CHARGE_FAILED', pending: false }
    })
    await processWebhook(
      newCtx(),
      baseConfig,
      makeTbank(true),
      storage,
      { PaymentId: 'pay_1', Status: 'REJECTED', Amount: 49900 },
      true
    )
    expect(storage.upsert).toHaveBeenCalled()
    expect(storage.getAccountContact).not.toHaveBeenCalled()
  })

  test('duplicate REJECTED (same status already applied, non-pending) -> idempotent, no upsert', async () => {
    const storage = makeStorage({
      ...activeSub,
      status: SubscriptionStatus.PastDue,
      providerData: { ...activeSub.providerData, status: 'REJECTED', pending: false }
    })
    await processWebhook(
      newCtx(),
      baseConfig,
      makeTbank(true),
      storage,
      { PaymentId: 'pay_1', Status: 'REJECTED', Amount: 49900 },
      true
    )
    expect(storage.upsert).not.toHaveBeenCalled()
    expect(storage.getAccountContact).not.toHaveBeenCalled()
  })

  test('DEADLINE_EXPIRED on active (not pending-first) sub -> no cancel, releases checkout', async () => {
    const storage = makeStorage(activeSub)
    await processWebhook(
      newCtx(),
      baseConfig,
      makeTbank(true),
      storage,
      { PaymentId: 'pay_1', Status: 'DEADLINE_EXPIRED', Amount: 49900 },
      true
    )
    expect(storage.upsert).not.toHaveBeenCalled()
    expect(storage.releaseCheckout).toHaveBeenCalledWith('pay_1')
  })

  // The AUTHORIZED -> CONFIRMED pair the DEMO terminal sends: the hold is only recorded, and the
  // CONFIRMED that follows does the whole activation (claim release + receipt + final RebillId).
  test('AUTHORIZED then CONFIRMED: the hold is recorded, CONFIRMED activates and releases the claim', async () => {
    const draft = {
      ...activeSub,
      status: SubscriptionStatus.PastDue,
      providerData: { ...activeSub.providerData, pending: true, paymentId: 8958842784 }
    }
    const storage = makeStorage(draft)
    const notification = { PaymentId: 8958842784, Status: 'AUTHORIZED', Amount: 100000, RebillId: 1 }

    await processWebhook(newCtx(), baseConfig, makeTbank(true), storage, notification, true)

    // The hold neither activates the sub nor frees the claim; the draft stays pending for CONFIRMED.
    expect(storage.upsert).not.toHaveBeenCalled()
    expect(storage.releaseCheckout).not.toHaveBeenCalled()

    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any
    try {
      await processWebhook(
        newCtx(),
        baseConfig,
        makeTbank(true),
        storage,
        { ...notification, Status: 'CONFIRMED' },
        true
      )
    } finally {
      global.fetch = realFetch
    }
    const activated = storage.upsert.mock.calls.at(-1)[0]
    expect(activated.status).toBe(SubscriptionStatus.Active)
    expect(activated.providerData.pending).toBe(false)
    expect(storage.releaseCheckout).toHaveBeenCalledWith('8958842784')
  })

  // Draft already gone (e.g. cleaned up): the claim must not leak on the early sub-null return.
  test('CONFIRMED with no matching subscription still releases the claim', async () => {
    const storage = makeStorage(null)
    await processWebhook(
      newCtx(),
      baseConfig,
      makeTbank(true),
      storage,
      { PaymentId: 'pay_x', Status: 'CONFIRMED', Amount: 100 },
      true
    )
    expect(storage.releaseCheckout).toHaveBeenCalledWith('pay_x')
    expect(storage.upsert).not.toHaveBeenCalled()
  })

  test('CONFIRMED with pendingReplacement cancels the old subscription', async () => {
    const newSub = {
      ...activeSub,
      id: 'tbank_2',
      providerSubscriptionId: 'pay_2',
      status: SubscriptionStatus.PastDue,
      providerData: { pending: true, paymentId: 'pay_2' }
    }
    const oldSub = {
      ...activeSub,
      id: 'tbank_1',
      providerSubscriptionId: 'pay_1',
      providerData: { ...activeSub.providerData, pendingReplacement: true }
    }
    const storage = makeStorage(newSub)
    storage.getAll = jest.fn().mockResolvedValue([oldSub, newSub])
    await processWebhook(
      newCtx(),
      baseConfig,
      makeTbank(true),
      storage,
      { PaymentId: 'pay_2', Status: 'CONFIRMED', Amount: 49900 },
      true
    )
    const canceled = storage.upsert.mock.calls.find((c: any[]) => c[0].id === 'tbank_1')
    expect(canceled).toBeDefined()
    expect(canceled[0].status).toBe(SubscriptionStatus.Canceled)
  })

  test('CONFIRMED purchase cancels nothing: purchases coexist and share the tier card', async () => {
    const purchase = {
      ...activeSub,
      id: 'purchase_2',
      type: 'purchase',
      plan: 'tokens-1m',
      providerSubscriptionId: 'pay_2',
      status: SubscriptionStatus.PastDue,
      providerData: { pending: true, paymentId: 'pay_2' }
    }
    const earlierPurchase = {
      ...purchase,
      id: 'purchase_1',
      providerSubscriptionId: 'pay_1',
      status: SubscriptionStatus.Active
    }
    const storage = makeStorage(purchase)
    storage.getAll = jest.fn().mockResolvedValue([earlierPurchase, activeSub, purchase])

    await processWebhook(
      newCtx(),
      baseConfig,
      makeTbank(true),
      storage,
      { PaymentId: 'pay_2', Status: 'CONFIRMED', Amount: 49900 },
      true
    )

    const canceled = storage.upsert.mock.calls.filter((c: any[]) => c[0].status === SubscriptionStatus.Canceled)
    expect(canceled).toHaveLength(0)
  })

  test('delta-upgrade CONFIRMED: activated sub bills the FULL recurring price from the draft, not the delta', async () => {
    const now = Date.now()
    const yearlyEnd = now + 100 * 24 * 3600 * 1000
    const draft = {
      ...activeSub,
      id: 'tbank_2',
      providerSubscriptionId: 'pay_2',
      status: SubscriptionStatus.PastDue,
      amount: 720000,
      periodStart: now - 265 * 24 * 3600 * 1000,
      periodEnd: yearlyEnd,
      providerData: { pending: true, paymentId: 'pay_2', period: 'yearly' }
    }
    const storage = makeStorage(draft)
    storage.getAll = jest.fn().mockResolvedValue([draft])
    await processWebhook(
      newCtx(),
      baseConfig,
      makeTbank(true),
      storage,
      { PaymentId: 'pay_2', Status: 'CONFIRMED', Amount: 495000 },
      true
    )
    const activated = storage.upsert.mock.calls.map((c: any[]) => c[0]).find((s: any) => s.id === 'tbank_2')
    expect(activated.status).toBe(SubscriptionStatus.Active)
    expect(activated.amount).toBe(720000)
    expect(activated.periodEnd).toBe(yearlyEnd)
  })
})

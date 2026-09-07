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
import { notifyUpcoming, notifyExpired } from '../notifications'

// Stub the whole notifications module: this suite asserts *which* reminder the scheduler picks
// and when, not how the email renders. jest.mock is hoisted above the imports, so the factory may
// not close over anything defined here — the mock fns are reached through the imported binding.
jest.mock('../notifications', () => ({
  notifyUpcoming: jest.fn().mockResolvedValue(undefined),
  notifyExpired: jest.fn().mockResolvedValue(undefined),
  notifyPaymentFailed: jest.fn().mockResolvedValue(undefined),
  notifyPaymentSucceeded: jest.fn().mockResolvedValue(undefined),
  notifyReceiptBlocked: jest.fn().mockResolvedValue(undefined),
  buildChargeDescription: jest.fn().mockResolvedValue('desc')
}))

const notifyUpcomingMock = notifyUpcoming as jest.MockedFunction<typeof notifyUpcoming>
const notifyExpiredMock = notifyExpired as jest.MockedFunction<typeof notifyExpired>

const NOW = Date.UTC(2026, 6, 19)
const DAY = 24 * 60 * 60 * 1000

const config: any = { GracePeriodDays: 7, UpcomingNoticeDays: 5, MailFrom: 'a@b.c' }

// Active recurrent tier, charge due in 3 days -> inside the 5-day notice window.
const recurrentSub: any = {
  id: 'tbank_1',
  provider: 'tbank',
  providerSubscriptionId: '1',
  workspaceUuid: 'ws-1',
  accountUuid: 'acc-1',
  type: 'tier',
  plan: 'business',
  status: SubscriptionStatus.Active,
  amount: 49900,
  periodEnd: NOW + 3 * DAY,
  providerData: { rebillId: 'reb_1', period: 'monthly' }
}

// getCandidates feeds the paid subscriptions; it defaults to empty so the unrelated cycles
// (renewal/cleanup/grace/cancel) stay inert. Trials live in pod-payment, not here.
function makeStorage (paid: any[] = [], extra: Record<string, any> = {}): any {
  const byId = new Map<string, any>(paid.map((s) => [s.id, s]))
  return {
    getCandidates: jest.fn().mockResolvedValue(paid),
    getById: jest.fn().mockImplementation(async (id: string) => byId.get(id) ?? null),
    claimRenewal: jest.fn().mockResolvedValue({ claimed: false, status: 'charged', intentId: 'i1' }),
    reclaimStaleCharge: jest.fn().mockResolvedValue(false),
    markCharge: jest.fn().mockResolvedValue(undefined),
    heartbeatCharge: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    logOperation: jest.fn().mockResolvedValue(undefined),
    getAccountContact: jest.fn().mockResolvedValue({ name: 'X', email: 'payer@x.com', phone: null, locale: 'ru' }),
    ...extra
  }
}

async function runOneTick (storage: any, cfg: any = config): Promise<void> {
  const ctx: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const tbank: any = { chargeRecurrent: jest.fn(), removeCard: jest.fn() }
  const handle = startScheduler(ctx, tbank, storage, cfg, 60)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await handle.close()
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] })
  jest.setSystemTime(NOW)
  notifyUpcomingMock.mockClear()
  notifyExpiredMock.mockClear()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('upcoming-expiry reminder: window', () => {
  test('due inside the notice window -> reminder sent', async () => {
    await runOneTick(makeStorage([recurrentSub]))
    expect(notifyUpcomingMock).toHaveBeenCalledTimes(1)
    expect(notifyUpcomingMock.mock.calls[0][4]).toBe('recurrent')
    expect(notifyUpcomingMock.mock.calls[0][5]).toBe(recurrentSub.periodEnd)
  })

  test('due beyond the notice window -> silent', async () => {
    const far = { ...recurrentSub, periodEnd: NOW + 30 * DAY }
    await runOneTick(makeStorage([far]))
    expect(notifyUpcomingMock).not.toHaveBeenCalled()
  })

  test('due date already passed -> silent (a late "5 days left" is pointless)', async () => {
    const past = { ...recurrentSub, periodEnd: NOW - DAY }
    await runOneTick(makeStorage([past]))
    expect(notifyUpcomingMock).not.toHaveBeenCalled()
  })
})

describe('upcoming-expiry reminder: kind', () => {
  test('recurrent tier with a saved card -> recurrent', async () => {
    await runOneTick(makeStorage([recurrentSub]))
    expect(notifyUpcomingMock.mock.calls[0][4]).toBe('recurrent')
  })

  test('non-recurrent subscription -> oneoff', async () => {
    const oneoff = { ...recurrentSub, providerData: { ...recurrentSub.providerData, recurrent: false } }
    await runOneTick(makeStorage([oneoff]))
    expect(notifyUpcomingMock.mock.calls[0][4]).toBe('oneoff')
  })

  test('recurrent flag set but no saved card -> oneoff (nothing can be charged)', async () => {
    const noCard = { ...recurrentSub, providerData: { period: 'monthly' } }
    await runOneTick(makeStorage([noCard]))
    expect(notifyUpcomingMock.mock.calls[0][4]).toBe('oneoff')
  })

  test('scheduled cancel -> canceled, wins over the recurrent/one-off split', async () => {
    const canceling = { ...recurrentSub, willCancelAt: recurrentSub.periodEnd }
    await runOneTick(makeStorage([canceling]))
    expect(notifyUpcomingMock.mock.calls[0][4]).toBe('canceled')
  })

  test('package keeps its own family but the same kind', async () => {
    const pkg = { ...recurrentSub, type: 'package', plan: 'storage-100gb' }
    await runOneTick(makeStorage([pkg]))
    expect(notifyUpcomingMock).toHaveBeenCalledTimes(1)
    expect(notifyUpcomingMock.mock.calls[0][3].type).toBe('package')
  })
})

describe('upcoming-expiry reminder: skipped states', () => {
  test('pending first payment -> silent', async () => {
    const pending = { ...recurrentSub, providerData: { ...recurrentSub.providerData, pending: true } }
    await runOneTick(makeStorage([pending]))
    expect(notifyUpcomingMock).not.toHaveBeenCalled()
  })

  test('past_due -> silent (dunning owns that conversation)', async () => {
    const pastDue = { ...recurrentSub, status: SubscriptionStatus.PastDue }
    await runOneTick(makeStorage([pastDue]))
    expect(notifyUpcomingMock).not.toHaveBeenCalled()
  })

  test('one-time purchase -> silent (nothing renews or runs out)', async () => {
    const purchase = { ...recurrentSub, type: 'purchase', plan: 'ai-tokens-1m' }
    await runOneTick(makeStorage([purchase]))
    expect(notifyUpcomingMock).not.toHaveBeenCalled()
  })
})

describe('upcoming-expiry reminder: idempotency', () => {
  test('already notified for this date -> no second email', async () => {
    const notified = {
      ...recurrentSub,
      providerData: { ...recurrentSub.providerData, upcomingNotifiedFor: recurrentSub.periodEnd }
    }
    await runOneTick(makeStorage([notified]))
    expect(notifyUpcomingMock).not.toHaveBeenCalled()
  })

  test('notified for an earlier period -> the new period still gets its email', async () => {
    const renewed = {
      ...recurrentSub,
      providerData: { ...recurrentSub.providerData, upcomingNotifiedFor: NOW - 27 * DAY }
    }
    await runOneTick(makeStorage([renewed]))
    expect(notifyUpcomingMock).toHaveBeenCalledTimes(1)
  })

  test('flag is written before the email is sent', async () => {
    const storage = makeStorage([recurrentSub])
    const order: string[] = []
    storage.upsert.mockImplementation(async (d: any) => {
      if (d.providerData?.upcomingNotifiedFor !== undefined) order.push('flag')
    })
    notifyUpcomingMock.mockImplementation(async () => {
      order.push('mail')
    })
    await runOneTick(storage)
    expect(order).toEqual(['flag', 'mail'])
  })

  test('re-fetch shows the period moved -> stale reminder is dropped', async () => {
    const storage = makeStorage([recurrentSub])
    // A renewal landed between the scan and the re-fetch: periodEnd is a month further out.
    storage.getById.mockResolvedValue({ ...recurrentSub, periodEnd: NOW + 33 * DAY })
    await runOneTick(storage)
    expect(notifyUpcomingMock).not.toHaveBeenCalled()
    expect(storage.upsert).not.toHaveBeenCalled()
  })

  test('re-fetch shows another pod already notified -> no duplicate', async () => {
    const storage = makeStorage([recurrentSub])
    storage.getById.mockResolvedValue({
      ...recurrentSub,
      providerData: { ...recurrentSub.providerData, upcomingNotifiedFor: recurrentSub.periodEnd }
    })
    await runOneTick(storage)
    expect(notifyUpcomingMock).not.toHaveBeenCalled()
  })
})

describe('access-ended email: which kind the scheduler picks', () => {
  // Expired one-off: periodEnd in the past, no auto-renewal, still Active.
  const expiredOneOff: any = {
    ...recurrentSub,
    periodEnd: NOW - DAY,
    providerData: { period: 'monthly', recurrent: false }
  }

  test('one-off ran out -> oneoff, dated by periodEnd not by the tick', async () => {
    await runOneTick(makeStorage([expiredOneOff]))
    expect(notifyExpiredMock).toHaveBeenCalledTimes(1)
    expect(notifyExpiredMock.mock.calls[0][4]).toBe('oneoff')
    expect(notifyExpiredMock.mock.calls[0][5]).toBe(expiredOneOff.periodEnd)
  })

  test('the user had scheduled a cancel -> canceled, not oneoff', async () => {
    const canceled = { ...expiredOneOff, willCancelAt: NOW - DAY }
    await runOneTick(makeStorage([canceled]))
    expect(notifyExpiredMock.mock.calls[0][4]).toBe('canceled')
  })

  test('a canceled one-off matches both cycles but is emailed once', async () => {
    // willCancelAt == periodEnd, so expireOneOffSubscriptions and enforceScheduledCancel both see it.
    // getById returns the pre-cancel row, so neither is stopped by the other's write — only the
    // recurrent check in enforceScheduledCancel keeps this from sending twice.
    const canceled = { ...expiredOneOff, willCancelAt: expiredOneOff.periodEnd }
    await runOneTick(makeStorage([canceled]))
    expect(notifyExpiredMock).toHaveBeenCalledTimes(1)
  })

  test('a one-off with no saved card and no recurrent flag is still emailed once', async () => {
    // recurrent:false is what routes it; a row that never set the flag must not fall through to both.
    const canceled = { ...expiredOneOff, providerData: { period: 'monthly' }, willCancelAt: expiredOneOff.periodEnd }
    await runOneTick(makeStorage([canceled]))
    expect(notifyExpiredMock).toHaveBeenCalledTimes(1)
  })

  test('period still running -> nothing sent', async () => {
    const live = { ...expiredOneOff, periodEnd: NOW + 30 * DAY }
    await runOneTick(makeStorage([live]))
    expect(notifyExpiredMock).not.toHaveBeenCalled()
  })

  test('re-fetch shows a repurchase extended the period -> no email', async () => {
    const storage = makeStorage([expiredOneOff])
    storage.getById.mockResolvedValue({ ...expiredOneOff, periodEnd: NOW + 30 * DAY })
    await runOneTick(storage)
    expect(notifyExpiredMock).not.toHaveBeenCalled()
  })

  test('recurrent cancel takes effect -> canceled, dated by willCancelAt', async () => {
    // Recurrent with a card: expireOneOffSubscriptions skips it, enforceScheduledCancel finalizes it.
    const scheduled = { ...recurrentSub, periodEnd: NOW - DAY, willCancelAt: NOW - DAY }
    await runOneTick(makeStorage([scheduled]))
    expect(notifyExpiredMock).toHaveBeenCalledTimes(1)
    expect(notifyExpiredMock.mock.calls[0][4]).toBe('canceled')
    expect(notifyExpiredMock.mock.calls[0][5]).toBe(scheduled.willCancelAt)
  })
})

describe('access-ended email: grace period', () => {
  // Failed renewal with retries exhausted, period ended more than GracePeriodDays (7) ago.
  const graceExpired: any = {
    ...recurrentSub,
    status: SubscriptionStatus.PastDue,
    periodEnd: NOW - 8 * DAY,
    providerData: { ...recurrentSub.providerData, retryAttempt: 3 }
  }

  test('grace ran out -> grace, dated by the end of the grace window', async () => {
    await runOneTick(makeStorage([graceExpired]))
    expect(notifyExpiredMock).toHaveBeenCalledTimes(1)
    expect(notifyExpiredMock.mock.calls[0][4]).toBe('grace')
    // periodEnd + 7 days, not the tick time: the mail names when access actually stopped.
    expect(notifyExpiredMock.mock.calls[0][5]).toBe(graceExpired.periodEnd + 7 * DAY)
  })

  test('still inside the grace window -> silent', async () => {
    const inGrace = { ...graceExpired, periodEnd: NOW - 2 * DAY }
    await runOneTick(makeStorage([inGrace]))
    expect(notifyExpiredMock).not.toHaveBeenCalled()
  })

  test('retries not exhausted -> silent (dunning still owns it)', async () => {
    const retrying = { ...graceExpired, providerData: { ...graceExpired.providerData, retryAttempt: 1 } }
    await runOneTick(makeStorage([retrying]))
    expect(notifyExpiredMock).not.toHaveBeenCalled()
  })

  test('a pending first-payment draft is never emailed', async () => {
    const draft = { ...graceExpired, providerData: { ...graceExpired.providerData, pending: true } }
    await runOneTick(makeStorage([draft]))
    expect(notifyExpiredMock).not.toHaveBeenCalled()
  })
})

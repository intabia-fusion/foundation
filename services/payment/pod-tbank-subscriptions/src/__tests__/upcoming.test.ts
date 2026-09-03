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
import { notifyUpcoming } from '../notifications'

// Stub the whole notifications module: this suite asserts *which* reminder the scheduler picks
// and when, not how the email renders. jest.mock is hoisted above the imports, so the factory may
// not close over anything defined here — the mock fns are reached through the imported binding.
jest.mock('../notifications', () => ({
  notifyUpcoming: jest.fn().mockResolvedValue(undefined),
  notifyPaymentFailed: jest.fn().mockResolvedValue(undefined),
  notifyPaymentSucceeded: jest.fn().mockResolvedValue(undefined),
  notifyReceiptBlocked: jest.fn().mockResolvedValue(undefined),
  buildChargeDescription: jest.fn().mockResolvedValue('desc')
}))

const notifyUpcomingMock = notifyUpcoming as jest.MockedFunction<typeof notifyUpcoming>

const NOW = Date.UTC(2026, 6, 19)
const DAY = 24 * 60 * 60 * 1000

const config: any = { GracePeriodDays: 7, UpcomingNoticeDays: 5, MailUrl: 'http://mail', MailFrom: 'a@b.c' }

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

const trialSub: any = {
  id: 'trial_1',
  provider: 'trial',
  providerSubscriptionId: 'trial-1',
  workspaceUuid: 'ws-2',
  accountUuid: 'acc-2',
  type: 'tier',
  plan: 'business',
  status: SubscriptionStatus.Trialing,
  trialEnd: NOW + 3 * DAY,
  providerData: { quantity: 10 }
}

// getCandidates feeds the paid subscriptions; getTrialCandidates feeds trials. Both default to
// empty so the unrelated cycles (renewal/cleanup/grace/cancel) stay inert.
function makeStorage (paid: any[] = [], trials: any[] = [], extra: Record<string, any> = {}): any {
  const byId = new Map<string, any>([...paid, ...trials].map((s) => [s.id, s]))
  return {
    getCandidates: jest.fn().mockResolvedValue(paid),
    getTrialCandidates: jest.fn().mockResolvedValue(trials),
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

  test('trial -> trial, dated by trialEnd', async () => {
    await runOneTick(makeStorage([], [trialSub]))
    expect(notifyUpcomingMock).toHaveBeenCalledTimes(1)
    expect(notifyUpcomingMock.mock.calls[0][4]).toBe('trial')
    expect(notifyUpcomingMock.mock.calls[0][5]).toBe(trialSub.trialEnd)
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

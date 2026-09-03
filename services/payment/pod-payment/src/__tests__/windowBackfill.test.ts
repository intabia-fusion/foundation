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

import { SubscriptionStatus, SubscriptionType } from '@hcengineering/account-client'
import { backfillWindowLimits } from '../windowBackfill'

describe('backfillWindowLimits', () => {
  let ctx: any

  const sub = (id: string, limits?: any, plan = 'business'): any => ({
    id,
    workspaceUuid: `ws-${id}`,
    provider: 'tbank',
    type: SubscriptionType.Tier,
    status: SubscriptionStatus.Active,
    plan,
    limits,
    providerData: { quantity: 3 }
  })

  const client = (subs: any[]): any => ({
    getSubscriptionsByProvider: jest.fn(async () => subs),
    upsertSubscriptionsBulk: jest.fn(async (batch: any[]) => batch.map((s) => ({ id: s.id, ok: true })))
  })

  // Mirrors the pod's resolveLimits: per-seat plans scale the window by paid seats. `boundless` is a
  // plan whose config sets windowMonthLimit 0 on purpose.
  const resolve = (s: any): any =>
    s.plan === 'unknown'
      ? undefined
      : s.plan === 'boundless'
        ? { usersLimit: 3, windowMonthLimit: 0 }
        : { usersLimit: 3, windowMonthLimit: 300000 * (s.providerData?.quantity ?? 1) }

  beforeEach(() => {
    ctx = { info: jest.fn(), error: jest.fn(), warn: jest.fn() }
  })

  it('fills the window for subscriptions that have none', async () => {
    const accountClient = client([sub('a', { usersLimit: 3 })])

    const updated = await backfillWindowLimits(ctx, accountClient, resolve)

    expect(updated).toBe(1)
    const written = accountClient.upsertSubscriptionsBulk.mock.calls[0][0]
    expect(written[0].limits.windowMonthLimit).toBe(900000)
  })

  it('leaves an existing window alone', async () => {
    const accountClient = client([sub('a', { usersLimit: 3, windowMonthLimit: 1000000 })])

    const updated = await backfillWindowLimits(ctx, accountClient, resolve)

    expect(updated).toBe(0)
    expect(accountClient.upsertSubscriptionsBulk).not.toHaveBeenCalled()
  })

  it('replaces a zero left by a config that had no windowMonthLimit', async () => {
    const accountClient = client([sub('a', { usersLimit: 3, windowMonthLimit: 0 })])

    const updated = await backfillWindowLimits(ctx, accountClient, resolve)

    expect(updated).toBe(1)
    expect(accountClient.upsertSubscriptionsBulk.mock.calls[0][0][0].limits.windowMonthLimit).toBe(900000)
  })

  it('keeps a zero the plan config grants on purpose', async () => {
    const accountClient = client([sub('a', { usersLimit: 3, windowMonthLimit: 0 }, 'boundless')])

    const updated = await backfillWindowLimits(ctx, accountClient, resolve)

    expect(updated).toBe(0)
    expect(accountClient.upsertSubscriptionsBulk).not.toHaveBeenCalled()
  })

  it('rewrites only the window, keeping the rest of the snapshot', async () => {
    const accountClient = client([sub('a', { usersLimit: 7, storageLimitGB: 42, windowMonthLimit: 0 })])

    await backfillWindowLimits(ctx, accountClient, resolve)

    expect(accountClient.upsertSubscriptionsBulk.mock.calls[0][0][0].limits).toEqual({
      usersLimit: 7,
      storageLimitGB: 42,
      windowMonthLimit: 900000
    })
  })

  it('leaves packages and purchases alone: the AI window is a tier concept', async () => {
    // resolveLimits fills windowMonthLimit for a package too (`?? 0`), so without a type guard the
    // backfill would stamp a bogus unlimited window onto a disk add-on.
    const pkg = { ...sub('a', undefined, '100gb'), type: SubscriptionType.Package }
    const accountClient = client([pkg])

    const updated = await backfillWindowLimits(ctx, accountClient, () => ({
      storageLimitGB: 100,
      trafficLimitGB: 0,
      meetingMinutesLimit: 0,
      tokenLimit: 0,
      usersLimit: 0,
      windowMonthLimit: 0
    }))

    expect(updated).toBe(0)
    expect(accountClient.upsertSubscriptionsBulk).not.toHaveBeenCalled()
  })

  it('gives a trial the flat grant, not the per-seat window times its seat cap', async () => {
    // A trial's seat cap lands in providerData.quantity, so a resolver that scaled by seats would
    // hand a 14-day trial a window hundreds of times the paid plan's.
    const trial = {
      ...sub('a', { usersLimit: 1000, windowMonthLimit: 0 }),
      status: SubscriptionStatus.Trialing,
      providerData: { quantity: 1000 }
    }
    const accountClient = client([trial])

    // Mirrors the pod's resolver: the trial grant overrides the scaled window.
    const updated = await backfillWindowLimits(ctx, accountClient, (s: any) => ({
      ...resolve(s),
      windowMonthLimit: s.status === SubscriptionStatus.Trialing ? 1000000 : resolve(s).windowMonthLimit
    }))

    expect(updated).toBe(1)
    expect(accountClient.upsertSubscriptionsBulk.mock.calls[0][0][0].limits.windowMonthLimit).toBe(1000000)
  })

  it('falls back to the stored seats when the provider left no quantity', async () => {
    // createManualSubscription writes no providerData.quantity, so an admin-made subscription would
    // otherwise get a single seat's window instead of one scaled to the seats it was sold.
    const manual = { ...sub('a', { usersLimit: 25, windowMonthLimit: 0 }), providerData: undefined }
    const accountClient = client([manual])

    const updated = await backfillWindowLimits(ctx, accountClient, (s: any) =>
      resolve({ ...s, providerData: { quantity: s.providerData?.quantity ?? s.limits?.usersLimit } })
    )

    expect(updated).toBe(1)
    expect(accountClient.upsertSubscriptionsBulk.mock.calls[0][0][0].limits.windowMonthLimit).toBe(7500000)
  })

  it('skips a per-seat plan whose seat count is unknown', async () => {
    // Seats nowhere to be found: a 0 window would read as unlimited downstream, so the resolver
    // declines and the subscription is left for a human.
    const accountClient = client([{ ...sub('a', { usersLimit: 0, windowMonthLimit: 0 }), providerData: undefined }])

    const updated = await backfillWindowLimits(ctx, accountClient, () => undefined)

    expect(updated).toBe(0)
    expect(accountClient.upsertSubscriptionsBulk).not.toHaveBeenCalled()
  })

  it('skips a plan the config no longer knows', async () => {
    const accountClient = client([sub('a', undefined, 'unknown')])

    const updated = await backfillWindowLimits(ctx, accountClient, resolve)

    expect(updated).toBe(0)
    expect(accountClient.upsertSubscriptionsBulk).not.toHaveBeenCalled()
  })

  it('asks for every provider, not just one', async () => {
    const accountClient = client([])

    await backfillWindowLimits(ctx, accountClient, resolve)

    expect(accountClient.getSubscriptionsByProvider).toHaveBeenCalledWith(undefined, [
      SubscriptionStatus.Active,
      SubscriptionStatus.PastDue,
      SubscriptionStatus.Trialing
    ])
  })

  it('reports a failed write instead of counting it', async () => {
    const accountClient = client([sub('a'), sub('b')])
    accountClient.upsertSubscriptionsBulk = jest.fn(async (batch: any[]) =>
      batch.map((s) => ({ id: s.id, ok: s.id !== 'a', error: s.id === 'a' ? 'boom' : undefined }))
    )

    const updated = await backfillWindowLimits(ctx, accountClient, resolve)

    expect(updated).toBe(1)
    expect(ctx.error).toHaveBeenCalled()
  })
})

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
import { expireTrials, msUntilHour, startTrialExpiry } from '../trialExpiry'

const DAY = 24 * 60 * 60 * 1000

describe('expireTrials', () => {
  let ctx: any
  let buildFree: jest.Mock

  const trial = (workspaceUuid: string, trialEnd: number | undefined): any => ({
    id: `trial-${workspaceUuid}`,
    workspaceUuid,
    provider: 'trial',
    type: SubscriptionType.Tier,
    status: SubscriptionStatus.Trialing,
    plan: 'business',
    trialEnd
  })

  const tier = (status: SubscriptionStatus, trialEnd?: number): any => ({
    type: SubscriptionType.Tier,
    status,
    trialEnd
  })

  // The server filters expired trials by trialEnd; the mock mirrors that so tests exercise the
  // same candidate set the pod would really receive.
  const client = (trials: any[], byWorkspace: Record<string, any[]> = {}): any => ({
    getSubscriptionsByProvider: jest.fn(async (_p: string, _s: string[], trialEndBefore?: number) =>
      trialEndBefore === undefined ? trials : trials.filter((t) => t.trialEnd != null && t.trialEnd <= trialEndBefore)
    ),
    getSubscriptions: jest.fn(async (ws: string) => byWorkspace[ws] ?? []),
    upsertSubscriptionsBulk: jest.fn(async (subs: any[]) => subs.map((s) => ({ id: s.id, ok: true })))
  })

  /** Everything written across every bulk call, flattened. */
  const written = (accountClient: any): any[] =>
    accountClient.upsertSubscriptionsBulk.mock.calls.flatMap((c: any) => c[0])

  beforeEach(() => {
    ctx = { info: jest.fn(), error: jest.fn(), warn: jest.fn() }
    buildFree = jest.fn((workspace: string) => ({
      id: `free-${workspace}`,
      workspaceUuid: workspace,
      provider: 'free',
      type: SubscriptionType.Tier,
      status: SubscriptionStatus.Active,
      plan: 'start'
    }))
  })

  it('asks the server for expired trials of the trial provider only', async () => {
    const accountClient = client([])
    await expireTrials(ctx, accountClient, buildFree)

    expect(accountClient.getSubscriptionsByProvider).toHaveBeenCalledWith(
      'trial',
      [SubscriptionStatus.Trialing],
      expect.any(Number)
    )
  })

  it('cancels an expired trial and creates the free tier in the same bulk call', async () => {
    const accountClient = client([trial('ws-1', Date.now() - DAY)], {
      'ws-1': [tier(SubscriptionStatus.Trialing, Date.now() - DAY)]
    })

    await expireTrials(ctx, accountClient, buildFree)

    expect(accountClient.upsertSubscriptionsBulk).toHaveBeenCalledTimes(1)
    // Cancel first: a free tier written before it would be retired by the supersede cascade.
    expect(written(accountClient)).toEqual([
      expect.objectContaining({
        id: 'trial-ws-1',
        status: SubscriptionStatus.Canceled,
        canceledAt: expect.any(Number),
        providerData: expect.objectContaining({ status: 'TRIAL_EXPIRED' })
      }),
      expect.objectContaining({ id: 'free-ws-1', provider: 'free', status: SubscriptionStatus.Active })
    ])
  })

  it('leaves accountUuid unset on the free tier so account resolves the owner', async () => {
    const accountClient = client([trial('ws-1', Date.now() - DAY)], {
      'ws-1': [tier(SubscriptionStatus.Trialing, Date.now() - DAY)]
    })

    await expireTrials(ctx, accountClient, buildFree)

    const free = written(accountClient).find((w) => w.provider === 'free')
    expect(free.accountUuid).toBeUndefined()
  })

  it('never marks the trial as a finalized user cancel (would double-provision free via the queue)', async () => {
    const accountClient = client([trial('ws-1', Date.now() - DAY)], {
      'ws-1': [tier(SubscriptionStatus.Trialing, Date.now() - DAY)]
    })

    await expireTrials(ctx, accountClient, buildFree)

    expect(written(accountClient)[0].providerData.status).not.toBe('CANCELED')
  })

  it('cancels the expired trial even without a free plan configured', async () => {
    const accountClient = client([trial('ws-1', Date.now() - DAY)], {
      'ws-1': [tier(SubscriptionStatus.Trialing, Date.now() - DAY)]
    })

    await expireTrials(ctx, accountClient, undefined)

    expect(written(accountClient)).toEqual([expect.objectContaining({ status: SubscriptionStatus.Canceled })])
  })

  it('leaves a live trial alone even if the server hands one back', async () => {
    // Server-side trialEnd filtering is bypassed on purpose: the pod re-checks the date itself.
    const accountClient = client([])
    accountClient.getSubscriptionsByProvider = jest.fn().mockResolvedValue([trial('ws-1', Date.now() + DAY)])

    await expireTrials(ctx, accountClient, buildFree)

    expect(accountClient.upsertSubscriptionsBulk).not.toHaveBeenCalled()
    // A live trial is skipped before the re-read — no extra account round-trip.
    expect(accountClient.getSubscriptions).not.toHaveBeenCalled()
  })

  it('skips a trial without trialEnd instead of expiring it', async () => {
    const accountClient = client([])
    accountClient.getSubscriptionsByProvider = jest.fn().mockResolvedValue([trial('ws-1', undefined)])

    await expireTrials(ctx, accountClient, buildFree)

    expect(accountClient.upsertSubscriptionsBulk).not.toHaveBeenCalled()
  })

  it('skips when the workspace already has a granting tier (paid in the meantime)', async () => {
    const accountClient = client([trial('ws-1', Date.now() - DAY)], {
      'ws-1': [tier(SubscriptionStatus.Active)]
    })

    await expireTrials(ctx, accountClient, buildFree)

    expect(accountClient.upsertSubscriptionsBulk).not.toHaveBeenCalled()
  })

  it('skips when free was already provisioned (idempotent across pods)', async () => {
    const accountClient = client([trial('ws-1', Date.now() - DAY)], {
      // Another pod won the race: the trial is Canceled and free is Active.
      'ws-1': [tier(SubscriptionStatus.Canceled), tier(SubscriptionStatus.Active)]
    })

    await expireTrials(ctx, accountClient, buildFree)

    expect(accountClient.upsertSubscriptionsBulk).not.toHaveBeenCalled()
  })

  it('keeps sweeping after the re-read of one workspace fails', async () => {
    const expiredAt = Date.now() - DAY
    const accountClient = client([trial('ws-1', expiredAt), trial('ws-2', expiredAt)], {
      'ws-1': [tier(SubscriptionStatus.Trialing, expiredAt)],
      'ws-2': [tier(SubscriptionStatus.Trialing, expiredAt)]
    })
    accountClient.getSubscriptions.mockRejectedValueOnce(new Error('account down'))

    await expireTrials(ctx, accountClient, buildFree)

    expect(written(accountClient).map((w) => w.id)).toEqual(['trial-ws-2', 'free-ws-2'])
    expect(ctx.error).toHaveBeenCalledWith(
      'failed to check trial workspace',
      expect.objectContaining({ workspace: 'ws-1' })
    )
  })

  it('reports a failed bulk entry without stopping the rest', async () => {
    const expiredAt = Date.now() - DAY
    const accountClient = client([trial('ws-1', expiredAt), trial('ws-2', expiredAt)], {
      'ws-1': [tier(SubscriptionStatus.Trialing, expiredAt)],
      'ws-2': [tier(SubscriptionStatus.Trialing, expiredAt)]
    })
    accountClient.upsertSubscriptionsBulk = jest.fn(async (subs: any[]) =>
      subs.map((s) => ({ id: s.id, ok: s.id !== 'free-ws-1', error: s.id === 'free-ws-1' ? 'no members' : undefined }))
    )

    await expireTrials(ctx, accountClient, buildFree)

    expect(ctx.error).toHaveBeenCalledWith(
      'failed to move expired trial to free plan',
      expect.objectContaining({ workspace: 'ws-1', error: 'no members' })
    )
    expect(ctx.info).toHaveBeenCalledWith(
      'free subscription created for workspace',
      expect.objectContaining({ workspace: 'ws-2' })
    )
  })

  it('writes both the cancel and the free tier to the payment ledger', async () => {
    const accountClient = client([trial('ws-1', Date.now() - DAY)], {
      'ws-1': [tier(SubscriptionStatus.Trialing, Date.now() - DAY)]
    })
    const logOperation = jest.fn().mockResolvedValue(undefined)

    await expireTrials(ctx, accountClient, buildFree, logOperation)

    expect(logOperation).toHaveBeenCalledTimes(2)
    expect(logOperation).toHaveBeenCalledWith(ctx, expect.objectContaining({ provider: 'trial' }), true)
    expect(logOperation).toHaveBeenCalledWith(ctx, expect.objectContaining({ provider: 'free' }), false)
  })

  it('splits a large sweep into batches', async () => {
    const expiredAt = Date.now() - DAY
    const trials = Array.from({ length: 120 }, (_, i) => trial(`ws-${i}`, expiredAt))
    const byWorkspace: Record<string, any[]> = {}
    for (let i = 0; i < 120; i++) byWorkspace[`ws-${i}`] = [tier(SubscriptionStatus.Trialing, expiredAt)]

    const accountClient = client(trials, byWorkspace)
    await expireTrials(ctx, accountClient, buildFree)

    // 120 trials -> batches of 100 and 20 candidates, each writing a cancel plus a free tier.
    expect(accountClient.upsertSubscriptionsBulk).toHaveBeenCalledTimes(2)
    expect(accountClient.upsertSubscriptionsBulk.mock.calls.map((c: any) => c[0].length)).toEqual([200, 40])
  })
})

describe('msUntilHour', () => {
  it('returns the delay to the target hour later the same day', () => {
    const from = Date.UTC(2026, 7, 17, 18, 0, 0)
    expect(msUntilHour(21, from)).toBe(3 * 60 * 60 * 1000)
  })

  it('rolls over to the next day when the hour already passed', () => {
    const from = Date.UTC(2026, 7, 17, 22, 0, 0)
    expect(msUntilHour(21, from)).toBe(23 * 60 * 60 * 1000)
  })

  it('waits a full day when fired exactly on the hour', () => {
    const from = Date.UTC(2026, 7, 17, 21, 0, 0)
    expect(msUntilHour(21, from)).toBe(24 * 60 * 60 * 1000)
  })
})

describe('startTrialExpiry', () => {
  let ctx: any
  let accountClient: any

  beforeEach(() => {
    ctx = { info: jest.fn(), error: jest.fn(), warn: jest.fn() }
    accountClient = {
      getSubscriptionsByProvider: jest.fn().mockResolvedValue([]),
      getSubscriptions: jest.fn().mockResolvedValue([]),
      upsertSubscriptionsBulk: jest.fn().mockResolvedValue([])
    }
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('does not sweep at startup — a deploy must not move plans mid-day', () => {
    const stop = startTrialExpiry(ctx, accountClient, undefined, { hourUtc: 21 })

    expect(accountClient.getSubscriptionsByProvider).not.toHaveBeenCalled()
    stop()
  })

  it('sweeps at the configured hour and re-arms for the next day', () => {
    jest.setSystemTime(Date.UTC(2026, 7, 17, 20, 0, 0))
    const stop = startTrialExpiry(ctx, accountClient, undefined, { hourUtc: 21 })

    jest.advanceTimersByTime(60 * 60 * 1000)
    expect(accountClient.getSubscriptionsByProvider).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(accountClient.getSubscriptionsByProvider).toHaveBeenCalledTimes(2)

    stop()
    jest.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(accountClient.getSubscriptionsByProvider).toHaveBeenCalledTimes(2)
  })

  it('honors the interval override and stops on close', () => {
    const stop = startTrialExpiry(ctx, accountClient, undefined, { hourUtc: 21, intervalMinutes: 30 })

    jest.advanceTimersByTime(30 * 60 * 1000)
    expect(accountClient.getSubscriptionsByProvider).toHaveBeenCalledTimes(1)

    stop()
    jest.advanceTimersByTime(30 * 60 * 1000)
    expect(accountClient.getSubscriptionsByProvider).toHaveBeenCalledTimes(1)
  })
})

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
import { type WorkspaceUuid } from '@hcengineering/core'
import { BillingMessageKind, type BillingDB, type BillingUsageMessage, type WorkspaceLimitState } from '../types'

const getSubscriptionsMock = jest.fn()
const collectDatalakeStatsMock = jest.fn()
const getWorkspaceInfoMock = jest.fn(async () => ({ usageInfo: { usage: {}, startTime: 0, updateTime: 0 } }))
const updateUsageInfoMock = jest.fn(async () => {})

jest.mock('@hcengineering/account-client', () => ({
  getClient: jest.fn(() => ({
    getSubscriptions: getSubscriptionsMock,
    getWorkspaceInfo: getWorkspaceInfoMock,
    updateUsageInfo: updateUsageInfoMock
  })),
  // Mirror the real grantsPlan: active/trialing/past_due/readonly grant, minus a pending past_due
  // draft and an expired trial.
  grantsPlan: (sub: any): boolean => {
    if (sub == null) return false
    if (sub.status === 'past_due' && sub.providerData?.pending === true) return false
    if (sub.status === 'trialing' && sub.trialEnd != null && sub.trialEnd < Date.now()) return false
    return ['active', 'trialing', 'past_due', 'readonly'].includes(sub.status)
  },
  isFreePlan: (tier: any): boolean => tier === undefined || tier.provider === 'free' || tier.plan === 'free',
  SubscriptionType: { Tier: 'tier', Support: 'support', Package: 'package' },
  SubscriptionStatus: {
    Active: 'active',
    Trialing: 'trialing',
    PastDue: 'past_due',
    ReadOnly: 'readonly',
    Canceled: 'canceled',
    Paused: 'paused',
    Expired: 'expired'
  }
}))
jest.mock('@hcengineering/server-token', () => ({
  generateToken: jest.fn(() => 'tok')
}))
jest.mock('../billing', () => ({
  collectDatalakeStats: (...args: any[]) => collectDatalakeStatsMock(...args)
}))
// config validates env on import; limits.ts only reads the window fallback from it.
jest.mock('../config', () => ({ __esModule: true, default: { WindowMonthLimit: 0 } }))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LimitsEngine, grantPeriodAnchor, getPeriodStartDate } = require('../limits')

const WS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' as WorkspaceUuid
const ctx: any = { info: jest.fn(), error: jest.fn(), warn: jest.fn() }

function makeDb (tokensUsed = 0, participantMinutes = 0, balance?: any): BillingDB {
  const dedup = new Set<string>()
  const states = new Map<string, WorkspaceLimitState>()
  let row = balance
  return {
    getTokenBalance: jest.fn(async () => row),
    settleTokenBalance: jest.fn(async (_c, _ws, charge, absorbedUntil, absorbedPeriod, newPeriodStart) => {
      // Mirrors the SQL guard: the row moves only while its period_start is still behind.
      if (row === undefined || new Date(row.periodStart).getTime() >= new Date(newPeriodStart).getTime()) {
        return false
      }
      row = {
        ...row,
        remainingTokens: row.remainingTokens - charge,
        absorbedUntil,
        absorbedPeriod,
        periodStart: newPeriodStart
      }
      return true
    }),
    accumulateUsageDelta: jest.fn(async (_c, ws, metric, _a, ref) => {
      const key = `${ws}:${metric}:${ref}`
      if (dedup.has(key)) return false
      dedup.add(key)
      return true
    }),
    getParticipantMinutes: jest.fn(async () => ({ totalMinutes: participantMinutes })),
    getLimitState: jest.fn(async (_c, ws, cat) => states.get(`${ws}:${cat}`)),
    upsertLimitState: jest.fn(async (_c, st) => {
      states.set(`${st.workspace}:${st.category}`, { ...st })
    }),
    getAllExhaustedStates: jest.fn(async () => Array.from(states.values()).filter((s) => s.exhausted)),
    getAiTokensStats: jest.fn(async () => [{ reason: 'chat', totalTokens: tokensUsed }]),
    getAiTranscriptStats: jest.fn(async () => ({ totalDurationSeconds: 0 }))
  } as unknown as BillingDB
}

function tierLimits (limits: Record<string, number>): void {
  getSubscriptionsMock.mockResolvedValue([{ type: 'tier', status: 'active', limits }])
}

// Unpaid tier (bad status, no active limits) carrying a free fallback — billing must enforce free.
function unpaidWithFree (freeLimits: Record<string, number>): void {
  getSubscriptionsMock.mockResolvedValue([{ type: 'tier', status: 'past_due', freeLimits }])
}

beforeEach(() => {
  jest.clearAllMocks()
  collectDatalakeStatsMock.mockResolvedValue({ size: 0, count: 0, byType: [] })
})

function makeEngine (db: BillingDB): any {
  const producer = { send: jest.fn().mockResolvedValue(undefined), close: jest.fn() }
  const engine = new LimitsEngine(db, 'http://account', [], producer)
  return { engine, producer }
}

function msg (ref: string, amount = 1): BillingUsageMessage {
  return { kind: BillingMessageKind.Usage, workspace: WS, metric: 'tokens', amount, ref }
}

describe('LimitsEngine', () => {
  it('ignores duplicate ref', async () => {
    tierLimits({ tokenLimit: 1000, windowMonthLimit: 1000 })
    const db = makeDb(0)
    const { engine } = makeEngine(db)
    await engine.processUsageDelta(ctx, msg('r1'))
    await engine.processUsageDelta(ctx, msg('r1'))
    expect(db.accumulateUsageDelta).toHaveBeenCalledTimes(2)
    expect(db.upsertLimitState).toHaveBeenCalledTimes(1)
  })

  it('publishes exhausted on flip, not on repeat', async () => {
    tierLimits({ tokenLimit: 1000, windowMonthLimit: 1000 })
    const db = makeDb()
    const { engine, producer } = makeEngine(db)

    // used 0 -> 999: below the limit, no flip
    await engine.processUsageDelta(ctx, msg('r1', 999))
    expect(producer.send).not.toHaveBeenCalled()
    // used 999 -> 1001: crosses the limit, exhausted flip
    await engine.processUsageDelta(ctx, msg('r2', 2))
    expect(producer.send).toHaveBeenCalledTimes(1)
    expect(producer.send).toHaveBeenCalledWith(
      ctx,
      WS,
      expect.arrayContaining([expect.objectContaining({ category: 'tokens', status: 'exhausted' })])
    )
    // already exhausted -> no repeat publish
    await engine.processUsageDelta(ctx, msg('r3', 1))
    expect(producer.send).toHaveBeenCalledTimes(1)
  })

  it('publishes ok when limit grows above usage', async () => {
    tierLimits({ tokenLimit: 5000, windowMonthLimit: 5000 })
    const db = makeDb()
    // pre-seed exhausted state from the previous (smaller) plan
    await db.upsertLimitState(ctx, { workspace: WS, category: 'tokens', used: 1001, limitValue: 1000, exhausted: true })
    const { engine, producer } = makeEngine(db)

    // a tiny delta under the grown limit re-evaluates and lifts exhausted
    await engine.processUsageDelta(ctx, msg('r-new', 1))
    expect(producer.send).toHaveBeenCalledWith(
      ctx,
      WS,
      expect.arrayContaining([expect.objectContaining({ category: 'tokens', status: 'ok' })])
    )
  })

  it('limit 0 = unlimited, never exhausted', async () => {
    tierLimits({ tokenLimit: 0, windowMonthLimit: 0 })
    const db = makeDb()
    const { engine, producer } = makeEngine(db)
    await engine.processUsageDelta(ctx, msg('r-unlim', 999999))
    expect(producer.send).not.toHaveBeenCalled()
  })

  it('unpaid tier enforces the free fallback limit', async () => {
    // No active paid tier, but a free fallback caps tokens at 1000 -> crossing it still flips exhausted.
    unpaidWithFree({ tokenLimit: 1000, windowMonthLimit: 1000 })
    const db = makeDb()
    const { engine, producer } = makeEngine(db)
    await engine.processUsageDelta(ctx, msg('r1', 1001))
    expect(producer.send).toHaveBeenCalledWith(
      ctx,
      WS,
      expect.arrayContaining([expect.objectContaining({ category: 'tokens', status: 'exhausted' })])
    )
  })

  it('unpaid tier without a free fallback is unlimited', async () => {
    getSubscriptionsMock.mockResolvedValue([{ type: 'tier', status: 'past_due' }])
    const db = makeDb()
    const { engine, producer } = makeEngine(db)
    await engine.processUsageDelta(ctx, msg('r1', 999999))
    expect(producer.send).not.toHaveBeenCalled()
  })

  describe('purchased token balance', () => {
    // Balance granted an hour before the period so the whole period's usage is absorbable.
    function balanceRow (remaining: number, periodStart: Date): any {
      return {
        workspace: WS,
        remainingTokens: remaining,
        absorbedUntil: null,
        absorbedPeriod: 0,
        periodStart: periodStart.toISOString()
      }
    }

    // recompute() anchors the period at the tier start; keep it in the past so usage falls inside.
    function tierWithPeriod (tokenLimit: number): Date {
      const periodStart = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
      getSubscriptionsMock.mockResolvedValue([
        { type: 'tier', status: 'active', limits: { windowMonthLimit: tokenLimit }, periodStart: periodStart.getTime() }
      ])
      return periodStart
    }

    it('spends the monthly grant first: staying under it leaves the pack untouched', async () => {
      const periodStart = tierWithPeriod(1000)
      const db = makeDb(800, 0, balanceRow(500, periodStart))
      const { engine } = makeEngine(db)

      await engine.recomputeWorkspace(ctx, WS)

      // `used` is the full spend now; the limit it is compared against is grant + pack.
      const state = await db.getLimitState(ctx, WS, 'tokens')
      expect(state?.used).toBe(800)
      expect(state?.exhausted).toBe(false)
      const balance: any = await db.getTokenBalance(ctx, WS)
      expect(balance.remainingTokens).toBe(500)
      expect(balance.absorbedPeriod).toBe(0)
    })

    it('does not touch the pack mid-period, even over the grant', async () => {
      const periodStart = tierWithPeriod(1000)
      const db = makeDb(1200, 0, balanceRow(500, periodStart))
      const { engine } = makeEngine(db)

      await engine.recomputeWorkspace(ctx, WS)

      // Nothing is written during a period: the pack is charged once, when the period ends.
      expect(db.settleTokenBalance).not.toHaveBeenCalled()
      const balance: any = await db.getTokenBalance(ctx, WS)
      expect(balance.remainingTokens).toBe(500)
    })

    it('keeps serving on balance alone once the tier window is spent', async () => {
      const periodStart = tierWithPeriod(1000)
      // Tier window fully spent, but the balance still covers the overage -> not exhausted.
      const db = makeDb(1000, 0, balanceRow(5000, periodStart))
      const { engine, producer } = makeEngine(db)

      await engine.recomputeWorkspace(ctx, WS)

      const state = await db.getLimitState(ctx, WS, 'tokens')
      expect(state?.exhausted).toBe(false)
      expect(producer.send).not.toHaveBeenCalled()
    })

    it('exhausts only when both pools are empty', async () => {
      const periodStart = tierWithPeriod(1000)
      const db = makeDb(1200, 0, balanceRow(200, periodStart))
      const { engine, producer } = makeEngine(db)

      await engine.recomputeWorkspace(ctx, WS)

      const state = await db.getLimitState(ctx, WS, 'tokens')
      expect(state?.exhausted).toBe(true)
      expect(producer.send).toHaveBeenCalledWith(
        ctx,
        WS,
        expect.arrayContaining([expect.objectContaining({ category: 'tokens', status: 'exhausted' })])
      )
    })

    it('charges the pack for the finished period when the period rolls over', async () => {
      const periodStart = tierWithPeriod(1000)
      // makeDb returns the same usage for any range, so the previous period also reads 1300:
      // 300 over the 1000 grant -> that much comes off the pack.
      const stale = balanceRow(1000, new Date(periodStart.getTime() - 30 * 24 * 60 * 60 * 1000))
      const db = makeDb(1300, 0, stale)
      const { engine } = makeEngine(db)

      await engine.recomputeWorkspace(ctx, WS)

      const balance: any = await db.getTokenBalance(ctx, WS)
      expect(balance.remainingTokens).toBe(700)
      // Stamped with the period start floored to the hour, matching the hourly usage buckets.
      const expected = new Date(periodStart)
      expected.setUTCMinutes(0, 0, 0)
      expect(new Date(balance.periodStart).getTime()).toBe(expected.getTime())
    })

    it('settles once: a second pass in the same period is a no-op', async () => {
      const periodStart = tierWithPeriod(1000)
      const stale = balanceRow(1000, new Date(periodStart.getTime() - 30 * 24 * 60 * 60 * 1000))
      const db = makeDb(1300, 0, stale)
      const { engine } = makeEngine(db)

      await engine.recomputeWorkspace(ctx, WS)
      await engine.recomputeWorkspace(ctx, WS)

      expect(db.settleTokenBalance).toHaveBeenCalledTimes(1)
      const balance: any = await db.getTokenBalance(ctx, WS)
      expect(balance.remainingTokens).toBe(700)
    })
  })

  describe('meetingMinutes', () => {
    function minutesMsg (ref: string, amountSeconds: number): BillingUsageMessage {
      return { kind: BillingMessageKind.Usage, workspace: WS, metric: 'meetingMinutes', amount: amountSeconds, ref }
    }

    it('enforces meetingMinutesLimit in seconds', async () => {
      // 2 minutes of plan -> exhausted only once past 120 seconds.
      tierLimits({ meetingMinutesLimit: 2 })
      const db = makeDb()
      const { engine, producer } = makeEngine(db)

      await engine.processUsageDelta(ctx, minutesMsg('m1', 119))
      expect(producer.send).not.toHaveBeenCalled()

      await engine.processUsageDelta(ctx, minutesMsg('m2', 2))
      expect(producer.send).toHaveBeenCalledWith(
        ctx,
        WS,
        expect.arrayContaining([expect.objectContaining({ category: 'meetingMinutes', status: 'exhausted' })])
      )
    })

    it('reports usageInfo in minutes while the queue delta stays in seconds', async () => {
      tierLimits({ meetingMinutesLimit: 60 })
      const db = makeDb()
      const { engine } = makeEngine(db)

      await engine.processUsageDelta(ctx, minutesMsg('m1', 90))

      expect(updateUsageInfoMock).toHaveBeenCalledWith(
        expect.objectContaining({ usage: expect.objectContaining({ meetingMinutes: 1.5 }) })
      )
    })

    it('recomputes used from participant minutes, converted to seconds', async () => {
      tierLimits({ meetingMinutesLimit: 10 })
      const db = makeDb(0, 3) // 3 minutes recorded in participant sessions
      const { engine } = makeEngine(db)

      await engine.recomputeWorkspace(ctx, WS)

      expect(db.upsertLimitState).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ category: 'meetingMinutes', used: 180, limitValue: 600 })
      )
    })
  })

  it('batch aggregates same workspace/metric into one apply, deduping refs', async () => {
    tierLimits({ tokenLimit: 1000, windowMonthLimit: 1000 })
    const db = makeDb()
    const { engine, producer } = makeEngine(db)
    const hb = jest.fn(async () => {})

    // ref 'a' repeats -> counted once; new deltas sum 999+2+5=1006, crossing 1000 a single time.
    await engine.processUsageBatch(ctx, [msg('a', 999), msg('b', 2), msg('a', 999), msg('c', 5)], hb)

    // one (workspace, metric) group -> one subscription fetch and one limit write, not per-message
    expect(getSubscriptionsMock).toHaveBeenCalledTimes(1)
    expect(db.upsertLimitState).toHaveBeenCalledTimes(1)
    const st = (db.upsertLimitState as jest.Mock).mock.calls[0][1]
    expect(st.used).toBe(1006)
    expect(st.exhausted).toBe(true)
    expect(producer.send).toHaveBeenCalledTimes(1)
    expect(hb).toHaveBeenCalledTimes(1)
  })

  it('batch keeps distinct metrics as separate groups (one heartbeat each)', async () => {
    tierLimits({ tokenLimit: 1000, windowMonthLimit: 1000 })
    const db = makeDb()
    const { engine } = makeEngine(db)
    const hb = jest.fn(async () => {})

    await engine.processUsageBatch(
      ctx,
      [
        { kind: 'usage', workspace: WS, metric: 'tokens', amount: 3, ref: 't1' },
        { kind: 'usage', workspace: WS, metric: 'transcript', amount: 5, ref: 'x1' },
        { kind: 'usage', workspace: WS, metric: 'tokens', amount: 2, ref: 't2' }
      ],
      hb
    )

    // two (workspace, metric) groups -> two limit writes and two heartbeats, sums per category
    expect(db.upsertLimitState).toHaveBeenCalledTimes(2)
    expect(hb).toHaveBeenCalledTimes(2)
    const byCat = Object.fromEntries(
      (db.upsertLimitState as jest.Mock).mock.calls.map((c) => [c[1].category, c[1].used])
    )
    expect(byCat.tokens).toBe(5)
    expect(byCat.transcript).toBe(5)
  })
})

describe('window step notify (5% fill)', () => {
  // windowMonthLimit 100 -> 5% step = 5 tokens; getAiTokensStats is stubbed to a fixed "current usage".
  function tierWithWindow (tokenLimit: number, windowMonthLimit: number): void {
    getSubscriptionsMock.mockResolvedValue([
      { type: 'tier', status: 'active', limits: { tokenLimit, windowMonthLimit } }
    ])
  }

  it('calls getSubscriptions exactly once per delta (no second account round trip)', async () => {
    tierWithWindow(1000000, 100)
    const db = makeDb(5) // usedNow = 5 -> step 1
    const { engine } = makeEngine(db)

    await engine.processUsageDelta(ctx, msg('r1', 5))

    expect(getSubscriptionsMock).toHaveBeenCalledTimes(1)
  })

  it('publishes LimitsChanged when the delta crosses a 5% step', async () => {
    tierWithWindow(1000000, 100)
    const db = makeDb(5) // absolute usage stub: stepNow = floor(5/5) = 1, stepPrev (usedNow-amount=0) = 0
    const { engine, producer } = makeEngine(db)

    await engine.processUsageDelta(ctx, msg('r1', 5))

    expect(producer.send).toHaveBeenCalledWith(
      ctx,
      WS,
      expect.arrayContaining([expect.objectContaining({ category: 'tokens', status: 'ok' })])
    )
  })

  it('does not publish when the delta stays within the same 5% step', async () => {
    tierWithWindow(1000000, 100)
    const db = makeDb(51) // stepNow = floor(51/5) = 10, stepPrev (51-1=50) = floor(50/5) = 10
    const { engine, producer } = makeEngine(db)

    await engine.processUsageDelta(ctx, msg('r1', 1))

    expect(producer.send).not.toHaveBeenCalled()
  })
})

describe('getPeriodStartDate', () => {
  // Usage lives in hourly buckets: a period starting at 18:19 must still count its own 18:00
  // bucket, or every purchase silently loses up to an hour of spend from the window.
  // Floored in UTC, like the hourly buckets themselves: a local floor lands mid-hour in zones
  // offset by 30/45 minutes (Asia/Kolkata, Asia/Kathmandu).
  it('floors the period start to the hour', () => {
    const start = getPeriodStartDate(Date.UTC(2026, 7, 16, 18, 19, 59, 123))
    expect(start.getTime()).toBe(Date.UTC(2026, 7, 16, 18, 0, 0, 0))
  })

  it('falls back to 30 days ago at UTC midnight when the tier has no period', () => {
    const start = getPeriodStartDate(undefined)
    expect(start.getUTCHours()).toBe(0)
    expect(start.getUTCMinutes()).toBe(0)
    expect(start.getUTCSeconds()).toBe(0)
  })
})

describe('grantPeriodAnchor (AI grant period)', () => {
  it('anchors on the earliest active AI package so tier and package top up together', () => {
    const pkgs = [
      { periodStart: 5000, limits: { tokenLimit: 1000 } },
      { periodStart: 3000, limits: { tokenLimit: 2000 } }
    ]
    expect(grantPeriodAnchor(1000, pkgs)).toBe(3000)
  })
  it('ignores non-token packages and falls back to the tier start', () => {
    expect(grantPeriodAnchor(1000, [{ periodStart: 5000, limits: { storageLimitGB: 10 } }])).toBe(1000)
    expect(grantPeriodAnchor(1000, [])).toBe(1000)
    expect(grantPeriodAnchor(undefined, [])).toBeUndefined()
  })
})

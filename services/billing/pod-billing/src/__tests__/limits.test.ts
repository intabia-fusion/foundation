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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LimitsEngine, effectivePeriodStart } = require('../limits')

const WS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' as WorkspaceUuid
const ctx: any = { info: jest.fn(), error: jest.fn(), warn: jest.fn() }

function makeDb (tokensUsed = 0, participantMinutes = 0): BillingDB {
  const dedup = new Set<string>()
  const states = new Map<string, WorkspaceLimitState>()
  return {
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
    getAiTranscriptStats: jest.fn(async () => ({ totalDurationSeconds: 0 })),
    getAiWindowReset: jest.fn(async () => undefined)
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
    tierLimits({ tokenLimit: 1000 })
    const db = makeDb(0)
    const { engine } = makeEngine(db)
    await engine.processUsageDelta(ctx, msg('r1'))
    await engine.processUsageDelta(ctx, msg('r1'))
    expect(db.accumulateUsageDelta).toHaveBeenCalledTimes(2)
    expect(db.upsertLimitState).toHaveBeenCalledTimes(1)
  })

  it('publishes exhausted on flip, not on repeat', async () => {
    tierLimits({ tokenLimit: 1000 })
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
    tierLimits({ tokenLimit: 5000 })
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
    tierLimits({ tokenLimit: 0 })
    const db = makeDb()
    const { engine, producer } = makeEngine(db)
    await engine.processUsageDelta(ctx, msg('r-unlim', 999999))
    expect(producer.send).not.toHaveBeenCalled()
  })

  it('unpaid tier enforces the free fallback limit', async () => {
    // No active paid tier, but a free fallback caps tokens at 1000 -> crossing it still flips exhausted.
    unpaidWithFree({ tokenLimit: 1000 })
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
    tierLimits({ tokenLimit: 1000 })
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
    tierLimits({ tokenLimit: 1000 })
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

describe('effectivePeriodStart (ai-token-reset window anchor)', () => {
  it('returns the later of tier start and reset', () => {
    expect(effectivePeriodStart(1000, 5000)).toBe(5000)
    expect(effectivePeriodStart(5000, 1000)).toBe(5000)
  })
  it('falls back to whichever is defined', () => {
    expect(effectivePeriodStart(1000, undefined)).toBe(1000)
    expect(effectivePeriodStart(undefined, 5000)).toBe(5000)
    expect(effectivePeriodStart(undefined, undefined)).toBeUndefined()
  })
})

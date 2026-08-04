//
// Copyright © 2026 Intabia Fusion
//

import { computePoolTransition } from '../pool'
import { type ProviderPool } from '../types'

function pool (over: Partial<ProviderPool> = {}): ProviderPool {
  return {
    providerId: 'gigachat',
    model: '',
    kind: 'purchased',
    purchasedTokens: 1000,
    period: 'monthly',
    periodStart: '2026-01-01T00:00:00.000Z',
    usedTokens: 0,
    exhausted: false,
    notified80: false,
    notified100: false,
    ...over
  }
}

describe('computePoolTransition', () => {
  it('below 80% is not exhausted and crosses nothing', () => {
    const t = computePoolTransition(pool(), 500)
    expect(t).toMatchObject({ exhausted: false, reach80: false, crossed80: false, crossed100: false })
  })

  it('crosses 80% once', () => {
    const t = computePoolTransition(pool(), 800)
    expect(t.reach80).toBe(true)
    expect(t.crossed80).toBe(true)
    expect(t.exhausted).toBe(false)
  })

  it('does not re-cross 80% when already notified', () => {
    const t = computePoolTransition(pool({ notified80: true }), 850)
    expect(t.reach80).toBe(true)
    expect(t.crossed80).toBe(false)
  })

  it('crosses 100% and exhausts at full usage', () => {
    const t = computePoolTransition(pool(), 1000)
    expect(t.exhausted).toBe(true)
    expect(t.crossed100).toBe(true)
    expect(t.crossed80).toBe(true)
  })

  it('local pools never exhaust or notify', () => {
    const t = computePoolTransition(pool({ kind: 'local' }), 99999)
    expect(t).toMatchObject({ exhausted: false, reach80: false, crossed80: false, crossed100: false })
  })

  it('zero purchased budget is treated as unlimited', () => {
    const t = computePoolTransition(pool({ purchasedTokens: 0 }), 5000)
    expect(t.exhausted).toBe(false)
    expect(t.crossed80).toBe(false)
  })
})

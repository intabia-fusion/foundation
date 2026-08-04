//
// Copyright © 2026 Intabia Fusion
//

import { decideLevel, type WindowUsage } from '../workspace/windowLimit'
import { type AIProviderConfig } from '../config'

// Two providers: a purchased one (levels low/high) and a local clisr fallback.
const registry: AIProviderConfig[] = [
  {
    id: 'openai',
    provider: 'openai',
    concurrency: 1,
    batch: 1,
    levels: {
      low: { model: 'gpt-low', tokenMultiplier: 1, order: 1, label: 'Low' },
      high: { model: 'gpt-high', tokenMultiplier: 2, order: 3, label: 'High' }
    }
  },
  {
    id: 'clisr',
    provider: 'clisr',
    concurrency: 1,
    batch: 1,
    levels: {
      fast: { model: 'local-fast', tokenMultiplier: 0.1, order: 0, label: 'Fast', fallbackEligible: true }
    }
  }
]

const usage = (used: number, limit: number, isFree = true, hasPackages = false): WindowUsage => ({
  month: { used, limit },
  plan: isFree ? 'free' : 'business',
  isFree,
  hasPackages
})

describe('decideLevel', () => {
  it('proceeds with requested level when under the monthly limit', () => {
    const d = decideLevel('high', registry, usage(10, 100))
    expect(d).toEqual({ action: 'proceed', level: 'high' })
  })

  it('over + free plan -> hard block (no fallback)', () => {
    const d = decideLevel('high', registry, usage(1000, 1000, true))
    expect(d).toEqual({ action: 'block', reason: 'limit' })
  })

  it('over + paid plan -> downgrade to the cheapest fallback-eligible level', () => {
    const d = decideLevel('high', registry, usage(1000, 1000, false))
    expect(d).toEqual({ action: 'proceed', level: 'fast' })
  })

  it('over + free plan blocks even a fallback-eligible level', () => {
    const d = decideLevel('fast', registry, usage(1000, 1000, true))
    expect(d).toEqual({ action: 'block', reason: 'limit' })
  })

  it('billing unavailable -> block regardless of the reported window', () => {
    const d = decideLevel('high', registry, { ...usage(0, 0, false), unavailable: true })
    expect(d).toEqual({ action: 'block', reason: 'unavailable' })
  })

  it('over + paid + requested already eligible -> proceed as-is', () => {
    const d = decideLevel('fast', registry, usage(1000, 1000, false))
    expect(d).toEqual({ action: 'proceed', level: 'fast' })
  })

  it('no limit (0) -> always proceed', () => {
    const d = decideLevel('high', registry, usage(1e9, 0))
    expect(d).toEqual({ action: 'proceed', level: 'high' })
  })
})

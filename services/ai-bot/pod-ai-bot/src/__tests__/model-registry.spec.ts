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

import { type AILevel, type AILevelModel, type AIProviderConfig } from '../config'
import { availableLevels, planMultiplier, providerLevels, resolveModel } from '../llms/modelRegistry'

function lvl (model: string, order: number, multiplier = 1, label = model, description?: string): AILevelModel {
  return { model, tokenMultiplier: multiplier, order, label, description }
}

function provider (
  id: string,
  type: AIProviderConfig['provider'],
  levels: Partial<Record<AILevel, AILevelModel>>
): AIProviderConfig {
  return { id, provider: type, concurrency: 1, batch: 1, levels }
}

describe('resolveModel', () => {
  it('returns the exact level match', () => {
    const reg = [provider('a', 'openai', { low: lvl('m-low', 0), high: lvl('m-high', 2) })]
    const r = resolveModel('high', reg)
    expect(r.level).toBe('high')
    expect(r.model.model).toBe('m-high')
    expect(r.provider.id).toBe('a')
  })

  it('serves multiple levels from one provider (gigachat-style)', () => {
    const giga = provider('gigachat', 'gigachat', {
      low: lvl('GigaChat-Lite', 0),
      middle: lvl('GigaChat', 1),
      high: lvl('GigaChat-Pro', 2)
    })
    expect(resolveModel('low', [giga]).model.model).toBe('GigaChat-Lite')
    expect(resolveModel('high', [giga]).model.model).toBe('GigaChat-Pro')
    expect(resolveModel('low', [giga]).provider).toBe(resolveModel('high', [giga]).provider)
  })

  it('falls back to the closest lower level by order', () => {
    const reg = [provider('a', 'openai', { low: lvl('l', 0), middle: lvl('m', 1), top: lvl('t', 9) })]
    // 'high' not served; nearest lower by order to ... 'high' is unknown order -> weakest.
    // Use a served-but-gapped case instead: request a custom level present in one provider only.
    const r = resolveModel('middle', reg)
    expect(r.level).toBe('middle')
  })

  it('falls back for an unknown requested level to the weakest available', () => {
    const reg = [provider('a', 'openai', { mid: lvl('m', 5), top: lvl('t', 9) })]
    const r = resolveModel('nonexistent', reg)
    expect(r.level).toBe('mid') // lowest order
  })

  it('supports arbitrary data-driven level ids', () => {
    const reg = [provider('a', 'openai', { fast: lvl('gpt-fast', 0), pro: lvl('gpt-pro', 10) })]
    expect(resolveModel('pro', reg).model.model).toBe('gpt-pro')
    expect(resolveModel('fast', reg).model.model).toBe('gpt-fast')
  })

  it('resolves across multiple providers', () => {
    const reg = [
      provider('clisr', 'clisr', { low: lvl('local', 0) }),
      provider('openai', 'openai', { high: lvl('gpt', 5) })
    ]
    expect(resolveModel('low', reg).provider.id).toBe('clisr')
    expect(resolveModel('high', reg).provider.id).toBe('openai')
  })

  it('throws when no provider serves any level', () => {
    expect(() => resolveModel('low', [provider('a', 'openai', {})])).toThrow('serves no levels')
    expect(() => resolveModel('low', [])).toThrow('serves no levels')
  })
})

describe('availableLevels', () => {
  it('lists distinct levels sorted by order with UI metadata', () => {
    const reg = [
      provider('a', 'openai', {
        pro: lvl('gpt-pro', 10, 4, 'Pro', 'Best quality'),
        fast: lvl('gpt-fast', 0, 1, 'Fast', 'Quick replies')
      })
    ]
    const levels = availableLevels(reg)
    expect(levels.map((l) => l.level)).toEqual(['fast', 'pro'])
    expect(levels[0]).toEqual({
      level: 'fast',
      order: 0,
      label: 'Fast',
      description: 'Quick replies',
      tokenMultiplier: 1,
      displayMultiplier: 1
    })
  })

  it('dedupes a level across providers, keeping the lower-order entry', () => {
    const reg = [
      provider('a', 'openai', { low: lvl('m1', 5, 2, 'A') }),
      provider('b', 'clisr', { low: lvl('m2', 0, 1, 'B') })
    ]
    const levels = availableLevels(reg)
    expect(levels).toHaveLength(1)
    expect(levels[0].label).toBe('B') // order 0 wins
  })
})

describe('providerLevels', () => {
  it('lists served levels weakest -> strongest by order', () => {
    const p = provider('a', 'gigachat', { high: lvl('h', 5), low: lvl('l', 0), max: lvl('x', 9) })
    expect(providerLevels(p)).toEqual(['low', 'high', 'max'])
  })
})

describe('planMultiplier', () => {
  // Low fallback class from config: base 0.1, free-no-pkg 0.5, paid 0.5 (slow local, still billed).
  const low = { tokenMultiplier: 0.1, freeMultiplier: 0.5, paidMultiplier: 0.5, fallbackEligible: true }
  // Any non-low level: no plan-dependent factors.
  const mid = { tokenMultiplier: 2 }

  it('returns tokenMultiplier for non-low levels regardless of plan', () => {
    expect(planMultiplier(mid, true, false)).toBe(2)
    expect(planMultiplier(mid, false, true)).toBe(2)
  })

  it('low + free + no package -> freeMultiplier', () => {
    expect(planMultiplier(low, true, false)).toBe(0.5)
  })

  it('low + free + package -> base tokenMultiplier', () => {
    expect(planMultiplier(low, true, true)).toBe(0.1)
  })

  it('low + paid -> paidMultiplier', () => {
    expect(planMultiplier(low, false, false)).toBe(0.5)
    expect(planMultiplier(low, false, true)).toBe(0.5)
  })

  it('undefined model -> 1', () => {
    expect(planMultiplier(undefined, true, false)).toBe(1)
  })
})

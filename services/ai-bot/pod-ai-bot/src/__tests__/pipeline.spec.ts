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

import { type AIProviderConfig } from '../config'
import { dispatch, providerTopic, providerTopics } from '../pipeline'

function provider (id: string, levels: AIProviderConfig['levels']): AIProviderConfig {
  return { id, provider: 'openai', concurrency: 1, batch: 1, levels }
}

describe('providerTopic', () => {
  it('prefixes the provider id', () => {
    expect(providerTopic('gigachat')).toBe('llm-gigachat')
  })
})

describe('dispatch', () => {
  const reg = [
    provider('clisr', { low: { model: 'local', tokenMultiplier: 0.1, order: 0, label: 'Local' } }),
    provider('gpt', { high: { model: 'gpt-4o', tokenMultiplier: 1, order: 5, label: 'Pro' } })
  ]

  it('routes an exact level to its provider topic', () => {
    const t = dispatch('high', reg)
    expect(t.providerId).toBe('gpt')
    expect(t.topic).toBe('llm-gpt')
    expect(t.level).toBe('high')
  })

  it('routes the local level to the clisr topic', () => {
    const t = dispatch('low', reg)
    expect(t.topic).toBe('llm-clisr')
  })

  it('reports the fallback level when the requested one is unavailable', () => {
    // 'middle' unknown -> weakest available is 'low' (clisr, order 0)
    const t = dispatch('middle', reg)
    expect(t.providerId).toBe('clisr')
    expect(t.level).toBe('low')
  })

  it('routes all levels of a multi-level provider to one topic', () => {
    const giga = [
      provider('gigachat', {
        low: { model: 'GigaChat-Lite', tokenMultiplier: 1, order: 0, label: 'Lite' },
        high: { model: 'GigaChat-Pro', tokenMultiplier: 4, order: 5, label: 'Pro' }
      })
    ]
    expect(dispatch('low', giga).topic).toBe('llm-gigachat')
    expect(dispatch('high', giga).topic).toBe('llm-gigachat')
  })
})

describe('providerTopics', () => {
  it('returns distinct topics for the registry', () => {
    const reg = [
      provider('a', { low: { model: 'm', tokenMultiplier: 1, order: 0, label: 'A' } }),
      provider('b', { high: { model: 'n', tokenMultiplier: 1, order: 1, label: 'B' } })
    ]
    expect(providerTopics(reg).sort()).toEqual(['llm-a', 'llm-b'])
  })
})

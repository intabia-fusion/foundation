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

import { type AsrLevel, type AsrLevelModel, type AsrProviderConfig } from '../config'
import { availableAsrLevels, resolveAsrModel, resolveTranscriptionConfig } from '../transcription/asrRegistry'

function lvl (model: string, order: number, multiplier = 1, label = model): AsrLevelModel {
  return { model, tokenMultiplier: multiplier, order, label }
}

function provider (
  id: string,
  type: AsrProviderConfig['provider'],
  levels: Partial<Record<AsrLevel, AsrLevelModel>>
): AsrProviderConfig {
  return { id, provider: type, levels }
}

describe('resolveAsrModel', () => {
  it('returns the exact level match', () => {
    const reg = [provider('a', 'openai', { default: lvl('whisper-1', 0), premium: lvl('whisper-large', 2) })]
    const r = resolveAsrModel('premium', reg)
    expect(r.level).toBe('premium')
    expect(r.model.model).toBe('whisper-large')
  })

  it('falls back to the weakest level for an unknown request', () => {
    const reg = [provider('a', 'server', { default: lvl('Base', 0), premium: lvl('Large', 9) })]
    expect(resolveAsrModel('nonexistent', reg).level).toBe('default')
  })

  it('throws when the registry serves no levels', () => {
    expect(() => resolveAsrModel('default', [])).toThrow('serves no levels')
  })
})

describe('availableAsrLevels', () => {
  it('lists distinct levels sorted by order', () => {
    const reg = [provider('a', 'openai', { premium: lvl('m1', 10, 3, 'Premium'), default: lvl('m2', 0, 1, 'Default') })]
    expect(availableAsrLevels(reg).map((l) => l.level)).toEqual(['default', 'premium'])
  })
})

describe('resolveTranscriptionConfig', () => {
  const vad = { vadRmsThreshold: 0.02, vadSpeechRatioThreshold: 0.1 }

  it('disables transcription (provider empty) when the registry is empty', () => {
    expect(resolveTranscriptionConfig([], 'default', vad)).toEqual({ provider: '' })
  })

  it('resolves provider/model from the registry when populated', () => {
    const reg = [provider('clisr', 'server', { default: { ...lvl('Base', 0), url: 'ws://clisr' } })]
    const result = resolveTranscriptionConfig(reg, 'default', vad)
    expect(result.provider).toBe('server')
    expect(result.model).toBe('Base')
    expect(result.url).toBe('ws://clisr')
    expect(result.vadRmsThreshold).toBe(0.02)
  })
})

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
import { type TranscriptionConfig } from './types'

export interface ResolvedAsrModel {
  provider: AsrProviderConfig
  level: AsrLevel // the level actually served (may differ from requested after fallback)
  model: AsrLevelModel
}

/** A level available across the registry, for UI listing. */
export interface AvailableAsrLevel {
  level: AsrLevel
  order: number
  label: string
  description?: string
  tokenMultiplier: number
  displayMultiplier: number
}

/**
 * All distinct levels the registry serves, sorted by `order` (weakest first).
 * Mirrors availableLevels() in llms/modelRegistry.ts.
 */
export function availableAsrLevels (registry: AsrProviderConfig[]): AvailableAsrLevel[] {
  const byLevel = new Map<AsrLevel, AvailableAsrLevel>()
  for (const provider of registry) {
    for (const [level, model] of Object.entries(provider.levels)) {
      if (model === undefined) continue
      const existing = byLevel.get(level)
      if (existing === undefined || model.order < existing.order) {
        byLevel.set(level, {
          level,
          order: model.order,
          label: model.label,
          description: model.description,
          tokenMultiplier: model.tokenMultiplier,
          displayMultiplier: model.displayMultiplier ?? model.tokenMultiplier
        })
      }
    }
  }
  return [...byLevel.values()].sort((a, b) => a.order - b.order)
}

/**
 * Resolve a requested level to a (provider, model). The exact level wins; if no
 * provider serves it, fall back to the nearest available level by `order`.
 * Mirrors resolveModel() in llms/modelRegistry.ts.
 */
export function resolveAsrModel (level: AsrLevel, registry: AsrProviderConfig[]): ResolvedAsrModel {
  const at = (lvl: AsrLevel): ResolvedAsrModel | undefined => {
    for (const provider of registry) {
      const model = provider.levels[lvl]
      if (model !== undefined) return { provider, level: lvl, model }
    }
    return undefined
  }

  const exact = at(level)
  if (exact !== undefined) return exact

  const levels = availableAsrLevels(registry)
  if (levels.length === 0) {
    throw new Error('ASR provider registry serves no levels')
  }

  const reqOrder = levels.find((l) => l.level === level)?.order
  if (reqOrder === undefined) {
    const fallback = at(levels[0].level)
    if (fallback !== undefined) return fallback
  } else {
    const lower = levels.filter((l) => l.order < reqOrder).pop()
    const higher = levels.find((l) => l.order > reqOrder)
    const pick = lower ?? higher
    if (pick !== undefined) {
      const r = at(pick.level)
      if (r !== undefined) return r
    }
  }

  throw new Error('ASR provider registry serves no levels')
}

/**
 * Build a TranscriptionConfig from the ASR registry (yaml `asr:` block). Empty registry
 * means transcription is disabled for this pod (provider '').
 */
export function resolveTranscriptionConfig (
  registry: AsrProviderConfig[],
  defaultLevel: AsrLevel,
  vad: { vadRmsThreshold?: number, vadSpeechRatioThreshold?: number }
): TranscriptionConfig {
  if (registry.length === 0) return { provider: '' }
  const resolved = resolveAsrModel(defaultLevel, registry)
  return {
    provider: resolved.provider.provider,
    url: resolved.model.url,
    apiKey: resolved.model.apiKey,
    model: resolved.model.model,
    vadRmsThreshold: vad.vadRmsThreshold,
    vadSpeechRatioThreshold: vad.vadSpeechRatioThreshold
  }
}

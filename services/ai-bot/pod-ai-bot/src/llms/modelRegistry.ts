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

import { type AILevel, type AILevelFeatures, type AILevelModel, type AIProviderConfig } from '../config'

export interface ResolvedModel {
  provider: AIProviderConfig
  level: AILevel // the level actually served (may differ from requested after fallback)
  model: AILevelModel
}

/** A level available across the registry, for UI listing. */
export interface AvailableLevel {
  level: AILevel
  order: number
  label: string
  tokenMultiplier: number
  displayMultiplier: number // UI-facing "xN"; resolved from AILevelModel.displayMultiplier ?? tokenMultiplier
  features?: AILevelModel['features']
}

/** All distinct levels the registry serves, sorted by `order`; lower-order entry wins on id collision. */
export function availableLevels (registry: AIProviderConfig[]): AvailableLevel[] {
  const byLevel = new Map<AILevel, AvailableLevel>()
  for (const provider of registry) {
    for (const [level, model] of Object.entries(provider.levels)) {
      if (model === undefined) continue
      const existing = byLevel.get(level)
      if (existing === undefined || model.order < existing.order) {
        byLevel.set(level, {
          level,
          order: model.order,
          label: model.label,
          tokenMultiplier: model.tokenMultiplier,
          displayMultiplier: model.displayMultiplier ?? model.tokenMultiplier,
          features: model.features
        })
      }
    }
  }
  return [...byLevel.values()].sort((a, b) => a.order - b.order)
}

/** Registry narrowed to levels that serve a feature, so routing falls back instead of failing at the model. */
export function registryForFeature (registry: AIProviderConfig[], feature?: keyof AILevelFeatures): AIProviderConfig[] {
  if (feature === undefined) return registry
  const filtered = registry
    .map((provider) => ({
      ...provider,
      levels: Object.fromEntries(
        Object.entries(provider.levels).filter(([, m]) => m !== undefined && m.features?.[feature] !== false)
      )
    }))
    .filter((provider) => Object.keys(provider.levels).length > 0)
  return filtered.length > 0 ? filtered : registry
}

/**
 * Resolve a requested level to (provider, model); the exact level wins, else falls back to the
 * nearest available level by `order` (closest lower/cheaper, then closest higher).
 */
export function resolveModel (level: AILevel, registry: AIProviderConfig[]): ResolvedModel {
  const at = (lvl: AILevel): ResolvedModel | undefined => {
    for (const provider of registry) {
      const model = provider.levels[lvl]
      if (model !== undefined) return { provider, level: lvl, model }
    }
    return undefined
  }

  const exact = at(level)
  if (exact !== undefined) return exact

  const levels = availableLevels(registry)
  if (levels.length === 0) {
    throw new Error('AI provider registry serves no levels')
  }

  // Requested level not served. Pick nearest by order: prefer closest lower,
  // else closest higher. Unknown requested level (no order) -> weakest available.
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

  throw new Error('AI provider registry serves no levels')
}

/** All levels a provider serves, weakest -> strongest (by `order`). */
export function providerLevels (provider: AIProviderConfig): AILevel[] {
  return Object.entries(provider.levels)
    .filter(([, m]) => m !== undefined)
    .sort(([, a], [, b]) => (a as AILevelModel).order - (b as AILevelModel).order)
    .map(([level]) => level)
}

/**
 * Resolve billing metadata for a provider level. modelFallback covers an absent level model id.
 * One multiplier per level: a plan-dependent one meant the same tokens were billed differently
 * depending on which call site remembered to pass the plan, which is how translate and summarize
 * ended up charged at the paid rate on a free workspace.
 */
export function billingMetaFor (
  provider: AIProviderConfig,
  level: AILevel | undefined,
  defaultLevel: AILevel,
  modelFallback: () => string = () => ''
): { multiplier: number, modelId: string, providerId: string, level: string } {
  const lvl = level ?? defaultLevel
  const m = provider.levels[lvl] ?? provider.levels[defaultLevel]
  return {
    multiplier: m?.tokenMultiplier ?? 1,
    modelId: m?.model ?? modelFallback(),
    providerId: provider.id,
    level: lvl
  }
}

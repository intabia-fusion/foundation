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
import { type PlanContext } from './types'

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
  description?: string
  tokenMultiplier: number
  displayMultiplier: number // UI-facing "xN"; resolved from AILevelModel.displayMultiplier ?? tokenMultiplier
}

/**
 * All distinct levels the registry serves, sorted by `order` (weakest first).
 * If two providers define the same level id, the lower-order entry wins. UI uses
 * this to render the level picker with labels/descriptions.
 */
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
 * provider serves it, fall back to the nearest available level by `order` (prefer
 * the closest lower/cheaper, then the closest higher). Throws if the registry
 * serves no levels.
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
 * Plan-dependent billed multiplier. Only the low/fallback level (the one carrying
 * free/paid multipliers in config) varies by plan; every other level bills at its
 * base tokenMultiplier. Billing outage ('unknown' plan) is treated as PAID.
 */
export function planMultiplier (
  m:
  | { tokenMultiplier: number, freeMultiplier?: number, paidMultiplier?: number, fallbackEligible?: boolean }
  | undefined,
  isFree: boolean,
  hasPackages: boolean
): number {
  if (m === undefined) return 1
  // No plan-dependent factors defined -> base multiplier (all non-low levels).
  if (m.paidMultiplier === undefined && m.freeMultiplier === undefined) return m.tokenMultiplier
  if (!isFree) return m.paidMultiplier ?? m.tokenMultiplier
  if (hasPackages) return m.tokenMultiplier
  return m.freeMultiplier ?? m.tokenMultiplier
}

/**
 * Resolve billing metadata for a provider level.
 * modelFallback is called only when the level model id is absent (provider-specific fallback).
 * planContext (when given) resolves the plan-dependent low-fallback multiplier; omitting it
 * keeps the base tokenMultiplier (back-compat for callers without plan info).
 */
export function billingMetaFor (
  provider: AIProviderConfig,
  level: AILevel | undefined,
  defaultLevel: AILevel,
  modelFallback: () => string = () => '',
  planContext?: PlanContext
): { multiplier: number, modelId: string, providerId: string, level: string } {
  const lvl = level ?? defaultLevel
  const m = provider.levels[lvl] ?? provider.levels[defaultLevel]
  return {
    multiplier:
      planContext !== undefined
        ? planMultiplier(m, planContext.isFree, planContext.hasPackages)
        : (m?.tokenMultiplier ?? 1),
    modelId: m?.model ?? modelFallback(),
    providerId: provider.id,
    level: lvl
  }
}

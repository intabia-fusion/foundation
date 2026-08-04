//
// Copyright © 2026 Intabia Fusion
//

import { type AILevel, type AIProviderConfig } from '../config'
import { providerLevels, resolveModel } from '../llms/modelRegistry'

export interface WindowUsage {
  // Single monthly billed-token window [periodStart, +30d].
  month: { used: number, limit: number }
  // Billing plan name ('free' | 'unknown' | tier). For display/billing only.
  plan: string
  // Free plan (by the free provider, not by name). Free is hard-blocked past the limit; paid downgrades.
  isFree: boolean
  // Whether the workspace has >=1 active AI/storage package (affects low fallback multiplier).
  hasPackages: boolean
  // Billing could not be reached: the real limit is unknown, so serving would be unmetered.
  unavailable?: boolean
}

export interface LimitDecision {
  // 'proceed' with the (possibly downgraded) level, or 'block' when the monthly limit is hit
  // (reason 'limit') or billing is unreachable (reason 'unavailable').
  action: 'proceed' | 'block'
  level?: AILevel
  reason?: 'limit' | 'unavailable'
}

function over (w: { used: number, limit: number }): boolean {
  return w.limit > 0 && w.used >= w.limit
}

// Monthly window over -> paid plans downgrade to the cheapest fallback-eligible (low),
// free plans are hard-blocked. Under the limit -> proceed as requested.
export function decideLevel (requested: AILevel, registry: AIProviderConfig[], usage: WindowUsage): LimitDecision {
  // Billing unreachable: the limit is unknown, so serving would be unmetered. Refuse instead.
  if (usage.unavailable === true) {
    return { action: 'block', reason: 'unavailable' }
  }
  if (!over(usage.month)) {
    return { action: 'proceed', level: requested }
  }

  // Monthly budget spent. Free plans are hard-blocked: no AI (not even low) until the month
  // resets. Paid plans always downgrade to the local low level (slow but usable).
  if (usage.isFree) {
    return { action: 'block', reason: 'limit' }
  }
  if (isEligible(requested, registry)) {
    return { action: 'proceed', level: requested }
  }
  const fallback = cheapestEligible(registry)
  if (fallback !== undefined) {
    return { action: 'proceed', level: fallback }
  }
  return { action: 'block', reason: 'limit' }
}

function isEligible (level: AILevel, registry: AIProviderConfig[]): boolean {
  try {
    return resolveModel(level, registry).model.fallbackEligible === true
  } catch {
    return false
  }
}

// Cheapest fallback-eligible level across all providers (lowest order).
export function cheapestEligible (registry: AIProviderConfig[]): AILevel | undefined {
  let best: { level: AILevel, order: number } | undefined
  for (const provider of registry) {
    for (const level of providerLevels(provider)) {
      const model = provider.levels[level]
      if (model?.fallbackEligible === true) {
        if (best === undefined || model.order < best.order) {
          best = { level, order: model.order }
        }
      }
    }
  }
  return best?.level
}

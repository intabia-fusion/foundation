//
// Copyright © 2026 Intabia Fusion
//

import { type AILevel } from '../config'

export interface WindowUsage {
  // Tier token window for the current period [periodStart, +30d]; burns at period end.
  month: { used: number, limit: number }
  // Purchased tokens left (packages + one-time buys). Spent before the tier window, never expire.
  balance: number
  // Billing plan name ('free' | 'unknown' | tier). For display/billing only.
  plan: string
  // Free plan (by the free provider, not by name). Drives the billed multiplier, not the block.
  isFree: boolean
  // Whether the workspace has >=1 active AI/storage package (affects low fallback multiplier).
  hasPackages: boolean
  // Billing could not be reached: the real limit is unknown, so serving would be unmetered.
  unavailable?: boolean
}

export interface LimitDecision {
  // 'proceed' with the requested level, or 'block' when both pools are empty (reason 'limit')
  // or billing is unreachable (reason 'unavailable').
  action: 'proceed' | 'block'
  level?: AILevel
  reason?: 'limit' | 'unavailable'
}

// Tokens left across both pools; 0 limit = unlimited monthly grant.
// `used` is the whole period spend and the pack is charged only at period end, so both pools go
// into one subtraction - clamping the grant first would hide an overspend behind the full pack.
function tokensLeft (usage: WindowUsage): number | undefined {
  if (usage.month.limit <= 0) return undefined
  return Math.max(0, usage.month.limit + usage.balance - usage.month.used)
}

// Out of tokens -> block every plan and offer a top-up. No level downgrade: a cheap on-prem
// model still costs money, and silently degrading quality reads as the product breaking.
export function decideLevel (requested: AILevel, usage: WindowUsage): LimitDecision {
  // Billing unreachable: the limit is unknown, so serving would be unmetered. Refuse instead.
  if (usage.unavailable === true) {
    return { action: 'block', reason: 'unavailable' }
  }
  const left = tokensLeft(usage)
  if (left !== undefined && left <= 0) {
    return { action: 'block', reason: 'limit' }
  }
  return { action: 'proceed', level: requested }
}

//
// Copyright © 2026 Intabia Fusion
//

import { type ProviderPool } from './types'

export interface PoolTransition {
  usedTokens: number
  exhausted: boolean
  reach80: boolean
  reach100: boolean
  crossed80: boolean
  crossed100: boolean
}

// Pure pool-state transition: given the current pool and a recomputed used-tokens
// value, decide exhausted/threshold flags and whether 80%/100% was newly crossed.
// Local pools and pools with no purchased budget never exhaust or notify.
export function computePoolTransition (pool: ProviderPool, usedTokens: number): PoolTransition {
  const unlimited = pool.kind === 'local' || pool.purchasedTokens <= 0
  const pct = unlimited ? 0 : usedTokens / pool.purchasedTokens
  const reach80 = !unlimited && pct >= 0.8
  const reach100 = !unlimited && pct >= 1
  return {
    usedTokens,
    exhausted: reach100,
    reach80,
    reach100,
    crossed80: reach80 && !pool.notified80,
    crossed100: reach100 && !pool.notified100
  }
}

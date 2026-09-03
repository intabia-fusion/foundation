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

import { PaletteColorIndexes } from '@hcengineering/ui'
import type { BillingPricing } from '@hcengineering/billing-client'

/** Percent fill clamped to [0, 100]. */
export function pct (used: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.round((used / total) * 100))
}

/** Maps a percent value (0-100 scale) to a palette color. */
export function barColor (p: number): number | undefined {
  if (p >= 100) return PaletteColorIndexes.Firework
  if (p >= 80) return PaletteColorIndexes.Sunshine
  return undefined
}

/** Cost in rubles for a token count at a given price per 1000 tokens. */
export function tokenCost (tokens: number, pricePer1000: number): number {
  return (tokens / 1000) * pricePer1000
}

/** Price per 1000 tokens for a model key from BillingPricing. */
export function priceForKey (pricing: BillingPricing | undefined, key: string | undefined): number {
  if (key === undefined || pricing === undefined) return 0
  return pricing.pricePer1000[key] ?? 0
}

/** Format a ruble amount with 2 decimal places. */
export function fmtRub (v: number): string {
  return `${v.toFixed(2)} ₽`
}

/** Format minutes as "Xh Ym" (or "Ym" if under an hour). */
export function formatMinutes (minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** Compact token count: "100.5k", "1.2M", "3.4B" (trims trailing ".0"). */
export function formatTokens (n: number): string {
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k']
  ]
  for (const [factor, suffix] of units) {
    if (n >= factor) return `${(n / factor).toFixed(1).replace(/\.0$/, '')}${suffix}`
  }
  return String(Math.round(n))
}

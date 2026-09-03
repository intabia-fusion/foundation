//
// Copyright © 2025 Hardcore Engineering Inc.
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

/** @public */
export type LocalizedString = string | Record<string, string>

/** @public */
export interface PlanItem {
  label: LocalizedString
  description: LocalizedString
  limits: LocalizedString[]
  features: LocalizedString[]
  // Monthly price in whole rubles; absent for free / contact-sales plans.
  priceMonthly?: number
  priceMonthlyPerUser?: number
  // Optional display override shown instead of a numeric price (e.g. "Бесплатно", "По запросу").
  priceMonthlyText?: LocalizedString
  // Yearly discount in percent
  yearlyDiscount?: number
  currency?: string
  free?: boolean
  contactSales?: boolean
  storageLimitGB: number
  trafficLimitGB: number
  meetingMinutesLimit: number // In minutes
  tokenLimit: number // In thousands of tokens
  usersLimit: number
  // Seats-input hard cap (usersLimit=0 = unlimited, can't cap input). Absent -> MAX_SEATS_FALLBACK.
  maxSeats?: number

  // AI rolling-window limit (billed tokens/month). Bigger plan = bigger window = more
  // AI before the rate-limit kicks in. 0 = unlimited.
  windowMonthLimit?: number

  index: number
  color?: string
}

/** @public */
export type PackageCategory = 'storage' | 'ai'

export interface PackageItem {
  description: LocalizedString
  // Monthly price in whole rubles.
  priceMonthly: number
  currency: string
  eligiblePlans: string[]
  // Storage addon packages grant disk; AI-token packages grant a monthly billed-token quota
  // (tokenLimit) whose unused part rolls over. One active subscription per category.
  category: PackageCategory
  storageLimitGB?: number
  tokenLimit?: number
}

/** One-time catalog purchase (not a subscription): bought once, its effect runs on payment. */
export interface PurchasableItem {
  description: LocalizedString
  // One-time price in whole rubles.
  priceMonthly: number
  currency: string
  eligiblePlans: string[]
  category: string
  // Effect key run on activation (e.g. 'add-ai-tokens' tops the AI token budget up).
  effect: string
  // Magnitude of the effect: billed tokens added by an 'add-ai-tokens' purchase.
  tokenLimit?: number
}

/** @public */
export interface PlanConfig {
  plans: Record<string, PlanItem>
  packages: Record<string, PackageItem>
  purchasables?: Record<string, PurchasableItem>
}

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

import { type PackageItem, type PlanItem } from './types'

/** Plan-config fields pricing needs. Both PlanItem and PackageItem satisfy it. */
export interface PricedItem {
  free?: boolean
  priceMonthly?: number
  priceMonthlyPerUser?: number
  yearlyDiscount?: number
  currency?: string
}

/**
 * Full price in minor units (kopecks) for a plan-config item at the given seats/period. The
 * config prices are whole rubles; callers that display the result divide by 100.
 * Server-side twin: computePlanPrice in services/payment/pod-payment/src/utils.ts. Kept separate on
 * purpose — a pod must not depend on a UI package. Change both or they drift.
 */
export function planCharge (item: PricedItem | undefined, seats: number, period: 'monthly' | 'yearly'): number {
  if (item == null || item.free === true) return 0
  const isYearly = period === 'yearly'
  const yd = Number(item.yearlyDiscount ?? 0)
  const discount = 1 - (Number.isFinite(yd) ? yd : 0) / 100
  if (item.priceMonthlyPerUser != null) {
    const perUser = Number(item.priceMonthlyPerUser)
    const monthly = isYearly ? Math.round(perUser * discount) : perUser
    return Math.round((isYearly ? monthly * 12 * seats : monthly * seats) * 100)
  }
  const flat = Number(item.priceMonthly)
  if (!Number.isFinite(flat)) return 0
  const monthly = isYearly ? Math.round(flat * discount) : flat
  return Math.round((isYearly ? monthly * 12 : monthly) * 100)
}

/** Effective monthly price per seat in whole rubles (yearly applies the discount). 0 for flat plans. */
export function monthlyPerSeat (item: PricedItem | undefined, period: 'monthly' | 'yearly'): number {
  const perUser = Number(item?.priceMonthlyPerUser)
  if (!Number.isFinite(perUser)) return 0
  if (period !== 'yearly') return perUser
  const yd = Number(item?.yearlyDiscount ?? 0)
  return Math.round(perUser * (1 - (Number.isFinite(yd) ? yd : 0) / 100))
}

/** Per-seat plans price by seat count; flat ones don't. */
export function isPerSeat (item: PricedItem | undefined): boolean {
  return item?.priceMonthlyPerUser != null
}

/** Display currency of a plan or package. */
export function currencyOf (item: PlanItem | PackageItem | undefined, fallback: string = '₽'): string {
  const currency = item?.currency
  return currency != null && currency !== '' ? currency : fallback
}

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

import type { AccountUuid, WorkspaceUuid } from '@hcengineering/core'

export enum SubscriptionType {
  Tier = 'tier', // Main workspace tier (free, starter, pro, enterprise)
  Support = 'support', // Voluntary support/donation subscription
  Package = 'package', // Additional package (storage, etc.)
  Purchase = 'purchase' // One-time catalog purchase (AI usage reset, skins, unlocks) — not a limit-granting subscription
}

export enum SubscriptionStatus {
  Active = 'active', // Subscription is active and paid
  Trialing = 'trialing', // In trial period (free usage)
  PastDue = 'past_due', // Payment failed but subscription not yet canceled (grace period — full access)
  ReadOnly = 'readonly', // Grace period expired — read-only access, payment still due
  Canceled = 'canceled', // Subscription was canceled by user or admin
  Paused = 'paused', // Subscription is temporarily paused (some providers support this)
  Expired = 'expired' // Subscription or trial has expired
}

export type BillingPeriod = 'monthly' | 'yearly'

/**
 * Subscription request parameters
 * Used when creating a new subscription
 */
export interface SubscribeRequest {
  type: SubscriptionType
  plan: string // Plan identifier
  customerEmail?: string // Optional customer email
  customerName?: string // Optional customer name
  quantity?: number // Number of seats for per-seat plans (total charge = price-per-seat * quantity)
  period?: BillingPeriod // Billing period; 'yearly' applies the plan's yearly discount. Defaults to 'monthly'.
  force?: boolean // Switch tariff: cancel a different pending checkout for this type, then open the new one.
  recurrent?: boolean // recurring charges; false (default) = one-off payment: don't save the card
}

/**
 * Checkout creation response
 * Contains checkout details for payment
 */
export interface CheckoutResponse {
  checkoutId: string // Checkout session ID
  checkoutUrl: string // URL to redirect user to for payment
  instant?: boolean // Subscription already active (no checkout page) — refetch instead of redirect
}

/**
 * Subscription data for checkout status
 * Matches @hcengineering/account-client Subscription type
 * @see @hcengineering/account-client
 */
export interface SubscriptionData {
  id: string // Internal unique subscription ID
  workspaceUuid: WorkspaceUuid
  accountUuid: AccountUuid
  provider: string
  providerSubscriptionId: string
  providerCheckoutId?: string
  type: SubscriptionType
  status: SubscriptionStatus
  plan: string
  amount?: number
  periodStart?: number
  periodEnd?: number
  trialEnd?: number
  canceledAt?: number
  providerData?: Record<string, any>
}

/**
 * Pro-rata preview for a seat/package change (no mutation). amount fields are in kopecks.
 */
export interface PlanChangePreview {
  charge: number // one-time charge now (0 for a downgrade)
  periodEnd?: number // resulting period end (ms); undefined when there is no paid period to prorate
  minSeats: number // seat floor (current member count)
  newSeats: number
  newFullPrice?: number // recurring price after the change
  isUpgrade?: boolean
  isYearly?: boolean
}

/**
 * Checkout status response
 * Contains information about the checkout and subscription status
 */
export interface CheckoutStatus {
  checkoutId: string // Checkout session ID
  subscriptionId: string | null // Subscription ID if completed
  status: 'pending' | 'completed' // Checkout status
  subscription: SubscriptionData | null // Full subscription data if available
}

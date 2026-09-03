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

import type { Express } from 'express'
import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import type { QueueSubscriptionTrigger } from '@hcengineering/server-core'
import { type SubscriptionType, type SubscriptionData } from '@hcengineering/account-client'

/**
 * A non-ok HTTP response from a downstream provider. Carries status + parsed `reason` so the facade
 * relays them instead of flattening to 500 (e.g. 409 'other_checkout_active' must reach the UI modal).
 */
export class ProviderHttpError extends Error {
  constructor (
    readonly status: number,
    readonly reason?: string,
    readonly body?: string
  ) {
    super(`Provider responded ${status}${reason !== undefined ? ` (${reason})` : ''}`)
    this.name = 'ProviderHttpError'
  }
}

/**
 * Publishes a provider subscription event to the Subscription queue. Providers verify + transform,
 * then call this instead of writing to the account DB directly — pod-payment's consumer is the single
 * writer (bakes limits + upserts). `canceled` marks a cancellation event; both end up persisted.
 */
export type SubscriptionPublisher = (
  ctx: MeasureContext,
  data: SubscriptionData,
  trigger: QueueSubscriptionTrigger,
  canceled?: boolean
) => Promise<void>

/**
 * Payment subscription plan configuration
 * Defines what plans are available for a subscription type
 * TODO: take from billing from model
 */
export interface SubscriptionPlan {
  id: string // Plan identifier
  name: string // Display name
  description?: string
  price: number // Price in cents
  currency: string // e.g. 'usd'
}

export type BillingPeriod = 'monthly' | 'yearly'

/**
 * Subscription request from client
 * Used for subscribing to a plan
 */
export interface SubscribeRequest {
  type: SubscriptionType
  plan: string
  customerEmail?: string
  customerName?: string
  quantity?: number // Number of seats for per-seat plans (total charge = price-per-seat * quantity)
  period?: BillingPeriod // Billing period; 'yearly' applies the plan's yearly discount. Defaults to 'monthly'.
  force?: boolean // Switch tariff: cancel a different pending checkout for this type, then open the new one.
  recurrent?: boolean // recurring charges; false (default) = one-off payment: don't save the card
}

/**
 * Checkout response when a new subscription or plan upgrade requires a checkout
 */
export interface CheckoutResponse {
  checkoutId: string
  checkoutUrl: string
  // Provider activated the subscription synchronously (e.g. the mock provider): no external
  // checkout page, the client should refetch instead of redirecting and polling.
  instant?: boolean
}

/**
 * Payment provider abstraction
 * Core interface that all payment providers must implement
 * Includes both subscription operations and webhook handling
 */
export interface PaymentProvider {
  get providerName(): string

  createSubscription: (
    ctx: MeasureContext,
    request: SubscribeRequest,
    workspaceUuid: WorkspaceUuid,
    workspaceUrl: string,
    accountUuid: string
  ) => Promise<CheckoutResponse>

  /**
   * Get subscription details
   */
  getSubscription: (ctx: MeasureContext, subscriptionId: string) => Promise<SubscriptionData | null>

  /**
   * Get subscription by checkout ID
   * Used to poll for subscription creation after successful checkout
   * Returns the subscription data if found, null otherwise
   */
  getSubscriptionByCheckout: (ctx: MeasureContext, checkoutId: string) => Promise<SubscriptionData | null>

  /**
   * Cancel a subscription
   * Accepts provider subscription ID
   * Returns the canceled subscription data
   */
  cancelSubscription: (ctx: MeasureContext, providerSubscriptionId: string) => Promise<SubscriptionData>

  /**
   * Uncancel a subscription (reactivate a previously canceled subscription)
   * Accepts provider subscription ID
   * Returns the reactivated subscription data
   */
  uncancelSubscription: (ctx: MeasureContext, providerSubscriptionId: string) => Promise<SubscriptionData>

  /**
   * Update a subscription to a different plan
   * Used for upgrades and downgrades
   * For paid-to-paid upgrades: Returns SubscriptionData | null
   * For free-to-paid upgrades: Returns CheckoutResponse (requires checkout)
   * Handles immediate effective date with proration
   */
  updateSubscriptionPlan: (
    ctx: MeasureContext,
    subscriptionId: string,
    newPlan: string,
    type: SubscriptionType,
    workspaceUrl: string,
    accountUuid: string,
    quantity?: number,
    period?: BillingPeriod,
    recurrent?: boolean,
    force?: boolean // Forced switch: cancel a pending checkout for a different order and open a new one.
  ) => Promise<SubscriptionData | CheckoutResponse | null>

  /**
   * Retry a failed payment for a subscription in past_due status.
   * Attempts to charge the saved payment method again.
   * Returns the updated subscription data or null if not supported.
   */
  retryPayment: (ctx: MeasureContext, providerSubscriptionId: string) => Promise<SubscriptionData | null>

  /**
   * Reconcile active subscriptions between provider and our database. Reads current state, and
   * publishes changed subscriptions via `publish` (does NOT write to the account DB directly).
   */
  reconcileActiveSubscriptions: (
    ctx: MeasureContext,
    accountsUrl: string,
    serviceToken: string,
    publish: SubscriptionPublisher
  ) => Promise<void>

  /**
   * Register provider-specific webhook endpoints. Handlers verify + transform, then publish via
   * `publish` (the single account writer is pod-payment's queue consumer).
   */
  registerWebhookEndpoints: (
    app: Express,
    ctx: MeasureContext,
    accountsUrl: string,
    serviceToken: string,
    publish: SubscriptionPublisher
  ) => void
}

/**
 * Factory for creating payment providers
 */
export interface PaymentProviderFactory {
  /**
   * Create a payment provider instance
   */
  create: (type: string, config: Record<string, any>) => PaymentProvider | undefined
}

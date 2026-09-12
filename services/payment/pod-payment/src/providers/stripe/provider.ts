//
// Copyright © 2025 Hardcore Engineering Inc.
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

import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import type { Express, Request, Response } from 'express'
import type Stripe from 'stripe'

import { AccountClient, SubscriptionType, type SubscriptionData } from '@hcengineering/account-client'
import type { PaymentProvider, SubscribeRequest, CheckoutResponse, SubscriptionPublisher } from '../index'
import { StripeClient } from './client'
import { handleStripeWebhook } from './webhook'
import { transformStripeSubscriptionToData } from './utils'
import { getPlanKey } from '../../utils'
import { parseSubscriptionPlans, cancelOrUncancelSubscription, reconcileActiveSubscriptions } from '../shared'

/**
 * Stripe payment adapter.
 */
export class StripeProvider implements PaymentProvider {
  readonly providerName = 'stripe'
  private readonly stripe: StripeClient
  private readonly stripeApiKey: string
  private readonly webhookSecret: string
  // Map: plan@type (Huly) -> priceId (Stripe)
  private readonly subscriptionPlans: Record<string, string>
  private readonly frontUrl: string
  private readonly accountClient: AccountClient

  constructor (
    apiKey: string,
    webhookSecret: string,
    subscriptionPlans: string,
    frontUrl: string,
    accountClient: AccountClient
  ) {
    this.stripeApiKey = apiKey
    this.stripe = new StripeClient(apiKey)
    this.webhookSecret = webhookSecret
    // TODO: support branding
    this.frontUrl = frontUrl.replace(/\/+$/, '')
    this.accountClient = accountClient
    this.subscriptionPlans = parseSubscriptionPlans(subscriptionPlans, (priceId) => priceId)
  }

  async createSubscription (
    ctx: MeasureContext,
    request: SubscribeRequest,
    workspaceUuid: WorkspaceUuid,
    workspaceUrl: string,
    accountUuid: string
  ): Promise<CheckoutResponse> {
    ctx.info('Creating Stripe subscription', { type: request.type, plan: request.plan })

    const planKey = getPlanKey(request.type, request.plan)
    const priceId = this.subscriptionPlans[planKey]
    if (priceId === undefined) {
      throw new Error(`Missing priceId for plan: ${planKey}`)
    }
    const successUrl = `${this.frontUrl}/workbench/${workspaceUrl}/setting/setting/billing/subscriptions?payment=success&checkout_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = `${this.frontUrl}/workbench/${workspaceUrl}/setting/setting/billing/subscriptions?payment=canceled`
    const response = await this.stripe.createCheckout(ctx, {
      priceId,
      successUrl,
      cancelUrl,
      customerEmail: request.customerEmail,
      customerName: request.customerName,
      metadata: {
        workspaceUuid,
        subscriptionType: request.type,
        subscriptionPlan: request.plan,
        accountUuid
      }
    })

    return {
      checkoutId: response.checkoutId,
      checkoutUrl: response.url
    }
  }

  async getSubscription (ctx: MeasureContext, subscriptionId: string): Promise<SubscriptionData | null> {
    const stripeSubscription = await this.stripe.getSubscription(ctx, subscriptionId)
    const subscriptionData = transformStripeSubscriptionToData(ctx, stripeSubscription)

    if (subscriptionData === null) {
      return null
    }

    return subscriptionData
  }

  async getSubscriptionByCheckout (ctx: MeasureContext, checkoutId: string): Promise<SubscriptionData | null> {
    try {
      const checkout = await this.stripe.getCheckout(ctx, checkoutId)

      // If checkout is not complete, no subscription yet
      if (checkout.status !== 'complete') {
        ctx.info('Cannot get subscription by checkout: checkout is not complete', {
          checkoutId,
          status: checkout.status
        })
        return null
      }

      // If checkout has a subscription ID, fetch it directly
      if (checkout.subscription != null) {
        const subscriptionId =
          typeof checkout.subscription === 'string' ? checkout.subscription : checkout.subscription.id
        const subscription = await this.stripe.getSubscription(ctx, subscriptionId)
        const subscriptionData = transformStripeSubscriptionToData(ctx, subscription)

        if (subscriptionData !== null) {
          ctx.info('Found subscription by checkout: subscription ID', { checkoutId, subscriptionId })
          return subscriptionData
        }
      }

      // If we have a customer ID, try to find the subscription
      const customerId = typeof checkout.customer === 'string' ? checkout.customer : checkout.customer?.id
      if (customerId === undefined || customerId === null) {
        ctx.error('Cannot search subscriptions: no customer ID in checkout', { checkoutId })
        return null
      }

      const activeSubscriptions = await this.stripe.getActiveSubscriptions(ctx, customerId)

      // Find the most recent subscription for this customer (likely created from this checkout)
      if (activeSubscriptions.length > 0) {
        // Sort by created date, most recent first
        activeSubscriptions.sort((a, b) => b.created - a.created)
        const subscriptionData = transformStripeSubscriptionToData(ctx, activeSubscriptions[0])

        if (subscriptionData !== null) {
          return subscriptionData
        } else {
          ctx.error('Cannot get subscription by checkout: subscription is in irrelevant state', {
            checkoutId,
            subscriptionId: activeSubscriptions[0].id
          })
        }
      }

      ctx.error('Cannot get subscription by checkout: no subscriptions found', { checkoutId })
      return null
    } catch (err) {
      ctx.error('Failed to get subscription by checkout', { checkoutId, err })
      return null
    }
  }

  async reconcileActiveSubscriptions (
    ctx: MeasureContext,
    accountsUrl: string,
    serviceToken: string,
    publish: SubscriptionPublisher
  ): Promise<void> {
    await reconcileActiveSubscriptions<Stripe.Subscription>(
      ctx,
      'stripe',
      this.accountClient,
      publish,
      async (ctx) => await this.stripe.getActiveSubscriptions(ctx),
      async (ctx, id) => await this.stripe.getSubscription(ctx, id),
      (sub) => sub.id,
      transformStripeSubscriptionToData
    )
  }

  async retryPayment (ctx: MeasureContext, _providerSubscriptionId: string): Promise<SubscriptionData | null> {
    ctx.info('Stripe payment retry — delegating to Stripe dunning', {})
    // Stripe handles retries via its built-in dunning process.
    // No manual retry needed — Stripe will automatically retry.
    return null
  }

  async cancelSubscription (ctx: MeasureContext, providerSubscriptionId: string): Promise<SubscriptionData> {
    return await cancelOrUncancelSubscription(
      ctx,
      providerSubscriptionId,
      'cancel',
      async (ctx, id) => await this.stripe.cancelSubscription(ctx, id),
      transformStripeSubscriptionToData
    )
  }

  async uncancelSubscription (ctx: MeasureContext, providerSubscriptionId: string): Promise<SubscriptionData> {
    return await cancelOrUncancelSubscription(
      ctx,
      providerSubscriptionId,
      'uncancel',
      async (ctx, id) => await this.stripe.uncancelSubscription(ctx, id),
      transformStripeSubscriptionToData
    )
  }

  async updateSubscriptionPlan (
    ctx: MeasureContext,
    subscriptionId: string,
    newPlan: string,
    type: SubscriptionType,
    workspaceUrl: string,
    accountUuid: string
  ): Promise<SubscriptionData | CheckoutResponse | null> {
    // Get the current subscription to check if it's free
    const currentSub = await this.stripe.getSubscription(ctx, subscriptionId)

    // Check if subscription is free by checking if the price amount is 0
    const price = currentSub.items.data[0]?.price
    const isFreeSubscription = price?.unit_amount === 0 || price === undefined

    // Get the Stripe price ID for the new plan
    const planKey = getPlanKey(type, newPlan)
    const priceId = this.subscriptionPlans[planKey]
    if (priceId === undefined) {
      throw new Error(`No price configured for plan: ${planKey}`)
    }

    // If subscription is free, create a checkout instead of updating directly
    if (isFreeSubscription) {
      const successUrl = `${this.frontUrl}/workbench/${workspaceUrl}/setting/setting/billing/subscriptions?payment=success&checkout_id={CHECKOUT_SESSION_ID}`
      const cancelUrl = `${this.frontUrl}/workbench/${workspaceUrl}/setting/setting/billing/subscriptions?payment=canceled`

      const customerId = typeof currentSub.customer === 'string' ? currentSub.customer : currentSub.customer?.id
      const metadata = currentSub.metadata ?? {}

      const response = await this.stripe.createCheckout(ctx, {
        priceId,
        successUrl,
        cancelUrl,
        customerId,
        subscriptionId: currentSub.id,
        metadata: {
          workspaceUuid: metadata.workspaceUuid,
          subscriptionType: type,
          subscriptionPlan: newPlan,
          accountUuid
        }
      })

      return {
        checkoutId: response.checkoutId,
        checkoutUrl: response.url
      }
    }

    // Update the subscription to the new price
    const updatedSub = await this.stripe.updateSubscription(ctx, subscriptionId, priceId)

    // Transform and return the updated subscription data
    const subscriptionData = transformStripeSubscriptionToData(ctx, updatedSub)
    return subscriptionData
  }

  registerWebhookEndpoints (
    app: Express,
    ctx: MeasureContext,
    accountsUrl: string,
    serviceToken: string,
    publish: SubscriptionPublisher
  ): void {
    ctx.info('Registering Stripe webhook endpoints')

    // Register Stripe-specific webhook endpoint (body parsing handled by server middleware)
    app.post('/api/v1/webhooks/stripe', (req: Request, res: Response) => {
      void handleStripeWebhook(ctx, accountsUrl, serviceToken, this.webhookSecret, this.stripeApiKey, req, res, publish)
    })
  }
}

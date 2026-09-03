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

import {
  type AccountClient,
  type Subscription,
  type SubscriptionData,
  SubscriptionStatus,
  SubscriptionType
} from '@hcengineering/account-client'
import { type AccountUuid, type WorkspaceUuid, SocialIdType } from '@hcengineering/core'

import { isFailedRenewal } from './utils'

export class SubscriptionStorage {
  constructor (
    private readonly accountClient: AccountClient,
    private readonly publish: (data: SubscriptionData) => Promise<void>,
    // Optional audit publisher — a payment-operation ledger event to the durable queue.
    private readonly publishOperation?: (op: Record<string, any>) => Promise<void>
  ) {}

  async upsert (subscription: SubscriptionData): Promise<void> {
    await this.publish(subscription)
  }

  async getTransactionCount (workspaceUuid: WorkspaceUuid): Promise<number> {
    return (await this.accountClient.getSubscriptions(workspaceUuid)).filter((s) => s.provider === 'tbank').length
  }

  async getById (id: string): Promise<Subscription | null> {
    return await this.accountClient.getSubscriptionById(id)
  }

  async getByProviderId (providerSubscriptionId: string): Promise<Subscription | null> {
    return await this.accountClient.getSubscriptionByProviderId('tbank', providerSubscriptionId)
  }

  async getAll (workspaceUuid?: WorkspaceUuid, activeOnly?: boolean): Promise<Subscription[]> {
    return await this.accountClient.getSubscriptions(workspaceUuid, activeOnly)
  }

  // Atomic cross-pod renewal claim: claimed=true wins the right to charge this period.
  // Key invariant: ':' separates fields, no component may contain it (sub is hex, period a number).
  async claimRenewal (
    subscriptionId: string,
    periodEnd: number,
    amount?: number
  ): Promise<{ claimed: boolean, status: string, intentId: string, heartbeatAt?: number }> {
    const { claimed, intent } = await this.accountClient.claimIntent(`renew:${subscriptionId}:${periodEnd}`, 'tbank', {
      subscriptionId,
      amount
    })
    return { claimed, status: intent.status, intentId: intent.id, heartbeatAt: intent.heartbeatAt }
  }

  // Atomic checkout claim: one pending checkout per (workspace, type). Only the winner issues a payment;
  // orderFingerprint (plan:seats:period) lets a loser reuse the URL only on an exact order match (else 409).
  async claimCheckout (
    workspaceUuid: WorkspaceUuid,
    type: string,
    orderFingerprint: string
  ): Promise<{
      claimed: boolean
      status: string
      intentId: string
      heartbeatAt?: number
      paymentUrl?: string
      orderFingerprint?: string
      paymentId?: string
      createdOn: number
    }> {
    // Purchases accumulate, so their slot is per order: an abandoned SKU must not block another.
    const slot = type === SubscriptionType.Purchase ? `${type}:${orderFingerprint}` : type
    const { claimed, intent } = await this.accountClient.claimIntent(`checkout:${workspaceUuid}:${slot}`, 'tbank', {
      workspaceUuid,
      orderFingerprint
    })
    return {
      claimed,
      status: intent.status,
      intentId: intent.id,
      heartbeatAt: intent.heartbeatAt,
      paymentUrl: intent.paymentUrl,
      orderFingerprint: intent.orderFingerprint,
      // paymentId of the losing caller's active checkout — needed to cancel it on a forced switch.
      paymentId: intent.paymentId,
      // createdOn ≈ when the tbank link was issued — used to detect an expired (dead) link on reuse.
      createdOn: intent.createdOn
    }
  }

  // Link a won checkout intent to its issued charge and save the URL for reuse by repeat callers.
  async setCheckoutPayment (intentId: string, paymentId: string, paymentUrl: string): Promise<void> {
    await this.accountClient.setIntentPayment(intentId, paymentId, paymentUrl)
  }

  // Release a checkout claim when its charge reaches a terminal webhook status, freeing the
  // (workspace, type) key for a later purchase. Idempotent — a duplicate webhook deletes nothing.
  async releaseCheckout (paymentId: string): Promise<void> {
    await this.accountClient.deleteCheckoutIntentByPaymentId(paymentId, 'tbank')
  }

  // Free a claim that never issued a payment (open-checkout failed before setCheckoutPayment), so a
  // retry gets a clean claim immediately instead of waiting out the 15-min lease.
  async abandonCheckout (intentId: string): Promise<void> {
    await this.accountClient.deleteCheckoutIntentById(intentId)
  }

  // Append an immutable audit row. Best-effort: a ledger write must never break the payment flow.
  async logOperation (op: {
    operation: 'init_charge' | 'webhook' | 'charge_recurrent' | 'cancel' | 'refund'
    status?: string
    paymentId?: string
    orderId?: string
    subscriptionId?: string
    workspaceUuid?: string
    accountUuid?: string
    actionId?: string
    actor?: 'user' | 'system' | 'provider' | 'admin'
    amount?: number
    raw?: Record<string, any>
  }): Promise<void> {
    // Publish to the durable payment-operation queue (account service appends the ledger row). Never
    // fails the payment path — a lost audit event is preferable to a broken charge.
    if (this.publishOperation === undefined) return
    try {
      await this.publishOperation({ provider: 'tbank', at: Date.now(), ...op })
    } catch {
      /* audit is best-effort */
    }
  }

  async markCharge (intentId: string, status: 'charged' | 'failed', paymentId?: string): Promise<void> {
    await this.accountClient.markChargeIntent(intentId, status, paymentId)
  }

  async heartbeatCharge (intentId: string): Promise<void> {
    await this.accountClient.heartbeatChargeIntent(intentId)
  }

  // True if THIS pod won the takeover of an orphaned (lease-expired) pending intent.
  async reclaimStaleCharge (intentId: string, leaseMs: number): Promise<boolean> {
    return await this.accountClient.reclaimStaleChargeIntent(intentId, leaseMs)
  }

  /**
   * Tbank renewal candidates: server pre-filters by provider + status {active, past_due}, so cleanup,
   * grace and renewal all start from the same small set. The caller refines per its own predicate.
   */
  async getCandidates (): Promise<Subscription[]> {
    return await this.accountClient.getSubscriptionsByProvider('tbank')
  }

  /**
   * Trial subscriptions (provider 'trial'), bounded by `trialEnd`.
   */
  async getTrialCandidates (): Promise<Subscription[]> {
    return await this.accountClient.getSubscriptionsByProvider('trial', [SubscriptionStatus.Trialing])
  }

  static needsRenewal (sub: Subscription, now: number): boolean {
    if (sub.providerData?.recurrent === false) return false
    if (sub.providerData?.rebillId === undefined) return false
    // Scheduled cancel: the sub is still Active until willCancelAt.
    // Then the scheduler flips it to Canceled (enforceScheduledCancel).
    if (sub.willCancelAt != null && sub.periodEnd != null && sub.periodEnd >= sub.willCancelAt) {
      return false
    }
    if (sub.status === SubscriptionStatus.Active) {
      return sub.periodEnd != null && sub.periodEnd <= now
    }
    if (isFailedRenewal(sub)) {
      const retryAttempt = (sub.providerData?.retryAttempt as number) ?? 0
      if (retryAttempt >= 3) return false
      const retryAfter = (sub.providerData?.retryAfter as number) ?? 0
      if (retryAfter > now) return false
      return true
    }
    return false
  }

  async getActiveTbankSubscription (workspaceUuid: WorkspaceUuid): Promise<Subscription | null> {
    return (
      (await this.accountClient.getSubscriptions(workspaceUuid)).find(
        (s) =>
          s.provider === 'tbank' && (s.status === SubscriptionStatus.Active || s.status === SubscriptionStatus.Trialing)
      ) ?? null
    )
  }

  async getWorkspaceUrl (workspaceUuid: WorkspaceUuid): Promise<string | null> {
    try {
      const [info] = await this.accountClient.getWorkspacesInfo([workspaceUuid])
      return info?.url ?? null
    } catch {
      return null
    }
  }

  /**
   * Workspace display name + url slug. `name` is what the owner sees in the UI, `url` builds the
   * link — customer-facing emails need both (name as the link text). Best-effort: null on failure.
   */
  async getWorkspaceInfo (workspaceUuid: WorkspaceUuid): Promise<{ name: string, url: string } | null> {
    try {
      const [info] = await this.accountClient.getWorkspacesInfo([workspaceUuid])
      if (info === undefined) return null
      return { name: info.name, url: info.url }
    } catch {
      return null
    }
  }

  async findSubscriptionByCheckoutId (checkoutId: string): Promise<SubscriptionData | null> {
    return (
      (await this.accountClient.getSubscriptions()).find(
        (s) => s.provider === 'tbank' && s.providerCheckoutId === checkoutId
      ) ?? null
    )
  }

  /**
   * Resolve the contact info (name + email + phone + UI locale) of a subscription owner.
   * `email`: first email-type social id (null when none).
   * `name`: person's display name (null when empty).
   * `phone`: person's phone (null when empty).
   * `locale`: account's preferred language (null when unset) — callers fall back to a default.
   */
  async getAccountContact (
    accountUuid: AccountUuid
  ): Promise<{ name: string | null, email: string | null, phone: string | null, locale: string | null }> {
    const personInfo = await this.accountClient.getPersonInfo(accountUuid)
    const emailSocialId = personInfo.socialIds.find((s) => s.type === SocialIdType.EMAIL && s.isDeleted !== true)

    let locale: string | null = null
    try {
      const accountInfo = await this.accountClient.getAccountInfo(accountUuid)
      locale = accountInfo.locale ?? null
    } catch {
      // Locale is optional — fall back to the caller's default if it cannot be resolved.
    }

    const name = personInfo.name !== undefined && personInfo.name !== '' ? personInfo.name : null
    // Phone is the 54-ФЗ receipt fallback when the account has no email.
    return { name, email: emailSocialId?.value ?? null, phone: personInfo.phoneHint ?? null, locale }
  }
}

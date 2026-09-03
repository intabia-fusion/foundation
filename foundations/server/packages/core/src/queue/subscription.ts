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

export enum QueueSubscriptionEvent {
  // Provider reports a subscription created/updated/renewed — consumer bakes limits and upserts.
  Upserted = 'upserted',
  // Provider reports a subscription canceled — consumer upserts the canceled state.
  Canceled = 'canceled',
  // An admin canceled a subscription — consumer provisions the free fallback plan.
  AdminCanceled = 'admin-canceled'
}

// What triggered the event, for observability/debugging only (not branched on).
export type QueueSubscriptionTrigger = 'webhook' | 'reconcile' | 'scheduler' | 'renewal' | 'admin'

export interface QueueSubscriptionMessage {
  type: QueueSubscriptionEvent
  // The provider's transform output (SubscriptionData shape). Limits are NOT set here — the consumer
  // (pod-payment) bakes them. Typed as a record to keep core free of the account-client dependency.
  subscription: Record<string, any>
  provider: string // 'stripe' | 'polar' | 'tbank'
  trigger: QueueSubscriptionTrigger
}

export const subscriptionEvents = {
  upserted: (
    subscription: Record<string, any>,
    provider: string,
    trigger: QueueSubscriptionTrigger
  ): QueueSubscriptionMessage => ({
    type: QueueSubscriptionEvent.Upserted,
    subscription,
    provider,
    trigger
  }),
  canceled: (
    subscription: Record<string, any>,
    provider: string,
    trigger: QueueSubscriptionTrigger
  ): QueueSubscriptionMessage => ({
    type: QueueSubscriptionEvent.Canceled,
    subscription,
    provider,
    trigger
  }),
  adminCanceled: (subscription: Record<string, any>, provider: string): QueueSubscriptionMessage => ({
    type: QueueSubscriptionEvent.AdminCanceled,
    subscription,
    provider,
    trigger: 'admin'
  })
}

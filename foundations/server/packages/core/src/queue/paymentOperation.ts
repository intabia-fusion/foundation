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

// Payment audit events published by provider pods (tbank/payment/polar) and consumed by the account
// service, which appends an immutable ledger row. Durable: a webhook is ack'd even if account is down;
// the consumer persists later. Provider-agnostic — every provider publishes the same shape.

export type PaymentOperationKind = 'init_charge' | 'webhook' | 'charge_recurrent' | 'cancel' | 'refund' | 'update'
/** Who drove this row: the workspace user, our scheduler, the bank callback, or an admin. */
export type PaymentActor = 'user' | 'system' | 'provider' | 'admin'

export interface QueuePaymentOperationMessage {
  provider: string // 'tbank' | 'polar' | 'stripe' | 'mock'
  operation: PaymentOperationKind
  status?: string // provider/webhook status (CONFIRMED|REJECTED|...) or 'success'|'failed'
  paymentId?: string
  orderId?: string
  subscriptionId?: string
  workspaceUuid?: string
  accountUuid?: string
  actionId?: string // groups every row produced by one intent (purchase, plan change, renewal cycle)
  actor?: PaymentActor
  amount?: number // minor units (kopecks)
  raw?: Record<string, any> // full provider payload for forensics
  at: number // event timestamp (ms), stamped by the producer
}

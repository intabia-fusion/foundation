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

import type { WorkspaceUuid } from '@hcengineering/core'

export type BillingPeriod = 'monthly' | 'yearly'

export interface CreateSubscriptionRequest {
  type: string
  plan: string
  workspaceUuid: WorkspaceUuid
  workspaceUrl: string
  accountUuid: string
  customerEmail?: string
  quantity?: number // Number of seats for per-seat plans (total charge = price-per-seat * quantity)
  period?: BillingPeriod // Billing period; 'yearly' applies the plan's yearly discount. Defaults to 'monthly'.
  force?: boolean // Switch tariff: cancel a different pending checkout for this type, then open the new one.
  recurrent?: boolean // recurring charges; false/undefined = one-off payment: no auto-renew
}

export interface UpdatePlanRequest {
  plan: string
  workspaceUrl?: string
  quantity?: number // Number of seats for per-seat plans (total charge = price-per-seat * quantity)
  period?: BillingPeriod // Billing period; 'yearly' applies the plan's yearly discount. Defaults to 'monthly'.
  recurrent?: boolean
  force?: boolean // Switch tariff: cancel a different pending checkout for this type, then open the new one.
}

/**
 * TBank webhook notification
 * Matches the structure sent by TBank Acquiring API
 * Documentation: https://developer.tbank.ru/eacq/intro/developer/notification
 */
export interface TbankWebhookNotification {
  TerminalKey: string
  OrderId: string
  Success: boolean
  Status: 'AUTHORIZED' | 'CONFIRMED' | 'REJECTED' | 'REVERSED' | 'REFUNDED' | 'DEADLINE_EXPIRED' | 'CANCELED'
  PaymentId: string
  ErrorCode: string
  Amount: number
  CardId?: string
  Pan?: string
  ExpDate?: string
  RebillId?: string
  CustomerKey?: string
  Token: string
  Data?: Record<string, string>
}

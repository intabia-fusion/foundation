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

import type { MeasureContext, WorkspaceUuid, AccountUuid } from '@hcengineering/core'

/** Languages the templates carry. Primary market is RU, so that is also the fallback. */
export type Lang = 'ru' | 'en'

export const DEFAULT_LANG: Lang = 'ru'

/** Used when a plan-config item carries no `currency`. Keep in step with `currencyOf`'s fallback. */
export const DEFAULT_CURRENCY = '₽'

export interface MailMessage {
  subject: string
  text: string
  html: string
}

/**
 * What the mails need from a pod's subscription storage.
 * Both payment pods reach the same account service, so each implements this over its own client.
 */
export interface BillingMailStorage {
  /** Payer contact for the subscription owner. `email: null` means the mail cannot be sent. */
  getAccountContact: (
    accountUuid: AccountUuid
  ) => Promise<{ name: string | null, email: string | null, locale: string | null }>
  /** Display name + slug of a workspace, or null when it cannot be resolved. */
  getWorkspaceInfo: (workspaceUuid: WorkspaceUuid) => Promise<{ name: string, url: string } | null>
  /** Workspace slug alone, or null when unknown. */
  getWorkspaceUrl: (workspaceUuid: WorkspaceUuid) => Promise<string | null>
}

/**
 * Resolve a localized plan/package label. Deliberately injected: pod-tbank-subscriptions fetches
 * plan-config over HTTP from pod-payment, while pod-payment holds the same config in memory.
 * Must never throw — fall back to the raw plan id so a mail is never blocked by it.
 */
export type PlanLabelResolver = (plan: string, type: string, lang: Lang) => Promise<string>

/**
 * Display currency of a plan/package, out of the same plan-config the label comes from.
 * Must never throw: a mail is never blocked by a missing currency.
 */
export type PlanCurrencyResolver = (plan: string, type: string) => Promise<string>

/** Sends one rendered mail. Implemented over the platform notification queue. */
export type MailSender = (ctx: MeasureContext, to: string, msg: MailMessage) => Promise<void>

/**
 * Undefined disables all mail. On a live pod the sender is wired unconditionally from the queue
 * producer, so a skip means something is wrong with startup — the notify* functions warn on it.
 */
export type OptionalMailSender = MailSender | undefined

/** Everything the mail functions need besides the subscription itself. */
export interface BillingMailContext {
  storage: BillingMailStorage
  send: OptionalMailSender
  planLabel: PlanLabelResolver
  planCurrency: PlanCurrencyResolver
  /** Front base URL, used to build the billing deep link. */
  frontUrl: string
  /** Support contacts rendered into the footer; both optional. */
  supportEmail?: string
  supportUrl?: string
  /** Service inbox(es) that get an audit copy of receipts and failed charges. */
  billingEmails?: string[]
}

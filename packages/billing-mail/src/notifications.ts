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

import type { MeasureContext } from '@hcengineering/core'
import type { SubscriptionData } from '@hcengineering/account-client'

import { type Lang, DEFAULT_LANG, type MailMessage, type BillingMailContext } from './types'
import {
  type PaymentFailedReason,
  type PaymentSucceededKind,
  type UpcomingKind,
  type ExpiredKind,
  type SuccessFields,
  type UpcomingFields,
  type ExpiredFields,
  SERVICE,
  fill,
  billingUrl,
  buildDunning,
  buildReceipt,
  buildUpcoming,
  buildExpired,
  buildSupportFooter,
  resolveWorkspaceLink,
  serviceHtml,
  resolveLang,
  formatAmount,
  formatDate,
  formatDateTime,
  formatCustomer,
  formatPaymentMethod
} from './render'

function buildMessage (
  reason: PaymentFailedReason,
  planLabel: string,
  mail: BillingMailContext,
  lang: Lang,
  workspaceSlug: string | null
): MailMessage {
  return buildDunning(reason, planLabel, billingUrl(mail, workspaceSlug), lang)
}

/**
 * Send a payment-failed email to the subscription owner.
 *
 * Best-effort: any failure (missing config, missing email, mail service error) is logged and
 * swallowed so that it never breaks the surrounding payment/renewal flow. Anti-spam decisions
 * (whether to send at all) are made by the caller.
 */
export async function notifyPaymentFailed (
  ctx: MeasureContext,
  mail: BillingMailContext,
  sub: SubscriptionData,
  reason: PaymentFailedReason
): Promise<void> {
  if (mail.send === undefined) {
    ctx.warn('Payment-failed email skipped: no mail sender wired', { subId: sub.id, reason })
    return
  }

  let payerEmail: string | null = null
  try {
    const { email, locale } = await mail.storage.getAccountContact(sub.accountUuid)
    payerEmail = email
    if (email === null) {
      ctx.warn('Payment-failed email skipped: no email for account', { subId: sub.id, account: sub.accountUuid })
    } else {
      const lang = resolveLang(locale)
      const planLabel = await mail.planLabel(sub.plan, sub.type, lang)
      const slug = await mail.storage.getWorkspaceUrl(sub.workspaceUuid)
      const { subject, text, html } = buildMessage(reason, planLabel, mail, lang, slug)
      await mail.send(ctx, email, { subject, text, html })
      ctx.info('Payment-failed email sent', { subId: sub.id, reason })
    }
  } catch (err: any) {
    ctx.error('Payment-failed email error', { subId: sub.id, reason, err: err?.message ?? String(err) })
  }

  // Service copy so the team can reach out to the payer directly.
  if (mail.billingEmails !== undefined && mail.billingEmails.length > 0) {
    const attempt = (sub.providerData?.retryAttempt as number) ?? 0
    const workspace = await resolveWorkspaceLink(mail, sub.workspaceUuid)
    // Team inbox is Russian-only: resolve the plan label and the reason enum to Russian.
    const planRu = await mail.planLabel(sub.plan, sub.type, DEFAULT_LANG)
    const currency = await mail.planCurrency(sub.plan, sub.type)
    const reasonRu = SERVICE.reason[reason]
    const typeRu = SERVICE.type[sub.type as keyof typeof SERVICE.type] ?? sub.type
    const l = SERVICE.labels
    // Decline reason from the last charge, so the team sees why (card code / our-side receipt block).
    const code = sub.providerData?.lastChargeErrorCode as string | undefined
    const causeMsg = sub.providerData?.lastChargeError as string | undefined
    const cause = code !== undefined || causeMsg !== undefined ? `${code ?? '-'} — ${causeMsg ?? '-'}` : undefined
    const lines = [
      `${l.workspace}: ${workspace}`,
      `${l.plan}: ${planRu} (${typeRu})`,
      `${l.amount}: ${formatAmount(sub.amount, currency)}`,
      `${l.attempt}: ${attempt} из 3 (${reasonRu})`,
      ...(cause !== undefined ? [`${l.cause}: ${cause}`] : []),
      `${l.customer}: ${payerEmail ?? sub.accountUuid}`,
      `${l.subscription}: ${sub.id ?? '-'}`
    ]
    const svc: MailMessage = {
      subject: fill(SERVICE.subject.failed, { plan: planRu, reason: reasonRu }),
      text: lines.join('\n'),
      html: serviceHtml(lines, workspace)
    }
    for (const to of mail.billingEmails) {
      try {
        await mail.send(ctx, to, svc)
      } catch (err: any) {
        ctx.error('Billing service email error', { to, err: err?.message ?? String(err) })
      }
    }
  }
}

/**
 * Send a successful-payment receipt email to the subscription owner.
 * A service copy goes to BillingEmails (if configured).
 */
export async function notifyPaymentSucceeded (
  ctx: MeasureContext,
  mail: BillingMailContext,
  sub: SubscriptionData,
  kind: PaymentSucceededKind,
  chargedAmount?: number
): Promise<void> {
  if (mail.send === undefined) {
    ctx.warn('Payment-succeeded email skipped: no mail sender wired', { subId: sub.id, kind })
    return
  }

  let payerEmail: string | null = null
  try {
    const { name, email, locale } = await mail.storage.getAccountContact(sub.accountUuid)
    payerEmail = email
    if (email === null) {
      ctx.warn('Payment-succeeded email skipped: no email for account', { subId: sub.id, account: sub.accountUuid })
    } else {
      const lang = resolveLang(locale)
      const planLabel = await mail.planLabel(sub.plan, sub.type, lang)
      // Transaction id: recurrent charges set lastChargePaymentId; the initial checkout sets paymentId.
      const txId =
        (sub.providerData?.lastChargePaymentId as string | undefined) ??
        (sub.providerData?.paymentId as string | undefined) ??
        sub.providerSubscriptionId
      // Payment moment == period start: both purchase activation and renewal set periodStart to now.
      const support = buildSupportFooter(mail, lang)
      const currency = await mail.planCurrency(sub.plan, sub.type)
      const slug = await mail.storage.getWorkspaceUrl(sub.workspaceUuid)
      const fields: SuccessFields = {
        customer: formatCustomer(name, email),
        plan: planLabel,
        // Charged: delta in case of upgrade, else - the recurring price.
        amount: formatAmount(chargedAmount ?? sub.amount, currency),
        paidAtDate: formatDate(sub.periodStart, lang),
        paidAt: formatDateTime(sub.periodStart, lang),
        txId,
        paymentMethod: formatPaymentMethod(sub, lang),
        periodStart: formatDate(sub.periodStart, lang),
        periodEnd: formatDate(sub.periodEnd, lang),
        url: billingUrl(mail, slug),
        supportText: support.text,
        supportHtml: support.html
      }
      const family = sub.type === 'package' ? 'package' : sub.type === 'purchase' ? 'purchase' : 'tier'
      const { subject, text, html } = buildReceipt(kind, family, fields, lang)
      await mail.send(ctx, email, { subject, text, html })
      ctx.info('Payment-succeeded email sent', { subId: sub.id, kind })
    }
  } catch (err: any) {
    ctx.error('Payment-succeeded email error', { subId: sub.id, kind, err: err?.message ?? String(err) })
  }

  // Service copy to the team about successful charges.
  if (mail.billingEmails !== undefined && mail.billingEmails.length > 0) {
    const workspace = await resolveWorkspaceLink(mail, sub.workspaceUuid)
    // Team inbox is Russian-only: resolve the plan label and the kind enum to Russian.
    const planRu = await mail.planLabel(sub.plan, sub.type, DEFAULT_LANG)
    const currency = await mail.planCurrency(sub.plan, sub.type)
    const kindRu = SERVICE.kind[kind]
    const typeRu = SERVICE.type[sub.type as keyof typeof SERVICE.type] ?? sub.type
    const l = SERVICE.labels
    const lines = [
      `${l.workspace}: ${workspace}`,
      `${l.plan}: ${planRu} (${typeRu})`,
      `${l.charged}: ${formatAmount(chargedAmount ?? sub.amount, currency)}`,
      // Showing both upgrade delta and the recurring price for the team.
      ...(chargedAmount !== undefined && sub.amount != null && chargedAmount !== Number(sub.amount)
        ? [`${l.regularPrice}: ${formatAmount(sub.amount, currency)}`]
        : []),
      `${l.kind}: ${kindRu}`,
      `${l.customer}: ${payerEmail ?? sub.accountUuid}`,
      `${l.subscription}: ${sub.id ?? '-'}`
    ]
    const svc: MailMessage = {
      subject: fill(SERVICE.subject.succeeded, { plan: planRu, kind: kindRu }),
      text: lines.join('\n'),
      html: serviceHtml(lines, workspace)
    }
    for (const to of mail.billingEmails) {
      try {
        await mail.send(ctx, to, svc)
      } catch (err: any) {
        ctx.error('Billing service email error', { to, err: err?.message ?? String(err) })
      }
    }
  }
}

/**
 * Send an upcoming-expiry reminder to the subscription owner, `noticeDays` before `dueAt`.
 * No service copy: a reminder is not an incident.
 * Best-effort: any failure is logged and swallowed.
 */
export async function notifyUpcoming (
  ctx: MeasureContext,
  mail: BillingMailContext,
  sub: SubscriptionData,
  kind: UpcomingKind,
  dueAt: number
): Promise<void> {
  if (mail.send === undefined) {
    ctx.warn('Upcoming-expiry email skipped: no mail sender wired', { subId: sub.id, kind })
    return
  }

  try {
    const { email, locale } = await mail.storage.getAccountContact(sub.accountUuid)
    if (email === null) {
      ctx.warn('Upcoming-expiry email skipped: no email for account', { subId: sub.id, account: sub.accountUuid })
      return
    }
    const lang = resolveLang(locale)
    const planLabel = await mail.planLabel(sub.plan, sub.type, lang)
    const support = buildSupportFooter(mail, lang)
    const currency = await mail.planCurrency(sub.plan, sub.type)
    const ws = await mail.storage.getWorkspaceInfo(sub.workspaceUuid)
    const fields: UpcomingFields = {
      workspace: ws?.name ?? '',
      workspaceUrl: ws !== null ? `${mail.frontUrl.replace(/\/+$/, '')}/workbench/${ws.url}` : '',
      plan: planLabel,
      amount: kind === 'recurrent' ? formatAmount(sub.amount, currency) : '',
      dueDate: formatDate(dueAt, lang),
      paymentMethod: kind === 'recurrent' ? formatPaymentMethod(sub, lang) : '',
      url: billingUrl(mail, ws?.url ?? null),
      supportText: support.text,
      supportHtml: support.html
    }
    const family = sub.type === 'package' ? 'package' : 'tier'
    const { subject, text, html } = buildUpcoming(kind, family, fields, lang)
    await mail.send(ctx, email, { subject, text, html })
    ctx.info('Upcoming-expiry email sent', { subId: sub.id, kind, dueAt })
  } catch (err: any) {
    ctx.error('Upcoming-expiry email error', { subId: sub.id, kind, err: err?.message ?? String(err) })
  }
}

/**
 * Tell the subscription owner that access has changed.
 * No service copy: an expiry is not an incident.
 * Best-effort: any failure is logged and swallowed.
 */
export async function notifyExpired (
  ctx: MeasureContext,
  mail: BillingMailContext,
  sub: SubscriptionData,
  kind: ExpiredKind,
  endedAt: number
): Promise<void> {
  if (mail.send === undefined) {
    ctx.warn('Access-ended email skipped: no mail sender wired', { subId: sub.id, kind })
    return
  }

  try {
    const { email, locale } = await mail.storage.getAccountContact(sub.accountUuid)
    if (email === null) {
      ctx.warn('Access-ended email skipped: no email for account', { subId: sub.id, account: sub.accountUuid })
      return
    }
    const lang = resolveLang(locale)
    const planLabel = await mail.planLabel(sub.plan, sub.type, lang)
    const support = buildSupportFooter(mail, lang)
    const ws = await mail.storage.getWorkspaceInfo(sub.workspaceUuid)
    // A trial was never charged, so it has no amount to show.
    const showAmount = kind !== 'trial' && sub.amount != null && sub.amount > 0
    const amount = showAmount ? formatAmount(sub.amount, await mail.planCurrency(sub.plan, sub.type)) : ''
    const fields: ExpiredFields = {
      workspace: ws?.name ?? '',
      workspaceUrl: ws !== null ? `${mail.frontUrl.replace(/\/+$/, '')}/workbench/${ws.url}` : '',
      plan: planLabel,
      endDate: formatDate(endedAt, lang),
      amount,
      url: billingUrl(mail, ws?.url ?? null),
      supportText: support.text,
      supportHtml: support.html
    }
    const family = sub.type === 'package' ? 'package' : 'tier'
    const { subject, text, html } = buildExpired(kind, family, fields, lang)
    await mail.send(ctx, email, { subject, text, html })
    ctx.info('Access-ended email sent', { subId: sub.id, kind, endedAt })
  } catch (err: any) {
    ctx.error('Access-ended email error', { subId: sub.id, kind, err: err?.message ?? String(err) })
  }
}

/**
 * Alert the team that a charge was blocked: no fiscal receipt could be issued (54-ФЗ):
 * no payer contact/the receipt build failed.
 */
export async function notifyReceiptBlocked (
  ctx: MeasureContext,
  mail: BillingMailContext,
  sub: SubscriptionData
): Promise<void> {
  const code = (sub.providerData?.lastChargeErrorCode as string) ?? 'RECEIPT_BLOCKED'
  const reason = (sub.providerData?.lastChargeError as string) ?? 'no valid fiscal receipt (54-ФЗ)'

  ctx.error('receipt_blocked: charge blocked, fiscal receipt cannot be issued (54-ФЗ)', {
    marker: 'receipt_blocked',
    code,
    reason,
    subId: sub.id,
    workspaceUuid: sub.workspaceUuid,
    accountUuid: sub.accountUuid,
    plan: `${sub.plan} (${sub.type})`
  })

  if (mail.send === undefined) return
  if (mail.billingEmails === undefined || mail.billingEmails.length === 0) return

  const l = SERVICE.labels
  const currency = await mail.planCurrency(sub.plan, sub.type)
  const typeRu = SERVICE.type[sub.type as keyof typeof SERVICE.type] ?? sub.type
  const lines = [
    SERVICE.receiptBlocked.lead,
    '',
    `${l.cause}: ${code} — ${reason}`,
    `${l.workspace}: ${sub.workspaceUuid}`,
    `${l.account}: ${sub.accountUuid}`,
    `${l.plan}: ${sub.plan} (${typeRu})`,
    `${l.amount}: ${formatAmount(sub.amount, currency)}`,
    `${l.subscription}: ${sub.id ?? '-'}`,
    '',
    SERVICE.receiptBlocked.hint
  ]
  const msg: MailMessage = {
    subject: fill(SERVICE.subject.receiptBlocked, { plan: sub.plan, code }),
    text: lines.join('\n'),
    html: `<pre>${lines.join('\n')}</pre>`
  }
  for (const to of mail.billingEmails) {
    try {
      await mail.send(ctx, to, msg)
    } catch (err: any) {
      ctx.error('Receipt-blocked service email error', { to, err: err?.message ?? String(err) })
    }
  }
}

// POST one message to pod-mail; throws on transport/HTTP errors (callers log and swallow).

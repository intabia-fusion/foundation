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
import type { SubscriptionData } from '@hcengineering/account-client'

import { type Lang, DEFAULT_LANG, DEFAULT_CURRENCY, type MailMessage, type BillingMailContext } from './types'
import receiptTemplates from './templates/receipt'
import dunningTemplates from './templates/dunning'
import serviceTemplate from './templates/service'
import chargeDescriptionTemplates from './templates/charge-description'
import upcomingTemplates from './templates/upcoming'
import expiredTemplates from './templates/expired'

/**
 * Why the payment-failed email is being sent.
 * - 'failed': recurrent charge failed, subscription just entered past_due (will be retried automatically).
 * - 'final': automatic retries are exhausted, the subscription is about to be canceled.
 */
export type PaymentFailedReason = 'failed' | 'final'

/**
 * Which successful-payment email to send.
 * - 'purchase': the first payment for a checkout (new subscription or plan change) settled.
 * - 'renewal': a recurrent renewal charge for the next period settled.
 */
export type PaymentSucceededKind = 'purchase' | 'renewal'

/** Which wording a receipt uses: a plan, an add-on package, or a one-time catalog purchase. */
export type ReceiptFamily = 'tier' | 'package' | 'purchase'

/**
 * Which upcoming-expiry reminder to send, `noticeDays` before the date.
 * - 'recurrent': a recurrent subscription will be charged for the next period.
 * - 'trial': the trial period runs out (workspace falls back to the free plan).
 * - 'oneoff': a one-off paid period runs out, nothing will be charged.
 * - 'canceled': the user canceled; access is kept until the end of the paid period.
 */
export type UpcomingKind = 'recurrent' | 'trial' | 'oneoff' | 'canceled'

/**
 * Which access-ended email to send, once access has actually stopped.
 * - 'oneoff': a one-off paid period ran out and nothing was charged.
 * - 'canceled': a scheduled cancellation took effect at the end of the paid period.
 * - 'grace': a failed renewal exhausted its retries and the grace period ran out (-> ReadOnly).
 * - 'trial': the trial period ended (-> free plan).
 */
export type ExpiredKind = 'oneoff' | 'canceled' | 'grace' | 'trial'

/** The charge that a payment Description / receipt line describes. */
export type ChargeKind = 'purchase' | 'update' | 'renewal' | 'retry'

/** Tier and package word differently: a tier drops to the free plan, a package simply ends. */
export type PlanFamily = 'tier' | 'package'

// Substitute {key} placeholders from params. Missing keys stay literal (surfaces template typos).
export function fill (str: string, params: Record<string, string>): string {
  return str.replace(/\{(\w+)\}/g, (m, key) => params[key] ?? m)
}

// Escape user-controlled text before it goes into email HTML.
export function escapeHtml (str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Localized copy for all email families, kept as data in ./templates/* (bundled by esbuild).
export const RECEIPT = receiptTemplates as Record<Lang, (typeof receiptTemplates)['ru']>
export const DUNNING = dunningTemplates as Record<Lang, (typeof dunningTemplates)['ru']>
export const SERVICE = serviceTemplate
export const UPCOMING = upcomingTemplates as Record<Lang, (typeof upcomingTemplates)['ru']>
export const EXPIRED = expiredTemplates as Record<Lang, (typeof expiredTemplates)['ru']>

// Render a payment-failed email from the dunning template. Markup + retry link stay here; copy is data.
export function buildDunning (reason: PaymentFailedReason, plan: string, url: string, lang: Lang): MailMessage {
  const t = DUNNING[lang]
  const block = t[reason]
  const p = { plan, url }
  return {
    subject: t.subject,
    text: `${fill(block.lead, p)}\n\n${block.note}\n\n${fill(t.retryText, p)}\n\n${t.contactAdmin}`,
    html:
      `<p>${fill(block.lead, { plan: `<b>${plan}</b>` })}</p>` +
      `<p>${block.note}</p>` +
      `<p>${t.retryHtmlPrefix} <a href="${url}">${t.retryLink}</a>.</p>` +
      `<p>${t.contactAdmin}</p>`
  }
}

export interface SuccessFields {
  customer: string // payer display: "Имя (email)", or just email/name when one is missing
  plan: string // localized plan label
  amount: string // formatted, e.g. "990.00 ₽"
  paidAtDate: string // payment date only, for the subject line, e.g. "21.08.2026"
  paidAt: string // payment date + time, e.g. "21.08.2026, 14:30"
  txId: string // provider transaction id
  paymentMethod: string // e.g. "Карта •••• 0777"; '' when unknown (hides the row)
  periodStart: string // subscription period start, e.g. "21.08.2026"
  periodEnd: string // subscription period end, e.g. "21.09.2026"
  url: string
  supportText: string // pre-rendered support contacts block (plain text), '' when none
  supportHtml: string // pre-rendered support contacts block (html), '' when none
}

// Render a receipt email from the receipt template.
export function buildReceipt (
  kind: PaymentSucceededKind,
  family: ReceiptFamily,
  f: SuccessFields,
  lang: Lang
): MailMessage {
  const t = RECEIPT[lang]
  const l = t.labels
  // A one-time purchase has no period: its periodEnd is an artefact of the checkout draft.
  const periodRow: Array<[string, string]> =
    family === 'purchase' ? [] : [[l.period, `${f.periodStart} — ${f.periodEnd}`]]
  // [label, value] rows; paymentMethod row is not shown when empty.
  const rows: Array<[string, string]> = [
    [l.customer, f.customer],
    [family === 'package' ? l.package : family === 'purchase' ? l.purchase : l.plan, f.plan],
    [l.amount[kind], f.amount],
    [l.paidAt, f.paidAt],
    [l.txId, f.txId],
    ...(f.paymentMethod !== '' ? ([[l.paymentMethod, f.paymentMethod]] as Array<[string, string]>) : []),
    ...periodRow
  ]
  const intro = fill(t.intro[kind][family], { plan: f.plan })
  const introHtml = fill(t.intro[kind][family], { plan: `<b>${f.plan}</b>` })
  return {
    subject: fill(t.subject, { plan: f.plan, paidAtDate: f.paidAtDate }),
    text:
      `${intro}\n\n` + rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\n${t.manageLink}: ${f.url}` + f.supportText,
    html:
      `<p>${introHtml}</p>` +
      '<p>' +
      rows.map(([k, v]) => `${k}: <b>${v}</b>`).join('<br/>') +
      '</p>' +
      `<p><a href="${f.url}">${t.manageLink}</a></p>` +
      f.supportHtml
  }
}

/** Support-contacts footer for the receipt email. Returns empty strings when no contact is configured. */
export function buildSupportFooter (mail: BillingMailContext, lang: Lang): { text: string, html: string } {
  const parts: string[] = []
  const partsHtml: string[] = []
  if (mail.supportEmail !== undefined && mail.supportEmail !== '') {
    parts.push(mail.supportEmail)
    partsHtml.push(`<a href="mailto:${mail.supportEmail}">${mail.supportEmail}</a>`)
  }
  if (mail.supportUrl !== undefined && mail.supportUrl !== '') {
    parts.push(mail.supportUrl)
    partsHtml.push(`<a href="${mail.supportUrl}">${mail.supportUrl}</a>`)
  }
  if (parts.length === 0) return { text: '', html: '' }

  const label = RECEIPT[lang].support
  return {
    text: `\n\n${label}: ${parts.join(', ')}`,
    html: `<hr/><p style="color:#888;font-size:12px">${label}: ${partsHtml.join(', ')}</p>`
  }
}

/**
 * Link to the billing settings of one workspace.
 * Falls back to the front root when the slug is unknown.
 */
export function billingUrl (mail: BillingMailContext, workspaceSlug: string | null): string {
  const base = mail.frontUrl.replace(/\/+$/, '')
  if (workspaceSlug === null || workspaceSlug === '') return base
  return `${base}/workbench/${workspaceSlug}/setting/setting/billing`
}

/**
 * Build the full workspace link for service copies.
 */
export async function resolveWorkspaceLink (mail: BillingMailContext, workspaceUuid: WorkspaceUuid): Promise<string> {
  const slug = await mail.storage.getWorkspaceUrl(workspaceUuid)
  if (slug === null) return workspaceUuid
  const base = mail.frontUrl.replace(/\/+$/, '')
  return `${base}/workbench/${slug}`
}

/**
 * Render the plain-text service-copy lines as HTML, turning workspace value into a clickable link.
 */
export function serviceHtml (lines: string[], workspace: string): string {
  const wsPrefix = `${SERVICE.labels.workspace}: `
  const body = lines
    .map((line) =>
      line.startsWith(wsPrefix) && workspace.startsWith('http')
        ? `${wsPrefix}<a href="${workspace}">${workspace}</a>`
        : line
    )
    .join('\n')
  return `<pre>${body}</pre>`
}

/** Normalize an account locale (e.g. 'en-US', 'ru') to a supported language, falling back to default. */
export function resolveLang (locale: string | null): Lang {
  const short = (locale ?? '').slice(0, 2).toLowerCase()
  return short in RECEIPT ? (short as Lang) : DEFAULT_LANG
}

const CHARGE_DESCRIPTION = chargeDescriptionTemplates as Record<Lang, Record<ReceiptFamily, Record<ChargeKind, string>>>

/**
 * Build the payer-facing charge Description (localized to the payer, human plan label).
 */
export async function buildChargeDescription (
  mail: BillingMailContext,
  plan: string,
  type: string,
  kind: ChargeKind,
  locale: string | null
): Promise<string> {
  const lang = resolveLang(locale)
  const label = await mail.planLabel(plan, type, lang)
  const t = CHARGE_DESCRIPTION[lang]
  const family = type === 'package' ? t.package : type === 'purchase' ? t.purchase : t.tier
  return fill(family[kind], { plan: label })
}

/** Money for display: minor units -> "990.00 ₽". Currency comes from the plan. */
export function formatAmount (amount: number | undefined, currency: string = DEFAULT_CURRENCY): string {
  return `${((amount ?? 0) / 100).toFixed(2)} ${currency}`
}

// Format an epoch-ms timestamp as a locale date (day precision — for periods and the subject line).
export function formatDate (ms: number | undefined, lang: Lang): string {
  if (ms === undefined) return '-'
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US'
  // UTC for the same reason as formatDateTime, and here it also decides which calendar day is shown:
  // without it a payment made late in the evening east of UTC would print the previous date.
  return new Date(ms).toLocaleDateString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

// Format an epoch-ms timestamp as a locale date + time (minute precision — for the payment moment).
export function formatDateTime (ms: number | undefined, lang: Lang): string {
  if (ms === undefined) return '-'
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US'
  const stamp = new Date(ms).toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC'
  })
  return `${stamp} UTC`
}

// Payer display: "Имя (email)", or whichever of the two is present, or '-' when both missing.
export function formatCustomer (name: string | null, email: string | null): string {
  if (name !== null && email !== null) return `${name} (${email})`
  return name ?? email ?? '-'
}

// Payment method from the stored masked PAN: "Карта •••• 0777".
// Empty when no card (SBP or PAN not delivered by the webhook).
// PAN is present -> payment type: card.
export function formatPaymentMethod (sub: SubscriptionData, lang: Lang): string {
  const pan = sub.providerData?.pan as string | undefined
  if (pan === undefined || pan === '') return ''
  const digits = pan.replace(/\D/g, '')
  const last4 = digits.slice(-4)
  if (last4.length < 4) return ''
  return `${RECEIPT[lang].card} •••• ${last4}`
}

export interface UpcomingFields {
  workspace: string // workspace display name, '' when it could not be resolved (hides the row)
  workspaceUrl: string // link to the workspace, '' when unknown (renders the name as plain text)
  plan: string // localized plan label
  amount: string // formatted upcoming charge, e.g. "990.00 ₽"; '' hides the row (trial/oneoff/canceled)
  dueDate: string // the charge / expiry date, e.g. "21.09.2026"
  paymentMethod: string // e.g. "Карта •••• 0777"; '' when unknown (hides the row)
  url: string
  supportText: string // pre-rendered support contacts block (plain text), '' when none
  supportHtml: string // pre-rendered support contacts block (html), '' when none
}

// Render an upcoming-expiry reminder.
export function buildUpcoming (
  kind: UpcomingKind,
  family: 'tier' | 'package',
  f: UpcomingFields,
  lang: Lang
): MailMessage {
  const t = UPCOMING[lang]
  const l = t.labels
  const p = { plan: f.plan, dueDate: f.dueDate }
  const lead = fill(t.lead[kind][family], p)
  const leadHtml = fill(t.lead[kind][family], { plan: `<b>${f.plan}</b>`, dueDate: `<b>${f.dueDate}</b>` })
  const note = kind === 'recurrent' ? t.note.recurrent : t.note[kind][family]
  // [label, text value, html value?] — html falls back to the escaped text value when absent.
  type Row = [string, string, string?]
  // The workspace name is the link text; plain text keeps the URL alongside it.
  const workspaceRow: Row[] =
    f.workspace === ''
      ? []
      : [
          [
            l.workspace,
            f.workspaceUrl === '' ? f.workspace : `${f.workspace} (${f.workspaceUrl})`,
            f.workspaceUrl === ''
              ? escapeHtml(f.workspace)
              : `<a href="${escapeHtml(f.workspaceUrl)}">${escapeHtml(f.workspace)}</a>`
          ]
        ]
  const rows: Row[] = [
    ...workspaceRow,
    [family === 'package' ? l.package : l.plan, f.plan],
    ...(f.amount !== '' ? ([[l.amount, f.amount]] as Row[]) : []),
    [kind === 'recurrent' ? l.dueDate : l.endDate, f.dueDate],
    ...(f.paymentMethod !== '' ? ([[l.paymentMethod, f.paymentMethod]] as Row[]) : [])
  ]
  return {
    subject: fill(t.subject[kind], p),
    text:
      `${lead}\n\n${note}\n\n` +
      rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
      `\n\n${t.cta[kind]}: ${f.url}` +
      f.supportText,
    html:
      `<p>${leadHtml}</p>` +
      `<p>${note}</p>` +
      '<p>' +
      rows.map(([k, v, vHtml]) => `${k}: <b>${vHtml ?? escapeHtml(v)}</b>`).join('<br/>') +
      '</p>' +
      `<p><a href="${f.url}">${t.cta[kind]}</a></p>` +
      f.supportHtml
  }
}

export interface ExpiredFields {
  workspace: string // workspace display name, '' when it could not be resolved (hides the row)
  workspaceUrl: string // link to the workspace, '' when unknown (renders the name as plain text)
  plan: string // localized plan label
  endDate: string // the date access ended, e.g. "21.09.2026"
  amount: string // formatted last charge, e.g. "1000.00 $"; '' hides the row (trial has no amount)
  url: string
  supportText: string // pre-rendered support contacts block (plain text), '' when none
  supportHtml: string // pre-rendered support contacts block (html), '' when none
}

// Render an access-ended email.
export function buildExpired (kind: ExpiredKind, family: 'tier' | 'package', f: ExpiredFields, lang: Lang): MailMessage {
  const t = EXPIRED[lang]
  const l = t.labels
  const p = { plan: f.plan, endDate: f.endDate }
  const lead = fill(t.lead[kind][family], p)
  const leadHtml = fill(t.lead[kind][family], { plan: `<b>${f.plan}</b>`, endDate: `<b>${f.endDate}</b>` })
  const note = t.note[kind][family]
  // [label, text value, html value?] — html falls back to the escaped text value when absent.
  type Row = [string, string, string?]
  // The workspace name is the link text; plain text keeps the URL alongside it.
  const workspaceRow: Row[] =
    f.workspace === ''
      ? []
      : [
          [
            l.workspace,
            f.workspaceUrl === '' ? f.workspace : `${f.workspace} (${f.workspaceUrl})`,
            f.workspaceUrl === ''
              ? escapeHtml(f.workspace)
              : `<a href="${escapeHtml(f.workspaceUrl)}">${escapeHtml(f.workspace)}</a>`
          ]
        ]
  const rows: Row[] = [
    ...workspaceRow,
    [family === 'package' ? l.package : l.plan, f.plan],
    ...(f.amount !== '' ? ([[l.amount, f.amount]] as Row[]) : []),
    [l.endDate, f.endDate]
  ]
  return {
    subject: fill(t.subject[kind][family], p),
    text:
      `${lead}\n\n${note}\n\n` +
      rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
      `\n\n${t.cta[kind]}: ${f.url}` +
      f.supportText,
    html:
      `<p>${leadHtml}</p>` +
      `<p>${note}</p>` +
      '<p>' +
      rows.map(([k, v, vHtml]) => `${k}: <b>${vHtml ?? escapeHtml(v)}</b>`).join('<br/>') +
      '</p>' +
      `<p><a href="${f.url}">${t.cta[kind]}</a></p>` +
      f.supportHtml
  }
}

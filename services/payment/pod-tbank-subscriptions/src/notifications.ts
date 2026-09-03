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

import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import type { SubscriptionData } from '@hcengineering/account-client'

import type { Config } from './config'
import type { SubscriptionStorage } from './storage'
import { fetchPlanConfig, type PlanConfigLike } from './utils'
import receiptTemplates from './templates/receipt'
import dunningTemplates from './templates/dunning'
import serviceTemplate from './templates/service'
import chargeDescriptionTemplates from './templates/charge-description'
import upcomingTemplates from './templates/upcoming'

const MAIL_TIMEOUT_MS = 10_000

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

interface MailMessage {
  subject: string
  text: string
  html: string
}

// Default language used when the account locale is unset or unsupported (primary market is RU).
const DEFAULT_LANG = 'ru'

type Lang = 'ru' | 'en'

// Substitute {key} placeholders from params. Missing keys stay literal (surfaces template typos).
function fill (str: string, params: Record<string, string>): string {
  return str.replace(/\{(\w+)\}/g, (m, key) => params[key] ?? m)
}

// Escape user-controlled text before it goes into email HTML.
function escapeHtml (str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Localized copy for all email families, kept as data in ./templates/* (bundled by esbuild).
const RECEIPT = receiptTemplates as Record<Lang, (typeof receiptTemplates)['ru']>
const DUNNING = dunningTemplates as Record<Lang, (typeof dunningTemplates)['ru']>
const SERVICE = serviceTemplate
const UPCOMING = upcomingTemplates as Record<Lang, (typeof upcomingTemplates)['ru']>

// Render a payment-failed email from the dunning template. Markup + retry link stay here; copy is data.
function buildDunning (reason: PaymentFailedReason, plan: string, url: string, lang: Lang): MailMessage {
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

interface SuccessFields {
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
function buildReceipt (kind: PaymentSucceededKind, f: SuccessFields, lang: Lang): MailMessage {
  const t = RECEIPT[lang]
  const l = t.labels
  // [label, value] rows; paymentMethod row is not shown when empty.
  const rows: Array<[string, string]> = [
    [l.customer, f.customer],
    [l.plan, f.plan],
    [l.amount[kind], f.amount],
    [l.paidAt, f.paidAt],
    [l.txId, f.txId],
    ...(f.paymentMethod !== '' ? ([[l.paymentMethod, f.paymentMethod]] as Array<[string, string]>) : []),
    [l.period, `${f.periodStart} — ${f.periodEnd}`]
  ]
  const intro = fill(t.intro[kind], { plan: f.plan })
  const introHtml = fill(t.intro[kind], { plan: `<b>${f.plan}</b>` })
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
function buildSupportFooter (config: Config, lang: Lang): { text: string, html: string } {
  const parts: string[] = []
  const partsHtml: string[] = []
  if (config.SupportEmail !== undefined && config.SupportEmail !== '') {
    parts.push(config.SupportEmail)
    partsHtml.push(`<a href="mailto:${config.SupportEmail}">${config.SupportEmail}</a>`)
  }
  if (config.SupportUrl !== undefined && config.SupportUrl !== '') {
    parts.push(config.SupportUrl)
    partsHtml.push(`<a href="${config.SupportUrl}">${config.SupportUrl}</a>`)
  }
  if (parts.length === 0) return { text: '', html: '' }

  const label = RECEIPT[lang].support
  return {
    text: `\n\n${label}: ${parts.join(', ')}`,
    html: `<hr/><p style="color:#888;font-size:12px">${label}: ${partsHtml.join(', ')}</p>`
  }
}

function billingUrl (config: Config): string {
  // Front URL points at the workspace UI; the billing settings live under /billing.
  const base = config.FrontUrl.replace(/\/+$/, '')
  return `${base}/billing`
}

/**
 * Build the full workspace link for service copies.
 */
async function resolveWorkspaceLink (
  storage: SubscriptionStorage,
  config: Config,
  workspaceUuid: WorkspaceUuid
): Promise<string> {
  const slug = await storage.getWorkspaceUrl(workspaceUuid)
  if (slug === null) return workspaceUuid
  const base = config.FrontUrl.replace(/\/+$/, '')
  return `${base}/workbench/${slug}`
}

/**
 * Render the plain-text service-copy lines as HTML, turning workspace value into a clickable link.
 */
function serviceHtml (lines: string[], workspace: string): string {
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

/** The charge that a payment Description / receipt line describes. */
export type ChargeKind = 'purchase' | 'update' | 'renewal' | 'retry'

const CHARGE_DESCRIPTION = chargeDescriptionTemplates as Record<
Lang,
{ tier: Record<ChargeKind, string>, package: Record<ChargeKind, string> }
>

/**
 * Build the payer-facing charge Description (localized to the payer, human plan label).
 */
export async function buildChargeDescription (
  config: Config,
  plan: string,
  type: string,
  kind: ChargeKind,
  locale: string | null
): Promise<string> {
  const lang = resolveLang(locale)
  const label = await getPlanLabel(config, plan, type, lang)
  const family = type === 'package' ? CHARGE_DESCRIPTION[lang].package : CHARGE_DESCRIPTION[lang].tier
  return fill(family[kind], { plan: label })
}

const PLAN_CONFIG_TTL_MS = 10 * 60 * 1000 // plan config is static; refresh every 10 min
let planConfigCache: { data: PlanConfigLike, fetchedAt: number } | null = null

/**
 * Resolve a localized plan/package label from pod-payment's /api/v1/plan-config.
 * Best-effort with a short cache: on any failure (no PaymentUrl, network, missing key)
 * falls back to the raw plan id so the email is never blocked.
 */
async function getPlanLabel (config: Config, plan: string, type: string, lang: Lang): Promise<string> {
  if (config.PaymentUrl === undefined) return plan

  try {
    const now = Date.now()
    if (planConfigCache === null || now - planConfigCache.fetchedAt > PLAN_CONFIG_TTL_MS) {
      // Single best-effort attempt (no retry loop) — a slow/unreachable pod-payment must not block the email.
      const data = await fetchPlanConfig(config.PaymentUrl, { attempts: 1, timeoutMs: MAIL_TIMEOUT_MS })
      planConfigCache = { data, fetchedAt: now }
    }

    // Display name per type: `label` for plans, `description` for packages (packages don't have label).
    const data = planConfigCache.data
    const name = type === 'package' ? data?.packages?.[plan]?.description : data?.plans?.[plan]?.label
    return name?.[lang] ?? name?.[DEFAULT_LANG] ?? plan
  } catch {
    return plan
  }
}

function buildMessage (reason: PaymentFailedReason, planLabel: string, config: Config, lang: Lang): MailMessage {
  return buildDunning(reason, planLabel, billingUrl(config), lang)
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
  storage: SubscriptionStorage,
  config: Config,
  sub: SubscriptionData,
  reason: PaymentFailedReason
): Promise<void> {
  if (config.MailUrl === undefined || config.MailFrom === undefined) {
    ctx.info('Payment-failed email skipped: mail not configured', { subId: sub.id, reason })
    return
  }

  let payerEmail: string | null = null
  try {
    const { email, locale } = await storage.getAccountContact(sub.accountUuid)
    payerEmail = email
    if (email === null) {
      ctx.warn('Payment-failed email skipped: no email for account', { subId: sub.id, account: sub.accountUuid })
    } else {
      const lang = resolveLang(locale)
      const planLabel = await getPlanLabel(config, sub.plan, sub.type, lang)
      const { subject, text, html } = buildMessage(reason, planLabel, config, lang)
      await sendMail(config, email, { subject, text, html })
      ctx.info('Payment-failed email sent', { subId: sub.id, reason })
    }
  } catch (err: any) {
    ctx.error('Payment-failed email error', { subId: sub.id, reason, err: err?.message ?? String(err) })
  }

  // Service copy so the team can reach out to the payer directly.
  if (config.BillingEmails !== undefined && config.BillingEmails.length > 0) {
    const attempt = (sub.providerData?.retryAttempt as number) ?? 0
    const workspace = await resolveWorkspaceLink(storage, config, sub.workspaceUuid)
    // Team inbox is Russian-only: resolve the plan label and the reason enum to Russian.
    const planRu = await getPlanLabel(config, sub.plan, sub.type, DEFAULT_LANG)
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
      `${l.amount}: ${formatAmount(sub.amount)}`,
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
    for (const to of config.BillingEmails) {
      try {
        await sendMail(config, to, svc)
      } catch (err: any) {
        ctx.error('Billing service email error', { to, err: err?.message ?? String(err) })
      }
    }
  }
}

function formatAmount (amount: number | undefined): string {
  return `${((amount ?? 0) / 100).toFixed(2)} ₽`
}

// Format an epoch-ms timestamp as a locale date (day precision — for periods and the subject line).
function formatDate (ms: number | undefined, lang: Lang): string {
  if (ms === undefined) return '-'
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US'
  return new Date(ms).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Format an epoch-ms timestamp as a locale date + time (minute precision — for the payment moment).
function formatDateTime (ms: number | undefined, lang: Lang): string {
  if (ms === undefined) return '-'
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US'
  return new Date(ms).toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// Payer display: "Имя (email)", or whichever of the two is present, or '-' when both missing.
function formatCustomer (name: string | null, email: string | null): string {
  if (name !== null && email !== null) return `${name} (${email})`
  return name ?? email ?? '-'
}

// Payment method from the stored masked PAN: "Карта •••• 0777".
// Empty when no card (SBP or PAN not delivered by the webhook).
// PAN is present -> payment type: card.
function formatPaymentMethod (sub: SubscriptionData, lang: Lang): string {
  const pan = sub.providerData?.pan as string | undefined
  if (pan === undefined || pan === '') return ''
  const digits = pan.replace(/\D/g, '')
  const last4 = digits.slice(-4)
  if (last4.length < 4) return ''
  return `${RECEIPT[lang].card} •••• ${last4}`
}

/**
 * Send a successful-payment receipt email to the subscription owner.
 * A service copy goes to BillingEmails (if configured).
 */
export async function notifyPaymentSucceeded (
  ctx: MeasureContext,
  storage: SubscriptionStorage,
  config: Config,
  sub: SubscriptionData,
  kind: PaymentSucceededKind,
  chargedAmount?: number
): Promise<void> {
  if (config.MailUrl === undefined || config.MailFrom === undefined) {
    ctx.info('Payment-succeeded email skipped: mail not configured', { subId: sub.id, kind })
    return
  }

  let payerEmail: string | null = null
  try {
    const { name, email, locale } = await storage.getAccountContact(sub.accountUuid)
    payerEmail = email
    if (email === null) {
      ctx.warn('Payment-succeeded email skipped: no email for account', { subId: sub.id, account: sub.accountUuid })
    } else {
      const lang = resolveLang(locale)
      const planLabel = await getPlanLabel(config, sub.plan, sub.type, lang)
      // Transaction id: recurrent charges set lastChargePaymentId; the initial checkout sets paymentId.
      const txId =
        (sub.providerData?.lastChargePaymentId as string | undefined) ??
        (sub.providerData?.paymentId as string | undefined) ??
        sub.providerSubscriptionId
      // Payment moment == period start: both purchase activation and renewal set periodStart to now.
      const support = buildSupportFooter(config, lang)
      const fields: SuccessFields = {
        customer: formatCustomer(name, email),
        plan: planLabel,
        // Charged: delta in case of upgrade, else - the recurring price.
        amount: formatAmount(chargedAmount ?? sub.amount),
        paidAtDate: formatDate(sub.periodStart, lang),
        paidAt: formatDateTime(sub.periodStart, lang),
        txId,
        paymentMethod: formatPaymentMethod(sub, lang),
        periodStart: formatDate(sub.periodStart, lang),
        periodEnd: formatDate(sub.periodEnd, lang),
        url: billingUrl(config),
        supportText: support.text,
        supportHtml: support.html
      }
      const { subject, text, html } = buildReceipt(kind, fields, lang)
      await sendMail(config, email, { subject, text, html })
      ctx.info('Payment-succeeded email sent', { subId: sub.id, kind })
    }
  } catch (err: any) {
    ctx.error('Payment-succeeded email error', { subId: sub.id, kind, err: err?.message ?? String(err) })
  }

  // Service copy to the team about successful charges.
  if (config.BillingEmails !== undefined && config.BillingEmails.length > 0) {
    const workspace = await resolveWorkspaceLink(storage, config, sub.workspaceUuid)
    // Team inbox is Russian-only: resolve the plan label and the kind enum to Russian.
    const planRu = await getPlanLabel(config, sub.plan, sub.type, DEFAULT_LANG)
    const kindRu = SERVICE.kind[kind]
    const typeRu = SERVICE.type[sub.type as keyof typeof SERVICE.type] ?? sub.type
    const l = SERVICE.labels
    const lines = [
      `${l.workspace}: ${workspace}`,
      `${l.plan}: ${planRu} (${typeRu})`,
      `${l.charged}: ${formatAmount(chargedAmount ?? sub.amount)}`,
      // Showing both upgrade delta and the recurring price for the team.
      ...(chargedAmount !== undefined && sub.amount != null && chargedAmount !== Number(sub.amount)
        ? [`${l.regularPrice}: ${formatAmount(sub.amount)}`]
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
    for (const to of config.BillingEmails) {
      try {
        await sendMail(config, to, svc)
      } catch (err: any) {
        ctx.error('Billing service email error', { to, err: err?.message ?? String(err) })
      }
    }
  }
}

/**
 * Which upcoming-expiry reminder to send, `noticeDays` before the date.
 * - 'recurrent': a recurrent subscription will be charged for the next period.
 * - 'trial': the trial period runs out (workspace falls back to the free plan).
 * - 'oneoff': a one-off paid period runs out, nothing will be charged.
 * - 'canceled': the user canceled; access is kept until the end of the paid period.
 */
export type UpcomingKind = 'recurrent' | 'trial' | 'oneoff' | 'canceled'

interface UpcomingFields {
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
function buildUpcoming (kind: UpcomingKind, family: 'tier' | 'package', f: UpcomingFields, lang: Lang): MailMessage {
  const t = UPCOMING[lang]
  const l = t.labels
  const p = { plan: f.plan, dueDate: f.dueDate }
  const lead = fill(t.lead[kind][family], p)
  const leadHtml = fill(t.lead[kind][family], { plan: `<b>${f.plan}</b>`, dueDate: `<b>${f.dueDate}</b>` })
  const note = kind === 'recurrent' ? t.note.recurrent : t.note[kind][family]
  // [label, text value, html value?] — html falls back to the escaped text value when absent.
  type Row = [string, string, string?]
  // The workspace name is the link text; plain text keeps the URL alongside it, since it cannot click.
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

/**
 * Send an upcoming-expiry reminder to the subscription owner, `noticeDays` before `dueAt`.
 * No service copy: a reminder is not an incident.
 * Best-effort: any failure is logged and swallowed.
 */
export async function notifyUpcoming (
  ctx: MeasureContext,
  storage: SubscriptionStorage,
  config: Config,
  sub: SubscriptionData,
  kind: UpcomingKind,
  dueAt: number
): Promise<void> {
  if (config.MailUrl === undefined || config.MailFrom === undefined) {
    ctx.info('Upcoming-expiry email skipped: mail not configured', { subId: sub.id, kind })
    return
  }

  try {
    const { email, locale } = await storage.getAccountContact(sub.accountUuid)
    if (email === null) {
      ctx.warn('Upcoming-expiry email skipped: no email for account', { subId: sub.id, account: sub.accountUuid })
      return
    }
    const lang = resolveLang(locale)
    const planLabel = await getPlanLabel(config, sub.plan, sub.type, lang)
    const support = buildSupportFooter(config, lang)
    const ws = await storage.getWorkspaceInfo(sub.workspaceUuid)
    const fields: UpcomingFields = {
      workspace: ws?.name ?? '',
      workspaceUrl: ws !== null ? `${config.FrontUrl.replace(/\/+$/, '')}/workbench/${ws.url}` : '',
      plan: planLabel,
      amount: kind === 'recurrent' ? formatAmount(sub.amount) : '',
      dueDate: formatDate(dueAt, lang),
      paymentMethod: kind === 'recurrent' ? formatPaymentMethod(sub, lang) : '',
      url: billingUrl(config),
      supportText: support.text,
      supportHtml: support.html
    }
    const family = sub.type === 'package' ? 'package' : 'tier'
    const { subject, text, html } = buildUpcoming(kind, family, fields, lang)
    await sendMail(config, email, { subject, text, html })
    ctx.info('Upcoming-expiry email sent', { subId: sub.id, kind, dueAt })
  } catch (err: any) {
    ctx.error('Upcoming-expiry email error', { subId: sub.id, kind, err: err?.message ?? String(err) })
  }
}

/**
 * Alert the team that a charge was blocked: no fiscal receipt could be issued (54-ФЗ):
 * no payer contact/the receipt build failed.
 */
export async function notifyReceiptBlocked (ctx: MeasureContext, config: Config, sub: SubscriptionData): Promise<void> {
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

  if (config.MailUrl === undefined || config.MailFrom === undefined) return
  if (config.BillingEmails === undefined || config.BillingEmails.length === 0) return

  const l = SERVICE.labels
  const typeRu = SERVICE.type[sub.type as keyof typeof SERVICE.type] ?? sub.type
  const lines = [
    SERVICE.receiptBlocked.lead,
    '',
    `${l.cause}: ${code} — ${reason}`,
    `${l.workspace}: ${sub.workspaceUuid}`,
    `${l.account}: ${sub.accountUuid}`,
    `${l.plan}: ${sub.plan} (${typeRu})`,
    `${l.amount}: ${formatAmount(sub.amount)}`,
    `${l.subscription}: ${sub.id ?? '-'}`,
    '',
    SERVICE.receiptBlocked.hint
  ]
  const msg: MailMessage = {
    subject: fill(SERVICE.subject.receiptBlocked, { plan: sub.plan, code }),
    text: lines.join('\n'),
    html: `<pre>${lines.join('\n')}</pre>`
  }
  for (const to of config.BillingEmails) {
    try {
      await sendMail(config, to, msg)
    } catch (err: any) {
      ctx.error('Receipt-blocked service email error', { to, err: err?.message ?? String(err) })
    }
  }
}

// POST one message to pod-mail; throws on transport/HTTP errors (callers log and swallow).
async function sendMail (config: Config, to: string, msg: MailMessage): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.MailApiKey !== undefined) {
    headers.Authorization = `Bearer ${config.MailApiKey}`
  }
  const res = await fetch(`${(config.MailUrl as string).replace(/\/+$/, '')}/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ from: config.MailFrom, to, subject: msg.subject, text: msg.text, html: msg.html }),
    signal: AbortSignal.timeout(MAIL_TIMEOUT_MS)
  })
  if (!res.ok) {
    throw new Error(`mail send failed: ${res.status}`)
  }
}

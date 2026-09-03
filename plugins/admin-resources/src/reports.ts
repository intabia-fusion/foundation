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

import type {
  AccountAggregatedInfo,
  AccountsFilter,
  AdminAction,
  WorkspaceInfoWithBilling
} from '@hcengineering/account-client'

import { getAccountClient, getAllSubscriptions, listWorkspacesPaged, requestAdminOtpCode } from './utils'

const PAGE = 1000

export type ReportId = 'accounts' | 'workspaces' | 'paid' | 'admin-actions'
export type ReportFormat = 'csv' | 'pdf'

/** Builders pick what they support: accounts uses search/filter, admin-actions uses search/action */
export interface ReportOptions {
  search?: string
  filter?: AccountsFilter
  action?: string
}

interface Kpi {
  n: string | number
  l: string
  hint?: string
  cls?: 'acc' | 'tea' | ''
}

interface BarChart {
  title: string
  sub?: string
  cls: 'acc' | 'tea'
  points: Array<{ label: string, value: number }>
}

interface PdfTable {
  title: string
  sub?: string
  headers: string[]
  rows: unknown[][]
}

// CSV export takes headers/rows (full data dump).
// PDF is an infographic: KPI cards + bar charts + compact top-N tables.
interface Report {
  name: string
  title: string
  sub?: string
  headers: string[]
  rows: unknown[][]
  kpis: Kpi[]
  charts: BarChart[]
  pdfTables: PdfTable[]
}

function csvEscape (v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

function downloadCsv (r: Report): void {
  const csv = [r.headers, ...r.rows].map((row) => row.map(csvEscape).join(',')).join('\n')
  // BOM so Excel detects UTF-8
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${r.name}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(link.href)
}

function escapeHtml (v: unknown): string {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

// Same design language as fusion-deployment/scripts/gen_report.py (light, print-friendly)
const PDF_CSS = `
  .wrap { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    color: #1a1f2b; background: #fff; padding: 8px; line-height: 1.5; font-variant-numeric: tabular-nums; }
  .eyebrow { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #4f6bf5;
    font-weight: 600; margin: 0 0 6px; }
  .wrap h1 { font-size: 26px; font-weight: 700; margin: 0 0 4px; letter-spacing: -.02em; }
  .sub { color: #545c6e; font-size: 13px; margin: 0 0 24px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 0 0 28px; }
  .kpi { background: #fff; border: 1px solid #d5dae4; border-radius: 12px; padding: 14px; }
  .kpi .n { font-size: 26px; font-weight: 700; letter-spacing: -.02em; line-height: 1; }
  .kpi .l { font-size: 11.5px; color: #545c6e; margin-top: 7px; }
  .kpi .hint { font-size: 10.5px; color: #8b93a6; margin-top: 2px; }
  .kpi.acc .n { color: #4f6bf5; } .kpi.tea .n { color: #14a89a; }
  section { margin-bottom: 26px; page-break-inside: avoid; }
  .wrap h2 { font-size: 15px; font-weight: 650; margin: 0 0 3px; }
  .shead { color: #8b93a6; font-size: 11.5px; margin: 0 0 12px; }
  .chart { background: #fff; border: 1px solid #d5dae4; border-radius: 12px; padding: 18px 18px 12px; }
  .bars { display: grid; gap: 8px; align-items: end; height: 130px; }
  .bar-col { display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
    height: 100%; gap: 5px; }
  .bar-val { font-size: 10.5px; font-weight: 600; color: #545c6e; }
  .bar { width: 100%; max-width: 42px; border-radius: 4px 4px 0 0; min-height: 3px; }
  .bar.acc { background: linear-gradient(180deg, #4f6bf5, #dfe5fe); }
  .bar.tea { background: linear-gradient(180deg, #14a89a, #cdeeea); }
  .xaxis { display: grid; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #e0e4ec; }
  .xtick { text-align: center; font-size: 9.5px; color: #8b93a6; }
  .tbl-wrap { background: #fff; border: 1px solid #d5dae4; border-radius: 12px; overflow: hidden; }
  .wrap table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  .wrap th, .wrap td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #e0e4ec; }
  .wrap th { font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em; color: #8b93a6; font-weight: 600; }
  .wrap tbody tr:last-child td { border-bottom: none; }
  footer { margin-top: 28px; padding-top: 14px; border-top: 1px solid #e0e4ec; color: #8b93a6; font-size: 11px; }
`

function barChartHtml (c: BarChart): string {
  const max = Math.max(1, ...c.points.map((p) => p.value))
  const cols = c.points
    .map(
      (p) =>
        `<div class='bar-col'><div class='bar-val'>${p.value}</div>` +
        `<div class='bar ${c.cls}' style='height:${((p.value / max) * 100).toFixed(1)}%'></div></div>`
    )
    .join('')
  const ticks = c.points.map((p) => `<div class='xtick'>${escapeHtml(p.label)}</div>`).join('')
  const grid = `grid-template-columns:repeat(${c.points.length},1fr)`
  return (
    `<section><h2>${escapeHtml(c.title)}</h2>` +
    (c.sub != null ? `<p class='shead'>${escapeHtml(c.sub)}</p>` : '') +
    `<div class='chart'><div class='bars' style='${grid}'>${cols}</div>` +
    `<div class='xaxis' style='${grid}'>${ticks}</div></div></section>`
  )
}

function pdfTableHtml (t: PdfTable): string {
  const th = t.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')
  const body = t.rows.map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')
  return (
    `<section><h2>${escapeHtml(t.title)}</h2>` +
    (t.sub != null ? `<p class='shead'>${escapeHtml(t.sub)}</p>` : '') +
    `<div class='tbl-wrap'><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div></section>`
  )
}

async function downloadPdf (r: Report): Promise<void> {
  const { default: html2pdf } = await import('html2pdf.js')
  const el = document.createElement('div')
  const kpis = r.kpis
    .map(
      (k) =>
        `<div class='kpi ${k.cls ?? ''}'><div class='n'>${escapeHtml(k.n)}</div><div class='l'>${escapeHtml(k.l)}</div>` +
        (k.hint != null ? `<div class='hint'>${escapeHtml(k.hint)}</div>` : '') +
        '</div>'
    )
    .join('')
  el.innerHTML = `
    <style>${PDF_CSS}</style>
    <div class="wrap">
      <p class="eyebrow">Аналитика</p>
      <h1>${escapeHtml(r.title)}</h1>
      <p class="sub">${escapeHtml(r.sub ?? '')} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</p>
      <div class="kpis">${kpis}</div>
      ${r.charts.map(barChartHtml).join('')}
      ${r.pdfTables.map(pdfTableHtml).join('')}
      <footer>Intabia Fusion · панель администратора · полные данные в CSV-выгрузке</footer>
    </div>`
  await html2pdf()
    .set({
      margin: 8,
      filename: `${r.name}.pdf`,
      pagebreak: { mode: ['css', 'legacy'] },
      html2canvas: { scale: 2 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    })
    .from(el)
    .save()
}

function fmtDate (ms: number | string | undefined | null): string {
  const n = Number(ms)
  if (ms == null || !Number.isFinite(n) || n === 0) return ''
  return new Date(n).toISOString().slice(0, 19).replace('T', ' ')
}

function daysSince (ms: number | undefined | null): string {
  if (ms == null || ms === 0) return ''
  return String(Math.floor((Date.now() - Number(ms)) / (24 * 3600 * 1000)))
}

function stamp (prefix: string): string {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}`
}

function fmtDay (ms: number | string | undefined | null): string {
  const s = fmtDate(ms)
  return s.slice(0, 10)
}

const MONTH_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

// Last 12 months of counts from a list of timestamps
function monthlySeries (dates: number[]): Array<{ label: string, value: number }> {
  const now = new Date()
  const byMonth = new Map<string, number>()
  for (const d of dates) {
    if (!Number.isFinite(d) || d === 0) continue
    const ym = new Date(d).toISOString().slice(0, 7)
    byMonth.set(ym, (byMonth.get(ym) ?? 0) + 1)
  }
  const res: Array<{ label: string, value: number }> = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    const ym = d.toISOString().slice(0, 7)
    res.push({ label: `${MONTH_RU[d.getUTCMonth()]} ${ym.slice(2, 4)}`, value: byMonth.get(ym) ?? 0 })
  }
  return res
}

const DAY = 24 * 3600 * 1000

function activeWithin (ms: number | undefined | null, days: number): boolean {
  return ms != null && ms !== 0 && Date.now() - Number(ms) <= days * DAY
}

async function fetchAllWorkspaces (): Promise<WorkspaceInfoWithBilling[]> {
  const all: WorkspaceInfoWithBilling[] = []
  for (let skip = 0; ; skip += PAGE) {
    const res = await listWorkspacesPaged({ skip, limit: PAGE, sort: 'createdOn', order: 'asc' })
    if (res == null) break
    all.push(...res.workspaces)
    if (all.length >= res.total || res.workspaces.length < PAGE) break
  }
  return all
}

/** All accounts: registration date (earliest social id), last visit, workspaces */
async function accountsReport (opts?: ReportOptions): Promise<Report> {
  const client = getAccountClient()
  const all: AccountAggregatedInfo[] = []
  for (let skip = 0; ; skip += PAGE) {
    const page = await client.listAccounts(opts?.search, skip, PAGE, 'name', opts?.filter)
    all.push(...page)
    if (page.length < PAGE) break
  }
  const registeredOf = (a: (typeof all)[number]): number => Number(a.registeredOn ?? Infinity)
  const emailOf = (a: (typeof all)[number]): string =>
    a.socialIds.find((s) => s.type === 'email')?.value ?? a.socialIds[0]?.value ?? ''

  const rows = all.map((a) => {
    const registered = registeredOf(a)
    return [
      a.uuid,
      `${a.firstName} ${a.lastName}`.trim(),
      emailOf(a),
      Number.isFinite(registered) ? fmtDate(registered) : '',
      fmtDate(a.lastVisit),
      daysSince(a.lastVisit),
      a.workspaces.length
    ]
  })

  const registeredBy = new Map(all.map((a) => [a.uuid, registeredOf(a)]))
  const registered = [...registeredBy.values()].filter((n) => Number.isFinite(n))
  const series = monthlySeries(registered)
  const peak = series.reduce((a, b) => (b.value > a.value ? b : a), series[0])
  const recent = all
    .filter((a) => Number.isFinite(registeredBy.get(a.uuid)))
    .sort((a, b) => (registeredBy.get(b.uuid) ?? 0) - (registeredBy.get(a.uuid) ?? 0))
    .slice(0, 15)

  const criteria = [
    opts?.filter?.noWorkspaces === true ? 'без пространств' : undefined,
    opts?.filter?.pendingOnly === true ? 'незавершённые регистрации' : undefined,
    opts?.filter?.inactiveDays !== undefined ? `не заходили ${opts.filter.inactiveDays}+ дн.` : undefined,
    opts?.search != null && opts.search !== '' ? `поиск "${opts.search}"` : undefined
  ].filter((s) => s != null)

  return {
    name: stamp(criteria.length > 0 ? 'accounts-filtered' : 'accounts'),
    title: 'Регистрации пользователей',
    sub: `Всего ${all.length} аккаунтов${criteria.length > 0 ? ` · ${criteria.join(', ')}` : ''}`,
    headers: ['uuid', 'name', 'email', 'registered_on', 'last_visit', 'days_inactive', 'workspaces'],
    rows,
    kpis: [
      { n: all.length, l: 'Всего аккаунтов', cls: 'acc', hint: `${registered.length} с датой регистрации` },
      { n: all.filter((a) => activeWithin(a.lastVisit, 30)).length, l: 'Активны за 30 дней', cls: 'tea' },
      { n: peak?.value ?? 0, l: 'Пик регистраций / мес', hint: peak?.label ?? '' },
      { n: series.at(-1)?.value ?? 0, l: 'Регистраций в этом месяце' }
    ],
    charts: [{ title: 'Регистрации аккаунтов по месяцам', cls: 'acc', points: series }],
    pdfTables: [
      {
        title: 'Последние регистрации',
        sub: 'Новые сверху, топ 15',
        headers: ['Имя', 'Email', 'Дата регистрации', 'Последний визит'],
        rows: recent.map((a) => [
          `${a.firstName} ${a.lastName}`.trim(),
          emailOf(a),
          fmtDay(registeredOf(a)),
          fmtDay(a.lastVisit)
        ])
      }
    ]
  }
}

/** All workspaces: created, last visited, days since last visit */
async function workspacesReport (): Promise<Report> {
  const all = await fetchAllWorkspaces()
  const rows = all.map((w) => [
    w.uuid,
    w.name,
    w.url,
    w.region ?? '',
    w.mode ?? '',
    fmtDate(w.createdOn),
    fmtDate(w.lastVisit),
    daysSince(w.lastVisit),
    w.billingPlan ?? '',
    w.billingStatus ?? ''
  ])
  const series = monthlySeries(all.map((w) => Number(w.createdOn ?? 0)))
  const active30 = all.filter((w) => activeWithin(w.lastVisit, 30)).length
  const stale90 = all.filter((w) => !activeWithin(w.lastVisit, 90)).length
  const recentlyActive = [...all]
    .filter((w) => w.lastVisit != null && w.lastVisit !== 0)
    .sort((a, b) => Number(b.lastVisit ?? 0) - Number(a.lastVisit ?? 0))
    .slice(0, 15)

  return {
    name: stamp('workspaces'),
    title: 'Пространства и активность',
    sub: `Всего ${all.length} пространств`,
    headers: [
      'uuid',
      'name',
      'url',
      'region',
      'mode',
      'created_on',
      'last_visit',
      'days_inactive',
      'billing_plan',
      'billing_status'
    ],
    rows,
    kpis: [
      { n: all.length, l: 'Всего пространств', cls: 'tea' },
      { n: active30, l: 'Активны за 30 дней', cls: 'tea', hint: `из ${all.length}` },
      { n: stale90, l: 'Не заходили 90+ дней' },
      { n: series.at(-1)?.value ?? 0, l: 'Создано в этом месяце' }
    ],
    charts: [{ title: 'Создание пространств по месяцам', sub: 'По workspace.created_on', cls: 'tea', points: series }],
    pdfTables: [
      {
        title: 'Недавно активные пространства',
        sub: 'По последнему визиту, топ 15',
        headers: ['Пространство', 'URL', 'Создано', 'Последний визит', 'Тариф'],
        rows: recentlyActive.map((w) => [
          w.name,
          w.url,
          fmtDay(w.createdOn),
          fmtDay(w.lastVisit),
          w.billingPlan != null ? `${w.billingPlan} (${w.billingStatus ?? ''})` : '-'
        ])
      }
    ]
  }
}

/** Paid tier subscriptions with workspace info */
async function paidReport (): Promise<Report> {
  const [subs, workspaces] = await Promise.all([getAllSubscriptions(), fetchAllWorkspaces()])
  const wsById = new Map(workspaces.map((w) => [w.uuid as string, w]))
  const paid = subs.filter(
    (s) => s.type === 'tier' && s.provider !== 'free' && s.provider !== 'trial' && Number(s.amount ?? 0) > 0
  )
  const rows = paid.map((s) => {
    const ws = wsById.get(s.workspaceUuid)
    return [
      s.workspaceUuid,
      ws?.name ?? '',
      s.plan,
      Number(s.providerData?.quantity ?? s.limits?.usersLimit ?? 0),
      s.status,
      Math.round(Number(s.amount ?? 0) / 100),
      s.provider,
      fmtDate(s.periodStart ?? s.createdOn),
      fmtDate(s.periodEnd),
      s.payerEmail ?? '',
      fmtDate(ws?.lastVisit),
      daysSince(ws?.lastVisit)
    ]
  })
  const current = paid.filter((s) => ['active', 'past_due', 'readonly'].includes(s.status))
  const seatsOf = (s: (typeof paid)[number]): number => Number(s.providerData?.quantity ?? s.limits?.usersLimit ?? 0)
  const monthlyRub = current.reduce((sum, s) => sum + Math.round(Number(s.amount ?? 0) / 100), 0)
  const payers = new Set(current.map((s) => s.payerEmail).filter((p) => p != null)).size

  return {
    name: stamp('paid-workspaces'),
    title: 'Платные пространства',
    sub: `${current.length} действующих платных подписок`,
    headers: [
      'workspace_uuid',
      'workspace',
      'plan',
      'seats',
      'status',
      'amount_rub',
      'provider',
      'period_start',
      'period_end',
      'payer',
      'last_visit',
      'days_inactive'
    ],
    rows,
    kpis: [
      { n: new Set(current.map((s) => s.workspaceUuid)).size, l: 'Платных пространств', cls: 'acc' },
      { n: current.reduce((sum, s) => sum + seatsOf(s), 0), l: 'Платных мест', cls: 'tea' },
      { n: `${monthlyRub.toLocaleString('ru')} ₽`, l: 'Сумма действующих подписок' },
      { n: payers, l: 'Плательщиков' }
    ],
    charts: [
      {
        title: 'Начало платных периодов по месяцам',
        cls: 'acc',
        points: monthlySeries(paid.map((s) => Number(s.periodStart ?? s.createdOn)))
      }
    ],
    pdfTables: [
      {
        title: 'Действующие платные подписки',
        sub: 'По окончанию периода',
        headers: ['Пространство', 'Тариф', 'Мест', 'Статус', 'Сумма', 'Конец периода', 'Плательщик'],
        rows: [...current]
          .sort((a, b) => Number(a.periodEnd ?? 0) - Number(b.periodEnd ?? 0))
          .map((s) => [
            wsById.get(s.workspaceUuid)?.name ?? s.workspaceUuid,
            s.plan,
            seatsOf(s),
            s.status,
            `${Math.round(Number(s.amount ?? 0) / 100).toLocaleString('ru')} ₽`,
            fmtDay(s.periodEnd),
            s.payerEmail ?? '-'
          ])
      }
    ]
  }
}

/** Admin audit trail */
async function adminActionsReport (opts?: ReportOptions): Promise<Report> {
  const client = getAccountClient()
  const all: AdminAction[] = []
  for (let skip = 0; ; skip += PAGE) {
    const res = await client.listAdminActions({ search: opts?.search, action: opts?.action, skip, limit: PAGE })
    all.push(...res.actions)
    if (all.length >= res.total || res.actions.length < PAGE) break
  }

  const rows = all.map((a) => [
    fmtDate(a.createdOn),
    a.actorEmail ?? '',
    a.actor,
    a.action,
    a.target ?? '',
    a.targetLabel ?? '',
    a.data != null ? JSON.stringify(a.data) : ''
  ])

  const byAction = new Map<string, number>()
  for (const a of all) byAction.set(a.action, (byAction.get(a.action) ?? 0) + 1)
  const topActions = [...byAction.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)

  return {
    name: stamp('admin-actions'),
    title: 'Действия администраторов',
    sub: `Всего ${all.length} записей${opts?.action != null ? ` · ${opts.action}` : ''}`,
    headers: ['time', 'actor_email', 'actor_uuid', 'action', 'target', 'target_label', 'data'],
    rows,
    kpis: [
      { n: all.length, l: 'Всего действий', cls: 'acc' },
      { n: new Set(all.map((a) => a.actor)).size, l: 'Администраторов', cls: 'tea' },
      { n: all.filter((a) => activeWithin(a.createdOn, 30)).length, l: 'За 30 дней' },
      { n: byAction.size, l: 'Типов операций' }
    ],
    charts: [
      { title: 'Действия администраторов по месяцам', cls: 'acc', points: monthlySeries(all.map((a) => a.createdOn)) }
    ],
    pdfTables: [
      {
        title: 'Частые операции',
        sub: 'Топ 10',
        headers: ['Операция', 'Количество'],
        rows: topActions
      },
      {
        title: 'Последние действия',
        sub: 'Новые сверху, топ 20',
        headers: ['Дата', 'Администратор', 'Операция', 'Объект'],
        rows: all
          .slice(0, 20)
          .map((a) => [fmtDay(a.createdOn), a.actorEmail ?? a.actor, a.action, a.targetLabel ?? a.target ?? ''])
      }
    ]
  }
}

const builders: Record<ReportId, (opts?: ReportOptions) => Promise<Report>> = {
  accounts: accountsReport,
  workspaces: workspacesReport,
  paid: paidReport,
  'admin-actions': adminActionsReport
}

export async function downloadReport (id: ReportId, format: ReportFormat, opts?: ReportOptions): Promise<void> {
  // Bulk PII leaves the panel here: confirm with a second factor so the export is auditable.
  const code = await requestAdminOtpCode()
  if (code === undefined) return
  await getAccountClient().adminConfirmExport(id, opts as Record<string, any> | undefined, code)

  const report = await builders[id](opts)
  if (format === 'csv') {
    downloadCsv(report)
  } else {
    await downloadPdf(report)
  }
}

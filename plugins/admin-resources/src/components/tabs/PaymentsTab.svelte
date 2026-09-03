<!--
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
-->
<script lang="ts">
  import { Label, Loading, Button, CheckBox, SearchEdit } from '@hcengineering/ui'
  import type {
    PaymentOperation,
    PaymentOperationKind,
    PaymentOperationStats,
    PaymentMonthlyStats,
    SubscriptionInfo
  } from '@hcengineering/account-client'
  import adminRes from '../../plugin'
  import {
    getPaymentOperations,
    getPaymentOperationStats,
    getPaymentMonthlyStats,
    getAllSubscriptions,
    listWorkspacesPaged,
    fmtAmount
  } from '../../utils'

  export let refreshTick: number = 0

  const DAY = 24 * 3600 * 1000
  const PAGE = 20
  let periodDays = 7
  let onlyPaid = false
  let onlyFree = false
  let onlyTrial = false
  let sortByAmount = false
  let onlyErrors = false
  let groupMode: 'payment' | 'workspace' | 'none' = 'payment'
  let opFilter: PaymentOperationKind | '' = ''
  let statusFilter = ''
  let search = ''

  // Known ledger statuses: tbank webhook states + internal success/failed/unknown markers.
  const STATUSES = ['NEW', 'CONFIRMED', 'REJECTED', 'REVERSED', 'REFUNDED', 'canceled', 'success', 'failed', 'unknown']

  // Operation log shows one (local) day at a time, defaulting to today.
  function localDayISO (d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  let selectedDay = localDayISO(new Date())
  let eventDays: Array<{ day: string, count: number }> = []
  function dayBounds (day: string): { from: number, to: number } {
    const [y, m, d] = day.split('-').map(Number)
    const from = new Date(y, m - 1, d).getTime()
    return { from, to: from + DAY }
  }
  $: dayOptions = eventDays.some((d) => d.day === selectedDay)
    ? eventDays
    : [{ day: selectedDay, count: 0 }, ...eventDays]

  let stats: PaymentOperationStats | null = null
  let operations: PaymentOperation[] = []
  let subscriptions: SubscriptionInfo[] = []
  let monthly: PaymentMonthlyStats[] = []
  let wsNames = new Map<string, string>()
  let hasMore = false
  let loading = true

  const OPS: PaymentOperationKind[] = ['init_charge', 'webhook', 'charge_recurrent', 'cancel', 'refund', 'update']
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  function opFilterParams (offset: number): any {
    const { from, to } = dayBounds(selectedDay)
    return {
      from,
      to,
      operation: opFilter !== '' ? opFilter : undefined,
      status: statusFilter !== '' ? statusFilter : undefined,
      workspaceUuid: UUID_RE.test(search.trim()) ? search.trim() : undefined,
      limit: PAGE,
      offset
    }
  }

  async function load (): Promise<void> {
    loading = true
    const to = Date.now()
    const from = to - periodDays * DAY
    const [s, ops, subs, mon, ws, recent] = await Promise.all([
      getPaymentOperationStats(from, to),
      getPaymentOperations(opFilterParams(0)),
      getAllSubscriptions(),
      getPaymentMonthlyStats(to - 365 * DAY, to),
      listWorkspacesPaged({ limit: 1000 }),
      getPaymentOperations({ from: to - 90 * DAY, to, limit: 500 })
    ])
    stats = s
    operations = ops
    subscriptions = subs
    monthly = mon
    hasMore = ops.length === PAGE
    if (ws != null) {
      wsNames = new Map(ws.workspaces.map((w) => [w.uuid as string, w.name ?? w.url ?? '']))
    }
    // Day picker options: only days that actually have ledger events (last 90 days).
    const byDay = new Map<string, number>()
    for (const op of recent) {
      const day = localDayISO(new Date(Number(op.createdOn)))
      byDay.set(day, (byDay.get(day) ?? 0) + 1)
    }
    eventDays = Array.from(byDay.entries())
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => b.day.localeCompare(a.day))
    loading = false
  }

  async function loadMore (): Promise<void> {
    const next = await getPaymentOperations(opFilterParams(operations.length))
    operations = [...operations, ...next]
    hasMore = next.length === PAGE
  }

  // Reload when the refresh tick, period, selected day or server-side filters change.
  $: void reloadOn(refreshTick, periodDays, opFilter, statusFilter, selectedDay)
  async function reloadOn (_tick: number, _days: number, _op: string, _st: string, _day: string): Promise<void> {
    await load()
  }

  function fmtDate (ms: number | string | undefined): string {
    const n = Number(ms)
    return ms != null && Number.isFinite(n) ? new Date(n).toLocaleString('ru') : '-'
  }
  // Day precision: period ends are what the admin edits, the time of day is noise in a one-line label.
  function fmtDay (ms: number | string | undefined): string {
    const n = Number(ms)
    return ms != null && Number.isFinite(n) ? new Date(n).toLocaleDateString('ru') : '-'
  }
  function fmtTime (ms: number | string | undefined): string {
    const n = Number(ms)
    return ms != null && Number.isFinite(n) ? new Date(n).toLocaleTimeString('ru') : '-'
  }

  // What actually happened, in plain words — the raw operation+status pair reads like noise.
  function eventLabel (op: PaymentOperation): string {
    const st = op.status ?? ''
    if (op.operation === 'init_charge') return 'Счёт выставлен'
    if (op.operation === 'refund') return 'Возврат'
    if (op.operation === 'cancel') {
      if (st === 'PLAN_CHANGE') return 'Снят при смене плана'
      // Only the expiry sweep writes a trial cancel to the ledger: the admin cancel goes to the
      // admin action log and the user's own cancel just sets canceledAt. Revisit if either starts
      // logging payment operations.
      if (op.provider === 'trial') return 'Пробный период истёк'
      return 'Подписка отменена'
    }
    if (op.operation === 'update') {
      // Name what the admin actually changed - three bare "edited" rows in a row tell nothing apart.
      const r = rawOf(op)
      const parts: string[] = []
      if (r.seatsAfter != null) parts.push(`места: ${r.seatsBefore ?? '?'} -> ${r.seatsAfter}`)
      if (r.amountAfter != null) parts.push(`цена: ${fmtAmount(r.amountBefore)} -> ${fmtAmount(r.amountAfter)}`)
      // Rows written before the time-of-day fix moved periodEnd within the same day; at day precision
      // that reads as "21.09 -> 21.09". Show the component only when the date actually differs.
      const dayBefore = fmtDay(r.periodEndBefore)
      const dayAfter = fmtDay(r.periodEndAfter)
      if (r.periodEndAfter != null && dayBefore !== dayAfter) parts.push(`до: ${dayBefore} -> ${dayAfter}`)
      return parts.length > 0 ? `Правка админом (${parts.join(', ')})` : 'Правка админом'
    }
    if (op.operation === 'charge_recurrent') {
      if (st === 'success') return 'Продление оплачено'
      if (st === 'unknown') return 'Продление: результат неизвестен'
      return 'Продление не прошло'
    }
    // webhook
    if (st === 'CONFIRMED' || st === 'AUTHORIZED') return 'Оплата подтверждена'
    if (st === 'REJECTED') return 'Оплата отклонена'
    if (st === 'REVERSED') return 'Оплата отменена банком'
    if (st === 'REFUNDED') return 'Возврат проведён'
    if (st === 'DEADLINE_EXPIRED') return 'Счёт просрочен'
    if (st === 'active') return op.provider === 'free' ? 'Переведён на бесплатный тариф' : 'Подписка активирована'
    if (st === 'trialing') return 'Пробный период начат'
    if (st === 'canceled') return 'Подписка снята'
    if (st === 'past_due' || st === 'readonly') return 'Подписка просрочена'
    return `${op.operation} ${st}`
  }
  function isPaid (s: SubscriptionInfo): boolean {
    return s.provider !== 'free' && s.provider !== 'trial' && (s.amount ?? 0) > 0
  }
  function isErrStatus (status: string | undefined): boolean {
    return status === 'REJECTED' || status === 'failed' || status === 'REVERSED' || status === 'unknown'
  }
  function wsLabel (uuid: string | undefined): string {
    if (uuid == null) return '-'
    return wsNames.get(uuid) ?? uuid
  }
  function attemptOf (op: PaymentOperation): string {
    const a = rawOf(op).attempt
    return a != null ? String(a) : '-'
  }

  // Older ledger rows were written double-encoded (a JSON string inside jsonb).
  function rawOf (op: PaymentOperation): Record<string, any> {
    const raw: any = op.raw
    if (typeof raw !== 'string') return raw ?? {}
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }

  // Plan + seats for a ledger row: only from the record itself — resolving via the subscription
  // would show its CURRENT plan/seats on historical rows, which is a lie.
  function planOf (op: PaymentOperation): string {
    const raw = rawOf(op)
    const plan = raw.plan
    const seats = raw.seats
    if (plan == null) return '-'
    return seats != null ? `${plan} ×${seats}` : String(plan)
  }
  function seatsOf (s: SubscriptionInfo): string {
    const q = s.providerData?.quantity ?? s.limits?.usersLimit
    return q != null ? String(q) : '-'
  }

  // Client-side narrowing of the loaded page: errors-only toggle + name/uuid substring search.
  $: shownOps = operations
    .filter((op) => !onlyErrors || isErrStatus(op.status))
    .filter((op) => {
      const q = search.trim().toLowerCase()
      if (q === '' || UUID_RE.test(q)) return true
      const ws = op.workspaceUuid ?? ''
      return ws.toLowerCase().includes(q) || wsLabel(ws).toLowerCase().includes(q)
    })

  // Error report: group error operations by operation + status + provider error code.
  // Built from the unfiltered page — the log filters below apply to the log table only.
  $: errorGroups = Array.from(
    operations
      .filter((op) => isErrStatus(op.status))
      .reduce((m, op) => {
        const raw = rawOf(op)
        const code = raw.errorCode ?? raw.ErrorCode ?? ''
        const key = `${op.operation}|${op.status}|${code}`
        const e = m.get(key) ?? {
          operation: op.operation,
          status: op.status ?? '',
          code,
          message: raw.message ?? raw.Message ?? '',
          count: 0,
          lastAt: 0,
          maxAttempt: 0
        }
        e.count++
        e.lastAt = Math.max(e.lastAt, Number(op.createdOn ?? 0))
        e.maxAttempt = Math.max(e.maxAttempt, Number(raw.attempt ?? 0))
        m.set(key, e)
        return m
      }, new Map<string, any>())
      .values()
  ).sort((a, b) => b.count - a.count)

  // Cancellations & refunds within the loaded page.
  $: cancelOps = operations.filter(
    (op) => op.operation === 'cancel' || op.operation === 'refund' || op.status === 'REFUNDED'
  )

  // Revenue per workspace from the aggregate stats, richest first.
  $: revenueRows = (stats?.workspaces ?? []).slice().sort((a, b) => b.amount - a.amount)

  // Failed auto-charges: past_due/readonly subscriptions with payer contact, most attempts first.
  $: failedRenewals = subscriptions
    .filter((s) => s.status === 'past_due' || s.status === 'readonly')
    .sort((a, b) => Number(b.providerData?.retryAttempt ?? 0) - Number(a.providerData?.retryAttempt ?? 0))

  // Paid seats: total purchased seats across paid granting tier subscriptions.
  $: paidSeats = subscriptions
    .filter((s) => s.type === 'tier' && (s.status === 'active' || s.status === 'trialing') && isPaid(s))
    .reduce((sum, s) => sum + Number(s.providerData?.quantity ?? s.limits?.usersLimit ?? 0), 0)

  // Monthly income chart: last 12 months from the ledger, oldest first.
  $: incomeMonths = (() => {
    const byMonth = new Map(monthly.map((m) => [m.month, m]))
    const res: Array<{ month: string, amount: number, charges: number }> = []
    const now = new Date()
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      const month = d.toISOString().slice(0, 7)
      const fact = byMonth.get(month)
      res.push({ month, amount: fact?.amount ?? 0, charges: fact?.charges ?? 0 })
    }
    return res
  })()
  const CW = 640
  const CH = 100
  const cPadL = 46
  const cTop = 6
  const cBottom = 78
  $: cSlotW = (CW - cPadL - 4) / Math.max(1, incomeMonths.length)
  $: cMax = Math.max(1, ...incomeMonths.map((p) => p.amount))

  // A ledger row that represents real charged money: tbank confirms via the webhook row (init stays NEW).
  function isCharged (op: PaymentOperation): boolean {
    return (
      (op.operation === 'webhook' && op.status === 'CONFIRMED') ||
      (op.operation === 'charge_recurrent' && op.status === 'success') ||
      (op.operation === 'init_charge' && op.status === 'CONFIRMED')
    )
  }

  // Operation log grouped into payment chains (orderId ties init -> webhook -> cancel of one charge;
  // a renewal cycle shares 'renew:<sub>:<period>' across its retries) or by workspace.
  // Groups: newest first. Rows inside a group: chronological.
  // One user/system intent (purchase, plan change, renewal cycle). Falls back to the payment chain
  // for rows written before actionId existed.
  function chainKey (op: PaymentOperation): string {
    // No subscriptionId fallback: two unrelated actions on the same subscription (activate now,
    // drop an hour later) would otherwise collapse into one bogus group.
    return op.actionId ?? op.orderId ?? op.paymentId ?? `row:${op.id ?? op.createdOn ?? '-'}`
  }
  const ACTORS: Record<string, string> = {
    user: 'Пользователь',
    system: 'Система',
    provider: 'Банк',
    admin: 'Администратор'
  }
  function actorOf (op: PaymentOperation): string {
    return op.actor != null ? (ACTORS[op.actor] ?? op.actor) : '-'
  }
  $: subById = new Map(subscriptions.map((s) => [s.id, s]))
  $: groupedOps = Array.from(
    shownOps
      .reduce((m, op) => {
        const key = groupMode === 'payment' ? chainKey(op) : (op.workspaceUuid ?? '-')
        const g = m.get(key) ?? { key, ops: [] as PaymentOperation[], total: 0 }
        g.ops.push(op)
        if (isCharged(op)) {
          g.total += Number(op.amount ?? 0)
        }
        m.set(key, g)
        return m
      }, new Map<string, { key: string, ops: PaymentOperation[], total: number }>())
      .values()
  )
    .map((g) => {
      const ops = g.ops.slice().sort((a, b) => Number(a.createdOn ?? 0) - Number(b.createdOn ?? 0))
      const withPlan = ops.find((o) => planOf(o) !== '-')
      const paid = ops.find((o) => isCharged(o))
      const attempts = ops.filter((o) => o.operation === 'charge_recurrent' || o.operation === 'init_charge').length
      // Where the subscription this chain paid for stands NOW — a chain can end with a charge and
      // still be superseded minutes later, so the last event alone is misleading.
      const subId = ops.find((o) => o.subscriptionId != null)?.subscriptionId
      const sub = subId != null ? subById.get(subId) : undefined
      return {
        ...g,
        ops,
        plan: withPlan !== undefined ? planOf(withPlan) : '-',
        // Outcome of the whole chain, so the group header alone tells the story.
        outcome: eventLabel(ops[ops.length - 1]),
        charged: paid !== undefined,
        attempts,
        subStatus: sub?.status,
        isCurrent: sub != null && (sub.status === 'active' || sub.status === 'trialing'),
        // Who took part — a renewal the user finished manually shows both system and user.
        actors: Array.from(new Set(ops.map((o) => o.actor).filter((a) => a != null))).map((a) => ACTORS[a] ?? a),
        // Header shows when the action FINISHED — same key the list is sorted by, so the eye can
        // scan straight down the timestamps.
        at: Number(ops[ops.length - 1]?.createdOn ?? 0),
        startedAt: Number(ops[0]?.createdOn ?? 0)
      }
    })
    .sort((a, b) => b.at - a.at)
</script>

<div class="flex-col flex-gap-4">
  <!-- Period + filters -->
  <div class="flex-row-center flex-gap-2 flex-wrap">
    <Button
      label={adminRes.string.Period7d}
      kind={periodDays === 7 ? 'primary' : 'regular'}
      on:click={() => (periodDays = 7)}
    />
    <Button
      label={adminRes.string.Period30d}
      kind={periodDays === 30 ? 'primary' : 'regular'}
      on:click={() => (periodDays = 30)}
    />
    <Button
      label={adminRes.string.Period90d}
      kind={periodDays === 90 ? 'primary' : 'regular'}
      on:click={() => (periodDays = 90)}
    />
    <Button
      label={adminRes.string.Period365d}
      kind={periodDays === 365 ? 'primary' : 'regular'}
      on:click={() => (periodDays = 365)}
    />
  </div>

  {#if loading}
    <Loading />
  {:else}
    <!-- Summary metrics -->
    {#if stats !== null}
      <div class="flex-row-center summary">
        <div>
          <div class="metric">{stats.totalCharges}</div>
          <Label label={adminRes.string.TotalCharges} />
        </div>
        <div>
          <div class="metric">{fmtAmount(stats.totalAmount)}</div>
          <Label label={adminRes.string.TotalAmount} />
        </div>
        <div>
          <div class="metric" class:err={stats.totalErrors > 0}>{stats.totalErrors}</div>
          <Label label={adminRes.string.TotalErrors} />
        </div>
        <div>
          <div class="metric">{cancelOps.length}</div>
          <Label label={adminRes.string.CancelsAndRefunds} />
        </div>
        <div>
          <div class="metric">{paidSeats}</div>
          <Label label={adminRes.string.PaidSeats} />
        </div>
      </div>
    {/if}

    <!-- Monthly income chart (last 12 months, from the ledger) -->
    <div class="section-title"><Label label={adminRes.string.MonthlyFinance} /></div>
    <svg viewBox={`0 0 ${CW} ${CH}`} width="100%" preserveAspectRatio="xMidYMid meet">
      <line x1={cPadL} y1={cBottom} x2={CW - 4} y2={cBottom} stroke="var(--theme-divider-color)" />
      <text x={cPadL - 4} y={cTop + 8} text-anchor="end" class="chart-text">{fmtAmount(cMax)}</text>
      <text x={cPadL - 4} y={cBottom} text-anchor="end" class="chart-text">0</text>
      {#each incomeMonths as p, i}
        {@const x = cPadL + i * cSlotW}
        {@const h = (p.amount / cMax) * (cBottom - cTop)}
        <rect
          x={x + cSlotW * 0.15}
          y={cBottom - h}
          width={cSlotW * 0.7}
          height={Math.max(h, p.amount > 0 ? 1 : 0)}
          class="chart-bar"
        >
          <title>{p.month}: {fmtAmount(p.amount)} ({p.charges})</title>
        </rect>
        <text x={x + cSlotW / 2} y={cBottom + 12} text-anchor="middle" class="chart-text">{p.month.slice(2)}</text>
      {/each}
    </svg>

    <!-- Failed auto-charges: workspaces to contact -->
    {#if failedRenewals.length > 0}
      <div class="section-title err"><Label label={adminRes.string.FailedRenewals} /></div>
      <table class="ptable">
        <thead>
          <tr>
            <th><Label label={adminRes.string.Workspace} /></th>
            <th><Label label={adminRes.string.Plan} /></th>
            <th><Label label={adminRes.string.Status} /></th>
            <th><Label label={adminRes.string.Amount} /></th>
            <th><Label label={adminRes.string.Attempt} /></th>
            <th><Label label={adminRes.string.RenewalDate} /></th>
            <th><Label label={adminRes.string.Payer} /></th>
          </tr>
        </thead>
        <tbody>
          {#each failedRenewals as s}
            <tr>
              <td>{wsLabel(s.workspaceUuid)}</td>
              <td>{s.plan}</td>
              <td class="err">{s.status}</td>
              <td>{fmtAmount(s.amount)}</td>
              <td>{Number(s.providerData?.retryAttempt ?? 0)}</td>
              <td>{fmtDate(s.periodEnd)}</td>
              <td>{s.payerEmail ?? '-'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <!-- Error report -->
    {#if errorGroups.length > 0}
      <div class="section-title err"><Label label={adminRes.string.TotalErrors} /></div>
      <table class="ptable">
        <thead>
          <tr>
            <th><Label label={adminRes.string.Operation} /></th>
            <th><Label label={adminRes.string.Status} /></th>
            <th>error</th>
            <th>count</th>
            <th><Label label={adminRes.string.Attempt} /></th>
            <th><Label label={adminRes.string.Date} /></th>
          </tr>
        </thead>
        <tbody>
          {#each errorGroups as g}
            <tr>
              <td>{g.operation}</td>
              <td class="err">{g.status}</td>
              <td>{g.code !== '' ? `${g.code} ` : ''}{g.message}</td>
              <td>{g.count}</td>
              <td>{g.maxAttempt > 0 ? g.maxAttempt : '-'}</td>
              <td>{fmtDate(g.lastAt)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <!-- Cancellations & refunds -->
    {#if cancelOps.length > 0}
      <div class="section-title"><Label label={adminRes.string.CancelsAndRefunds} /></div>
      <table class="ptable">
        <thead>
          <tr>
            <th><Label label={adminRes.string.Date} /></th>
            <th><Label label={adminRes.string.Event} /></th>
            <th><Label label={adminRes.string.Plan} /></th>
            <th><Label label={adminRes.string.Amount} /></th>
            <th><Label label={adminRes.string.Workspace} /></th>
          </tr>
        </thead>
        <tbody>
          {#each cancelOps as op}
            <tr>
              <td>{fmtDate(op.createdOn)}</td>
              <td>{eventLabel(op)}</td>
              <td>{planOf(op)}</td>
              <td>{fmtAmount(op.amount)}</td>
              <td>{wsLabel(op.workspaceUuid)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <!-- Revenue by workspace -->
    {#if revenueRows.length > 0}
      <div class="section-title"><Label label={adminRes.string.RevenueByWorkspace} /></div>
      <table class="ptable">
        <thead>
          <tr>
            <th><Label label={adminRes.string.Workspace} /></th>
            <th><Label label={adminRes.string.TotalCharges} /></th>
            <th><Label label={adminRes.string.TotalAmount} /></th>
            <th><Label label={adminRes.string.TotalErrors} /></th>
          </tr>
        </thead>
        <tbody>
          {#each revenueRows as r}
            <tr>
              <td>{wsLabel(r.workspaceUuid)}</td>
              <td>{r.charges}</td>
              <td>{fmtAmount(r.amount)}</td>
              <td class:err={r.errors > 0}>{r.errors}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <!-- Upcoming renewals -->
    <div class="section-title"><Label label={adminRes.string.UpcomingRenewals} /></div>
    <table class="ptable">
      <thead>
        <tr>
          <th><Label label={adminRes.string.Workspace} /></th>
          <th><Label label={adminRes.string.Plan} /></th>
          <th><Label label={adminRes.string.Amount} /></th>
          <th><Label label={adminRes.string.RenewalDate} /></th>
          <th><Label label={adminRes.string.Payer} /></th>
        </tr>
      </thead>
      <tbody>
        {#each subscriptions
          .filter((s) => s.status === 'active' && s.periodEnd != null && (s.periodEnd ?? 0) > Date.now())
          .sort((a, b) => (a.periodEnd ?? 0) - (b.periodEnd ?? 0)) as s}
          <tr>
            <td>{wsLabel(s.workspaceUuid)}</td>
            <td>{s.plan}</td>
            <td>{fmtAmount(s.amount)}</td>
            <td>{fmtDate(s.periodEnd)}</td>
            <td>{s.payerEmail ?? '-'}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <!-- Per-workspace subscriptions with filters/sort -->
    <div class="flex-row-center flex-gap-4">
      <div class="section-title"><Label label={adminRes.string.Workspace} /></div>
      <label class="flex-row-center flex-gap-1">
        <CheckBox bind:checked={onlyPaid} /><Label label={adminRes.string.OnlyPaid} />
      </label>
      <label class="flex-row-center flex-gap-1">
        <CheckBox bind:checked={onlyFree} /><Label label={adminRes.string.OnlyFree} />
      </label>
      <label class="flex-row-center flex-gap-1">
        <CheckBox bind:checked={onlyTrial} /><Label label={adminRes.string.OnlyTrial} />
      </label>
      <label class="flex-row-center flex-gap-1">
        <CheckBox bind:checked={sortByAmount} /><Label label={adminRes.string.SortByAmount} />
      </label>
    </div>
    <table class="ptable">
      <thead>
        <tr>
          <th><Label label={adminRes.string.Workspace} /></th>
          <th><Label label={adminRes.string.Plan} /></th>
          <th><Label label={adminRes.string.Seats} /></th>
          <th><Label label={adminRes.string.Status} /></th>
          <th><Label label={adminRes.string.Amount} /></th>
          <th><Label label={adminRes.string.Payer} /></th>
        </tr>
      </thead>
      <tbody>
        {#each subscriptions
          .filter((s) => s.type === 'tier' && s.status !== 'canceled')
          .filter((s) => (!onlyPaid || isPaid(s)) && (!onlyFree || !isPaid(s)) && (!onlyTrial || s.status === 'trialing'))
          .sort((a, b) => (sortByAmount ? Number(b.amount ?? 0) - Number(a.amount ?? 0) : 0)) as s}
          <tr>
            <td>{wsLabel(s.workspaceUuid)}</td>
            <td>{s.plan}</td>
            <td>{seatsOf(s)}</td>
            <td>{s.status}</td>
            <td>{fmtAmount(s.amount)}</td>
            <td>{s.payerEmail ?? '-'}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <!-- Operation log: latest PAGE ops, filters apply to this table only -->
    <div class="flex-row-center flex-gap-4 flex-wrap">
      <div class="section-title"><Label label={adminRes.string.PaymentOperations} /></div>
      <select class="status-select" bind:value={selectedDay}>
        {#each dayOptions as d}
          <option value={d.day}>{d.day} ({d.count})</option>
        {/each}
      </select>
      <Button
        label={adminRes.string.AllOperations}
        kind={opFilter === '' ? 'primary' : 'regular'}
        size="small"
        on:click={() => (opFilter = '')}
      />
      {#each OPS as op}
        <Button
          kind={opFilter === op ? 'primary' : 'regular'}
          size="small"
          on:click={() => (opFilter = opFilter === op ? '' : op)}
        >
          <svelte:fragment slot="content">{op}</svelte:fragment>
        </Button>
      {/each}
      <select class="status-select" bind:value={statusFilter}>
        <option value="">--</option>
        {#each STATUSES as st}
          <option value={st}>{st}</option>
        {/each}
      </select>
      <label class="flex-row-center flex-gap-1">
        <CheckBox bind:checked={onlyErrors} /><Label label={adminRes.string.OnlyErrors} />
      </label>
      <Button
        label={adminRes.string.GroupByPayment}
        kind={groupMode === 'payment' ? 'primary' : 'regular'}
        size="small"
        on:click={() => (groupMode = groupMode === 'payment' ? 'none' : 'payment')}
      />
      <Button
        label={adminRes.string.GroupByWorkspace}
        kind={groupMode === 'workspace' ? 'primary' : 'regular'}
        size="small"
        on:click={() => (groupMode = groupMode === 'workspace' ? 'none' : 'workspace')}
      />
      <SearchEdit bind:value={search} width={'14rem'} />
    </div>
    {#if shownOps.length === 0}
      <div class="dark-color"><Label label={adminRes.string.NoOperations} /></div>
    {:else}
      <table class="ptable">
        <thead>
          <tr>
            <th><Label label={adminRes.string.Date} /></th>
            <th><Label label={adminRes.string.Event} /></th>
            <th><Label label={adminRes.string.Actor} /></th>
            <th><Label label={adminRes.string.Plan} /></th>
            <th><Label label={adminRes.string.Amount} /></th>
            <th><Label label={adminRes.string.Attempt} /></th>
            <th><Label label={adminRes.string.Provider} /></th>
            <th><Label label={adminRes.string.Workspace} /></th>
            <th>payment_id</th>
          </tr>
        </thead>
        <tbody>
          {#if groupMode !== 'none'}
            {#each groupedOps as g}
              <tr class="group-row" class:current={g.isCurrent}>
                <td colspan="3">
                  {#if groupMode === 'payment'}
                    {fmtTime(g.at)}{g.at - g.startedAt >= 1000 ? ` (+${Math.round((g.at - g.startedAt) / 1000)}с)` : ''}
                    · {wsLabel(g.ops[0]?.workspaceUuid)} · {g.plan}
                    {#if g.isCurrent}
                      <span class="badge current-badge"><Label label={adminRes.string.CurrentPlan} /></span>
                    {:else if g.subStatus != null}
                      <span class="badge">{g.subStatus}</span>
                    {/if}
                  {:else}
                    {wsLabel(g.key === '-' ? undefined : g.key)}
                  {/if}
                </td>
                <td>{g.charged ? fmtAmount(g.total) : '-'}</td>
                <td colspan="5" class:err={!g.charged && groupMode === 'payment'}>
                  {#if groupMode === 'payment'}
                    {g.outcome}{g.attempts > 1 ? ` · попыток: ${g.attempts}` : ''}{g.actors.length > 0
                      ? ` · ${g.actors.join(', ')}`
                      : ''}
                  {/if}
                </td>
              </tr>
              {#each g.ops as op}
                <tr>
                  <td>{fmtDate(op.createdOn)}</td>
                  <td class:err={isErrStatus(op.status)}>{eventLabel(op)}</td>
                  <td>{actorOf(op)}</td>
                  <td>{planOf(op)}</td>
                  <td>{fmtAmount(op.amount)}</td>
                  <td>{attemptOf(op)}</td>
                  <td>{op.provider}</td>
                  <td>{wsLabel(op.workspaceUuid)}</td>
                  <td class="mono">{op.paymentId ?? '-'}</td>
                </tr>
              {/each}
            {/each}
          {:else}
            {#each shownOps as op}
              <tr>
                <td>{fmtDate(op.createdOn)}</td>
                <td class:err={isErrStatus(op.status)}>{eventLabel(op)}</td>
                <td>{actorOf(op)}</td>
                <td>{planOf(op)}</td>
                <td>{fmtAmount(op.amount)}</td>
                <td>{attemptOf(op)}</td>
                <td>{op.provider}</td>
                <td>{wsLabel(op.workspaceUuid)}</td>
                <td class="mono">{op.paymentId ?? '-'}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
      {#if hasMore}
        <Button
          label={adminRes.string.MoreItems}
          kind="regular"
          on:click={() => {
            void loadMore()
          }}
        />
      {/if}
    {/if}
  {/if}
</div>

<style lang="scss">
  .summary {
    padding: var(--spacing-2) 0;
    > div {
      min-width: 8rem;
      padding: 0 1.5rem;
      border-left: 1px solid var(--theme-divider-color);
      &:first-child {
        border-left: none;
        padding-left: 0;
      }
    }
    .metric {
      font-size: 1.5rem;
      font-weight: 600;
    }
    .err {
      color: var(--theme-error-color);
    }
  }
  .section-title {
    font-weight: 600;
    margin-top: var(--spacing-2);
    &.err {
      color: var(--theme-error-color);
    }
  }
  .ptable {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
    th,
    td {
      text-align: left;
      padding: 4px 8px;
      border-bottom: 1px solid var(--theme-divider-color);
    }
    th {
      color: var(--theme-dark-color);
      font-weight: 500;
    }
    .mono {
      font-family: monospace;
      font-size: 0.75rem;
    }
    .err {
      color: var(--theme-error-color);
    }
    .group-row td {
      font-weight: 600;
      background: var(--theme-comp-header-color);
    }
    .group-row.current td {
      background: var(--theme-navpanel-selected);
      border-left: 2px solid var(--positive-button-default);
    }
    .badge {
      margin-left: 0.5rem;
      padding: 1px 6px;
      border-radius: 0.25rem;
      font-size: 0.6875rem;
      font-weight: 500;
      background: var(--theme-button-hovered);
      color: var(--theme-dark-color);
    }
    .current-badge {
      background: var(--positive-button-default);
      color: var(--primary-button-color);
    }
  }
  .chart-text {
    font-size: 9px;
    fill: var(--theme-dark-color);
  }
  .chart-bar {
    fill: var(--primary-button-default);
  }
  .status-select {
    padding: 2px 6px;
    border: 1px solid var(--theme-divider-color);
    border-radius: var(--extra-small-BorderRadius);
    background: var(--theme-bg-color);
    color: var(--theme-content-color);
    font-size: 0.8125rem;
  }
</style>

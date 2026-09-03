/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

import { loadServerConfig, type ServerConfig } from '@hcengineering/api-client'
import { generateUuid, systemAccountUuid, type WorkspaceUuid } from '@hcengineering/core'
import { getClient as getAccountClient, type AccountClient, type PaymentOperation } from '@hcengineering/account-client'
import { generateToken } from '@hcengineering/server-token'
import { adminSessionClient } from './admin.fixtures'

/** Admin RPCs demand a second factor stamped within ADMIN_SESSION_TTL_SEC. */
const adminMfaAt = (): string => String(Math.floor(Date.now() / 1000))

// Drives the payment ledger against the real account-service DB. Only the payment-service token may
// append rows (logPaymentOperation); admin reads the audit (getPaymentOperations/Stats/MonthlyStats).
describe('plan-ledger', () => {
  const wsName = 'api-tests-unpaid'
  let config: ServerConfig
  let workspaceUuid: WorkspaceUuid
  let payment: AccountClient // service:payment — the only writer
  let admin: AccountClient // admin — reads the audit

  beforeAll(async () => {
    config = await loadServerConfig('http://localhost:8083')
    const listAdmin = getAccountClient(
      config.ACCOUNTS_URL,
      generateToken(systemAccountUuid, undefined, { admin: 'true', mfaAt: adminMfaAt() }, 'secret')
    )
    const ws = (await listAdmin.listWorkspaces()).find((w) => w.url === wsName)
    if (ws == null) throw new Error(`Workspace not found: ${wsName}`)
    workspaceUuid = ws.uuid
    payment = getAccountClient(
      config.ACCOUNTS_URL,
      generateToken(systemAccountUuid, workspaceUuid, { service: 'payment' }, 'secret')
    )
    admin = await adminSessionClient(config)
  }, 30000)

  async function log (op: Omit<PaymentOperation, 'provider' | 'workspaceUuid'>): Promise<void> {
    const row: PaymentOperation = { provider: 'tbank', workspaceUuid, ...op }
    await payment.logPaymentOperation(row)
  }

  it('rejects a ledger write from a non-payment token', async () => {
    // A workspace-scoped user token (no service:payment, no admin) must not append audit rows.
    const user = getAccountClient(config.ACCOUNTS_URL, generateToken(systemAccountUuid, workspaceUuid, {}, 'secret'))
    const row: PaymentOperation = { provider: 'tbank', operation: 'init_charge', workspaceUuid }
    await expect(user.logPaymentOperation(row)).rejects.toThrow()
  })

  it('rejects a monthly-stats read from a non-admin token', async () => {
    // getPaymentMonthlyStats is admin-only (finance overview), unlike getPaymentOperations.
    await expect(payment.getPaymentMonthlyStats(0, Date.now())).rejects.toThrow()
  })

  it('writes an operation and reads it back with filters', async () => {
    const paymentId = generateUuid()
    const actionId = `act-${generateUuid()}`
    await log({ operation: 'init_charge', status: 'NEW', paymentId, actionId, actor: 'user', amount: 149700 })

    const from = Date.now() - 60_000
    const to = Date.now() + 60_000
    const rows = await admin.getPaymentOperations({ workspaceUuid, from, to, limit: 200 })
    const mine = rows.find((r) => r.paymentId === paymentId)
    expect(mine).toBeDefined()
    expect(mine?.operation).toBe('init_charge')
    expect(mine?.status).toBe('NEW')
    expect(mine?.actionId).toBe(actionId)
    expect(mine?.actor).toBe('user')
    expect(Number(mine?.amount)).toBe(149700)

    // Filter by operation narrows the result to just this kind.
    const initOnly = await admin.getPaymentOperations({ workspaceUuid, from, to, operation: 'init_charge', limit: 200 })
    expect(initOnly.every((r) => r.operation === 'init_charge')).toBe(true)
    expect(initOnly.some((r) => r.paymentId === paymentId)).toBe(true)
  })

  it('groups a full plan-change action under one actionId (charge + webhook + supersede cancel)', async () => {
    const actionId = `act-${generateUuid()}`
    const paymentId = generateUuid()
    const oldSubId = generateUuid()
    // The three rows one intent produces: bill the new plan, bank confirms it, drop the old plan.
    await log({ operation: 'init_charge', status: 'NEW', paymentId, actionId, actor: 'user', amount: 49900 })
    await log({ operation: 'webhook', status: 'CONFIRMED', paymentId, actionId, actor: 'provider', amount: 49900 })
    await log({ operation: 'cancel', status: 'PLAN_CHANGE', subscriptionId: oldSubId, actionId, actor: 'provider' })

    const from = Date.now() - 60_000
    const to = Date.now() + 60_000
    const rows = await admin.getPaymentOperations({ workspaceUuid, from, to, limit: 500 })
    const group = rows.filter((r) => r.actionId === actionId)
    expect(group).toHaveLength(3)
    const kinds = group.map((r) => r.operation).sort()
    expect(kinds).toEqual(['cancel', 'init_charge', 'webhook'])
    // Both a user and the bank took part in this single action.
    expect(new Set(group.map((r) => r.actor))).toEqual(new Set(['user', 'provider']))
  })

  // Per-workspace charge/amount/error counters over a window (0 if the workspace has none).
  async function wsStats (from: number, to: number): Promise<{ charges: number, amount: number, errors: number }> {
    const stats = await admin.getPaymentOperationStats(from, to)
    return stats.workspaces.find((w) => w.workspaceUuid === workspaceUuid) ?? { charges: 0, amount: 0, errors: 0 }
  }

  it('counts a confirmed charge once despite a duplicate webhook; the NEW init is not money', async () => {
    const from = Date.now() - 1_000
    const before = await wsStats(from, Date.now())
    const paymentId = generateUuid()
    const actionId = `act-${generateUuid()}`
    // init stays NEW (not money), webhook CONFIRMED is the real charge, delivered twice (at-least-once).
    await log({ operation: 'init_charge', status: 'NEW', paymentId, actionId, actor: 'user', amount: 99900 })
    await log({ operation: 'webhook', status: 'CONFIRMED', paymentId, actionId, actor: 'provider', amount: 99900 })
    await log({ operation: 'webhook', status: 'CONFIRMED', paymentId, actionId, actor: 'provider', amount: 99900 })

    const after = await wsStats(from, Date.now() + 1_000)
    // Exactly one 99900 charge added, despite the duplicate webhook and the NEW init row.
    expect(after.charges - before.charges).toBe(1)
    expect(after.amount - before.amount).toBe(99900)
  })

  it('reports a rejected charge as an error, not a charge', async () => {
    const from = Date.now() - 1_000
    const before = await wsStats(from, Date.now())
    await log({ operation: 'webhook', status: 'REJECTED', paymentId: generateUuid(), actor: 'provider', amount: 44900 })

    const after = await wsStats(from, Date.now() + 1_000)
    expect(after.errors - before.errors).toBe(1)
    expect(after.charges - before.charges).toBe(0)
  })
})

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
import { generateUuid, systemAccountUuid, type AccountUuid, type WorkspaceUuid } from '@hcengineering/core'
import {
  getClient as getAccountClient,
  grantsPlan,
  SubscriptionStatus,
  SubscriptionType,
  type AccountClient,
  type Subscription
} from '@hcengineering/account-client'
import { generateToken } from '@hcengineering/server-token'
import { adminSessionClient, DEV_OTP } from './admin.fixtures'

/** Admin RPCs demand a second factor stamped within ADMIN_SESSION_TTL_SEC. */
const adminMfaAt = (): string => String(Math.floor(Date.now() / 1000))

// Uses api-tests-unpaid (created without a plan). Drives the account subscription store directly
// via a payment-service token to assert the provider-agnostic trial invariant: activating a paid
// Business tier supersedes an active trial, and a Trialing tier is visible/plan-granting on read.
describe('plan-trial', () => {
  const wsName = 'api-tests-unpaid'
  let config: ServerConfig
  let workspaceUuid: WorkspaceUuid
  let accountUuid: AccountUuid // subscription FK requires an existing account
  let account: AccountClient // payment-service scoped: allowed to upsert subscriptions
  let admin: AccountClient // admin scoped: adminCreateSubscription

  beforeAll(async () => {
    config = await loadServerConfig('http://localhost:8083')
    const listAdmin = getAccountClient(
      config.ACCOUNTS_URL,
      generateToken(systemAccountUuid, undefined, { admin: 'true', mfaAt: adminMfaAt() }, 'secret')
    )
    const ws = (await listAdmin.listWorkspaces()).find((w) => w.url === wsName)
    if (ws == null) throw new Error(`Workspace not found: ${wsName}`)
    workspaceUuid = ws.uuid
    const paymentToken = generateToken(systemAccountUuid, workspaceUuid, { service: 'payment' }, 'secret')
    account = getAccountClient(config.ACCOUNTS_URL, paymentToken)
    admin = await adminSessionClient(config)
    const members = await account.getWorkspaceMembers()
    const owner = members.find((m) => m.role === 'OWNER') ?? members[0]
    if (owner === undefined) throw new Error(`No members in workspace: ${wsName}`)
    accountUuid = owner.person
  }, 30000)

  async function clearSubscriptions (): Promise<void> {
    for (const s of await account.getSubscriptions(workspaceUuid, false)) {
      if (s.status !== SubscriptionStatus.Canceled) {
        await account.upsertSubscription({ ...s, status: SubscriptionStatus.Canceled, canceledAt: Date.now() })
      }
    }
  }

  function tierId (): { id: string, providerSubscriptionId: string } {
    const id = generateUuid()
    return { id, providerSubscriptionId: id }
  }

  async function activeTiers (): Promise<Subscription[]> {
    const all = await account.getSubscriptions(workspaceUuid, false)
    return all.filter(
      (s) =>
        s.type === SubscriptionType.Tier &&
        (s.status === SubscriptionStatus.Active || s.status === SubscriptionStatus.Trialing)
    )
  }

  // Clear before AND after: a prior failed run can leave an active tier that pollutes the first read.
  beforeEach(clearSubscriptions)
  afterEach(clearSubscriptions)

  it('a trialing business tier is returned by the default (active-only) read', async () => {
    const { id, providerSubscriptionId } = tierId()
    await account.upsertSubscription({
      id,
      workspaceUuid,
      accountUuid,
      provider: 'trial',
      providerSubscriptionId,
      type: SubscriptionType.Tier,
      status: SubscriptionStatus.Trialing,
      plan: 'business',
      trialEnd: Date.now() + 14 * 24 * 3600 * 1000,
      limits: { usersLimit: 10, storageLimitGB: 50, trafficLimitGB: 0, tokenLimit: 0, meetingMinutesLimit: 0 }
    } as any)

    const active = await account.getSubscriptions(workspaceUuid) // activeOnly=true default
    const trial = active.find((s) => s.type === SubscriptionType.Tier)
    expect(trial).toBeDefined()
    expect(trial?.status).toBe(SubscriptionStatus.Trialing)
    expect(trial?.plan).toBe('business')
    expect(trial?.limits?.usersLimit).toBe(10)
    expect(grantsPlan(trial)).toBe(true) // a live trial grants the business plan
  }, 30000)

  it('an expired trial no longer grants its plan (lazy fallback to free)', async () => {
    const { id, providerSubscriptionId } = tierId()
    await account.upsertSubscription({
      id,
      workspaceUuid,
      accountUuid,
      provider: 'trial',
      providerSubscriptionId,
      type: SubscriptionType.Tier,
      status: SubscriptionStatus.Trialing,
      plan: 'business',
      trialEnd: Date.now() - 24 * 3600 * 1000, // already past
      limits: { usersLimit: 10, storageLimitGB: 50, trafficLimitGB: 0, tokenLimit: 0, meetingMinutesLimit: 0 }
    } as any)

    const all = await account.getSubscriptions(workspaceUuid, false)
    const trial = all.find((s) => s.type === SubscriptionType.Tier && s.provider === 'trial')
    expect(trial).toBeDefined()
    // No sweep/timer: expiry is enforced on read via grantsPlan, so limit resolution falls back to free.
    expect(grantsPlan(trial)).toBe(false)
  }, 30000)

  it('buying Business (active) supersedes the running trial', async () => {
    const trial = tierId()
    await account.upsertSubscription({
      id: trial.id,
      workspaceUuid,
      accountUuid,
      provider: 'trial',
      providerSubscriptionId: trial.providerSubscriptionId,
      type: SubscriptionType.Tier,
      status: SubscriptionStatus.Trialing,
      plan: 'business',
      trialEnd: Date.now() + 14 * 24 * 3600 * 1000
    } as any)

    // Simulate a completed purchase (any provider): an active Business tier is written.
    const paid = tierId()
    await account.upsertSubscription({
      id: paid.id,
      workspaceUuid,
      accountUuid,
      provider: 'tbank',
      providerSubscriptionId: paid.providerSubscriptionId,
      type: SubscriptionType.Tier,
      status: SubscriptionStatus.Active,
      plan: 'business',
      limits: { usersLimit: 3, storageLimitGB: 15, trafficLimitGB: 0, tokenLimit: 0, meetingMinutesLimit: 0 }
    } as any)

    const tiers = await activeTiers()
    expect(tiers).toHaveLength(1)
    expect(tiers[0].status).toBe(SubscriptionStatus.Active)
    expect(tiers[0].provider).toBe('tbank')
    expect(tiers[0].limits?.usersLimit).toBe(3)
  }, 30000)

  it('admin can create a trial (status=trialing, trialEnd) that grants the plan', async () => {
    await admin.adminCreateSubscription({
      otpCode: DEV_OTP,
      workspaceUuid,
      plan: 'business',
      type: 'tier',
      status: 'trialing',
      trialEnd: Date.now() + 14 * 24 * 3600 * 1000,
      limits: { usersLimit: 10, storageLimitGB: 50, trafficLimitGB: 0, tokenLimit: 0, meetingMinutesLimit: 0 }
    })

    const tier = (await account.getSubscriptions(workspaceUuid, false)).find(
      (s) => s.type === SubscriptionType.Tier && s.status === SubscriptionStatus.Trialing
    )
    expect(tier).toBeDefined()
    expect(tier?.plan).toBe('business')
    expect(tier?.trialEnd).toBeGreaterThan(Date.now())
    expect(grantsPlan(tier)).toBe(true)
  }, 30000)
})

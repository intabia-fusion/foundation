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

import {
  createRestClient,
  createRestTxOperations,
  getWorkspaceToken,
  loadServerConfig,
  type RestClient,
  type ServerConfig,
  type WorkspaceToken
} from '@hcengineering/api-client'
import core, {
  type AccountUuid,
  generateUuid,
  MeasureMetricsContext,
  pickPrimarySocialId,
  type Ref,
  type SocialId,
  type TxOperations
} from '@hcengineering/core'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import { ensureEmployee } from '@hcengineering/contact'
import drivePlugin, { type Drive } from '@hcengineering/drive'
import { adminSessionClient, DEV_OTP } from './admin.fixtures'

// Workspace api-tests-seats boots with business (10 seats) so user1(OWNER)/user2/user3 all onboard.
// The test then sets usersLimit=2: seats go by role priority (Owner first), then account uuid — the
// owner plus one user are seated, the other user is downgraded to read-only. Asserts seat enforcement
// (now sourced from account ws_members) reacts to a runtime plan change.
describe('plan-seats', () => {
  const testCtx = new MeasureMetricsContext('test', {})
  const wsName = 'api-tests-seats'
  let config: ServerConfig
  let owner: WorkspaceToken
  let seated: WorkspaceToken
  let seatless: WorkspaceToken
  let seatedOps: TxOperations
  let seatlessOps: TxOperations

  beforeAll(async () => {
    config = await loadServerConfig('http://localhost:8083')

    // Onboard all members (business has 10 seats at boot). Seat winners are decided later by role
    // priority then account uuid, not by onboarding order.
    owner = await login('user1')
    await ensureEmployeeFor(owner)
    seated = await login('user2')
    await ensureEmployeeFor(seated)
    seatless = await login('user3')
    await ensureEmployeeFor(seatless)

    seatedOps = await createRestTxOperations(seated.endpoint, seated.workspaceId, seated.token)
    seatlessOps = await createRestTxOperations(seatless.endpoint, seatless.workspaceId, seatless.token)
  }, 30000)

  async function setUsersLimit (usersLimit: number): Promise<void> {
    const adminClient = await adminSessionClient(config)
    await adminClient.adminCreateSubscription({
      otpCode: DEV_OTP,
      workspaceUuid: owner.workspaceId,
      plan: 'business',
      limits: {
        usersLimit,
        storageLimitGB: 0,
        trafficLimitGB: 0,
        tokenLimit: 0,
        meetingMinutesLimit: 0
      }
    })
  }

  async function login (email: string): Promise<WorkspaceToken> {
    return await getWorkspaceToken('http://localhost:8083', { email, password: '1234', workspace: wsName }, config)
  }

  async function ensureEmployeeFor (ws: WorkspaceToken): Promise<void> {
    const accountClient = getAccountClient(config.ACCOUNTS_URL, ws.token)
    const person = await accountClient.getPerson()
    const socialIds: SocialId[] = await accountClient.getSocialIds(true)
    await ensureEmployee(
      testCtx,
      {
        uuid: ws.info.account,
        role: ws.info.role,
        primarySocialId: pickPrimarySocialId(socialIds)._id,
        socialIds: socialIds.map((si) => si._id),
        fullSocialIds: socialIds
      },
      connect(ws),
      socialIds,
      async () => person
    )
  }

  function connect (ws: WorkspaceToken): RestClient {
    return createRestClient(ws.endpoint, ws.workspaceId, ws.token)
  }

  async function createDrive (ops: TxOperations, name: string): Promise<Ref<Drive>> {
    return await ops.createDoc(drivePlugin.class.Drive, core.space.Space, {
      name,
      description: '',
      private: false,
      archived: false,
      members: [],
      owners: [],
      autoJoin: false,
      restricted: false,
      type: drivePlugin.spaceType.DefaultDrive
    })
  }

  /** Poll until fn starts throwing (returns true) or deadline passes (returns false). */
  async function pollRejected (fn: () => Promise<unknown>, timeoutMs = 15000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        await fn()
        await new Promise((resolve) => setTimeout(resolve, 500))
      } catch {
        return true
      }
    }
    return false
  }

  it('usersLimit=2 seats the owner plus one user, the other user is read-only', async () => {
    // Seats go by role priority then account-uuid (createdOn no longer decides), so which of the two
    // plain users loses the seat depends on uuid order — assert "owner + exactly one user" instead.
    try {
      await setUsersLimit(2)

      // Poll until one of the two users is downgraded (limit propagates via the members/plan event).
      let blockedOps: TxOperations | undefined
      let seatedOps2: TxOperations | undefined
      const deadline = Date.now() + 20000
      while (Date.now() < deadline && blockedOps === undefined) {
        for (const [cand, other] of [
          [seatlessOps, seatedOps],
          [seatedOps, seatlessOps]
        ]) {
          const rejected = await pollRejected(
            async () => await createDrive(cand, `seats-probe-${generateUuid()}`),
            1500
          )
          if (rejected) {
            blockedOps = cand
            seatedOps2 = other
            break
          }
        }
        if (blockedOps === undefined) await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      expect(blockedOps).toBeDefined()

      // The other user keeps its seat and still writes.
      const ok = await createDrive(seatedOps2 as TxOperations, `seats-ok-${generateUuid()}`)
      expect(ok).toBeDefined()

      // Reads keep working for the seatless member.
      const spaces = await (blockedOps as TxOperations).findAll(core.class.Space, {})
      expect(spaces.length).toBeGreaterThan(0)
    } finally {
      await setUsersLimit(0)
    }
  }, 60000)

  it('seatless write is rejected fast and not retried', async () => {
    // A seatless member's write must fail with a 403 that the REST client does NOT retry —
    // otherwise it spams the transactor with 3x exponential backoff on every write.
    try {
      await setUsersLimit(1) // owner takes the only slot -> user3 seatless

      // Wait until the limit propagates and writes start failing.
      const blocked = await pollRejected(async () => await createDrive(seatlessOps, `noretry-wait-${generateUuid()}`))
      expect(blocked).toBe(true)

      // Measure a single rejection: a retried 403 would burn ~700ms of backoff sleeps.
      const start = Date.now()
      let rejected = false
      try {
        await createDrive(seatlessOps, `noretry-measure-${generateUuid()}`)
      } catch {
        rejected = true
      }
      const elapsed = Date.now() - start
      expect(rejected).toBe(true)
      expect(elapsed).toBeLessThan(600)
    } finally {
      await setUsersLimit(0)
    }
  }, 60000)

  // Join-time hard cap now lives in the account service (a join is not a transactor tx). The old
  // Employee-mixin block was removed in the seat-source-of-truth refactor: a member occupies a seat
  // only once in account ws_members, so joining past the limit is what account rejects.
  const joinerAccountUuid = async (): Promise<AccountUuid> => {
    const cli = getAccountClient(config.ACCOUNTS_URL)
    const info = await cli.login('user4', '1234')
    if (info == null) throw new Error('user4 login failed')
    return info.account
  }

  // Owner creates an invite; the joiner (an account token, not yet a member) redeems it.
  async function inviteAndJoin (): Promise<void> {
    const ownerAccount = getAccountClient(config.ACCOUNTS_URL, owner.token)
    const inviteId = await ownerAccount.createInvite(24 * 3600 * 1000, '*', 1, 'USER' as any)
    const cli = getAccountClient(config.ACCOUNTS_URL)
    const info = await cli.login('user4', '1234')
    if (info?.token == null) throw new Error('user4 login failed')
    await getAccountClient(config.ACCOUNTS_URL, info.token).joinByInvite(inviteId)
  }

  async function removeJoiner (): Promise<void> {
    const account = await joinerAccountUuid()
    // Removing someone else needs at least Maintainer in the workspace; the owner token qualifies.
    // A service/system token is NOT a workspace member, so leaveWorkspace rejects it with 403.
    const ownerClient = getAccountClient(config.ACCOUNTS_URL, owner.token)
    try {
      await ownerClient.leaveWorkspace(account)
    } catch {
      /* not a member — nothing to remove */
    }
  }

  it('joining past usersLimit is rejected by the account seat cap', async () => {
    // usersLimit=3 fills all seats with user1/2/3; user4 (not a member) must be rejected on join.
    try {
      await setUsersLimit(3)
      const blocked = await pollRejected(inviteAndJoin)
      expect(blocked).toBe(true)
    } finally {
      await setUsersLimit(0)
      await removeJoiner()
    }
  }, 60000)

  it('after lifting the limit the new member can join again', async () => {
    // Once usersLimit is raised past the member count the join-time cap no longer rejects.
    try {
      await setUsersLimit(3)
      const blocked = await pollRejected(inviteAndJoin)
      expect(blocked).toBe(true)

      await setUsersLimit(10)
      const deadline = Date.now() + 20000
      let ok = false
      while (Date.now() < deadline && !ok) {
        try {
          await inviteAndJoin()
          ok = true
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
      expect(ok).toBe(true)
    } finally {
      await setUsersLimit(0)
      await removeJoiner()
    }
  }, 60000)
})

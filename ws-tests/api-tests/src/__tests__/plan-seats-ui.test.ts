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
import { AccountRole, MeasureMetricsContext, pickPrimarySocialId, type SocialId } from '@hcengineering/core'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import contact, { type Employee, ensureEmployee } from '@hcengineering/contact'
import { adminSessionClient, DEV_OTP } from './admin.fixtures'

// Reproduces the SANITY "seat downgrade read-only" UI check at the API level: after a downgrade
// the UI's checkIsLimited must mark the over-limit member seatless. checkIsLimited reads
// usageInfo.membersCount + the active subscription limits + the employee seat order. This test
// replicates that exact computation against real server data to find why the UI banner is missing.
describe('plan-seats-ui', () => {
  const testCtx = new MeasureMetricsContext('test', {})
  const wsName = 'api-tests-seats-ui'
  let config: ServerConfig
  let owner: WorkspaceToken
  let seated: WorkspaceToken
  let seatless: WorkspaceToken

  beforeAll(async () => {
    config = await loadServerConfig('http://localhost:8083')
    owner = await login('user1')
    await ensureEmployeeFor(owner)
    seated = await login('user2')
    await ensureEmployeeFor(seated)
    seatless = await login('user3')
    await ensureEmployeeFor(seatless)
  }, 30000)

  async function setUsersLimit (usersLimit: number): Promise<void> {
    const adminClient = await adminSessionClient(config)
    await adminClient.adminCreateSubscription({
      otpCode: DEV_OTP,
      workspaceUuid: owner.workspaceId,
      plan: 'start',
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

  // Replica of plugins/billing-resources checkIsLimited for the given member.
  async function uiIsLimited (
    ws: WorkspaceToken
  ): Promise<{ limited: boolean, usersLimit: number, membersCount: number }> {
    const accountClient = getAccountClient(config.ACCOUNTS_URL, ws.token)
    const wsInfo = await accountClient.getWorkspaceInfo(false)
    const membersCount = wsInfo?.usageInfo?.usage.membersCount ?? 0

    const subs = await accountClient.getSubscriptions(ws.workspaceId, false)
    const tier = subs.find((s) => s.type === 'tier' && s.status === 'active')
    const usersLimit = tier?.limits?.usersLimit ?? 0

    if (usersLimit === 0 || membersCount <= usersLimit) {
      return { limited: false, usersLimit, membersCount }
    }

    const members = await accountClient.getWorkspaceMembers()
    const roleByPerson = new Map(members.map((m) => [m.person as string, m.role]))
    const ops = await createRestTxOperations(ws.endpoint, ws.workspaceId, ws.token)
    const employees = await ops.findAll(contact.mixin.Employee, { active: true })

    const prio = (r: AccountRole | undefined): number =>
      r === AccountRole.Owner ? 0 : r === AccountRole.Maintainer ? 1 : 2
    const sorted = [...employees].sort((a: Employee, b: Employee) => {
      const pa = prio(a.personUuid == null ? undefined : roleByPerson.get(a.personUuid))
      const pb = prio(b.personUuid == null ? undefined : roleByPerson.get(b.personUuid))
      if (pa !== pb) return pa - pb
      return (a.createdOn ?? 0) - (b.createdOn ?? 0)
    })

    let seats = 0
    let isSeated = false
    for (const emp of sorted) {
      if (seats >= usersLimit) break
      const uuid = emp.personUuid
      if (uuid == null) continue
      const role = roleByPerson.get(uuid)
      if (role === undefined || role === AccountRole.Admin) continue
      seats++
      if (uuid === ws.info.account) {
        isSeated = true
        break
      }
    }
    return { limited: !isSeated, usersLimit, membersCount }
  }

  it('UI checkIsLimited marks the over-limit member as read-only after downgrade', async () => {
    try {
      await setUsersLimit(1)

      // Poll: the UI recomputes on the LimitsChanged broadcast; replicate that data read until it settles.
      let result = { limited: false, usersLimit: 0, membersCount: 0 }
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        result = await uiIsLimited(seatless)
        if (result.limited) break
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }

      // Diagnostic: surfaces the actual data the UI would see.
      testCtx.info('seatless uiIsLimited', result)
      expect(result.usersLimit).toBe(1)
      expect(result.membersCount).toBeGreaterThan(1)
      expect(result.limited).toBe(true)

      // Owner stays seated.
      const ownerResult = await uiIsLimited(owner)
      expect(ownerResult.limited).toBe(false)
    } finally {
      await setUsersLimit(0)
    }
  }, 60000)
})

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

import { getWorkspaceToken, loadServerConfig, type ServerConfig, type WorkspaceToken } from '@hcengineering/api-client'
import { AccountRole, systemAccountUuid, type AccountUuid, type WorkspaceUuid } from '@hcengineering/core'
import { generateToken } from '@hcengineering/server-token'

import {
  DEV_OTP,
  isForbidden,
  isInvalidOtp,
  isRefused,
  payloadOf,
  rpc,
  STAND_URL,
  STATS_URL,
  TRANSACTOR_URL,
  WRONG_OTP,
  type RpcResult
} from './admin.fixtures'

/**
 * Gates around the admin surface, per foundation-tasks/admin-otp-plan.md section 3.
 * Written before the implementation: every case names the step (A0..A5) at which it turns green.
 * `admin-otp.test.ts` asserts the *current* behaviour of a system+admin token and is removed by A0.
 */
describe('admin-gates', () => {
  const wsName = 'api-tests'
  const ADMIN_SESSION_TTL_SEC = 43200

  let config: ServerConfig
  let owner: WorkspaceToken
  let member: WorkspaceToken
  let wsUuid: WorkspaceUuid
  let memberAccount: AccountUuid
  let adminAccount: AccountUuid
  /** Plain login token of the human admin: has extra.admin, no mfaAt. */
  let adminLogin: string
  /** Token after verifyAdminSession: carries extra.mfaAt. */
  let adminSession: string
  let billingLogin: string

  beforeAll(async () => {
    config = await loadServerConfig(STAND_URL)
    owner = await wsToken('user1')
    member = await wsToken('user2')
    wsUuid = owner.workspaceId
    memberAccount = member.info.account

    const adminInfo = await login('admin')
    adminLogin = adminInfo.token
    adminAccount = adminInfo.account
    billingLogin = (await login('billing')).token
    adminSession = await openAdminSession(adminLogin)
  }, 60000)

  async function wsToken (email: string): Promise<WorkspaceToken> {
    return await getWorkspaceToken(STAND_URL, { email, password: '1234', workspace: wsName }, config)
  }

  async function login (email: string): Promise<{ token: string, account: AccountUuid }> {
    const res = await rpc(config, undefined, 'login', { email, password: '1234' })
    expect(res.error).toBeUndefined()
    return { token: res.result.token, account: res.result.account }
  }

  /** A1: exchanges an admin login token for a session token carrying mfaAt. */
  async function openAdminSession (token: string, code: string = DEV_OTP): Promise<string> {
    const res = await rpc(config, token, 'verifyAdminSession', { otpCode: code })
    return res.result?.token ?? token
  }

  async function auditActions (action: string): Promise<any[]> {
    const res = await rpc(config, adminSession, 'listAdminActions', { action, limit: 20 })
    return res.result?.actions ?? []
  }

  async function requestOtp (token: string = adminSession): Promise<void> {
    await rpc(config, token, 'requestAdminOperationOtp', {})
  }

  // ---------------------------------------------------------------- A1: admin session

  it('1. requires an admin session before any admin RPC (A1)', async () => {
    const before = await rpc(config, adminLogin, 'listWorkspacesPaged', { limit: 1 })
    expect(isForbidden(before)).toBe(true)

    const opened = await rpc(config, adminLogin, 'verifyAdminSession', { otpCode: DEV_OTP })
    expect(opened.error).toBeUndefined()
    const token: string = opened.result.token
    expect(payloadOf(token).extra?.mfaAt).toBeDefined()

    const after = await rpc(config, token, 'listWorkspacesPaged', { limit: 1 })
    expect(after.error).toBeUndefined()
  })

  it('2. refuses a session older than ADMIN_SESSION_TTL_SEC (A1)', async () => {
    const stale = generateToken(
      adminAccount,
      undefined,
      { admin: 'true', mfaAt: String(Math.floor(Date.now() / 1000) - ADMIN_SESSION_TTL_SEC - 60) },
      'secret'
    )
    expect(isForbidden(await rpc(config, stale, 'listWorkspacesPaged', { limit: 1 }))).toBe(true)
  })

  it('3. logs otp_failed when the session code is wrong (A1)', async () => {
    const res = await rpc(config, adminLogin, 'verifyAdminSession', { otpCode: WRONG_OTP })
    expect(isInvalidOtp(res)).toBe(true)
    const failures = await auditActions('otp_failed')
    expect(failures.some((a) => a.actor === adminAccount)).toBe(true)
  })

  it('4. drops the code after 5 failed attempts (A1)', async () => {
    await requestOtp()
    for (let i = 0; i < 5; i++) {
      expect(isRefused(await rpc(config, adminLogin, 'verifyAdminSession', { otpCode: WRONG_OTP }))).toBe(true)
    }
    // Rate limiter has invalidated the code: even the dev code must not pass now.
    expect(isRefused(await rpc(config, adminLogin, 'verifyAdminSession', { otpCode: DEV_OTP }))).toBe(true)

    await requestOtp(adminLogin)
    const recovered = await rpc(config, adminLogin, 'verifyAdminSession', { otpCode: DEV_OTP })
    expect(recovered.error).toBeUndefined()
  }, 30000)

  it('8. billing admin reads but cannot mutate (A1)', async () => {
    const session = await openAdminSession(billingLogin)
    expect((await rpc(config, session, 'listWorkspacesPaged', { limit: 1 })).error).toBeUndefined()
    expect(
      isForbidden(
        await rpc(config, session, 'adminUpdateWorkspaceRole', {
          workspace: wsUuid,
          targetAccount: memberAccount,
          role: AccountRole.Maintainer,
          otpCode: DEV_OTP
        })
      )
    ).toBe(true)
  })

  // ---------------------------------------------------------------- A0: human vs service

  it('6. a system token with admin:true is not a human admin (A0)', async () => {
    const system = generateToken(systemAccountUuid, wsUuid, { admin: 'true' }, 'secret')
    const res = await rpc(config, system, 'adminUpdateWorkspaceRole', {
      workspace: wsUuid,
      targetAccount: memberAccount,
      role: AccountRole.Maintainer,
      otpCode: DEV_OTP
    })
    expect(isForbidden(res)).toBe(true)
    expect((await auditActions('forbidden')).length).toBeGreaterThan(0)
  })

  it('7. service tokens keep only their allowlisted methods (A0)', async () => {
    const tool = generateToken(systemAccountUuid, undefined, { service: 'tool', admin: 'true' }, 'secret')
    expect(
      isForbidden(
        await rpc(config, tool, 'adminCreateSubscription', { workspace: wsUuid, plan: 'free', period: 'monthly' })
      )
    ).toBe(true)

    const billing = generateToken(systemAccountUuid, undefined, { service: 'billing' }, 'secret')
    expect((await rpc(config, billing, 'listWorkspaces', {})).error).toBeUndefined()
  })

  // ---------------------------------------------------------------- A2: per-op OTP + audit

  interface MutationCase {
    name: string
    method: string
    params: Record<string, any>
    /** Audit action expected on success; undefined -> gate only, success path covered elsewhere. */
    audit?: string
    /** Runs after a successful call to restore the stand. */
    revert?: () => Promise<void>
  }

  function mutations (): MutationCase[] {
    return [
      {
        name: 'adminUpdateWorkspaceRole',
        method: 'adminUpdateWorkspaceRole',
        params: { workspace: wsUuid, targetAccount: memberAccount, role: AccountRole.Maintainer },
        audit: 'update_workspace_role',
        revert: async () => {
          await rpc(config, adminSession, 'adminUpdateWorkspaceRole', {
            workspace: wsUuid,
            targetAccount: memberAccount,
            role: AccountRole.User,
            otpCode: DEV_OTP
          })
        }
      },
      {
        name: 'adminUpdateWorkspaceName',
        method: 'adminUpdateWorkspaceName',
        params: { workspace: wsUuid, name: 'api-tests-renamed' },
        audit: 'rename_workspace',
        revert: async () => {
          await rpc(config, adminSession, 'adminUpdateWorkspaceName', {
            workspace: wsUuid,
            name: wsName,
            otpCode: DEV_OTP
          })
        }
      },
      {
        name: 'adminUpdateWorkspaceDisabledFeatures',
        method: 'adminUpdateWorkspaceDisabledFeatures',
        params: { workspace: wsUuid, features: ['invites'] },
        audit: 'set_disabled_features',
        revert: async () => {
          await rpc(config, adminSession, 'adminUpdateWorkspaceDisabledFeatures', {
            workspace: wsUuid,
            features: [],
            otpCode: DEV_OTP
          })
        }
      },
      {
        name: 'adminReindexWorkspace',
        method: 'adminReindexWorkspace',
        params: { workspace: wsUuid },
        audit: 'reindex'
      },
      {
        name: 'performWorkspaceOperation:reset-attempts',
        method: 'performWorkspaceOperation',
        params: { workspaceId: wsUuid, event: 'reset-attempts' },
        audit: 'workspace_reset-attempts'
      },
      // Destructive or environment-wide: gate only, the success path lives in sanity.
      {
        name: 'performWorkspaceOperation:archive',
        method: 'performWorkspaceOperation',
        params: { workspaceId: wsUuid, event: 'archive' }
      },
      {
        name: 'performWorkspaceOperation:delete',
        method: 'performWorkspaceOperation',
        params: { workspaceId: wsUuid, event: 'delete' }
      },
      { name: 'adminSetMaintenance', method: 'adminSetMaintenance', params: { timeoutMinutes: -1 } },
      { name: 'adminForceCloseWorkspace', method: 'adminForceCloseWorkspace', params: { workspace: wsUuid } },
      { name: 'adminConfirmExport', method: 'adminConfirmExport', params: { kind: 'accounts', filter: {} } },
      {
        name: 'adminCreateSubscription',
        method: 'adminCreateSubscription',
        params: { workspaceUuid: wsUuid, plan: 'free' }
      }
    ]
  }

  it('5. every admin mutation demands a valid OTP and writes one audit row (A2)', async () => {
    for (const m of mutations()) {
      const empty = await rpc(config, adminSession, m.method, { ...m.params, otpCode: '' })
      expect([m.name, isRefused(empty)]).toEqual([m.name, true])

      const wrong = await rpc(config, adminSession, m.method, { ...m.params, otpCode: WRONG_OTP })
      expect([m.name, isRefused(wrong)]).toEqual([m.name, true])

      if (m.audit === undefined) continue

      const before = (await auditActions(m.audit)).length
      await requestOtp()
      const ok = await rpc(config, adminSession, m.method, { ...m.params, otpCode: DEV_OTP })
      expect([m.name, ok.error]).toEqual([m.name, undefined])
      expect([m.name, (await auditActions(m.audit)).length]).toEqual([m.name, before + 1])

      await m.revert?.()
    }
  }, 120000)

  it('11. PII reads are audited (A2)', async () => {
    const before = (await auditActions('read_accounts')).length
    expect((await rpc(config, adminSession, 'listAccounts', { limit: 5 })).error).toBeUndefined()
    expect((await auditActions('read_accounts')).length).toBe(before + 1)

    await requestOtp()
    const exported = await rpc(config, adminSession, 'adminConfirmExport', {
      kind: 'accounts',
      filter: {},
      otpCode: DEV_OTP
    })
    expect(exported.error).toBeUndefined()
    expect((await auditActions('export_report')).length).toBeGreaterThan(0)
  }, 30000)

  it('12. workspace owner confirms delete/self-leave with an OTP code (A2)', async () => {
    // Gate only: the success path destroys a workspace / drops the owner, covered by sanity.
    expect(isRefused(await rpc(config, owner.token, 'deleteWorkspace', { otpCode: '' }))).toBe(true)
    expect(
      isRefused(await rpc(config, owner.token, 'leaveWorkspace', { account: owner.info.account, otpCode: '' }))
    ).toBe(true)
  })

  // ---------------------------------------------------------------- A2: management endpoints

  async function head (url: string, init?: RequestInit): Promise<number> {
    const res = await fetch(url, init)
    return res.status
  }

  it('9. the account management endpoint is gone; maintenance is an audited RPC (A2)', async () => {
    const url = `${config.ACCOUNTS_URL}/api/v1/manage?operation=maintenance&token=${adminSession}`
    expect(await head(url, { method: 'PUT' })).toBe(404)

    await requestOtp()
    const viaRpc = await rpc(config, adminSession, 'adminSetMaintenance', { timeoutMinutes: -1, otpCode: DEV_OTP })
    expect(viaRpc.error).toBeUndefined()
  })

  it('10. transactor and stats management endpoints reject query tokens (A2)', async () => {
    // A query string token is ignored now: nothing decodes and the endpoint 404s.
    expect(await head(`${TRANSACTOR_URL}/api/v1/profiling?token=${adminSession}`)).toBe(404)
    expect(
      await head(`${TRANSACTOR_URL}/api/v1/manage?token=${adminSession}&operation=profile-start`, { method: 'PUT' })
    ).toBe(404)
    expect(await head(`${STATS_URL}/api/v1/manage?token=${adminSession}&operation=wipe`, { method: 'PUT' })).toBe(404)

    // A login token without a second factor is refused; the session token passes.
    expect(
      await head(`${TRANSACTOR_URL}/api/v1/profiling`, { headers: { Authorization: `Bearer ${adminLogin}` } })
    ).toBe(404)
    expect(
      await head(`${TRANSACTOR_URL}/api/v1/profiling`, { headers: { Authorization: `Bearer ${adminSession}` } })
    ).toBe(200)
  })

  // ---------------------------------------------------------------- A3: escalations

  it('13. an admin is not a member of a workspace they never joined (A3)', async () => {
    const foreign = await rpc(config, adminSession, 'selectWorkspace', { workspaceUrl: wsName })
    expect(isForbidden(foreign)).toBe(true)

    // Reads stay open for the admin panel: the workspace is listed even though the admin is no member.
    const listed = await rpc(config, adminSession, 'listWorkspacesPaged', { search: wsName, limit: 10 })
    expect(listed.error).toBeUndefined()
    expect(listed.result.workspaces.some((w: any) => w.uuid === wsUuid)).toBe(true)

    // Workspace-scoped RPCs read the workspace from the token, so forge one: the escalation used to
    // live in verifyAllowedRole, and selectWorkspace no longer hands out such a token.
    const adminInWs = generateToken(
      adminAccount,
      wsUuid,
      { admin: 'true', mfaAt: String(Math.floor(Date.now() / 1000)) },
      'secret'
    )
    expect(
      isForbidden(await rpc(config, adminInWs, 'createInviteLink', { email: 'x@example.com', role: AccountRole.User }))
    ).toBe(true)
    expect(isForbidden(await rpc(config, adminInWs, 'createAccessLink', { role: AccountRole.User }))).toBe(true)
    expect(
      isForbidden(
        await rpc(config, adminSession, 'mergeSpecifiedPersons', {
          primaryPerson: adminAccount,
          secondaryPerson: memberAccount
        })
      )
    ).toBe(true)
    expect(
      isForbidden(
        await rpc(config, adminSession, 'addSocialIdToPerson', {
          person: memberAccount,
          type: 'email',
          value: 'x@example.com'
        })
      )
    ).toBe(true)
  })

  it('14. adminImpersonate is OTP-gated, scoped, read-only and short lived (A3)', async () => {
    expect(
      isRefused(
        await rpc(config, adminSession, 'adminImpersonate', {
          workspace: wsUuid,
          account: memberAccount,
          otpCode: ''
        })
      )
    ).toBe(true)

    await requestOtp()
    const impersonated: RpcResult = await rpc(config, adminSession, 'adminImpersonate', {
      workspace: wsUuid,
      account: memberAccount,
      otpCode: DEV_OTP
    })
    expect(impersonated.error).toBeUndefined()
    const payload = payloadOf(impersonated.result.token)
    expect(payload.account).toBe(memberAccount)
    expect(payload.workspace).toBe(wsUuid)
    expect(payload.extra?.impersonatedBy).toBe(adminAccount)
    expect(payload.extra?.readonly).toBe('true')
    expect(payload.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(1800)

    // The workbench re-exchanges the token through selectWorkspace: read-only must survive that.
    const reselected = await rpc(config, impersonated.result.token, 'selectWorkspace', { workspaceUrl: wsName })
    expect(reselected.error).toBeUndefined()
    expect(payloadOf(reselected.result.token).extra?.readonly).toBe('true')

    // Impersonating someone who is not a member is refused.
    await requestOtp()
    expect(
      isRefused(
        await rpc(config, adminSession, 'adminImpersonate', {
          workspace: wsUuid,
          account: (await login('user4')).account,
          otpCode: DEV_OTP
        })
      )
    ).toBe(true)
  }, 30000)

  // ---------------------------------------------------------------- A5: feature override

  it('15. disabled features override reaches workspace login info (A5)', async () => {
    await requestOtp()
    const set = await rpc(config, adminSession, 'adminUpdateWorkspaceDisabledFeatures', {
      workspace: wsUuid,
      features: ['invites'],
      otpCode: DEV_OTP
    })
    expect(set.error).toBeUndefined()

    // selectWorkspace is what carries the override to the client; getLoginInfoByToken never had it.
    const info = await rpc(config, (await login('user1')).token, 'selectWorkspace', { workspaceUrl: wsName })
    expect(info.result?.disabledFeaturesOverride).toEqual(['invites'])

    await requestOtp()
    await rpc(config, adminSession, 'adminUpdateWorkspaceDisabledFeatures', {
      workspace: wsUuid,
      features: [],
      otpCode: DEV_OTP
    })
  }, 30000)
})

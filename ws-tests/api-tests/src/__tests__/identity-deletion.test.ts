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
import { type AccountUuid, type WorkspaceUuid } from '@hcengineering/core'

import { DEV_OTP, isRefused, rpc, STAND_URL } from './admin.fixtures'

/**
 * Deletion is deferred: a request only stamps a deadline, and the support path (`force`) is what
 * purges an identity right away. Covers both, plus the re-signup that follows a purge.
 */
describe('identity-deletion', () => {
  const email = `purge-${Date.now()}@example.com`
  const password = '1234'

  let config: ServerConfig
  let adminSession: string
  let userToken: string
  let userAccount: AccountUuid
  let wsUuid: WorkspaceUuid

  beforeAll(async () => {
    config = await loadServerConfig(STAND_URL)
    const login = await rpc(config, undefined, 'login', { email: 'admin', password })
    expect(login.error).toBeUndefined()
    const session = await rpc(config, login.result.token, 'verifyAdminSession', { otpCode: DEV_OTP })
    expect(session.error).toBeUndefined()
    adminSession = session.result.token
  }, 60000)

  async function adminOp (method: string, params: Record<string, any>): Promise<any> {
    await rpc(config, adminSession, 'requestAdminOperationOtp', {})
    return await rpc(config, adminSession, method, { ...params, otpCode: DEV_OTP })
  }

  async function auditActions (action: string): Promise<any[]> {
    const res = await rpc(config, adminSession, 'listAdminActions', { action, limit: 50 })
    return res.result?.actions ?? []
  }

  async function workspaceStatus (uuid: WorkspaceUuid): Promise<any> {
    const res = await rpc(config, adminSession, 'listWorkspaces', {})
    return res.result?.find((it: any) => it.uuid === uuid)?.status
  }

  async function workspaceMode (uuid: WorkspaceUuid): Promise<string | undefined> {
    return (await workspaceStatus(uuid))?.mode
  }

  async function waitMode (uuid: WorkspaceUuid, mode: string, timeoutMs = 180000): Promise<void> {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if ((await workspaceMode(uuid)) === mode) return
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    throw new Error(`workspace ${uuid} never reached mode '${mode}', last: ${await workspaceMode(uuid)}`)
  }

  it('signs up a user who creates their own workspace', async () => {
    const signedUp = await rpc(config, undefined, 'signUp', { email, password, firstName: 'Purge', lastName: 'Me' })
    expect(signedUp.error).toBeUndefined()
    userToken = signedUp.result.token
    userAccount = signedUp.result.account

    const created = await rpc(config, userToken, 'createWorkspace', { workspaceName: `purge-${Date.now()}` })
    expect(created.error).toBeUndefined()
    wsUuid = created.result.workspace
    await waitMode(wsUuid, 'active')
  }, 240000)

  it('refuses to delete the account while their workspace is alive', async () => {
    const res = await adminOp('deleteAccount', { uuid: userAccount })
    expect(isRefused(res)).toBe(true)
    expect(await workspaceMode(wsUuid)).toEqual('active')

    // Same rule as seen by the person themselves - this is what hides the UI link.
    const can = await rpc(config, userToken, 'canDeleteAccount', {})
    expect(can.error).toBeUndefined()
    expect(can.result.canDelete).toBe(false)
    expect(can.result.ownedWorkspaces.map((it: any) => it.uuid)).toContain(wsUuid)
  }, 60000)

  it('schedules the workspace from the admin panel instead of dropping it, and records who did it', async () => {
    const res = await adminOp('performWorkspaceOperation', { workspaceId: wsUuid, event: 'delete', params: [] })
    expect(res.error).toBeUndefined()

    // Deferred: the workspace keeps running read-only until the deadline the sweep acts on.
    const status = await workspaceStatus(wsUuid)
    expect(status.mode).toEqual('active')
    expect(status.deleteOn).toBeGreaterThan(Date.now())

    const entry = (await auditActions('workspace_delete')).find((a) => a.target === wsUuid)
    expect(entry).toBeDefined()
    expect(entry.actorEmail).toEqual('admin')
  }, 120000)

  it('marks the account without touching it while a scheduled workspace no longer blocks', async () => {
    const can = await rpc(config, userToken, 'canDeleteAccount', {})
    expect(can.result.canDelete).toBe(true)

    const res = await adminOp('deleteAccount', { uuid: userAccount })
    expect(res.error).toBeUndefined()

    // Still able to sign in - that is the way back - and told when the account goes away.
    const relogin = await rpc(config, undefined, 'login', { email, password })
    expect(relogin.error).toBeUndefined()
    expect(relogin.result.deleteOn).toBeGreaterThan(Date.now())
    userToken = relogin.result.token
  }, 60000)

  it('takes the mark off when the person calls the deletion off', async () => {
    const cancelled = await rpc(config, userToken, 'cancelAccountDeletion', {})
    expect(cancelled.error).toBeUndefined()

    const relogin = await rpc(config, undefined, 'login', { email, password })
    expect(relogin.error).toBeUndefined()
    expect(relogin.result.deleteOn ?? null).toBeNull()
  }, 60000)

  it('purges the identity right away on the support path', async () => {
    const res = await adminOp('deleteAccount', { uuid: userAccount, force: true })
    expect(res.error).toBeUndefined()

    const relogin = await rpc(config, undefined, 'login', { email, password })
    expect(isRefused(relogin)).toBe(true)
  }, 60000)

  it('lets the same person sign up again with the same email', async () => {
    const again = await rpc(config, undefined, 'signUp', { email, password, firstName: 'Purge', lastName: 'Again' })
    expect(again.error).toBeUndefined()
    expect(again.result.account).not.toEqual(userAccount)
  }, 60000)

  it('records who scheduled a workspace when the owner does it themselves', async () => {
    const ownerEmail = `owner-${Date.now()}@example.com`
    const signedUp = await rpc(config, undefined, 'signUp', {
      email: ownerEmail,
      password,
      firstName: 'Ws',
      lastName: 'Owner'
    })
    expect(signedUp.error).toBeUndefined()

    const created = await rpc(config, signedUp.result.token, 'createWorkspace', {
      workspaceName: `owned-${Date.now()}`
    })
    expect(created.error).toBeUndefined()
    const ownedUuid: WorkspaceUuid = created.result.workspace
    await waitMode(ownedUuid, 'active')

    const selected = await rpc(config, signedUp.result.token, 'selectWorkspace', {
      workspaceUrl: created.result.workspaceUrl,
      kind: 'external'
    })
    expect(selected.error).toBeUndefined()

    const deleted = await rpc(config, selected.result.token, 'deleteWorkspace', { otpCode: DEV_OTP })
    expect(deleted.error).toBeUndefined()
    expect((await workspaceStatus(ownedUuid)).deleteOn).toBeGreaterThan(Date.now())

    const entry = (await auditActions('workspace_delete')).find((a) => a.target === ownedUuid)
    expect(entry).toBeDefined()
    expect(entry.actor).toEqual(signedUp.result.account)
    expect(entry.actorEmail).toEqual(ownerEmail)

    // An owner can call it off, and nothing was archived yet, so the workspace just keeps running.
    const cancelled = await adminOp('performWorkspaceOperation', {
      workspaceId: ownedUuid,
      event: 'cancel-delete',
      params: []
    })
    expect(cancelled.error).toBeUndefined()
    const after = await workspaceStatus(ownedUuid)
    expect(after.deleteOn ?? null).toBeNull()
    expect(after.mode).toEqual('active')
  }, 240000)

  it('lets a person who owns nothing schedule their own deletion', async () => {
    const selfEmail = `self-${Date.now()}@example.com`
    const signedUp = await rpc(config, undefined, 'signUp', {
      email: selfEmail,
      password,
      firstName: 'Self',
      lastName: 'Purge'
    })
    expect(signedUp.error).toBeUndefined()
    const selfToken: string = signedUp.result.token

    const res = await rpc(config, selfToken, 'deleteAccount', { otpCode: DEV_OTP })
    expect(res.error).toBeUndefined()

    const relogin = await rpc(config, undefined, 'login', { email: selfEmail, password })
    expect(relogin.error).toBeUndefined()
    expect(relogin.result.deleteOn).toBeGreaterThan(Date.now())
  }, 120000)
})

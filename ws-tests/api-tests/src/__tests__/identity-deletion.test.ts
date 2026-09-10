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
 * The support scenario: a user asks to be removed, an admin deletes the workspace and the account,
 * and the same person can sign up again later with the same email.
 *
 * Written against the behaviour we want. What fails today is listed in
 * docs/memory/identity-deletion.md.
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

  async function workspaceMode (uuid: WorkspaceUuid): Promise<string | undefined> {
    const res = await rpc(config, adminSession, 'listWorkspaces', {})
    return res.result?.find((it: any) => it.uuid === uuid)?.status?.mode
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

  it('deletes the workspace through the admin panel and records who did it', async () => {
    const res = await adminOp('performWorkspaceOperation', { workspaceId: wsUuid, event: 'delete', params: [] })
    expect(res.error).toBeUndefined()
    await waitMode(wsUuid, 'deleted')

    const entry = (await auditActions('workspace_delete')).find((a) => a.target === wsUuid)
    expect(entry).toBeDefined()
    expect(entry.actorEmail).toEqual('admin')
  }, 240000)

  it('deletes the account once nothing is left behind it', async () => {
    const can = await rpc(config, userToken, 'canDeleteAccount', {})
    expect(can.result.canDelete).toBe(true)

    const res = await adminOp('deleteAccount', { uuid: userAccount })
    expect(res.error).toBeUndefined()

    const relogin = await rpc(config, undefined, 'login', { email, password })
    expect(isRefused(relogin)).toBe(true)
  }, 60000)

  it('lets the same person sign up again with the same email', async () => {
    const again = await rpc(config, undefined, 'signUp', { email, password, firstName: 'Purge', lastName: 'Again' })
    expect(again.error).toBeUndefined()
    expect(again.result.account).not.toEqual(userAccount)
  }, 60000)

  it('records who deleted a workspace when the owner does it themselves', async () => {
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

    const entry = (await auditActions('workspace_delete')).find((a) => a.target === ownedUuid)
    expect(entry).toBeDefined()
    expect(entry.actor).toEqual(signedUp.result.account)
    expect(entry.actorEmail).toEqual(ownerEmail)
  }, 240000)

  it('lets a person who owns nothing delete themselves', async () => {
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

    expect(isRefused(await rpc(config, undefined, 'login', { email: selfEmail, password }))).toBe(true)
  }, 120000)
})

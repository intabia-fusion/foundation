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

jest.mock('../workspaceClient', () => ({ getSystemTransactorTarget: jest.fn() }))
jest.mock('@hcengineering/account-client', () => ({ getClient: jest.fn() }))
jest.mock('../ssrf', () => ({ ...jest.requireActual('../ssrf'), safeFetch: jest.fn() }))

/* eslint-disable import/first */
import { createServer as createHttpServer } from 'http'
import type { AddressInfo } from 'net'
import setting, { type WebhookEndpoint } from '@hcengineering/setting'
import { AccountRole } from '@hcengineering/core'
import { generateToken } from '@hcengineering/server-token'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import { createServer } from '../server'
import { safeFetch } from '../ssrf'
import { getSystemTransactorTarget } from '../workspaceClient'
/* eslint-enable import/first */

const WORKSPACE = crypto.randomUUID()
const OTHER_WORKSPACE = crypto.randomUUID()
const ACCOUNT = crypto.randomUUID()

const newCtx = (): any => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })

// Every test but the role one runs as the workspace owner - that is what the endpoint requires.
function mockRole (role: AccountRole): void {
  ;(getAccountClient as jest.Mock).mockReturnValue({
    getLoginWithWorkspaceInfo: jest.fn().mockResolvedValue({ workspaces: { [WORKSPACE]: { role } } })
  })
}

const CONFIG: any = {
  RateLimitMax: 60,
  RateLimitWindowMs: 60000,
  RateLimitPathMax: 20,
  WebhookDeliveryTimeoutMs: 10000,
  WebhookMaxResponseBytes: 65536,
  AllowInsecureWebhookHttp: false
}

function baseEndpoint (overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return {
    _id: 'ep_1' as any,
    _class: setting.class.WebhookEndpoint,
    space: 'space-1' as any,
    modifiedOn: 0,
    modifiedBy: 'social_1' as any,
    url: 'https://receiver.example/hook',
    events: ['issue.created'],
    secrets: [{ id: 's1', secret: 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', createdOn: 0 }],
    enabled: true,
    failureCount: 0,
    ...overrides
  }
}

function mockTarget (endpoint: WebhookEndpoint | undefined): any {
  return {
    token: 'sys-token',
    transactorUrl: 'http://transactor.local',
    rest: {
      findOne: jest.fn().mockResolvedValue(endpoint),
      createDoc: jest.fn().mockResolvedValue('id'),
      findAll: jest.fn().mockResolvedValue([]),
      removeDoc: jest.fn().mockResolvedValue(undefined)
    }
  }
}

async function startServer (): Promise<{ base: string, close: () => void }> {
  const accountClient: any = { verifyApiKey: jest.fn() }
  const producer: any = { send: jest.fn() }
  const { app } = createServer(newCtx(), CONFIG, accountClient, producer)
  const server = createHttpServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}/api/v1/webhook/${WORKSPACE}`, close: () => server.close() }
}

describe('POST /api/v1/webhook/:workspace/test/:endpointId', () => {
  beforeEach(() => {
    mockRole(AccountRole.Owner)
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  test('no token -> 401', async () => {
    const { base, close } = await startServer()
    const res = await fetch(`${base}/test/ep_1`, { method: 'POST' })
    close()
    expect(res.status).toBe(401)
  })

  test('token for a different workspace -> 401', async () => {
    const { base, close } = await startServer()
    const token = generateToken(ACCOUNT as any, OTHER_WORKSPACE as any)
    const res = await fetch(`${base}/test/ep_1`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    close()
    expect(res.status).toBe(401)
  })

  test('a non-owner member is refused', async () => {
    mockRole(AccountRole.User)
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(mockTarget(baseEndpoint()))
    const { base, close } = await startServer()
    const token = generateToken(ACCOUNT as any, WORKSPACE as any)

    const res = await fetch(`${base}/test/ep_1`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    close()

    expect(res.status).toBe(403)
    expect(safeFetch).not.toHaveBeenCalled()
  })

  test('unknown endpoint -> 404', async () => {
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(mockTarget(undefined))
    const { base, close } = await startServer()
    const token = generateToken(ACCOUNT as any, WORKSPACE as any)
    const res = await fetch(`${base}/test/ep_1`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    close()
    expect(res.status).toBe(404)
  })

  test('delivers a signed test event and reports the receiver status, recorded into history', async () => {
    const target = mockTarget(baseEndpoint())
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(target)
    ;(safeFetch as jest.Mock).mockResolvedValue({ status: 200, body: 'ok' })
    const { base, close } = await startServer()
    const token = generateToken(ACCOUNT as any, WORKSPACE as any)

    const res = await fetch(`${base}/test/ep_1`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    close()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ delivered: true, status: 200 })
    const [url, opts] = (safeFetch as jest.Mock).mock.calls[0]
    expect(url).toBe('https://receiver.example/hook')
    expect(opts.headers['webhook-signature']).toMatch(/^v1,/)
    expect(target.rest.createDoc).toHaveBeenCalledWith(
      setting.class.WebhookDelivery,
      expect.anything(),
      expect.objectContaining({ endpoint: 'ep_1', status: 200 })
    )
  })

  test('a delivery error is reported in the response, not thrown, and endpoint.updateDoc is never called', async () => {
    const target = mockTarget(baseEndpoint())
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(target)
    ;(safeFetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'))
    const { base, close } = await startServer()
    const token = generateToken(ACCOUNT as any, WORKSPACE as any)

    const res = await fetch(`${base}/test/ep_1`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    close()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ delivered: false, error: 'ECONNREFUSED' })
  })
})

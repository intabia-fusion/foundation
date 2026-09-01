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
import { createServer as createHttpServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import type { ApiKeyCheck } from '@hcengineering/account-client'
import { createServer } from '../server'

export interface WebhookSenderOptions {
  rateLimitMax?: number
  rateLimitWindowMs?: number
  rateLimitPathMax?: number
}

// Mimics an external caller of the webhook pod: real express app from ../server, listening on a
// random port, driven with plain fetch - the same setup server.test.ts already used, extracted for reuse.
export interface WebhookSender {
  url: string
  server: Server
  producer: { send: jest.Mock, close: jest.Mock, getQueue: jest.Mock }
  verifyApiKey: jest.Mock
  /** Swap what the account service answers, to act as a different key against the same server. */
  setCheck: (check: ApiKeyCheck | null) => void
  /** POST .../action with the key in the Authorization header. */
  action: (key: string, body: Record<string, unknown>, headers?: Record<string, string>) => Promise<Response>
  /** POST .../k/:key - same call, key in the path instead. */
  pathKey: (key: string, body: Record<string, unknown>) => Promise<Response>
  /** GET .../job/:id, authenticated with `key`. */
  job: (key: string, id: string) => Promise<Response>
  close: () => void
}

const newCtx = (): any => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })

export async function startWebhookSender (
  check: ApiKeyCheck | null,
  opts: WebhookSenderOptions = {}
): Promise<WebhookSender> {
  const verifyApiKey = jest.fn().mockResolvedValue(check)
  const accountClient: any = { verifyApiKey }
  const producer = { send: jest.fn().mockResolvedValue(undefined), close: jest.fn(), getQueue: jest.fn() }
  const config: any = {
    RateLimitMax: opts.rateLimitMax ?? 60,
    RateLimitWindowMs: opts.rateLimitWindowMs ?? 60000,
    RateLimitPathMax: opts.rateLimitPathMax ?? 20
  }
  const { app } = createServer(newCtx(), config, accountClient, producer)
  const server = createHttpServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  const base = `${url}/api/v1/webhook`

  return {
    url,
    server,
    producer,
    verifyApiKey,
    setCheck: (next) => {
      verifyApiKey.mockResolvedValue(next)
    },
    action: async (key, body, headers = {}) =>
      await fetch(`${base}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...headers },
        body: JSON.stringify(body)
      }),
    pathKey: async (key, body) =>
      await fetch(`${base}/k/${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }),
    job: async (key, id) => await fetch(`${base}/job/${id}`, { headers: { Authorization: `Bearer ${key}` } }),
    close: () => server.close()
  }
}

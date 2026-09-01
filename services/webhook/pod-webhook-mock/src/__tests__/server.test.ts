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

import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { signStandard } from '@hcengineering/pod-webhook/src/signature'

import { createServer } from '../server'
import { DeliveryStore } from '../store'
import { verifyStandardSignature } from '../verify'

describe('webhook mock', () => {
  test('verifyStandardSignature matches a correctly signed body and rejects a wrong secret', () => {
    const secret = 'whsec_test'
    const body = '{"hello":"world"}'
    const timestamp = 1700000000
    const signature = signStandard([secret], 'msg_1', timestamp, body)
    const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(timestamp), 'webhook-signature': signature }

    expect(verifyStandardSignature(secret, headers, body).match).toBe(true)
    expect(verifyStandardSignature('whsec_wrong', headers, body).match).toBe(false)
  })

  test('a delivery posted to /receive shows up in /api/deliveries', async () => {
    const store = new DeliveryStore()
    const app = createServer({ Port: 0, WebhookUrl: 'http://unused' }, store)
    const server: Server = app.listen(0)
    const { port } = server.address() as AddressInfo

    try {
      const posted = await fetch(`http://127.0.0.1:${port}/receive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'webhook-id': 'msg_1',
          'webhook-timestamp': '1700000000',
          'webhook-signature': 'v1,abc'
        },
        body: '{"hello":"world"}'
      })
      expect(posted.status).toBe(200)

      const list = await fetch(`http://127.0.0.1:${port}/api/deliveries`)
      const items = (await list.json()) as Array<{ headers: Record<string, string>, rawBody: string }>
      expect(items).toHaveLength(1)
      expect(items[0].headers['webhook-id']).toBe('msg_1')
      expect(items[0].rawBody).toBe('{"hello":"world"}')
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
  })
})

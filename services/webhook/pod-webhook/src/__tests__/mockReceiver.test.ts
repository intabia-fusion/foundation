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
import { startMockReceiver, type MockReceiver } from './mockReceiver'

describe('mock receiver', () => {
  let receiver: MockReceiver

  afterEach(async () => {
    await receiver.close()
  })

  test('captures method, headers and the raw body of an incoming request', async () => {
    receiver = await startMockReceiver()
    const rawBody = '{"event":"issue.created","id":1}'
    await fetch(`${receiver.url}/hooks/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': 'sha256=abc' },
      body: rawBody
    })

    expect(receiver.requests).toHaveLength(1)
    const [req] = receiver.requests
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/hooks/deliver')
    expect(req.headers['x-signature']).toBe('sha256=abc')
    expect(req.body.toString('utf8')).toBe(rawBody)
  })

  test('serves queued responses in order, then falls back to 200', async () => {
    receiver = await startMockReceiver()
    receiver.queueResponses({ status: 500 }, { status: 200, body: '{"ok":true}' })

    const first = await fetch(receiver.url, { method: 'POST', body: '{}' })
    expect(first.status).toBe(500)

    const second = await fetch(receiver.url, { method: 'POST', body: '{}' })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: true })

    const third = await fetch(receiver.url, { method: 'POST', body: '{}' })
    expect(third.status).toBe(200)
  })

  test('serves a 429 with a Retry-After header', async () => {
    receiver = await startMockReceiver()
    receiver.queueResponses({ status: 429, headers: { 'Retry-After': '3' } })

    const res = await fetch(receiver.url, { method: 'POST', body: '{}' })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('3')
  })

  test('close() stops the server - a further request is refused', async () => {
    receiver = await startMockReceiver()
    const url = receiver.url
    await receiver.close()

    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow()
  })
})

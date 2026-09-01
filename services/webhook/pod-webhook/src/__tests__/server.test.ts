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
import type { ApiKeyCheck } from '@hcengineering/account-client'
import { startWebhookSender, type WebhookSender } from './webhookSender'

const KEY = 'fus_ws1_test'

const baseCheck: ApiKeyCheck = {
  keyId: 'key_1',
  name: 'key one',
  workspace: 'ws-1' as any,
  socialId: 'social_1' as any,
  personUuid: 'person_1' as any,
  ops: ['issue:create'],
  spaces: [],
  incoming: true
}

describe('POST /api/v1/webhook/action', () => {
  let sender: WebhookSender

  afterEach(() => {
    sender.close()
  })

  test('invalid key -> 401 unauthorized', async () => {
    sender = await startWebhookSender(null)
    const res = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('unauthorized')
  })

  test('action not in the key ops -> 403 forbidden', async () => {
    sender = await startWebhookSender({ ...baseCheck, ops: [] })
    const res = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden')
  })

  test('key without incoming -> 401 unauthorized, same as an unknown key, on both routes', async () => {
    sender = await startWebhookSender({ ...baseCheck, incoming: false })
    const unknown = await startWebhookSender(null)

    const res = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' })
    const unauthorizedRes = await unknown.action(KEY, { action: 'issue:create', space: 'FUSIO' })
    expect(res.status).toBe(unauthorizedRes.status)
    expect(await res.json()).toEqual(await unauthorizedRes.json())

    const pathRes = await sender.pathKey(KEY, { action: 'issue:create', space: 'FUSIO' })
    expect(pathRes.status).toBe(401)
    expect((await pathRes.json()).error).toBe('unauthorized')

    unknown.close()
  })

  test('key with incoming still works', async () => {
    sender = await startWebhookSender({ ...baseCheck, incoming: true })
    const res = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' })
    expect(res.status).toBe(202)
  })

  test('unknown action -> 400 invalid_payload', async () => {
    sender = await startWebhookSender(baseCheck)
    const res = await sender.action(KEY, { action: 'bogus:op', space: 'FUSIO' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_payload')
  })

  test('missing space -> 400 invalid_payload', async () => {
    sender = await startWebhookSender(baseCheck)
    const res = await sender.action(KEY, { action: 'issue:create' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_payload')
  })

  test('body over the 1mb limit -> 413 payload_too_large', async () => {
    sender = await startWebhookSender(baseCheck)
    const res = await sender.action(KEY, {
      action: 'issue:create',
      space: 'FUSIO',
      description: 'x'.repeat(2 * 1024 * 1024)
    })
    expect(res.status).toBe(413)
    expect((await res.json()).error).toBe('payload_too_large')
  })

  test('valid key and action -> 202 with a jobId, job visible via GET /job/:id', async () => {
    sender = await startWebhookSender(baseCheck)
    const res = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' })
    expect(res.status).toBe(202)
    const { jobId } = await res.json()
    expect(jobId).toEqual(expect.any(String))

    const jobRes = await sender.job(KEY, jobId)
    expect(jobRes.status).toBe(200)
    const job = await jobRes.json()
    expect(job).toMatchObject({ jobId, status: 'queued' })
  })

  test('unknown job id -> 404 not_found', async () => {
    sender = await startWebhookSender(baseCheck)
    const res = await sender.job(KEY, 'wh_does_not_exist')
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('not_found')
  })

  test('repeat with the same Idempotency-Key returns the same job, enqueued only once', async () => {
    sender = await startWebhookSender(baseCheck)
    const headers = { 'Idempotency-Key': 'idem-1' }
    const first = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' }, headers)
    const second = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' }, headers)
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect((await second.json()).jobId).toBe((await first.json()).jobId)
    expect(sender.producer.send).toHaveBeenCalledTimes(1)
  })

  test('exceeding the rate limit returns 429 with rate-limit headers', async () => {
    // rateLimitMax=2: the sliding window already flags the 2nd request in its own window as the limit hit.
    sender = await startWebhookSender(baseCheck, { rateLimitMax: 2, rateLimitWindowMs: 60000 })
    const first = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' })
    expect(first.status).toBe(202)

    const second = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' })
    expect(second.status).toBe(429)
    expect((await second.json()).error).toBe('rate_limited')
    expect(second.headers.get('retry-after')).not.toBeNull()
    expect(second.headers.get('x-ratelimit-limit')).toBe('2')
    expect(second.headers.get('x-ratelimit-remaining')).toBe('0')
  })

  test('an unknown key is rate-limited too, so the account service cannot be used as an oracle', async () => {
    sender = await startWebhookSender(null, { rateLimitMax: 2, rateLimitWindowMs: 60000 })
    const first = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' })
    expect(first.status).toBe(401)

    const second = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' })
    expect(second.status).toBe(429)
    // Two attempts, one verify: the rejected one never reached the account service.
    expect(sender.verifyApiKey).toHaveBeenCalledTimes(1)
  })

  test('a job is readable by the key that created it, not by another key in the same workspace', async () => {
    sender = await startWebhookSender(baseCheck)
    const { jobId } = await (await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' })).json()
    expect((await sender.job(KEY, jobId)).status).toBe(200)

    // Same server, same store, same workspace - only the key differs.
    sender.setCheck({ ...baseCheck, keyId: 'key_2' })
    expect((await sender.job('fus_ws1_other', jobId)).status).toBe(404)
  })

  test('a failed enqueue leaves no job behind', async () => {
    sender = await startWebhookSender(baseCheck)
    sender.producer.send.mockRejectedValueOnce(new Error('queue down'))
    const res = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('internal_error')
  })

  test('a path key hits its stricter limit before the same key would via the header', async () => {
    sender = await startWebhookSender(baseCheck, { rateLimitMax: 10, rateLimitWindowMs: 60000, rateLimitPathMax: 2 })
    // Header route: two calls stay well under the looser header-key limit.
    const h1 = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' })
    const h2 = await sender.action(KEY, { action: 'issue:create', space: 'FUSIO' })
    expect(h1.status).toBe(202)
    expect(h2.status).toBe(202)

    // Path route, same key: same action succeeds once, then the stricter path limit trips.
    const p1 = await sender.pathKey(KEY, { action: 'issue:create', space: 'FUSIO' })
    const p2 = await sender.pathKey(KEY, { action: 'issue:create', space: 'FUSIO' })
    expect(p1.status).toBe(202)
    expect(p2.status).toBe(429)
  })
})

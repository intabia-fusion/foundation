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

jest.mock('../workspaceClient', () => ({
  getTransactorTarget: jest.fn()
}))

/* eslint-disable import/first */
import setting from '@hcengineering/setting'
import { processJob } from '../consumer'
import { getTransactorTarget } from '../workspaceClient'
import { WebhookStore } from '../store'
import type { WebhookJobMessage } from '../types'
/* eslint-enable import/first */

const newCtx = (): any => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })

function baseJob (overrides: Partial<WebhookJobMessage> = {}): WebhookJobMessage {
  return {
    jobId: 'wh_1',
    workspace: 'ws-1' as any,
    keyId: 'key_1',
    name: 'ci',
    socialId: 'social_1' as any,
    personUuid: 'person_1' as any,
    action: 'issue:create',
    ops: ['issue:create'],
    spaces: [],
    payload: { space: 'FUSIO', title: 'Title', description: 'hello' },
    receivedAt: Date.now(),
    attempt: 0,
    ...overrides
  }
}

const testConfig: any = { TransactorTimeoutMs: 30000 }

function mockTarget (uploadMarkup: jest.Mock = jest.fn().mockResolvedValue('blob-ref-1')): any {
  return { token: 'key-token', transactorUrl: 'http://transactor.local', rest: { uploadMarkup } }
}

describe('processJob', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  test('uploads the markdown field and POSTs to the transactor ops route with the key token', async () => {
    const uploadMarkup = jest.fn().mockResolvedValue('blob-ref-1')
    ;(getTransactorTarget as jest.Mock).mockResolvedValue(mockTarget(uploadMarkup))
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ identifier: 'FUSIO-1' }) })
    ;(global as any).fetch = fetchMock

    const store = new WebhookStore()
    store.createJob('wh_1', 'ws-1' as any, 'key_1')
    const queue: any = { getProducer: jest.fn() }

    await processJob(newCtx(), testConfig, queue, store, baseJob())

    expect(uploadMarkup).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://transactor.local/api/v1/ops/issue:create/ws-1')
    expect(init.headers.Authorization).toBe('Bearer key-token')
    const sentBody = JSON.parse(init.body)
    expect(sentBody.descriptionRef).toBe('blob-ref-1')
    expect(sentBody.description).toBeUndefined()

    const job = store.getJob('wh_1')
    expect(job?.status).toBe('done')
    expect(job?.result).toEqual({ identifier: 'FUSIO-1' })
  })

  test('a raw markdown body field is forwarded unchanged, not uploaded', async () => {
    const uploadMarkup = jest.fn().mockResolvedValue('blob-ref-1')
    ;(getTransactorTarget as jest.Mock).mockResolvedValue(mockTarget(uploadMarkup))
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ identifier: 'FUSIO-1' }) })
    ;(global as any).fetch = fetchMock

    const store = new WebhookStore()
    store.createJob('wh_body', 'ws-1' as any, 'key_1')
    const queue: any = { getProducer: jest.fn() }

    await processJob(
      newCtx(),
      testConfig,
      queue,
      store,
      baseJob({ jobId: 'wh_body', payload: { space: 'FUSIO', title: 'Title', body: '# Hello' } })
    )

    expect(uploadMarkup).not.toHaveBeenCalled()
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body).body).toBe('# Hello')
  })

  test('an unknown action fails the job without calling the transactor', async () => {
    const store = new WebhookStore()
    store.createJob('wh_2', 'ws-1' as any, 'key_1')
    const queue: any = { getProducer: jest.fn() }

    await processJob(
      newCtx(),
      testConfig,
      queue,
      store,
      baseJob({ jobId: 'wh_2', action: 'bogus:op' as any, attempt: 5 })
    )

    expect(getTransactorTarget).not.toHaveBeenCalled()
    const job = store.getJob('wh_2')
    expect(job?.status).toBe('failed')
    expect(job?.error).toContain('unknown action')
  })

  test('a 4xx transactor response fails the job immediately, no retry scheduled', async () => {
    ;(getTransactorTarget as jest.Mock).mockResolvedValue(mockTarget())
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' })
    ;(global as any).fetch = fetchMock

    const store = new WebhookStore()
    store.createJob('wh_3', 'ws-1' as any, 'key_1')
    const queue: any = { getProducer: jest.fn() }

    // attempt: 0 - a genuine first try, to prove the 4xx path skips retryOrFail entirely rather than
    // just happening to hit the attempt cap.
    await processJob(newCtx(), testConfig, queue, store, baseJob({ jobId: 'wh_3', attempt: 0 }))

    expect(queue.getProducer).not.toHaveBeenCalled()
    const job = store.getJob('wh_3')
    expect(job?.status).toBe('failed')
    expect(job?.error).toContain('403')
  })

  test('a 5xx transactor response before the attempt cap schedules a retry through time-machine', async () => {
    ;(getTransactorTarget as jest.Mock).mockResolvedValue(mockTarget())
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' })
    ;(global as any).fetch = fetchMock

    const store = new WebhookStore()
    store.createJob('wh_4', 'ws-1' as any, 'key_1')
    const send = jest.fn().mockResolvedValue(undefined)
    const queue: any = { getProducer: jest.fn().mockReturnValue({ send }) }

    await processJob(newCtx(), testConfig, queue, store, baseJob({ jobId: 'wh_4', attempt: 0 }))

    expect(send).toHaveBeenCalledTimes(1)
    const job = store.getJob('wh_4')
    expect(job?.status).toBe('queued') // stays queued until time-machine re-delivers it
  })

  test('a 5xx transactor response dead-letters the job once retries are exhausted', async () => {
    ;(getTransactorTarget as jest.Mock).mockResolvedValue(mockTarget())
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' })
    ;(global as any).fetch = fetchMock

    const store = new WebhookStore()
    store.createJob('wh_5', 'ws-1' as any, 'key_1')
    const queue: any = { getProducer: jest.fn() }

    // attempt >= max retries so the failure dead-letters immediately, no time-machine round trip to mock.
    await processJob(newCtx(), testConfig, queue, store, baseJob({ jobId: 'wh_5', attempt: 5 }))

    const job = store.getJob('wh_5')
    expect(job?.status).toBe('failed')
    expect(job?.error).toContain('500')
  })

  test('a successful job bumps the stat for its operation, keyed by keyId', async () => {
    const findOne = jest.fn().mockResolvedValue(undefined)
    const createDoc = jest.fn().mockResolvedValue('stat-id')
    const updateDoc = jest.fn().mockResolvedValue(undefined)
    ;(getTransactorTarget as jest.Mock).mockResolvedValue({
      token: 'key-token',
      transactorUrl: 'http://transactor.local',
      rest: { uploadMarkup: jest.fn().mockResolvedValue('blob-ref-1'), findOne, createDoc, updateDoc }
    })
    ;(global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ identifier: 'FUSIO-1' }) })

    const store = new WebhookStore()
    store.createJob('wh_stat', 'ws-1' as any, 'key_1')
    const queue: any = { getProducer: jest.fn() }

    await processJob(newCtx(), testConfig, queue, store, baseJob({ jobId: 'wh_stat' }))

    expect(createDoc).toHaveBeenCalledWith(
      setting.class.WebhookStat,
      expect.anything(),
      expect.objectContaining({ direction: 'in', target: 'key_1', type: 'issue:create', count: 1 }),
      'in:key_1:issue:create'
    )
  })

  test('a failed job does not bump the stat - only a completed operation counts as received', async () => {
    const findOne = jest.fn().mockResolvedValue(undefined)
    const createDoc = jest.fn().mockResolvedValue('stat-id')
    const updateDoc = jest.fn().mockResolvedValue(undefined)
    ;(getTransactorTarget as jest.Mock).mockResolvedValue({
      token: 'key-token',
      transactorUrl: 'http://transactor.local',
      rest: { uploadMarkup: jest.fn(), findOne, createDoc, updateDoc }
    })
    ;(global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' })

    const store = new WebhookStore()
    store.createJob('wh_stat_fail', 'ws-1' as any, 'key_1')
    const queue: any = { getProducer: jest.fn() }

    await processJob(newCtx(), testConfig, queue, store, baseJob({ jobId: 'wh_stat_fail', attempt: 0 }))

    expect(store.getJob('wh_stat_fail')?.status).toBe('failed')
    expect(createDoc).not.toHaveBeenCalled()
    expect(updateDoc).not.toHaveBeenCalled()
  })
})

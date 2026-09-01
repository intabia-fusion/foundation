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
jest.mock('../ssrf', () => ({ ...jest.requireActual('../ssrf'), safeFetch: jest.fn() }))
jest.mock('../notify', () => ({ notifyOwnerDisabled: jest.fn() }))

/* eslint-disable import/first */
import setting, { type WebhookEndpoint } from '@hcengineering/setting'
import { processDelivery, recordDeliveryOutcome } from '../delivery'
import { notifyOwnerDisabled } from '../notify'
import { safeFetch } from '../ssrf'
import type { WebhookDeliveryMessage } from '../types'
import { getSystemTransactorTarget } from '../workspaceClient'
/* eslint-enable import/first */

const newCtx = (): any => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })

function baseJob (overrides: Partial<WebhookDeliveryMessage> = {}): WebhookDeliveryMessage {
  return {
    deliveryId: 'msg_1',
    workspace: 'ws-1' as any,
    endpointId: 'ep_1' as any,
    event: {
      action: 'create',
      type: 'issue.created',
      actor: 'social_1' as any,
      data: { id: 'FUSIO-1' },
      organizationId: 'ws-1' as any
    },
    attempt: 0,
    ...overrides
  }
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

function mockTarget (
  endpoint: WebhookEndpoint | undefined,
  updateDoc: jest.Mock = jest.fn().mockResolvedValue(undefined)
): any {
  return {
    token: 'sys-token',
    transactorUrl: 'http://transactor.local',
    rest: {
      // Two reads on a failure path: the endpoint, then the count $inc just wrote.
      findOne: jest
        .fn()
        .mockResolvedValueOnce(endpoint)
        .mockResolvedValue(
          endpoint === undefined ? undefined : { ...endpoint, failureCount: (endpoint.failureCount ?? 0) + 1 }
        ),
      updateDoc,
      createDoc: jest.fn().mockResolvedValue('delivery-doc-id'),
      findAll: jest.fn().mockResolvedValue([]),
      removeDoc: jest.fn().mockResolvedValue(undefined)
    }
  }
}

const CONFIG: any = {
  WebhookDeliveryTimeoutMs: 10000,
  WebhookMaxResponseBytes: 65536,
  AllowInsecureWebhookHttp: false,
  WebhookDisableAfterFailures: 3
}

describe('processDelivery', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  test('skips a disabled or missing endpoint without calling safeFetch', async () => {
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(mockTarget(undefined))
    const queue: any = { getProducer: jest.fn() }

    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob())

    expect(safeFetch).not.toHaveBeenCalled()
  })

  test('a 2xx response resets the failure counter and records the delivery time', async () => {
    const updateDoc = jest.fn().mockResolvedValue(undefined)
    const target = mockTarget(baseEndpoint({ failureCount: 2 }), updateDoc)
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(target)
    ;(safeFetch as jest.Mock).mockResolvedValue({ status: 200, body: '{}' })
    const queue: any = { getProducer: jest.fn() }

    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob())

    expect(updateDoc).toHaveBeenCalledWith(
      setting.class.WebhookEndpoint,
      expect.anything(),
      'ep_1',
      expect.objectContaining({ failureCount: 0 })
    )
    expect(target.rest.createDoc).toHaveBeenCalledWith(
      setting.class.WebhookDelivery,
      expect.anything(),
      expect.objectContaining({ endpoint: 'ep_1', deliveryId: 'msg_1', attempt: 0, status: 200 })
    )
  })

  test('a 400 response fails permanently, no retry scheduled', async () => {
    const updateDoc = jest.fn().mockResolvedValue(undefined)
    const target = mockTarget(baseEndpoint(), updateDoc)
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(target)
    ;(safeFetch as jest.Mock).mockResolvedValue({ status: 400, body: 'bad request' })
    const queue: any = { getProducer: jest.fn() }

    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob())

    expect(queue.getProducer).not.toHaveBeenCalled()
    expect(updateDoc).toHaveBeenCalledWith(
      setting.class.WebhookEndpoint,
      expect.anything(),
      'ep_1',
      expect.objectContaining({ $inc: { failureCount: 1 } })
    )
    expect(target.rest.createDoc).toHaveBeenCalledWith(
      setting.class.WebhookDelivery,
      expect.anything(),
      expect.objectContaining({ endpoint: 'ep_1', deliveryId: 'msg_1', attempt: 0, error: 'http 400' })
    )
  })

  test('a 500 response before the attempt cap schedules a retry through time-machine, endpoint untouched', async () => {
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(mockTarget(baseEndpoint()))
    ;(safeFetch as jest.Mock).mockResolvedValue({ status: 500, body: 'boom' })
    const send = jest.fn().mockResolvedValue(undefined)
    const queue: any = { getProducer: jest.fn().mockReturnValue({ send }) }

    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob({ attempt: 0 }))

    expect(send).toHaveBeenCalledTimes(1)
    const [, , [scheduled]] = send.mock.calls[0]
    expect(scheduled.id).toBe('msg_1') // same deliveryId across retries
    expect(scheduled.data.attempt).toBe(1)
  })

  test('sends the correct delivery-id and attempt headers, and a Standard Webhooks signature', async () => {
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(mockTarget(baseEndpoint()))
    ;(safeFetch as jest.Mock).mockResolvedValue({ status: 200, body: '{}' })
    const queue: any = { getProducer: jest.fn() }

    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob({ attempt: 2 }))

    const [url, opts] = (safeFetch as jest.Mock).mock.calls[0]
    expect(url).toBe('https://receiver.example/hook')
    expect(opts.headers['X-Webhook-Delivery-Id']).toBe('msg_1')
    expect(opts.headers['X-Webhook-Attempt']).toBe('3')
    expect(opts.headers['webhook-id']).toBe('msg_1')
    expect(opts.headers['webhook-signature']).toMatch(/^v1,/)
    const sentBody = JSON.parse(opts.body)
    expect(sentBody.webhookId).toBe('msg_1')
    expect(sentBody.data).toEqual({ id: 'FUSIO-1' })
  })

  test('disables the endpoint and notifies the owner once failureCount reaches the configured threshold', async () => {
    const updateDoc = jest.fn().mockResolvedValue(undefined)
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(
      mockTarget(baseEndpoint({ failureCount: 2 }), updateDoc)
    )
    ;(safeFetch as jest.Mock).mockResolvedValue({ status: 400, body: 'bad' })
    const queue: any = { getProducer: jest.fn() }

    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob())

    expect(updateDoc).toHaveBeenCalledWith(
      setting.class.WebhookEndpoint,
      expect.anything(),
      'ep_1',
      expect.objectContaining({ $inc: { failureCount: 1 } })
    )
    expect(updateDoc).toHaveBeenCalledWith(setting.class.WebhookEndpoint, expect.anything(), 'ep_1', { enabled: false })
    expect(notifyOwnerDisabled).toHaveBeenCalledTimes(1)
  })

  test('does not disable or notify while under the failure threshold', async () => {
    const updateDoc = jest.fn().mockResolvedValue(undefined)
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(
      mockTarget(baseEndpoint({ failureCount: 0 }), updateDoc)
    )
    ;(safeFetch as jest.Mock).mockResolvedValue({ status: 400, body: 'bad' })
    const queue: any = { getProducer: jest.fn() }

    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob())

    expect(updateDoc).toHaveBeenCalledWith(
      setting.class.WebhookEndpoint,
      expect.anything(),
      'ep_1',
      expect.not.objectContaining({ enabled: false })
    )
    expect(notifyOwnerDisabled).not.toHaveBeenCalled()
  })

  test('a 500 response that exhausts every retry finalizes as a failure', async () => {
    const updateDoc = jest.fn().mockResolvedValue(undefined)
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(mockTarget(baseEndpoint(), updateDoc))
    ;(safeFetch as jest.Mock).mockResolvedValue({ status: 500, body: 'boom' })
    const queue: any = { getProducer: jest.fn() }

    // attempt already at the cap - no time-machine round trip to mock.
    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob({ attempt: 5 }))

    expect(queue.getProducer).not.toHaveBeenCalled()
    expect(updateDoc).toHaveBeenCalledWith(
      setting.class.WebhookEndpoint,
      expect.anything(),
      'ep_1',
      expect.objectContaining({ $inc: { failureCount: 1 } })
    )
  })

  test('an SsrfError from safeFetch fails permanently, no retry scheduled', async () => {
    const updateDoc = jest.fn().mockResolvedValue(undefined)
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(mockTarget(baseEndpoint(), updateDoc))
    const { SsrfError } = jest.requireActual('../ssrf')
    ;(safeFetch as jest.Mock).mockRejectedValue(new SsrfError('address 10.0.0.5 is not allowed'))
    const queue: any = { getProducer: jest.fn() }

    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob())

    expect(queue.getProducer).not.toHaveBeenCalled()
    expect(updateDoc).toHaveBeenCalledWith(
      setting.class.WebhookEndpoint,
      expect.anything(),
      'ep_1',
      expect.objectContaining({ $inc: { failureCount: 1 }, lastError: expect.stringContaining('not allowed') })
    )
  })

  test('a network error (not SsrfError) retries', async () => {
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(mockTarget(baseEndpoint()))
    ;(safeFetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'))
    const send = jest.fn().mockResolvedValue(undefined)
    const queue: any = { getProducer: jest.fn().mockReturnValue({ send }) }

    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob({ attempt: 0 }))

    expect(send).toHaveBeenCalledTimes(1)
  })

  test('a successful delivery bumps the stat once for its event type', async () => {
    const updateDoc = jest.fn().mockResolvedValue(undefined)
    const target = mockTarget(baseEndpoint(), updateDoc)
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(target)
    ;(safeFetch as jest.Mock).mockResolvedValue({ status: 200, body: '{}' })
    const queue: any = { getProducer: jest.fn() }

    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob())

    const statCalls = updateDoc.mock.calls.filter((c) => c[0] === setting.class.WebhookStat)
    expect(statCalls).toHaveLength(1)
    expect(statCalls[0][2]).toBe('out:ep_1:issue.created')
    expect(statCalls[0][3]).toEqual(expect.objectContaining({ $inc: { count: 1 } }))
  })

  test('a retried delivery that eventually succeeds bumps the stat once, not once per attempt', async () => {
    const updateDoc = jest.fn().mockResolvedValue(undefined)
    const target = mockTarget(baseEndpoint(), updateDoc)
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(target)
    const send = jest.fn().mockResolvedValue(undefined)
    const queue: any = { getProducer: jest.fn().mockReturnValue({ send }) }

    // attempt 0: transient failure, only a retry is scheduled - no stat write yet.
    ;(safeFetch as jest.Mock).mockResolvedValueOnce({ status: 500, body: 'boom' })
    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob({ attempt: 0 }))

    // attempt 1: succeeds - the only stat write for this delivery.
    ;(safeFetch as jest.Mock).mockResolvedValueOnce({ status: 200, body: '{}' })
    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob({ attempt: 1 }))

    const statCalls = updateDoc.mock.calls.filter((c) => c[0] === setting.class.WebhookStat)
    expect(statCalls).toHaveLength(1)
  })

  test('a permanent failure records the outcome but does not count as delivered', async () => {
    const updateDoc = jest.fn().mockResolvedValue(undefined)
    const target = mockTarget(baseEndpoint(), updateDoc)
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(target)
    ;(safeFetch as jest.Mock).mockResolvedValue({ status: 400, body: 'bad request' })
    const queue: any = { getProducer: jest.fn() }

    await processDelivery(newCtx(), CONFIG, queue, {} as any, baseJob())

    expect(updateDoc.mock.calls.filter((c) => c[0] === setting.class.WebhookStat)).toHaveLength(0)
    expect(target.rest.createDoc).toHaveBeenCalledWith(
      setting.class.WebhookDelivery,
      expect.anything(),
      expect.objectContaining({ error: expect.anything() })
    )
  })

  test('a failed stat write does not fail the delivery', async () => {
    const updateDoc = jest.fn().mockResolvedValue(undefined)
    const findOne = jest.fn((cls: any) => {
      if (cls === setting.class.WebhookStat) return Promise.reject(new Error('stat lookup down'))
      return Promise.resolve(baseEndpoint())
    })
    const target = mockTarget(baseEndpoint(), updateDoc)
    target.rest.findOne = findOne
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue(target)
    ;(safeFetch as jest.Mock).mockResolvedValue({ status: 200, body: '{}' })
    const queue: any = { getProducer: jest.fn() }
    const ctx = newCtx()

    await expect(processDelivery(ctx, CONFIG, queue, {} as any, baseJob())).resolves.toBeUndefined()

    // The real delivery work still happened.
    expect(updateDoc).toHaveBeenCalledWith(
      setting.class.WebhookEndpoint,
      expect.anything(),
      'ep_1',
      expect.objectContaining({ failureCount: 0 })
    )
    expect(target.rest.createDoc).toHaveBeenCalledWith(
      setting.class.WebhookDelivery,
      expect.anything(),
      expect.objectContaining({ deliveryId: 'msg_1' })
    )
    expect(ctx.error).toHaveBeenCalledWith('webhook stat bump failed', expect.objectContaining({ direction: 'out' }))
  })
})

describe('recordDeliveryOutcome', () => {
  test('leaves history untouched at or under the cap', async () => {
    const rest: any = {
      createDoc: jest.fn().mockResolvedValue('id'),
      findAll: jest.fn().mockResolvedValue(new Array(20).fill({ _id: 'old' })),
      removeDoc: jest.fn().mockResolvedValue(undefined)
    }

    await recordDeliveryOutcome(rest, 'ep_1' as any, { deliveryId: 'msg_1', attempt: 0, status: 200 })

    expect(rest.removeDoc).not.toHaveBeenCalled()
  })

  test('trims the oldest entry once past the cap', async () => {
    const oldest = { _id: 'oldest' }
    const rest: any = {
      createDoc: jest.fn().mockResolvedValue('id'),
      findAll: jest.fn().mockResolvedValue([...new Array(20).fill({ _id: 'recent' }), oldest]),
      removeDoc: jest.fn().mockResolvedValue(undefined)
    }

    await recordDeliveryOutcome(rest, 'ep_1' as any, { deliveryId: 'msg_1', attempt: 0, status: 200 })

    expect(rest.removeDoc).toHaveBeenCalledWith(setting.class.WebhookDelivery, expect.anything(), 'oldest')
  })
})

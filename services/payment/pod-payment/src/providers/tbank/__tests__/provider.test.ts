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

import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import { AccountClient, SubscriptionType } from '@hcengineering/account-client'
import { TbankProvider } from '../provider'
import { ProviderHttpError } from '../../index'

function mockResponse (opts: { ok: boolean, status?: number, json?: any, text?: string }): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: jest.fn().mockResolvedValue(opts.json),
    text: jest.fn().mockResolvedValue(opts.text ?? JSON.stringify(opts.json ?? {}))
  } as unknown as Response
}

describe('TbankProvider', () => {
  const tbankUrl = 'https://tbank-subscriptions.test'

  let accountClient: jest.Mocked<AccountClient>
  let ctx: jest.Mocked<MeasureContext>
  let fetchMock: jest.Mock

  beforeEach(() => {
    accountClient = {
      getSubscriptions: jest.fn(),
      getSubscriptionsByProvider: jest.fn(),
      upsertSubscription: jest.fn()
    } as any

    ctx = {
      info: jest.fn(),
      error: jest.fn(),
      with: jest.fn()
    } as any

    fetchMock = jest.fn()
    global.fetch = fetchMock as any

    jest.clearAllMocks()
  })

  describe('createSubscription', () => {
    const request = {
      type: SubscriptionType.Tier,
      plan: 'common',
      customerEmail: 'user@example.test',
      quantity: 3,
      period: 'monthly' as const
    }
    const workspaceUuid = 'workspace-uuid' as WorkspaceUuid
    const workspaceUrl = 'ws1'
    const accountUuid = 'account-uuid'

    test('happy path returns checkoutId and checkoutUrl', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(
        mockResponse({ ok: true, json: { checkoutId: 'chk_1', checkoutUrl: 'https://tbank.test/pay' } })
      )

      const result = await provider.createSubscription(ctx, request, workspaceUuid, workspaceUrl, accountUuid)

      expect(result).toEqual({ checkoutId: 'chk_1', checkoutUrl: 'https://tbank.test/pay' })
      expect(fetchMock).toHaveBeenCalledWith(
        `${tbankUrl}/api/v1/subscriptions`,
        expect.objectContaining({ method: 'POST' })
      )
    })

    test('sends Authorization header with service token', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: true, json: { checkoutId: 'chk_1', checkoutUrl: 'url' } }))

      await provider.createSubscription(ctx, request, workspaceUuid, workspaceUrl, accountUuid)

      const init = fetchMock.mock.calls[0][1]
      expect(init.headers.Authorization).toMatch(/^Bearer .+/)
    })

    test('non-ok response with JSON body throws ProviderHttpError with status and reason', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 409, json: { reason: 'other_checkout_active' } }))

      await expect(
        provider.createSubscription(ctx, request, workspaceUuid, workspaceUrl, accountUuid)
      ).rejects.toMatchObject({
        status: 409,
        reason: 'other_checkout_active'
      })
    })

    test('non-ok response with non-JSON body throws ProviderHttpError without reason', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500, text: 'internal error' }))

      let error: ProviderHttpError | undefined
      try {
        await provider.createSubscription(ctx, request, workspaceUuid, workspaceUrl, accountUuid)
      } catch (err) {
        error = err as ProviderHttpError
      }

      expect(error).toBeInstanceOf(ProviderHttpError)
      expect(error?.status).toBe(500)
      expect(error?.reason).toBeUndefined()
    })
  })

  describe('getSubscription', () => {
    test('returns null on 404', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 404 }))

      const result = await provider.getSubscription(ctx, 'sub_1')

      expect(result).toBeNull()
    })

    test('throws on other non-ok status', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500, text: 'boom' }))

      await expect(provider.getSubscription(ctx, 'sub_1')).rejects.toThrow()
    })

    test('sends Authorization header with service token', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: true, json: { id: 'sub_1' } }))

      await provider.getSubscription(ctx, 'sub_1')

      const init = fetchMock.mock.calls[0][1]
      expect(init.headers.Authorization).toMatch(/^Bearer .+/)
    })
  })

  describe('getSubscriptionByCheckout', () => {
    test('returns null on 404', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 404 }))

      const result = await provider.getSubscriptionByCheckout(ctx, 'chk_1')

      expect(result).toBeNull()
    })

    test('throws on other non-ok status', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500, text: 'boom' }))

      await expect(provider.getSubscriptionByCheckout(ctx, 'chk_1')).rejects.toThrow()
    })
  })

  describe('cancelSubscription', () => {
    test('throws on non-ok', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500, text: 'boom' }))

      await expect(provider.cancelSubscription(ctx, 'sub_1')).rejects.toThrow()
    })

    test('returns subscription data on success', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: true, json: { id: 'sub_1', status: 'canceled' } }))

      const result = await provider.cancelSubscription(ctx, 'sub_1')

      expect(result).toEqual({ id: 'sub_1', status: 'canceled' })
    })
  })

  describe('uncancelSubscription', () => {
    test('throws on non-ok', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500, text: 'boom' }))

      await expect(provider.uncancelSubscription(ctx, 'sub_1')).rejects.toThrow()
    })
  })

  describe('updateSubscriptionPlan', () => {
    test('throws on non-ok', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500, text: 'boom' }))

      await expect(
        provider.updateSubscriptionPlan(ctx, 'sub_1', 'epic', SubscriptionType.Tier, 'ws1', 'acc-1')
      ).rejects.toThrow()
    })

    test('throws ProviderHttpError preserving status + body on a 402 (declined card)', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 402, text: '{"error":"declined"}' }))

      let error: ProviderHttpError | undefined
      try {
        await provider.updateSubscriptionPlan(ctx, 'sub_1', 'epic', SubscriptionType.Tier, 'ws1', 'acc-1')
      } catch (err) {
        error = err as ProviderHttpError
      }
      expect(error).toBeInstanceOf(ProviderHttpError)
      expect(error?.status).toBe(402)
      expect(error?.body).toBe('{"error":"declined"}')
    })

    // force must reach pod-tbank: without it a claim conflict answers 409 other_checkout_active again.
    test('forwards force to pod-tbank so a forced switch can cancel the pending checkout', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: true, json: { checkoutUrl: 'https://tbank.test/pay' } }))

      await provider.updateSubscriptionPlan(
        ctx,
        'sub_1',
        'pkg_500gb',
        SubscriptionType.Package,
        'ws1',
        'acc-1',
        undefined,
        'monthly',
        true,
        true
      )

      const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
      expect(body.force).toBe(true)
      // Guard the neighbours: force is appended last, nothing may shift onto recurrent.
      expect(body.recurrent).toBe(true)
      expect(body.period).toBe('monthly')
    })
  })

  describe('retryPayment', () => {
    test('returns null on 404', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 404 }))

      const result = await provider.retryPayment(ctx, 'sub_1')

      expect(result).toBeNull()
    })

    test('throws on other non-ok status', async () => {
      const provider = new TbankProvider(tbankUrl, accountClient)
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500, text: 'boom' }))

      await expect(provider.retryPayment(ctx, 'sub_1')).rejects.toThrow()
    })
  })
})

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

import type { Request, Response } from 'express'
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks'
import { handlePolarWebhook } from '../webhook'
import { transformPolarSubscriptionToData } from '../utils'

jest.mock('@polar-sh/sdk/webhooks', () => ({
  validateEvent: jest.fn(),
  WebhookVerificationError: class WebhookVerificationError extends Error {}
}))
jest.mock('../utils', () => ({
  transformPolarSubscriptionToData: jest.fn()
}))

describe('handlePolarWebhook', () => {
  const accountsUrl = 'https://accounts.example.test'
  const serviceToken = 'service-token'
  const webhookSecret = 'whsec_123'

  let ctx: any
  let req: Partial<Request>
  let res: Partial<Response>
  let jsonMock: jest.Mock
  let statusMock: jest.Mock
  let publish: jest.Mock

  beforeEach(() => {
    ctx = { info: jest.fn(), error: jest.fn() }

    jsonMock = jest.fn()
    statusMock = jest.fn().mockImplementation(() => ({ json: jsonMock }))

    req = {
      body: Buffer.from('payload'),
      headers: { 'webhook-signature': 'sig' }
    }
    res = { status: statusMock }

    publish = jest.fn().mockResolvedValue(undefined)

    jest.clearAllMocks()
  })

  test('returns 403 on invalid signature', async () => {
    ;(validateEvent as jest.Mock).mockImplementation(() => {
      throw new WebhookVerificationError('bad signature')
    })

    await handlePolarWebhook(ctx, accountsUrl, serviceToken, webhookSecret, req as Request, res as Response, publish)

    expect(statusMock).toHaveBeenCalledWith(403)
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Invalid signature' })
  })

  test('returns 400 on empty body', async () => {
    req.body = Buffer.alloc(0)

    await handlePolarWebhook(ctx, accountsUrl, serviceToken, webhookSecret, req as Request, res as Response, publish)

    expect(statusMock).toHaveBeenCalledWith(400)
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Invalid body' })
    expect(validateEvent).not.toHaveBeenCalled()
  })

  test.each(['subscription.created', 'subscription.updated', 'subscription.canceled'])(
    '%s publishes subscription data',
    async (type) => {
      const subscription = { id: 'sub_1', status: 'active' }
      ;(validateEvent as jest.Mock).mockReturnValue({ type, data: subscription })
      ;(transformPolarSubscriptionToData as jest.Mock).mockReturnValue({ id: 'polar_sub_1', status: 'active' })

      await handlePolarWebhook(ctx, accountsUrl, serviceToken, webhookSecret, req as Request, res as Response, publish)

      // handler runs the publish in a fire-and-forget microtask
      await Promise.resolve()
      await Promise.resolve()

      expect(publish).toHaveBeenCalledWith(ctx, { id: 'polar_sub_1', status: 'active' }, 'webhook')
      expect(statusMock).toHaveBeenCalledWith(202)
      expect(jsonMock).toHaveBeenCalledWith({ received: true })
    }
  )

  test('unknown event type is a no-op and returns 202', async () => {
    ;(validateEvent as jest.Mock).mockReturnValue({ type: 'order.created', data: {} })

    await handlePolarWebhook(ctx, accountsUrl, serviceToken, webhookSecret, req as Request, res as Response, publish)

    expect(publish).not.toHaveBeenCalled()
    expect(statusMock).toHaveBeenCalledWith(202)
    expect(jsonMock).toHaveBeenCalledWith({ received: true })
  })
})

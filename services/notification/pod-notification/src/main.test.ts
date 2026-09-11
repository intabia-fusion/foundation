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

import webpush, { WebPushError } from 'web-push'
import core, { type Ref, type AccountUuid, type PersonId } from '@hcengineering/core'
import notification, { type PushSubscription } from '@hcengineering/notification'

import { sendPushToSubscription } from './main'

jest.mock('./config', () => ({
  default: {
    Source: 'test-source',
    PushPublicKey: 'test-key',
    PushPrivateKey: 'test-private-key',
    PushSubject: 'mailto:test@example.com',
    TTL: 86400,
    ServiceId: 'web-push-service',
    AccountsUrl: 'http://localhost:3000',
    Secret: 'secret'
  }
}))

jest.mock('web-push', () => {
  class WebPushError extends Error {
    statusCode: number
    headers: Record<string, string>
    body: string | null | undefined
    endpoint: string
    constructor (
      message: string,
      statusCode: number,
      headers: Record<string, string>,
      body: string | null | undefined,
      endpoint: string
    ) {
      super(message)
      this.name = 'WebPushError'
      this.statusCode = statusCode
      this.headers = headers
      this.body = body
      this.endpoint = endpoint
    }
  }
  return {
    sendNotification: jest.fn(),
    setVapidDetails: jest.fn(),
    WebPushError
  }
})

describe('sendPushToSubscription', () => {
  const mockSubscriptions: PushSubscription[] = [
    {
      _id: 'sub-1' as Ref<PushSubscription>,
      _class: notification.class.PushSubscription,
      space: core.space.Workspace,
      user: 'user-1' as AccountUuid,
      endpoint: 'https://example.com/endpoint1',
      keys: { p256dh: 'dh1', auth: 'auth1' },
      modifiedOn: 0,
      modifiedBy: 'system' as PersonId
    },
    {
      _id: 'sub-2' as Ref<PushSubscription>,
      _class: notification.class.PushSubscription,
      space: core.space.Workspace,
      user: 'user-1' as AccountUuid,
      endpoint: 'https://example.com/endpoint2',
      keys: { p256dh: 'dh2', auth: 'auth2' },
      modifiedOn: 0,
      modifiedBy: 'system' as PersonId
    }
  ]

  const mockData = {
    title: 'Test Title',
    body: 'Test Body'
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should successfully send notifications and return no failed subscription IDs', async () => {
    ;(webpush.sendNotification as jest.Mock).mockResolvedValue({})

    const failedIds = await sendPushToSubscription(mockSubscriptions, mockData)

    expect(failedIds).toEqual([])
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2)
  })

  it('should return subscription IDs for expired or unregistered subscriptions', async () => {
    ;(webpush.sendNotification as jest.Mock)
      .mockRejectedValueOnce(
        new WebPushError('Subscription expired', 410, {}, '{"code": "expired"}', 'https://example.com/endpoint1')
      )
      .mockRejectedValueOnce(
        new WebPushError(
          'Unregistered subscription',
          404,
          {},
          '{"message": "Unregistered"}',
          'https://example.com/endpoint2'
        )
      )

    const failedIds = await sendPushToSubscription(mockSubscriptions, mockData)

    expect(failedIds).toEqual(['sub-1', 'sub-2'])
  })

  it('should return subscription IDs for VAPID key mismatch errors', async () => {
    ;(webpush.sendNotification as jest.Mock).mockRejectedValueOnce(
      new WebPushError(
        'VAPID key mismatch',
        400,
        {},
        '{"reason":"VapidPkHashMismatch"}',
        'https://example.com/endpoint1'
      )
    )

    const failedIds = await sendPushToSubscription([mockSubscriptions[0]], mockData)

    expect(failedIds).toEqual(['sub-1'])
  })

  it('should return no subscription IDs for other non-cleanup WebPush errors', async () => {
    ;(webpush.sendNotification as jest.Mock).mockRejectedValue(
      new WebPushError('Quota exceeded', 429, {}, '{"code": "quotaExceeded"}', 'https://example.com/endpoint1')
    )

    const failedIds = await sendPushToSubscription(mockSubscriptions, mockData)

    expect(failedIds).toEqual([])
  })

  it('should handle undefined body in WebPushError gracefully without throwing a TypeError', async () => {
    const errorWithNullBody = new WebPushError('Bad request', 400, {}, 'bad-body', 'https://example.com/endpoint1')
    ;(errorWithNullBody as { body: string | undefined }).body = undefined
    ;(webpush.sendNotification as jest.Mock).mockRejectedValue(errorWithNullBody)

    const failedIds = await sendPushToSubscription(mockSubscriptions, mockData)

    expect(failedIds).toEqual([])
  })

  it('should handle non-WebPush errors gracefully and return empty list', async () => {
    ;(webpush.sendNotification as jest.Mock).mockRejectedValue(new Error('Network connection timeout'))

    const failedIds = await sendPushToSubscription(mockSubscriptions, mockData)

    expect(failedIds).toEqual([])
  })
})

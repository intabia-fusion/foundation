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

import { generateWebhookSecret } from '@hcengineering/setting'
import { buildDeliveryHeaders } from '../signature'

const DELIVERY_ID = 'msg_test123'
const TIMESTAMP = 1700000000
const BODY = JSON.stringify({ hello: 'world' })

describe('buildDeliveryHeaders', () => {
  test('signature matches an independently computed HMAC-SHA256', () => {
    // Expected value computed outside this module: base64-decode the secret's payload after `whsec_`
    // and HMAC-SHA256 over `{id}.{timestamp}.{body}`, base64-encoded - the Standard Webhooks recipe.
    const secret = 'whsec_MfKQ9r8GKYqrTwjQPqZk8T4LK2Xw7BiXeQx3AWmy7yQ='
    const expected = 'v1,ItaOG3Mvmik5kau42eyKHR0a0X8IgU1YgkgkuPILiu8='

    const headers = buildDeliveryHeaders(
      { secrets: [{ id: 's1', secret, createdOn: 0 }] },
      DELIVERY_ID,
      TIMESTAMP,
      BODY,
      0
    )

    expect(headers['webhook-id']).toBe(DELIVERY_ID)
    expect(headers['webhook-timestamp']).toBe(String(TIMESTAMP))
    expect(headers['webhook-signature']).toBe(expected)
  })

  test('two active secrets: both signatures present, space-separated, oldest first', () => {
    const secretOld = 'whsec_MfKQ9r8GKYqrTwjQPqZk8T4LK2Xw7BiXeQx3AWmy7yQ='
    const secretNew = 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    const expectedOld = 'v1,ItaOG3Mvmik5kau42eyKHR0a0X8IgU1YgkgkuPILiu8='

    const headers = buildDeliveryHeaders(
      {
        secrets: [
          { id: 'old', secret: secretOld, createdOn: 0 },
          { id: 'new', secret: secretNew, createdOn: 1 }
        ]
      },
      DELIVERY_ID,
      TIMESTAMP,
      BODY,
      0
    )

    const values = headers['webhook-signature'].split(' ')
    expect(values).toHaveLength(2)
    expect(values[0]).toBe(expectedOld)
    expect(values[1]).not.toBe(expectedOld)
  })

  test('delivery id and attempt headers are always present', () => {
    const headers = buildDeliveryHeaders(
      { secrets: [{ id: 's1', secret: 'x', createdOn: 0 }] },
      DELIVERY_ID,
      TIMESTAMP,
      BODY,
      3
    )
    expect(headers['X-Webhook-Delivery-Id']).toBe(DELIVERY_ID)
    expect(headers['X-Webhook-Attempt']).toBe('4') // 1-based
  })
})

describe('generateWebhookSecret', () => {
  test('produces a whsec_-prefixed, unique secret each time', () => {
    const a = generateWebhookSecret()
    const b = generateWebhookSecret()
    expect(a).toMatch(/^whsec_/)
    expect(a).not.toBe(b)
  })
})

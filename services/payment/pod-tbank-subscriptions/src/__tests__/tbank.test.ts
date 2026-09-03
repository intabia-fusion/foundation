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

import { createHash } from 'crypto'
import TbankPayments, {
  TbankTransportError,
  TBANK_SUCCESS_STATES,
  TBANK_FAILED_STATES,
  describeFetchError
} from '../tbank'

// Every test drives the client through a stubbed global.fetch — no real network, no real terminal.
// This is the only layer that exercises the actual request serialization / signature / response
// parsing of the clean-room client (the pod's own tests stub the client out entirely).

const realFetch = global.fetch

// Build a fetch stub that returns a fixed JSON envelope with HTTP 200.
function mockJson (body: Record<string, any>, status = 200): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  })
}

// Capture the parsed body of the Nth fetch call (0-based).
function sentBody (fetchMock: jest.Mock, call = 0): Record<string, any> {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string)
}

function sentUrl (fetchMock: jest.Mock, call = 0): string {
  return fetchMock.mock.calls[call][0] as string
}

const CONFIG = { merchantId: 'term', secret: 'pass123', apiUrl: 'https://bank.example', retries: 3 }

function client (extra: Record<string, any> = {}): TbankPayments {
  return new TbankPayments({ ...CONFIG, ...extra })
}

afterEach(() => {
  global.fetch = realFetch
  jest.clearAllMocks()
})

// Recompute the reference token independently of the implementation (mirrors the T-Bank algorithm),
// so a subtle regression in generateToken is caught rather than validated against itself.
function referenceToken (fields: Record<string, any>, password: string): string {
  const root: Record<string, string> = { Password: password }
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'Token' || v === undefined || v === null || typeof v === 'object') continue
    root[k] = String(v)
  }
  const concat = Object.keys(root)
    .sort()
    .map((k) => root[k])
    .join('')
  return createHash('sha256').update(concat, 'utf8').digest('hex')
}

describe('constructor', () => {
  test('throws when merchantId is empty', () => {
    expect(() => new TbankPayments({ merchantId: '', secret: 'x' })).toThrow(/required/)
  })

  test('throws when secret is empty', () => {
    expect(() => new TbankPayments({ merchantId: 'x', secret: '' })).toThrow(/required/)
  })

  test('strips a trailing slash from apiUrl', async () => {
    const fetchMock = mockJson({ Success: true, PaymentId: 1, Status: 'NEW' })
    global.fetch = fetchMock as any
    await client({ apiUrl: 'https://bank.example/' }).initPayment({ Amount: 1, OrderId: 'o' })
    expect(sentUrl(fetchMock)).toBe('https://bank.example/v2/Init')
  })
})

describe('generateToken', () => {
  // Locked to a hash computed independently in Node (see referenceToken + the doc spec vector).
  test('matches the known reference vector', () => {
    const token = client().generateToken({
      TerminalKey: 'term',
      Amount: 100000,
      OrderId: 'ord-1',
      Description: 'Test'
    })
    expect(token).toBe('c5277ddceccfffa2a8ff6f3740523f7b8529d53d4ab0f1a8f58dc94f10d91f66')
  })

  test('serializes boolean as "true"/"false"', () => {
    const token = client().generateToken({ SendEmail: true })
    expect(token).toBe('9b09d9bd2c7fa019f6f1f8f71bbda46f10ae391fd31984ae71fe6f5fd6eeab98')
  })

  test('excludes nested objects/arrays, Token, undefined and null', () => {
    const base = { Amount: 100000, OrderId: 'ord-1' }
    const withExtras = {
      ...base,
      Receipt: { Items: [{ Name: 'x' }] }, // nested object — excluded
      DATA: { k: 'v' }, // nested object — excluded
      Token: 'should-not-count', // excluded
      Nothing: undefined, // excluded
      Empty: null // excluded
    }
    expect(client().generateToken(withExtras)).toBe(client().generateToken(base))
  })

  test('is order-independent (keys are sorted before concat)', () => {
    const a = client().generateToken({ Amount: 1, OrderId: 'o', Description: 'd' })
    const b = client().generateToken({ Description: 'd', OrderId: 'o', Amount: 1 })
    expect(a).toBe(b)
  })

  test('depends on the secret (different password -> different token)', () => {
    const t1 = new TbankPayments({ merchantId: 'term', secret: 'pass123' }).generateToken({ Amount: 1 })
    const t2 = new TbankPayments({ merchantId: 'term', secret: 'other' }).generateToken({ Amount: 1 })
    expect(t1).not.toBe(t2)
  })
})

describe('post() envelope', () => {
  test('injects TerminalKey and a computed Token into the request body', async () => {
    const fetchMock = mockJson({ Success: true, PaymentId: 1, Status: 'NEW' })
    global.fetch = fetchMock as any
    await client().initPayment({ Amount: 100000, OrderId: 'ord-1', Description: 'Test' })

    const body = sentBody(fetchMock)
    expect(body.TerminalKey).toBe('term')
    // Token computed over the full body (TerminalKey included), verified against an independent recompute.
    const { Token, ...rest } = body
    expect(Token).toBe(referenceToken(rest, 'pass123'))
  })

  test('POSTs JSON with the correct Content-Type header', async () => {
    const fetchMock = mockJson({ Success: true, PaymentId: 1, Status: 'NEW' })
    global.fetch = fetchMock as any
    await client().initPayment({ Amount: 1, OrderId: 'o' })
    const opts = fetchMock.mock.calls[0][1]
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/json')
  })
})

// Each of the 7 methods must POST to its documented /v2/<path> and return the parsed envelope.
describe('endpoint routing (7 methods)', () => {
  const cases: Array<{ name: string, path: string, call: (t: TbankPayments) => Promise<any> }> = [
    { name: 'initPayment', path: '/v2/Init', call: (t) => t.initPayment({ Amount: 1, OrderId: 'o' }) },
    { name: 'chargeRecurrent', path: '/v2/Charge', call: (t) => t.chargeRecurrent({ PaymentId: '1', RebillId: 'r' }) },
    { name: 'cancelPayment', path: '/v2/Cancel', call: (t) => t.cancelPayment({ PaymentId: '1' }) },
    { name: 'removeCard', path: '/v2/RemoveCard', call: (t) => t.removeCard({ CustomerKey: 'c', CardId: '1' }) },
    { name: 'getPaymentState', path: '/v2/GetState', call: (t) => t.getPaymentState({ PaymentId: '1' }) },
    { name: 'checkOrder', path: '/v2/CheckOrder', call: (t) => t.checkOrder({ OrderId: 'o' }) }
  ]

  for (const c of cases) {
    test(`${c.name} POSTs to ${c.path}`, async () => {
      const fetchMock = mockJson({ Success: true, Status: 'OK' })
      global.fetch = fetchMock as any
      const res = await c.call(client())
      expect(sentUrl(fetchMock)).toBe(`https://bank.example${c.path}`)
      expect(res.Success).toBe(true)
    })
  }

  // verifyNotificationSignature is the 7th surface (webhook side): round-trips the same token algorithm.
  test('verifyNotificationSignature accepts a self-signed notification and rejects a tampered one', () => {
    const t = client()
    const notification = { TerminalKey: 'term', OrderId: 'ord-1', Status: 'CONFIRMED', PaymentId: 42, Success: true }
    const goodToken = t.generateToken(notification)
    expect(t.verifyNotificationSignature(notification, goodToken)).toBe(true)
    expect(t.verifyNotificationSignature({ ...notification, Amount: 999 }, goodToken)).toBe(false)
    expect(t.verifyNotificationSignature(notification, 'deadbeef')).toBe(false)
  })
})

describe('error contract', () => {
  test('HTTP 200 with Success:false is returned as an object, never thrown (business decline)', async () => {
    global.fetch = mockJson({
      Success: false,
      ErrorCode: '1051',
      Message: 'Insufficient funds',
      Status: 'REJECTED'
    }) as any
    const res = await client().chargeRecurrent({ PaymentId: '1', RebillId: 'r' })
    expect(res.Success).toBe(false)
    expect(res.ErrorCode).toBe('1051')
    expect(res.Status).toBe('REJECTED')
  })

  test('a 4xx fails fast with a non-retriable error (no retry)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
      json: async () => ({})
    })
    global.fetch = fetchMock as any
    await expect(client().initPayment({ Amount: 1, OrderId: 'o' })).rejects.toThrow(/HTTP 400/)
    // 4xx is deterministic — retrying can't fix it, so exactly one attempt is made.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('a 5xx is retried up to `retries` times, then throws TbankTransportError', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'unavailable',
      json: async () => ({})
    })
    global.fetch = fetchMock as any
    await expect(client({ retries: 3 }).initPayment({ Amount: 1, OrderId: 'o' })).rejects.toBeInstanceOf(
      TbankTransportError
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('a network error is retried, then throws TbankTransportError', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNRESET'))
    global.fetch = fetchMock as any
    await expect(client({ retries: 3 }).initPayment({ Amount: 1, OrderId: 'o' })).rejects.toBeInstanceOf(
      TbankTransportError
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('recovers on a later attempt when a transient failure is followed by success', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ Success: true, Status: 'NEW' }) })
    global.fetch = fetchMock as any
    const res = await client({ retries: 3 }).initPayment({ Amount: 1, OrderId: 'o' })
    expect(res.Success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('an aborted (timed-out) request is treated as transport failure and retried', async () => {
    const fetchMock = jest.fn().mockImplementation(async (_url: string, opts: any) => {
      // Simulate the AbortController firing: reject as fetch does on abort.
      return await new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    global.fetch = fetchMock as any
    await expect(client({ retries: 2, timeoutMs: 10 }).initPayment({ Amount: 1, OrderId: 'o' })).rejects.toBeInstanceOf(
      TbankTransportError
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('describeFetchError', () => {
  test('unwraps the undici cause chain that hides the real reason behind "fetch failed"', () => {
    const cause: any = new Error('getaddrinfo ENOTFOUND securepay.tinkoff.ru')
    cause.code = 'ENOTFOUND'
    const err: any = new TypeError('fetch failed')
    err.cause = cause
    expect(describeFetchError(err)).toBe('fetch failed <- ENOTFOUND getaddrinfo ENOTFOUND securepay.tinkoff.ru')
  })

  test('terminates on a self-referencing cause chain', () => {
    const err: any = new Error('boom')
    err.cause = err
    expect(describeFetchError(err).split(' <- ')).toHaveLength(6)
  })

  test('falls back to String() for non-Error throws', () => {
    expect(describeFetchError('plain string')).toBe('plain string')
  })
})

describe('state constants', () => {
  test('success states are CONFIRMED / AUTHORIZED', () => {
    expect([...TBANK_SUCCESS_STATES].sort()).toEqual(['AUTHORIZED', 'CONFIRMED'])
  })

  test('failed states are REJECTED / DEADLINE_EXPIRED / CANCELED', () => {
    expect([...TBANK_FAILED_STATES].sort()).toEqual(['CANCELED', 'DEADLINE_EXPIRED', 'REJECTED'])
  })
})

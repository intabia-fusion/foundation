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
import { apiKeyLoginLimiter, apiKeyLoginRateLimit, clientKey } from '../rateLimit'

describe('apiKeyLoginRateLimit', () => {
  beforeEach(() => {
    apiKeyLoginLimiter.reset()
  })

  function hammer (method: string, ip: string, times: number): number {
    let blocked = 0
    for (let i = 0; i < times; i++) {
      if (apiKeyLoginRateLimit(method, {}, ip) !== undefined) blocked++
    }
    return blocked
  }

  it('lets a normal burst of key logins through, then blocks', () => {
    expect(apiKeyLoginRateLimit('loginWithApiKey', {}, '1.2.3.4')).toBeUndefined()
    expect(hammer('loginWithApiKey', '1.2.3.4', 100)).toBeGreaterThan(0)
  })

  it('blocks only the client that hammered', () => {
    hammer('loginWithApiKey', '1.2.3.4', 100)
    expect(apiKeyLoginRateLimit('loginWithApiKey', {}, '5.6.7.8')).toBeUndefined()
  })

  it('leaves every other method alone', () => {
    expect(hammer('login', '1.2.3.4', 100)).toBe(0)
    expect(hammer('getLoginInfoByToken', '1.2.3.4', 100)).toBe(0)
  })

  it('answers with retry hints so the caller can back off', () => {
    hammer('loginWithApiKey', '1.2.3.4', 100)
    const info = apiKeyLoginRateLimit('loginWithApiKey', {}, '1.2.3.4')
    expect(info?.remaining).toBe(0)
    expect(info?.retryAfter).toBeGreaterThan(0)
    expect(info?.limit).toBeGreaterThan(0)
  })

  it('falls back to the default when the env limit is not a number', () => {
    const prev = process.env.API_KEY_LOGIN_RATE_LIMIT
    process.env.API_KEY_LOGIN_RATE_LIMIT = 'abc'
    jest.resetModules()
    try {
      // A typo in the env must not silently switch the throttle off.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fresh = require('../rateLimit')
      let blocked = 0
      for (let i = 0; i < 100; i++) {
        if (fresh.apiKeyLoginRateLimit('loginWithApiKey', {}, '1.2.3.4') !== undefined) blocked++
      }
      expect(blocked).toBeGreaterThan(0)
    } finally {
      if (prev === undefined) delete process.env.API_KEY_LOGIN_RATE_LIMIT
      else process.env.API_KEY_LOGIN_RATE_LIMIT = prev
      jest.resetModules()
    }
  })

  it('falls back to the default when the env limit is an empty string', () => {
    const prev = process.env.API_KEY_LOGIN_RATE_LIMIT
    process.env.API_KEY_LOGIN_RATE_LIMIT = ''
    jest.resetModules()
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fresh = require('../rateLimit')
      let blocked = 0
      for (let i = 0; i < 100; i++) {
        if (fresh.apiKeyLoginRateLimit('loginWithApiKey', {}, '1.2.3.4') !== undefined) blocked++
      }
      expect(blocked).toBeGreaterThan(0)
    } finally {
      if (prev === undefined) delete process.env.API_KEY_LOGIN_RATE_LIMIT
      else process.env.API_KEY_LOGIN_RATE_LIMIT = prev
      jest.resetModules()
    }
  })

  it('keys on the first x-forwarded-for hop, since the ingress socket ip is shared', () => {
    expect(clientKey({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, '10.0.0.1')).toBe('9.9.9.9')
    expect(clientKey({}, '10.0.0.1')).toBe('10.0.0.1')
    expect(clientKey({ 'x-forwarded-for': '' }, '10.0.0.1')).toBe('10.0.0.1')

    // Two clients behind the same ingress must not share a bucket.
    hammer('loginWithApiKey', 'ignored', 0)
    for (let i = 0; i < 100; i++) apiKeyLoginRateLimit('loginWithApiKey', { 'x-forwarded-for': '9.9.9.9' }, '10.0.0.1')
    expect(apiKeyLoginRateLimit('loginWithApiKey', { 'x-forwarded-for': '8.8.8.8' }, '10.0.0.1')).toBeUndefined()
  })
})

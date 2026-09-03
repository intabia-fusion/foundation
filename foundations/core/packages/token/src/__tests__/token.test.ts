//
// Copyright © 2025 Hardcore Engineering Inc.
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

import { setMetadata } from '@hcengineering/platform'
import type { PersonUuid, WorkspaceUuid } from '@hcengineering/core'
import { decodeToken, extractCookieToken, generateToken } from '../token'
import plugin from '../plugin'

export function decodeTokenPayload (token: string): any {
  try {
    return JSON.parse(atob(token.split('.')[1]))
  } catch (err: any) {
    console.error(err)
    return {}
  }
}

describe('generateToken', () => {
  beforeEach(() => {
    setMetadata(plugin.metadata.Secret, undefined)
    setMetadata(plugin.metadata.Service, undefined)
  })

  it('throws TokenError for invalid account uuid', () => {
    expect(() => {
      generateToken('invalid-uuid' as PersonUuid, '' as WorkspaceUuid, {}, 'secret')
    }).toThrow('Invalid account uuid: "invalid-uuid"')
  })

  it('throws TokenError for invalid workspace uuid', () => {
    expect(() => {
      generateToken('123e4567-e89b-12d3-a456-426614174000' as PersonUuid, 'invalid-uuid' as WorkspaceUuid, {}, 'secret')
    }).toThrow('Invalid workspace uuid: "invalid-uuid"')
  })

  it('generates token without extra and workspace', () => {
    const token = generateToken('123e4567-e89b-12d3-a456-426614174000' as PersonUuid, undefined, undefined, 'secret')
    const decodedPayload = decodeTokenPayload(token)
    expect(decodedPayload).toEqual({
      account: '123e4567-e89b-12d3-a456-426614174000',
      workspace: undefined
    })
  })

  it('should generate token with only required fields', () => {
    const token = generateToken(
      '123e4567-e89b-12d3-a456-426614174000' as PersonUuid,
      '123e4567-e89b-12d3-a456-426614174001' as WorkspaceUuid,
      undefined,
      'secret'
    )
    const decodedPayload = decodeTokenPayload(token)
    expect(decodedPayload).toEqual({
      account: '123e4567-e89b-12d3-a456-426614174000',
      workspace: '123e4567-e89b-12d3-a456-426614174001'
    })
  })

  it('should generate token with extra fields', () => {
    const extra = { service: 'test' }
    const token = generateToken(
      '123e4567-e89b-12d3-a456-426614174000' as PersonUuid,
      '123e4567-e89b-12d3-a456-426614174001' as WorkspaceUuid,
      extra,
      'secret'
    )
    const decodedPayload = decodeTokenPayload(token)
    expect(decodedPayload).toEqual({
      extra,
      account: '123e4567-e89b-12d3-a456-426614174000',
      workspace: '123e4567-e89b-12d3-a456-426614174001'
    })
  })

  it('should generate token with default secret', () => {
    const token = generateToken(
      '123e4567-e89b-12d3-a456-426614174000' as PersonUuid,
      '123e4567-e89b-12d3-a456-426614174001' as WorkspaceUuid,
      undefined,
      'test'
    )
    const decodedPayload = decodeTokenPayload(token)
    expect(decodedPayload).toEqual({
      account: '123e4567-e89b-12d3-a456-426614174000',
      workspace: '123e4567-e89b-12d3-a456-426614174001'
    })
  })

  it('should generate token with default service in extra', () => {
    setMetadata(plugin.metadata.Service, 'test')
    const token = generateToken(
      '123e4567-e89b-12d3-a456-426614174000' as PersonUuid,
      '123e4567-e89b-12d3-a456-426614174001' as WorkspaceUuid,
      undefined,
      'secret'
    )
    const decodedPayload = decodeToken(token, false, 'test')
    expect(decodedPayload).toEqual({
      extra: { service: 'test' },
      account: '123e4567-e89b-12d3-a456-426614174000',
      workspace: '123e4567-e89b-12d3-a456-426614174001'
    })
  })
})

describe('extractCookieToken', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.abc' // a JWT-looking value
  const SIG = 'ZMmaHvXbxEvo6L_C3dah-q2xbVE' // koa signature value (not a JWT)

  it('returns undefined for no header', () => {
    expect(extractCookieToken(undefined)).toBeUndefined()
    expect(extractCookieToken('')).toBeUndefined()
  })

  it('returns undefined when no token cookie present', () => {
    expect(extractCookieToken('foo=1; bar=2')).toBeUndefined()
    expect(extractCookieToken('foo=1; bar=2', 'account-metadata-Token')).toBeUndefined()
  })

  // The core regression: koa also sets `<name>.sig`; if it is listed first, .includes()/substring
  // matching would return the signature instead of the JWT -> invalid token.
  it('skips the .sig signature cookie even when it is listed first', () => {
    const header = `account-metadata-Token.sig=${SIG}; account-metadata-Token=${JWT}`
    expect(extractCookieToken(header)).toBe(JWT) // substring mode (print/export/sign)
    expect(extractCookieToken(header, 'account-metadata-Token')).toBe(JWT) // exact mode (account)
  })

  it('finds the token when it is listed first too', () => {
    const header = `account-metadata-Token=${JWT}; account-metadata-Token.sig=${SIG}`
    expect(extractCookieToken(header)).toBe(JWT)
    expect(extractCookieToken(header, 'account-metadata-Token')).toBe(JWT)
  })

  it('exact-name mode ignores other cookies that merely contain "token"', () => {
    const header = `csrf-token=nope; account-metadata-Token=${JWT}`
    expect(extractCookieToken(header, 'account-metadata-Token')).toBe(JWT)
  })

  it('substring mode matches any cookie name containing "token", case-insensitive', () => {
    expect(extractCookieToken(`Some-TOKEN=${JWT}`)).toBe(JWT)
  })

  it('is case-insensitive on the exact name', () => {
    expect(extractCookieToken(`account-metadata-token=${JWT}`, 'account-metadata-Token')).toBe(JWT)
  })

  it('tolerates surrounding whitespace between cookies', () => {
    expect(extractCookieToken(`  foo=1 ;  account-metadata-Token=${JWT}  `, 'account-metadata-Token')).toBe(JWT)
  })

  it('preserves "=" inside the value (base64 padding)', () => {
    const padded = 'aGVsbG8='
    expect(extractCookieToken(`account-metadata-Token=${padded}`, 'account-metadata-Token')).toBe(padded)
  })

  it('returns undefined for an empty token value', () => {
    expect(extractCookieToken('account-metadata-Token=', 'account-metadata-Token')).toBeUndefined()
  })
})

describe('decodeToken cache', () => {
  const account = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' as PersonUuid
  const workspace = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' as WorkspaceUuid

  beforeEach(() => {
    setMetadata(plugin.metadata.Secret, 'secret')
    setMetadata(plugin.metadata.Service, undefined)
  })

  it('should return the same payload on repeated decode', () => {
    const token = generateToken(account, workspace, { admin: 'true' })

    expect(decodeToken(token)).toEqual(decodeToken(token))
    expect(decodeToken(token).account).toBe(account)
  })

  it('should not serve an expired token from the cache', () => {
    const token = generateToken(account, workspace, undefined, undefined, {
      exp: Math.floor(Date.now() / 1000) + 1
    })
    expect(decodeToken(token).account).toBe(account)

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)
    try {
      expect(() => decodeToken(token)).toThrow()
    } finally {
      jest.spyOn(Date, 'now').mockRestore()
    }
  })

  it('should keep tokens of different secrets apart', () => {
    const token = generateToken(account, workspace, undefined, 'other-secret')

    expect(decodeToken(token, true, 'other-secret').account).toBe(account)
    expect(() => decodeToken(token)).toThrow()
  })

  it('should keep a hot token alive across an eviction sweep', () => {
    const hot = generateToken(account, workspace)
    // A cache hit returns the very object that was stored, a miss decodes a fresh one.
    const cached = decodeToken(hot)
    expect(decodeToken(hot)).toBe(cached)

    // Overflow the cache several times over; the hot token is re-set on every hit.
    for (let i = 0; i < 6000; i++) {
      decodeToken(generateToken(account, workspace, { n: `${i}` }))
      if (i % 100 === 0) expect(decodeToken(hot)).toBe(cached)
    }
    expect(decodeToken(hot)).toBe(cached)
  })

  it('should evict a cold token once the cache overflows', () => {
    const cold = generateToken(account, workspace, { cold: 'true' })
    const cached = decodeToken(cold)

    for (let i = 0; i < 6000; i++) {
      decodeToken(generateToken(account, workspace, { m: `${i}` }))
    }
    // Same payload, but a re-decoded object - the cold entry was swept.
    const after = decodeToken(cold)
    expect(after).not.toBe(cached)
    expect(after).toEqual(cached)
  })

  it('should not let a tampered token through after a valid one', () => {
    const token = generateToken(account, workspace)
    expect(decodeToken(token).account).toBe(account)

    const [h, p] = token.split('.')
    expect(() => decodeToken(`${h}.${p}.deadbeef`)).toThrow()
  })
})

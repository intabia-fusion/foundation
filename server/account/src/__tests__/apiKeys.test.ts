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

import { type AccountUuid } from '@hcengineering/core'
import {
  type ApiKeySecret,
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  isApiKeyUsable,
  isValidApiKeyOps,
  isValidApiKeyTokenTtl,
  maskApiKey,
  maxApiKeyTokenTtlMs,
  minApiKeyTokenTtlMs
} from '../apiKeys'

function secretOf (over: Partial<ApiKeySecret> = {}): ApiKeySecret {
  return {
    keyId: 'k1',
    name: 'ci',
    masked: 'fus_ws_...abcd',
    ops: ['issue:create'],
    spaces: [],
    createdOn: 1000,
    createdBy: 'acc' as AccountUuid,
    ...over
  }
}

describe('api keys', () => {
  test('key format: prefix, workspace short, hex random', () => {
    const key = generateApiKey('My-Workspace_42')
    const [prefix, short, random] = key.split('_')

    expect(prefix).toBe(apiKeyPrefix)
    expect(short).toBe('myworkspace4')
    expect(random).toHaveLength(64)
    expect(random).toMatch(/^[0-9a-f]+$/)
    expect(generateApiKey('ws')).not.toBe(generateApiKey('ws'))
  })

  test('hash is stable and differs per key', () => {
    const key = generateApiKey('ws')

    expect(hashApiKey(key)).toBe(hashApiKey(key))
    expect(hashApiKey(key)).toHaveLength(64)
    expect(hashApiKey(key)).not.toBe(hashApiKey(generateApiKey('ws')))
    expect(hashApiKey(key)).not.toContain(key.slice(-8))
  })

  test('mask keeps the prefix and last 4 chars only', () => {
    const key = 'fus_ws_abcdefghijklmnop'

    expect(maskApiKey(key)).toBe('fus_ws_...mnop')
  })

  test('ops must be a list of known operations, empty means read-only', () => {
    expect(isValidApiKeyOps(['issue:create', 'chat:post'])).toBe(true)
    expect(isValidApiKeyOps([])).toBe(true)
    expect(isValidApiKeyOps(['issue:delete'])).toBe(false)
    expect(isValidApiKeyOps('issue:create')).toBe(false)
  })

  test('revoked or expired key is not usable', () => {
    expect(isApiKeyUsable(secretOf(), 2000)).toBe(true)
    expect(isApiKeyUsable(secretOf({ expiresOn: 3000 }), 2000)).toBe(true)
    expect(isApiKeyUsable(secretOf({ expiresOn: 1500 }), 2000)).toBe(false)
    expect(isApiKeyUsable(secretOf({ revokedOn: 1500 }), 2000)).toBe(false)
  })

  test('token ttl must be within 1-90 days', () => {
    expect(isValidApiKeyTokenTtl(minApiKeyTokenTtlMs)).toBe(true)
    expect(isValidApiKeyTokenTtl(maxApiKeyTokenTtlMs)).toBe(true)
    expect(isValidApiKeyTokenTtl(minApiKeyTokenTtlMs - 1)).toBe(false)
    expect(isValidApiKeyTokenTtl(maxApiKeyTokenTtlMs + 1)).toBe(false)
    expect(isValidApiKeyTokenTtl(undefined)).toBe(false)
    expect(isValidApiKeyTokenTtl('7')).toBe(false)
  })
})

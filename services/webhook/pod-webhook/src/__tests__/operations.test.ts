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

import { apiKeyOperations } from '@hcengineering/account-client'
import { isKnownOperation, markdownFields } from '../operations'

describe('operations registry', () => {
  test('rejects an unknown operation', () => {
    expect(isKnownOperation('bogus:op')).toBe(false)
    expect(isKnownOperation(undefined)).toBe(false)
    expect(isKnownOperation('issue:create')).toBe(true)
  })

  test('every known API key operation has a markdown-field entry', () => {
    for (const op of apiKeyOperations) {
      expect(markdownFields[op]).toBeDefined()
    }
  })

  test('collaborative fields upload as a blob ref, message fields convert inline', () => {
    expect(markdownFields['issue:create']?.description).toEqual({
      kind: 'blob',
      refField: 'descriptionRef',
      objectClass: expect.any(String)
    })
    expect(markdownFields['issue:comment']?.message).toEqual({ kind: 'inline' })
  })

  test('body is forwarded raw - the transactor converts and uploads it itself', () => {
    expect(markdownFields['issue:create']?.body).toEqual({ kind: 'raw' })
    expect(markdownFields['issue:update']?.body).toEqual({ kind: 'raw' })
    expect(markdownFields['doc:create']?.body).toEqual({ kind: 'raw' })
    expect(markdownFields['doc:update']?.body).toEqual({ kind: 'raw' })
  })
})

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

// tokensRecord is pure; stub the config module so importing billing.ts does not run
// the env-validating IIFE (which throws without a full pod config).
jest.mock('../config', () => ({ __esModule: true, default: {} }))

/* eslint-disable import/first */
import { type WorkspaceUuid } from '@hcengineering/core'
import { tokensRecord } from '../billing'
/* eslint-enable import/first */

const ws = 'ws-1' as WorkspaceUuid

describe('tokensRecord', () => {
  it('applies the billing multiplier and fills the record', () => {
    const r = tokensRecord(ws, 100, 50, 0.1, 'chat', 'clisr', '2026-01-01T00:00:00.000Z')
    expect(r.tokens).toBe(15) // ceil(150 * 0.1)
    expect(r.reason).toBe('chat:clisr')
    expect(r.workspace).toBe(ws)
    expect(r.date).toBe('2026-01-01T00:00:00.000Z')
  })

  it.each([
    [80, 20, 1, 100], // multiplier 1 = raw total
    [3, 0, 0.1, 1] // ceil(0.3)
  ])('rounds billed(%i+%i, x%d) up to %i', (prompt, completion, mult, expected) => {
    expect(tokensRecord(ws, prompt, completion, mult, 'chat').tokens).toBe(expected)
  })

  it('omits the model suffix when modelId is absent', () => {
    expect(tokensRecord(ws, 10, 0, 1, 'chat').reason).toBe('chat')
  })
})

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

import setting from '@hcengineering/setting'
import { bumpWebhookStat } from '../stats'

const newCtx = (): any => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })

function mockRest (overrides: Partial<Record<'findOne' | 'createDoc' | 'updateDoc', jest.Mock>> = {}): any {
  return {
    findOne: jest.fn().mockResolvedValue(undefined),
    createDoc: jest.fn().mockResolvedValue('id'),
    updateDoc: jest.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

describe('bumpWebhookStat', () => {
  test('creates the doc with count 1 on first use, deterministic _id', async () => {
    const rest = mockRest()

    await bumpWebhookStat(newCtx(), rest, 'out', 'ep_1', 'issue.created')

    expect(rest.createDoc).toHaveBeenCalledWith(
      setting.class.WebhookStat,
      expect.anything(),
      expect.objectContaining({ direction: 'out', target: 'ep_1', type: 'issue.created', count: 1 }),
      'out:ep_1:issue.created'
    )
    expect(rest.updateDoc).not.toHaveBeenCalled()
  })

  test('increments an existing doc via $inc instead of creating a second one', async () => {
    const rest = mockRest({ findOne: jest.fn().mockResolvedValue({ _id: 'in:key_1:issue:create' }) })

    await bumpWebhookStat(newCtx(), rest, 'in', 'key_1', 'issue:create')

    expect(rest.updateDoc).toHaveBeenCalledWith(
      setting.class.WebhookStat,
      expect.anything(),
      'in:key_1:issue:create',
      expect.objectContaining({ $inc: { count: 1 } })
    )
    expect(rest.createDoc).not.toHaveBeenCalled()
  })

  test('a lost create race falls back to the $inc update instead of failing', async () => {
    const rest = mockRest({ createDoc: jest.fn().mockRejectedValue(new Error('duplicate key')) })

    await bumpWebhookStat(newCtx(), rest, 'out', 'ep_1', 'issue.created')

    expect(rest.updateDoc).toHaveBeenCalledWith(
      setting.class.WebhookStat,
      expect.anything(),
      'out:ep_1:issue.created',
      expect.objectContaining({ $inc: { count: 1 } })
    )
  })

  test('a failed stat write is swallowed, not thrown', async () => {
    const ctx = newCtx()
    const rest = mockRest({ findOne: jest.fn().mockRejectedValue(new Error('network down')) })

    await expect(bumpWebhookStat(ctx, rest, 'out', 'ep_1', 'issue.created')).resolves.toBeUndefined()
    expect(ctx.error).toHaveBeenCalledWith('webhook stat bump failed', expect.objectContaining({ direction: 'out' }))
  })
})

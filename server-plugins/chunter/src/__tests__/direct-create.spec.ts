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

import { type AccountUuid, systemAccountUuid } from '@hcengineering/core'
import { ChunterMiddleware } from '../middleware'

const BOT = 'bot-account' as AccountUuid
const USER = 'user-account' as AccountUuid
const OTHER = 'other-account' as AccountUuid

/** Runs the private onDirectCreate with stubbed storage, returning the mutated attributes. */
async function onDirectCreate (
  actor: AccountUuid,
  members: AccountUuid[],
  existing: unknown[] = []
): Promise<{ members: AccountUuid[], type?: string, referenceId?: string }> {
  const middleware = Object.create(ChunterMiddleware.prototype)
  middleware.findAll = async () => existing
  const ctx = { contextData: { account: { uuid: actor } } }
  const tx = { attributes: { members: [...members] } }
  await middleware.onDirectCreate(ctx, tx)
  return tx.attributes as any
}

describe('onDirectCreate', () => {
  it('keeps a service-created direct at two members', async () => {
    // The ai-bot welcome direct is written with a service token: adding systemAccountUuid would
    // make it a group, skip the referenceId dedup and let a second direct appear.
    const attrs = await onDirectCreate(systemAccountUuid, [BOT, USER])
    expect(attrs.members.sort()).toEqual([BOT, USER].sort())
    expect(attrs.type).toBe('person')
    expect(attrs.referenceId).toBeDefined()
  })

  it('still adds the author of a user-created direct', async () => {
    const attrs = await onDirectCreate(OTHER, [BOT, USER])
    expect(attrs.members).toContain(OTHER)
    expect(attrs.type).toBe('group')
  })

  it('refuses a second direct with the same two members', async () => {
    await expect(onDirectCreate(systemAccountUuid, [BOT, USER], [{ _id: 'existing' }])).rejects.toThrow()
  })
})

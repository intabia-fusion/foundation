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

/* eslint-disable @typescript-eslint/no-var-requires */

import { type ParticipantInfo } from '@hcengineering/love'
import { get } from 'svelte/store'

jest.mock('svelte/store', () => require('./svelteStoreDouble'))

jest.mock('@hcengineering/ai-bot-resources', () => {
  const { writable } = require('svelte/store')
  return { aiBotSocialIdentityStore: writable(undefined) }
})

jest.mock('@hcengineering/contact', () => ({
  getCurrentEmployee: jest.fn(() => 'person-me')
}))

jest.mock('@hcengineering/contact-resources', () => ({
  getPersonRefByPersonId: jest.fn(async () => null),
  getPersonsByPersonRefs: jest.fn(async () => new Map())
}))

// `mock`-prefixed name so jest's hoist-scope check allows referencing it inside jest.mock factory below.
const mockQueryInstances: Array<{ query: jest.Mock, unsubscribe: jest.Mock }> = []

jest.mock('@hcengineering/presentation', () => ({
  createQuery: jest.fn(() => {
    const inst = { query: jest.fn(), unsubscribe: jest.fn() }
    mockQueryInstances.push(inst)
    return inst
  }),
  onClient: jest.fn((cb: () => void) => {
    cb()
  })
}))

function makeParticipantInfo (sessionId: string): ParticipantInfo {
  return {
    _id: `pi-${sessionId}`,
    _class: 'love:class:ParticipantInfo',
    space: 'space-1',
    modifiedOn: 0,
    modifiedBy: 'person-me',
    kind: 'user',
    person: 'person-shared',
    name: 'Shared Person',
    meeting: 'meeting-1',
    room: 'room-1',
    x: 0,
    y: 0,
    sessionId,
    account: null
  } as unknown as ParticipantInfo
}

describe('filterParticipantInfo dedup by person (defect A)', () => {
  it('produces the same result regardless of the input order of two sessions of the same person (defect: dedup by person)', async () => {
    const love = (await import('../plugin')).default
    const { infos } = await import('../stores')

    const call = mockQueryInstances
      .flatMap((inst) => inst.query.mock.calls)
      .find((c) => c[0] === love.class.ParticipantInfo)
    expect(call).toBeDefined()
    const onParticipantInfoUpdate = call?.[2] as (res: ParticipantInfo[]) => Promise<void>

    const older = makeParticipantInfo('old-session')
    const newer = makeParticipantInfo('new-session')

    await onParticipantInfoUpdate([older, newer])
    const oldFirst = get(infos).map((p) => p.sessionId)

    await onParticipantInfoUpdate([newer, older])
    const newFirst = get(infos).map((p) => p.sessionId)

    // Both sessions belong to the same live person (old tab not yet closed, new tab
    // already connected). The surviving session must not depend on array order.
    expect(oldFirst).toEqual(newFirst)
  })
})

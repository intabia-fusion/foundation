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

import { type ParticipantInfo, type UserMeetingInvite } from '@hcengineering/love'

jest.mock('svelte/store', () => require('./svelteStoreDouble'))

jest.mock('@hcengineering/contact', () => ({
  getCurrentEmployee: jest.fn(() => 'person-me'),
  getCurrentEmployeeSpace: jest.fn(() => 'space-1')
}))
jest.mock('@hcengineering/contact-resources', () => ({
  getPersonByPersonRef: jest.fn(async () => undefined)
}))

// `mock`-prefixed so jest's hoist-scope check allows referencing it inside the factory below.
const mockRemoveDoc = jest.fn(async () => undefined)

jest.mock('@hcengineering/presentation', () => ({
  createQuery: jest.fn(() => ({ query: jest.fn(), unsubscribe: jest.fn() })),
  onClient: jest.fn(),
  getClient: jest.fn(() => ({ removeDoc: mockRemoveDoc })),
  playSound: jest.fn(async () => null)
}))
jest.mock('@hcengineering/ui', () => ({
  addNotification: jest.fn(),
  NotificationSeverity: { Info: 0, Success: 1, Warning: 2, Error: 3 }
}))
jest.mock('@hcengineering/theme', () => ({
  getCurrentLanguage: jest.fn(() => 'en')
}))
jest.mock('../meetings', () => ({
  createMeeting: jest.fn(),
  joinOrCreateMeetingByInvite: jest.fn(async () => true)
}))
jest.mock('../components/meeting/invites/KnockResolutionToast.svelte', () => ({ default: function () {} }))
jest.mock('../stores', () => {
  const { writable } = require('svelte/store')
  return {
    infos: writable([]),
    meetings: writable([]),
    currentMeetingMinutes: writable(undefined)
  }
})

function makeInvite (): UserMeetingInvite {
  return {
    _id: 'invite-1',
    space: 'space-me',
    kind: 'invite-request',
    from: 'person-me',
    to: 'person-other',
    meeting: 'meeting-1',
    status: 'pending'
  } as unknown as UserMeetingInvite
}

function makeRecipientJoinedInfo (): ParticipantInfo {
  return {
    _id: 'pi-other',
    kind: 'user',
    person: 'person-other',
    meeting: 'meeting-1',
    room: undefined
  } as unknown as ParticipantInfo
}

describe('outgoingInvitesStore side effects (defect C)', () => {
  it('does not call removeDoc again for the same invite on repeated derived recomputations while nothing relevant changed (defect: derived side effects re-run every tick)', async () => {
    const { allInvites, outgoingInvitesStore } = require('../invites')
    const { infos } = require('../stores')

    allInvites.set([makeInvite()])
    // Recipient already joined the meeting some other way -> our own
    // invite-request becomes stale and outgoingInvitesStore drops it.
    infos.set([makeRecipientJoinedInfo()])

    const unsubscribe = outgoingInvitesStore.subscribe(() => {})
    try {
      // Simulate unrelated live-query ticks on `infos` (e.g. someone else's
      // presence changing) — the invite/recipient state itself does not change.
      infos.update((v: ParticipantInfo[]) => [...v])
      infos.update((v: ParticipantInfo[]) => [...v])
      infos.update((v: ParticipantInfo[]) => [...v])
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      unsubscribe()
    }

    expect(mockRemoveDoc).toHaveBeenCalledTimes(1)
  })
})

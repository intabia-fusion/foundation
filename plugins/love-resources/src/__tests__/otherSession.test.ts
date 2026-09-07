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

import { type MeetingMinutes, type ParticipantInfo } from '@hcengineering/love'
import { type Ref } from '@hcengineering/core'

jest.mock('svelte/store', () => require('./svelteStoreDouble'))

jest.mock('@hcengineering/contact', () => ({
  getCurrentEmployee: jest.fn(() => 'person-me')
}))

jest.mock('@hcengineering/love', () => ({
  isOffice: jest.fn(() => false)
}))

jest.mock('@hcengineering/presentation', () => ({ MessageBox: 'MessageBox' }))

const mockShowPopup = jest.fn()
jest.mock('@hcengineering/ui', () => ({
  showPopup: (...args: any[]) => mockShowPopup(...args)
}))

jest.mock('../plugin', () => ({
  __esModule: true,
  default: { string: { AlreadyInAnotherMeeting: 'title', LeaveOtherMeeting: 'msg' } }
}))

jest.mock('../liveKitClient', () => {
  const { writable } = require('svelte/store')
  return { lkSessionConnected: writable(false), myLastSessionSid: writable(undefined) }
})

jest.mock('../stores', () => {
  const { writable } = require('svelte/store')
  return { currentRoom: writable(undefined), meetings: writable([]), myInfos: writable([]) }
})

const OTHER = 'meeting-other' as Ref<MeetingMinutes>
const TARGET = 'meeting-target' as Ref<MeetingMinutes>

function seat (meeting: Ref<MeetingMinutes>, sessionId: string | null): ParticipantInfo {
  return { _id: `pi-${meeting}`, person: 'person-me', meeting, sessionId } as unknown as ParticipantInfo
}

describe('findOtherLiveSession', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // The popup resolves with Ok unless a test says otherwise.
    mockShowPopup.mockImplementation((_c: any, _p: any, _t: any, onClose: (r?: boolean) => void) => {
      onClose(true)
    })
  })

  async function load (): Promise<any> {
    const stores = await import('../stores')
    const lk = await import('../liveKitClient')
    const guard = await import('../otherSession')
    return { stores, lk, guard }
  }

  it('says nothing when I hold no other seat', async () => {
    const { guard } = await load()

    expect(guard.findOtherLiveSession(TARGET, undefined)).toBeUndefined()
  })

  it('reports the seat another session holds in a live meeting', async () => {
    const { stores, guard } = await load()
    stores.myInfos.set([seat(OTHER, 'sid-other-tab')])
    stores.meetings.set([{ _id: OTHER, name: 'Standup' }])

    expect(guard.findOtherLiveSession(TARGET, undefined)?.meeting).toBe(OTHER)
  })

  // The row of a meeting that is already Finished is a leftover; `meetings` filters those out and
  // the popup would name an empty meeting.
  it('ignores a seat whose meeting is no longer live', async () => {
    const { stores, guard } = await load()
    stores.myInfos.set([seat(OTHER, 'sid-other-tab')])
    stores.meetings.set([])

    expect(guard.findOtherLiveSession(TARGET, undefined)).toBeUndefined()
  })

  // This tab left a moment ago and the webhook has not removed its row yet.
  it('ignores my own leftover row, matched by session sid', async () => {
    const { stores, lk, guard } = await load()
    stores.myInfos.set([seat(OTHER, 'sid-mine')])
    stores.meetings.set([{ _id: OTHER, name: 'Standup' }])
    lk.myLastSessionSid.set('sid-mine')

    expect(guard.findOtherLiveSession(TARGET, undefined)).toBeUndefined()
  })

  it('ignores the meeting this tab is still in', async () => {
    const { stores, guard } = await load()
    stores.myInfos.set([seat(OTHER, 'sid-other-tab')])
    stores.meetings.set([{ _id: OTHER, name: 'Standup' }])

    expect(guard.findOtherLiveSession(TARGET, OTHER)).toBeUndefined()
  })
})

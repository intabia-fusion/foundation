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

import { type Ref } from '@hcengineering/core'
import { RoomType, type MeetingMinutes, type ParticipantInfo, type Room } from '@hcengineering/love'

jest.mock('svelte/store', () => require('./svelteStoreDouble'))

jest.mock('@hcengineering/contact', () => ({
  getCurrentEmployee: jest.fn(() => 'person-me')
}))
jest.mock('@hcengineering/contact-resources', () => ({
  getPersonByPersonRef: jest.fn(async () => ({ _id: 'person-me', personUuid: 'acc-me' }))
}))
jest.mock('@hcengineering/presentation', () => ({
  default: { metadata: { SessionId: 'presentation:metadata:SessionId' } },
  createQuery: jest.fn(() => ({ query: jest.fn(), unsubscribe: jest.fn() })),
  onClient: jest.fn(),
  getClient: jest.fn(() => ({ findOne: jest.fn(), apply: jest.fn() }))
}))
jest.mock('../utils', () => ({
  getLiveKitEndpoint: jest.fn(() => 'wss://example.test'),
  getRoomName: jest.fn(async () => 'Room 1'),
  liveKitClient: { connect: jest.fn(async () => {}), disconnect: jest.fn(async () => {}) },
  loveClient: { getRoomToken: jest.fn(async () => 'token') },
  navigateToMeetingMinutes: jest.fn(async () => {}),
  navigateToOfficeDoc: jest.fn(async () => {})
}))
jest.mock('../loveClient', () => {
  class LoveServiceError extends Error {
    status: number
    constructor (status: number, message: string) {
      super(message)
      this.status = status
      this.name = 'LoveServiceError'
    }
  }
  return { LoveServiceError }
})
jest.mock('../invites', () => ({
  sendInvites: jest.fn(async () => {})
}))
jest.mock('../liveKitClient', () => {
  const { writable } = require('svelte/store')
  return { lkIsConnecting: writable(false), lkSessionConnected: writable(false) }
})
jest.mock('../stores', () => {
  const { writable } = require('svelte/store')
  return {
    infos: writable([]),
    rooms: writable([]),
    myConnectingSessionId: writable(null),
    meetings: writable([]),
    currentMeetingMinutes: writable(undefined),
    waitForOfficeLoaded: jest.fn(async () => {}),
    withConnectingToMeeting: jest.fn(async (op: () => Promise<unknown>) => await op())
  }
})

function makeRoom (): Room {
  return {
    _id: 'room-1' as Ref<Room>,
    name: 'Room 1',
    type: RoomType.Video,
    floor: 'floor-1',
    width: 1,
    height: 1,
    x: 0,
    y: 0,
    language: 'en',
    startWithTranscription: false,
    startWithRecording: false,
    startPrivate: false,
    description: null
  } as unknown as Room
}

function makeOccupyingParticipant (room: Ref<Room>): ParticipantInfo {
  return {
    _id: 'pi-other',
    kind: 'user',
    person: 'person-other',
    name: 'Other',
    meeting: 'inaccessible-meeting' as unknown as Ref<MeetingMinutes>,
    room,
    x: 0,
    y: 0,
    sessionId: 'sess-other',
    account: null
  } as unknown as ParticipantInfo
}

describe('createMeeting silent no-op (defect B)', () => {
  it('signals why nothing happened instead of silently resolving to undefined when the room is occupied by an inaccessible meeting (defect: createMeeting silent no-op)', async () => {
    const { createMeeting } = require('../meetings')
    const { infos } = require('../stores')

    const room = makeRoom()
    infos.set([makeOccupyingParticipant(room._id)])

    const result = await createMeeting(room)

    // Connect on an occupied room must surface an actionable outcome, not a silent no-op
    // the caller cannot tell apart from "already connected".
    expect(result).not.toBeUndefined()
  })
})

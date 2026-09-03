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

import { AccountRole, setCurrentAccount, type Account, type AccountUuid, type Ref } from '@hcengineering/core'
import { MeetingStatus, RoomType, type MeetingMinutes, type Room } from '@hcengineering/love'

jest.mock('svelte/store', () => require('./svelteStoreDouble'))

jest.mock('@hcengineering/contact', () => ({
  getCurrentEmployee: jest.fn(() => 'person-me')
}))
jest.mock('@hcengineering/contact-resources', () => ({
  getPersonByPersonRef: jest.fn(async () => ({ _id: 'person-me', personUuid: 'acc-me' }))
}))

interface FakeDoc {
  _id: string
  [key: string]: unknown
}

// Tiny stand-in for the server-side notMatch/commit semantics: a doc "conflicts"
// with a query when every field matches (supports plain equality and `$in`).
function matchesQuery (doc: FakeDoc, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (value !== null && typeof value === 'object' && '$in' in (value as Record<string, unknown>)) {
      return (value as { $in: unknown[] }).$in.includes(doc[key])
    }
    return doc[key] === value
  })
}

// Fake single-room server state: one pre-existing Scheduled meeting.
const mockFakeDb: FakeDoc[] = []

const mockGetClient = jest.fn(() => ({
  apply: jest.fn((_txId: string) => {
    let notMatchQuery: Record<string, unknown> | undefined
    let pendingCreate: FakeDoc | undefined
    return {
      notMatch: jest.fn((_cls: unknown, query: Record<string, unknown>) => {
        notMatchQuery = query
      }),
      createDoc: jest.fn(async (_cls: unknown, _space: unknown, data: Record<string, unknown>, docId: string) => {
        pendingCreate = { _id: docId, ...data }
      }),
      commit: jest.fn(async () => {
        const conflict =
          notMatchQuery !== undefined &&
          mockFakeDb.some((d) => matchesQuery(d, notMatchQuery as Record<string, unknown>))
        if (conflict) return { result: false }
        if (pendingCreate !== undefined) mockFakeDb.push(pendingCreate)
        return { result: true }
      })
    }
  }),
  findOne: jest.fn(async (_cls: unknown, query: Record<string, unknown>) =>
    mockFakeDb.find((d) => matchesQuery(d, query))
  ),
  findAll: jest.fn(async (_cls: unknown, query: Record<string, unknown>) =>
    mockFakeDb.filter((d) => matchesQuery(d, query))
  )
}))

jest.mock('@hcengineering/presentation', () => ({
  __esModule: true,
  default: { metadata: { SessionId: 'presentation:metadata:SessionId' } },
  createQuery: jest.fn(() => ({ query: jest.fn(), unsubscribe: jest.fn() })),
  onClient: jest.fn(),
  getClient: mockGetClient
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

describe('createMeetingDocument ignores Scheduled meetings (defect D)', () => {
  beforeEach(() => {
    mockFakeDb.length = 0
    setCurrentAccount({
      uuid: 'acc-me' as AccountUuid,
      role: AccountRole.User,
      primarySocialId: 'social:me',
      socialIds: ['social:me']
    } as unknown as Account)
  })

  it('reuses the existing Scheduled meeting instead of creating a second one for the same room (defect: notMatch omits Scheduled)', async () => {
    const { createMeeting } = require('../meetings')

    const room = makeRoom()
    mockFakeDb.push({
      _id: 'scheduled-1',
      roomId: room._id,
      status: MeetingStatus.Scheduled,
      meetingScheduledDate: Date.now(),
      name: 'Scheduled meeting'
    })

    const result = await createMeeting(room)

    const meetingsForRoom = mockFakeDb.filter((d) => d.roomId === room._id)
    // Someone clicking the room while a calendar-scheduled meeting is pending
    // must land in that same meeting, not spin up a second LiveKit room.
    expect(meetingsForRoom).toHaveLength(1)
    expect((result as { meeting?: MeetingMinutes }).meeting?._id).toBe('scheduled-1')
  })

  it('starts a fresh ad-hoc meeting when the only Scheduled one is outside its start window', async () => {
    const { createMeeting } = require('../meetings')

    const room = makeRoom()
    mockFakeDb.push({
      _id: 'scheduled-next-week',
      roomId: room._id,
      status: MeetingStatus.Scheduled,
      meetingScheduledDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      name: 'Next week planning'
    })

    const result = await createMeeting(room)

    const created = (result as { meeting?: MeetingMinutes }).meeting
    expect(created?._id).not.toBe('scheduled-next-week')
    expect(mockFakeDb.find((d) => d._id === 'scheduled-next-week')?.status).toBe(MeetingStatus.Scheduled)
  })

  it('starts a fresh ad-hoc meeting when the Scheduled one carries no date', async () => {
    const { createMeeting } = require('../meetings')

    const room = makeRoom()
    mockFakeDb.push({ _id: 'scheduled-no-date', roomId: room._id, status: MeetingStatus.Scheduled, name: 'Dateless' })

    const result = await createMeeting(room)

    expect((result as { meeting?: MeetingMinutes }).meeting?._id).not.toBe('scheduled-no-date')
  })
})

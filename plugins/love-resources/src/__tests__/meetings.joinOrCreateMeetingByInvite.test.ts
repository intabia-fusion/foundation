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
import { MeetingStatus, type MeetingMinutes } from '@hcengineering/love'

jest.mock('svelte/store', () => require('./svelteStoreDouble'))

jest.mock('@hcengineering/contact', () => ({
  getCurrentEmployee: jest.fn(() => 'person-me')
}))
jest.mock('@hcengineering/contact-resources', () => ({
  getPersonByPersonRef: jest.fn(async () => ({ _id: 'person-me', personUuid: 'acc-me' }))
}))

const mockFindOne = jest.fn()
const mockConnect = jest.fn()

jest.mock('@hcengineering/presentation', () => ({
  __esModule: true,
  default: { metadata: { SessionId: 'presentation:metadata:SessionId' } },
  createQuery: jest.fn(() => ({ query: jest.fn(), unsubscribe: jest.fn() })),
  onClient: jest.fn(),
  getClient: jest.fn(() => ({ findOne: mockFindOne }))
}))
jest.mock('../utils', () => ({
  getLiveKitEndpoint: jest.fn(() => 'wss://example.test'),
  getRoomName: jest.fn(async () => 'Room 1'),
  liveKitClient: { connect: mockConnect, disconnect: jest.fn(async () => {}) },
  loveClient: { getRoomToken: jest.fn(async () => 'token'), claimSession: jest.fn(async () => {}) },
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
  return { lkIsConnecting: writable(false), lkSessionConnected: writable(false), myLastSessionSid: writable(undefined) }
})
jest.mock('../stores', () => {
  const { writable } = require('svelte/store')
  return {
    infos: writable([]),
    rooms: writable([]),
    myConnectingSessionId: writable(null),
    meetings: writable([]),
    myInfos: writable([]),
    currentMeetingMinutes: writable(undefined),
    waitForOfficeLoaded: jest.fn(async () => {}),
    withConnectingToMeeting: jest.fn(async (op: () => Promise<unknown>) => await op())
  }
})

describe('joinOrCreateMeetingByInvite fixed polling backoff (defect E)', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('connects within tens of milliseconds when the meeting and membership become available almost immediately, instead of waiting out the fixed backoff tick (defect: fixed polling backoff)', async () => {
    jest.useFakeTimers()
    try {
      setCurrentAccount({
        uuid: 'acc-me' as AccountUuid,
        role: AccountRole.User,
        primarySocialId: 'social:me',
        socialIds: ['social:me']
      } as unknown as Account)

      const { LoveServiceError } = require('../loveClient')
      const { joinOrCreateMeetingByInvite } = require('../meetings')

      const meetingId = 'meeting-1' as Ref<MeetingMinutes>
      const meeting = {
        _id: meetingId,
        roomId: undefined,
        status: MeetingStatus.Active,
        private: false,
        members: ['acc-me']
      } as unknown as MeetingMinutes

      // Meeting is found immediately, membership propagates on the very next check.
      mockFindOne.mockResolvedValue(meeting)
      mockConnect.mockRejectedValueOnce(new LoveServiceError(403, 'forbidden')).mockResolvedValue(undefined)

      const promise: Promise<boolean> = joinOrCreateMeetingByInvite(meetingId)

      // "Almost immediately" — well under the code's fixed 250ms backoff tick.
      await jest.advanceTimersByTimeAsync(50)

      let resolved: boolean | undefined
      void promise.then((v) => {
        resolved = v
      })
      await Promise.resolve()
      await Promise.resolve()

      expect(resolved).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })
})

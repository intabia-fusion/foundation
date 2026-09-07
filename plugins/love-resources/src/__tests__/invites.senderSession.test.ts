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

import { type UserMeetingInvite } from '@hcengineering/love'

jest.mock('svelte/store', () => require('./svelteStoreDouble'))

let sessionId: string | undefined = 'tab-sender'

jest.mock('@hcengineering/platform', () => ({
  ...jest.requireActual('@hcengineering/platform'),
  getMetadata: jest.fn(() => sessionId)
}))
jest.mock('@hcengineering/contact', () => ({
  getCurrentEmployee: jest.fn(() => 'person-me'),
  getCurrentEmployeeSpace: jest.fn(() => 'space-1')
}))
jest.mock('@hcengineering/contact-resources', () => ({
  getPersonByPersonRef: jest.fn(async () => ({ personUuid: 'account-other' }))
}))
jest.mock('@hcengineering/presentation', () => ({
  __esModule: true,
  default: { metadata: { SessionId: 'presentation:metadata:SessionId' } },
  createQuery: jest.fn(() => ({ query: jest.fn(), unsubscribe: jest.fn() })),
  onClient: jest.fn(),
  getClient: jest.fn(() => ({
    removeDoc: jest.fn(async () => undefined),
    findOne: jest.fn(async () => ({ _id: 'office-me' })),
    update: jest.fn(async () => undefined)
  })),
  playSound: jest.fn(async () => null)
}))
jest.mock('@hcengineering/ui', () => ({
  addNotification: jest.fn(),
  NotificationSeverity: { Info: 0, Success: 1, Warning: 2, Error: 3 }
}))
jest.mock('@hcengineering/theme', () => ({ getCurrentLanguage: jest.fn(() => 'en') }))

const mockCreateMeeting = jest.fn(async () => ({ meeting: { _id: 'meeting-new', members: [] } }))
const mockJoin = jest.fn(async () => true)
jest.mock('../meetings', () => ({
  createMeeting: async (...args: any[]) => await mockCreateMeeting(...(args as [])),
  joinOrCreateMeetingByInvite: async (...args: any[]) => await mockJoin(...(args as []))
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

function acceptedInvite (senderSessionId?: string): UserMeetingInvite {
  return {
    _id: 'invite-1',
    space: 'space-me',
    kind: 'invite-request',
    from: 'person-me',
    to: 'person-other',
    meeting: 'meeting-1',
    status: 'accepted',
    senderSessionId
  } as unknown as UserMeetingInvite
}

describe('checkAndJoinIfRecipientJoined - sender multi-tab guard', () => {
  beforeEach(() => {
    jest.resetModules()
    mockJoin.mockClear()
    mockCreateMeeting.mockClear()
    sessionId = 'tab-sender'
  })

  it('joins from the tab that placed the call', async () => {
    const { checkAndJoinIfRecipientJoined } = require('../invites')
    await checkAndJoinIfRecipientJoined([acceptedInvite('tab-sender')])
    expect(mockJoin).toHaveBeenCalledWith('meeting-1')
  })

  it('does not join from another tab of the same person', async () => {
    sessionId = 'tab-other'
    const { checkAndJoinIfRecipientJoined } = require('../invites')
    await checkAndJoinIfRecipientJoined([acceptedInvite('tab-sender')])
    expect(mockJoin).not.toHaveBeenCalled()
  })

  it('does not create a second A2 meeting from another tab', async () => {
    sessionId = 'tab-other'
    const { checkAndJoinIfRecipientJoined } = require('../invites')
    const inv = acceptedInvite('tab-sender')
    delete (inv as any).meeting
    await checkAndJoinIfRecipientJoined([inv])
    expect(mockCreateMeeting).not.toHaveBeenCalled()
  })

  it('falls back to every tab for legacy invites without a sender session', async () => {
    sessionId = 'tab-other'
    const { checkAndJoinIfRecipientJoined } = require('../invites')
    await checkAndJoinIfRecipientJoined([acceptedInvite(undefined)])
    expect(mockJoin).toHaveBeenCalledWith('meeting-1')
  })

  it('treats an empty SessionId as unknown so the accept guard cannot false-match', async () => {
    sessionId = ''
    const { responseToInviteRequest } = require('../invites')
    const presentation = require('@hcengineering/presentation')
    const update = jest.fn(async () => undefined)
    presentation.getClient.mockReturnValue({ update, removeDoc: jest.fn(), findOne: jest.fn() })
    await responseToInviteRequest(acceptedInvite(undefined), true)
    expect(update).toHaveBeenCalledWith(expect.anything(), { status: 'accepted', acceptedSessionId: undefined })
  })
})

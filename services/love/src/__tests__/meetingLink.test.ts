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
import { type Ref, type WorkspaceUuid } from '@hcengineering/core'
import { buildMeetingLinkPayload, defaultMeetingAccess, MeetingStatus, type MeetingMinutes } from '@hcengineering/love'
import { GuestManager } from '../guests'
import { WorkspaceClient } from '../workspaceClient'
import { decodeToken } from '@hcengineering/server-token'
import { createMockContext } from './test-helpers'

jest.mock('../workspaceClient')
jest.mock('@hcengineering/server-token')

const workspace = 'workspace-1' as WorkspaceUuid
const meetingId = 'meeting-1' as Ref<MeetingMinutes>
const day = 24 * 60 * 60 * 1000

function req (body: Record<string, any>): any {
  return { body, headers: {} }
}

function res (): any {
  return { status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() }
}

// Fixtures name a series by its master; `pointer`/`title`/`kind` are what findMeetingTarget adds.
function wsClientWith (target: any, session: any): any {
  const resolved =
    target === undefined
      ? undefined
      : { kind: 'event', pointer: target.master?.eventId, title: target.master?.title, ...target }
  return {
    findMeetingTarget: jest.fn().mockResolvedValue(resolved),
    resolveSession: jest.fn().mockResolvedValue(session),
    findMeetingById: jest.fn()
  }
}

const liveSession = { meeting: { _id: meetingId, status: MeetingStatus.Active } }

function pointer (linkVersion = 1): string {
  return buildMeetingLinkPayload({ eventId: 'E1', workspace, linkVersion })
}

function permanentPointer (linkVersion = 1): string {
  return buildMeetingLinkPayload({ eventId: 'PM1', workspace, linkVersion, kind: 'meeting' })
}

describe('guest link pointer payload', () => {
  let manager: GuestManager
  let roomClient: any

  beforeEach(() => {
    jest.clearAllMocks()
    roomClient = { listRooms: jest.fn().mockResolvedValue([{ name: `${workspace}_${meetingId}` }]) }
    manager = new GuestManager(createMockContext(), roomClient)
  })

  it('opens a meeting addressed by its series, without decoding a token', async () => {
    const wsClient = wsClientWith(
      { master: { eventId: 'E1' }, link: { linkVersion: 1 }, nextOccurrence: Date.now() + day },
      liveSession
    )
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestJoin(req({ token: pointer(), firstName: 'A', lastName: 'B' }), response)

    // A pointer is not a credential - nothing is verified by signature here.
    expect(decodeToken).not.toHaveBeenCalled()
    expect(wsClient.resolveSession).toHaveBeenCalledWith('E1', expect.any(Number), false, 'event')
  })

  it('refuses a link issued before the meeting was revoked', async () => {
    const wsClient = wsClientWith(
      { master: { eventId: 'E1' }, link: { linkVersion: 2 }, nextOccurrence: Date.now() + day },
      liveSession
    )
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestJoin(req({ token: pointer(1) }), response)

    expect(response.status).toHaveBeenCalledWith(403)
    expect(response.send).toHaveBeenCalledWith({ error: 'Link has been revoked.' })
    expect(wsClient.resolveSession).not.toHaveBeenCalled()
  })

  it('refuses a link once the series is over and its ttl has passed', async () => {
    const wsClient = wsClientWith(
      {
        master: { eventId: 'E1' },
        link: { linkVersion: 1, meetingAccess: defaultMeetingAccess },
        lastMeetingEnd: Date.now() - 30 * day
      },
      liveSession
    )
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestJoin(req({ token: pointer() }), response)

    expect(response.status).toHaveBeenCalledWith(403)
    expect(response.send).toHaveBeenCalledWith({ error: 'Link has expired.' })
  })

  it('keeps a recurring link alive long after the last session', async () => {
    const wsClient = wsClientWith(
      {
        master: { eventId: 'E1' },
        link: { linkVersion: 1, meetingAccess: defaultMeetingAccess },
        nextOccurrence: Date.now() + day,
        lastMeetingEnd: Date.now() - 30 * day
      },
      liveSession
    )
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestJoin(req({ token: pointer(), firstName: 'A', lastName: 'B' }), response)

    expect(response.status).not.toHaveBeenCalledWith(403)
  })

  it('lets a guest open the session when the link is a permanent room', async () => {
    const wsClient = wsClientWith(
      {
        master: { eventId: 'E1' },
        link: { linkVersion: 1, meetingAccess: { ...defaultMeetingAccess, start: 'link' } },
        nextOccurrence: Date.now() + day
      },
      liveSession
    )
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)

    await manager.handleGuestJoin(req({ token: pointer(), firstName: 'A', lastName: 'B' }), res())

    expect(wsClient.resolveSession).toHaveBeenCalledWith('E1', expect.any(Number), true, 'event')
  })

  it('makes a guest wait for a participant when only members may start', async () => {
    const wsClient = wsClientWith(
      {
        master: { eventId: 'E1' },
        link: { linkVersion: 1, meetingAccess: defaultMeetingAccess },
        nextOccurrence: Date.now() + day
      },
      liveSession
    )
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)

    await manager.handleGuestJoin(req({ token: pointer(), firstName: 'A', lastName: 'B' }), res())

    expect(wsClient.resolveSession).toHaveBeenCalledWith('E1', expect.any(Number), false, 'event')
  })

  it('withholds the name of a finished series when past access is none', async () => {
    const series = {
      master: { eventId: 'E1', title: 'Board sync' },
      link: { linkVersion: 1, meetingAccess: { ...defaultMeetingAccess, past: 'none' } },
      lastMeetingEnd: Date.now() - 60 * 1000
    }
    const wsClient = wsClientWith(series, { error: 'no-occurrence' })
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestInfo(req({ token: pointer() }), response)

    expect(response.send.mock.calls[0][0]).toMatchObject({ title: undefined })
  })

  it('still names a finished series when past access is last', async () => {
    const series = {
      master: { eventId: 'E1', title: 'Board sync' },
      link: { linkVersion: 1, meetingAccess: defaultMeetingAccess },
      lastMeetingEnd: Date.now() - 60 * 1000
    }
    const wsClient = wsClientWith(series, { error: 'no-occurrence' })
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestInfo(req({ token: pointer() }), response)

    expect(response.send.mock.calls[0][0]).toMatchObject({ title: 'Board sync' })
  })

  it('names an upcoming occurrence regardless of past access', async () => {
    const series = {
      master: { eventId: 'E1', title: 'Board sync' },
      link: { linkVersion: 1, meetingAccess: { ...defaultMeetingAccess, past: 'none' } },
      nextOccurrence: Date.now() + day
    }
    const wsClient = wsClientWith(series, { error: 'no-occurrence', nextOccurrence: Date.now() + day })
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestInfo(req({ token: pointer() }), response)

    expect(response.send.mock.calls[0][0]).toMatchObject({ title: 'Board sync' })
  })

  it('tells the lobby to wait when the meeting is still ahead', async () => {
    const wsClient = wsClientWith(
      { master: { eventId: 'E1', title: 'Standup' }, link: { linkVersion: 1 }, nextOccurrence: Date.now() + day },
      { error: 'no-occurrence', nextOccurrence: Date.now() + day }
    )
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestInfo(req({ token: pointer() }), response)

    expect(response.send.mock.calls[0][0]).toMatchObject({ mode: 'before', title: 'Standup' })
  })

  it('tells the lobby the series is over', async () => {
    const wsClient = wsClientWith(
      { master: { eventId: 'E1', title: 'Standup' }, link: { linkVersion: 1 }, lastMeetingEnd: Date.now() - 60 * 1000 },
      { error: 'no-occurrence' }
    )
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestInfo(req({ token: pointer() }), response)

    expect(response.send.mock.calls[0][0]).toMatchObject({ mode: 'after' })
  })

  it('holds the guest in the lobby until the room actually exists', async () => {
    // A session row is not an open meeting: without a LiveKit room there is nothing to join.
    roomClient.listRooms.mockResolvedValue([])
    const wsClient = wsClientWith(
      { master: { eventId: 'E1' }, link: { linkVersion: 1 }, nextOccurrence: Date.now() + day },
      liveSession
    )
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestInfo(req({ token: pointer() }), response)

    expect(response.send.mock.calls[0][0]).toMatchObject({ mode: 'before', roomFound: false })
  })

  it('opens the meeting once its room is up', async () => {
    const wsClient = wsClientWith(
      { master: { eventId: 'E1' }, link: { linkVersion: 1 }, nextOccurrence: Date.now() + day },
      liveSession
    )
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestInfo(req({ token: pointer() }), response)

    expect(response.send.mock.calls[0][0]).toMatchObject({ mode: 'live', roomFound: true })
  })

  it('routes a permanent-meeting pointer to its own kind', async () => {
    const wsClient = wsClientWith(
      { kind: 'meeting', pointer: 'PM1', title: 'Design corner', link: { linkVersion: 1 } },
      liveSession
    )
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestJoin(req({ token: permanentPointer(), firstName: 'A', lastName: 'B' }), response)

    expect(wsClient.findMeetingTarget).toHaveBeenCalledWith('PM1', 'meeting')
    expect(wsClient.resolveSession).toHaveBeenCalledWith('PM1', expect.any(Number), false, 'meeting')
  })

  it('keeps a permanent link alive however long since the last session', async () => {
    // No series to outlive, so afterTtl never starts counting.
    const wsClient = wsClientWith(
      {
        kind: 'meeting',
        pointer: 'PM1',
        title: 'Design corner',
        link: { linkVersion: 1, meetingAccess: defaultMeetingAccess },
        lastMeetingEnd: Date.now() - 400 * day
      },
      liveSession
    )
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestInfo(req({ token: permanentPointer() }), response)

    expect(response.send.mock.calls[0][0]).toMatchObject({ mode: 'live' })
  })

  it('never calls a permanent meeting over, only not started', async () => {
    const wsClient = wsClientWith(
      { kind: 'meeting', pointer: 'PM1', title: 'Design corner', link: { linkVersion: 1 } },
      { error: 'not-started' }
    )
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestInfo(req({ token: permanentPointer() }), response)

    expect(response.send.mock.calls[0][0]).toMatchObject({ mode: 'before', title: 'Design corner' })
  })

  it('reports a pointer to a meeting that no longer exists', async () => {
    const wsClient = wsClientWith(undefined, liveSession)
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    const response = res()

    await manager.handleGuestInfo(req({ token: pointer() }), response)

    expect(response.status).toHaveBeenCalledWith(404)
  })
})

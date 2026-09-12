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

import { Ref, WorkspaceUuid } from '@hcengineering/core'
import { MeetingMinutes, MeetingStatus } from '@hcengineering/love'
import { Person } from '@hcengineering/contact'
import { GuestManager } from '../guests'
import { WorkspaceClient } from '../workspaceClient'
import { decodeToken, generateToken } from '@hcengineering/server-token'
import { createMockContext } from './test-helpers'

jest.mock('../workspaceClient')
jest.mock('@hcengineering/server-token')

const workspace = 'workspace-1' as WorkspaceUuid
const meetingId = 'meeting-1' as Ref<MeetingMinutes>
const personRef = 'person-1' as Ref<Person>

function createMockReq (body: Record<string, any>): any {
  return { body, headers: {} }
}

function createMockRes (): any {
  return {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis()
  }
}

function createMockRoomClient (): { listRooms: jest.Mock } {
  return { listRooms: jest.fn().mockResolvedValue([{ name: `${workspace}_${meetingId}` }]) }
}

function createMockWsClient (): jest.Mocked<WorkspaceClient> {
  return {
    findMeetingById: jest.fn(),
    ensurePersonByName: jest.fn()
  } as unknown as jest.Mocked<WorkspaceClient>
}

const validDecoded = { workspace, extra: { meetingId } } as any

describe('GuestManager.handleGuestJoin', () => {
  let roomClient: ReturnType<typeof createMockRoomClient>
  let wsClient: jest.Mocked<WorkspaceClient>
  let manager: GuestManager

  beforeEach(() => {
    jest.clearAllMocks()
    roomClient = createMockRoomClient()
    wsClient = createMockWsClient()
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    ;(decodeToken as jest.Mock).mockReturnValue(validDecoded)
    manager = new GuestManager(createMockContext(), roomClient as any)
  })

  it('returns 403 when meeting is Finished', async () => {
    wsClient.findMeetingById.mockResolvedValue({
      _id: meetingId,
      status: MeetingStatus.Finished
    } as unknown as MeetingMinutes)
    const req = createMockReq({ token: 'guest-token' })
    const res = createMockRes()

    await manager.handleGuestJoin(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.send).toHaveBeenCalledWith({ error: 'Meeting has already finished.' })
  })

  it('returns 404 when meeting is Active but no LiveKit room exists', async () => {
    wsClient.findMeetingById.mockResolvedValue({
      _id: meetingId,
      status: MeetingStatus.Active
    } as unknown as MeetingMinutes)
    roomClient.listRooms.mockResolvedValue([])
    const req = createMockReq({ token: 'guest-token' })
    const res = createMockRes()

    await manager.handleGuestJoin(req, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.send).toHaveBeenCalledWith({ error: 'Meeting room not found.' })
  })

  it('returns 200 with token/roomName/person when Active, room exists and person is created', async () => {
    wsClient.findMeetingById.mockResolvedValue({
      _id: meetingId,
      status: MeetingStatus.Active
    } as unknown as MeetingMinutes)
    wsClient.ensurePersonByName.mockResolvedValue(personRef)
    const req = createMockReq({ token: 'guest-token', firstName: 'John', lastName: 'Doe' })
    const res = createMockRes()

    await manager.handleGuestJoin(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    const payload = res.send.mock.calls[0][0]
    expect(payload.roomName).toBe(`${workspace}_${meetingId}`)
    expect(payload.person).toBe(personRef)
    expect(typeof payload.token).toBe('string')
  })

  it('returns 500 when ensurePersonByName fails to produce a person', async () => {
    wsClient.findMeetingById.mockResolvedValue({
      _id: meetingId,
      status: MeetingStatus.Active
    } as unknown as MeetingMinutes)
    wsClient.ensurePersonByName.mockResolvedValue(undefined)
    const req = createMockReq({ token: 'guest-token', firstName: 'John', lastName: 'Doe' })
    const res = createMockRes()

    await manager.handleGuestJoin(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.send).toHaveBeenCalledWith({ error: 'Failed to create guest identity' })
  })
})

describe('GuestManager.handleGuestInfo', () => {
  let roomClient: any
  let wsClient: jest.Mocked<WorkspaceClient>
  let manager: GuestManager

  beforeEach(() => {
    jest.clearAllMocks()
    roomClient = { listRooms: jest.fn().mockResolvedValue([{ name: `${workspace}_${meetingId}` }]) }
    wsClient = createMockWsClient()
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    ;(decodeToken as jest.Mock).mockReturnValue(validDecoded)
    manager = new GuestManager(createMockContext(), roomClient)
  })

  it('returns meetingStatus and roomFound true when room exists', async () => {
    wsClient.findMeetingById.mockResolvedValue({
      status: MeetingStatus.Active,
      name: 'Test'
    } as unknown as MeetingMinutes)
    const req = createMockReq({ token: 'guest-token' })
    const res = createMockRes()

    await manager.handleGuestInfo(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    const payload = res.send.mock.calls[0][0]
    expect(payload.meetingStatus).toBe(MeetingStatus.Active)
    expect(payload.roomFound).toBe(true)
  })

  it('returns roomFound false but still 200 when listRooms throws', async () => {
    wsClient.findMeetingById.mockResolvedValue({
      status: MeetingStatus.Active,
      name: 'Test'
    } as unknown as MeetingMinutes)
    roomClient.listRooms.mockRejectedValue(new Error('livekit down'))
    const req = createMockReq({ token: 'guest-token' })
    const res = createMockRes()

    await manager.handleGuestInfo(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    const payload = res.send.mock.calls[0][0]
    expect(payload.roomFound).toBe(false)
  })

  it('returns 404 when meeting is missing', async () => {
    wsClient.findMeetingById.mockResolvedValue(undefined)
    const req = createMockReq({ token: 'guest-token' })
    const res = createMockRes()

    await manager.handleGuestInfo(req, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.send).toHaveBeenCalledWith({ error: 'Meeting not found' })
  })

  it('returns 401 when token is invalid', async () => {
    ;(decodeToken as jest.Mock).mockImplementation(() => {
      throw new Error('bad token')
    })
    const req = createMockReq({ token: 'bad-token' })
    const res = createMockRes()

    await manager.handleGuestInfo(req, res)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.send).toHaveBeenCalledWith({ error: 'Invalid or expired token' })
  })
})

describe('GuestManager.createGuestToken', () => {
  let roomClient: any
  let wsClient: jest.Mocked<WorkspaceClient>
  let manager: GuestManager
  const loginInfo = { workspace, workspaceUrl: 'ws-url' } as any

  beforeEach(() => {
    jest.clearAllMocks()
    roomClient = { listRooms: jest.fn() }
    wsClient = createMockWsClient()
    wsClient.findMeetingById.mockResolvedValue({ _id: meetingId } as unknown as MeetingMinutes)
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    ;(generateToken as jest.Mock).mockReturnValue('raw-jwt-token')
    manager = new GuestManager(createMockContext(), roomClient)
  })

  it('returns the shortId when createShortLink succeeds', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ shortId: 'short-abc' })
    }) as any

    const result = await manager.createGuestToken(meetingId, loginInfo)

    expect(result).toBe('short-abc')
  })

  it('falls back to the raw JWT when fetch fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network error')) as any

    const result = await manager.createGuestToken(meetingId, loginInfo)

    expect(result).toBe('raw-jwt-token')
  })

  it('falls back to the raw JWT when fetch returns a non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any

    const result = await manager.createGuestToken(meetingId, loginInfo)

    expect(result).toBe('raw-jwt-token')
  })
})

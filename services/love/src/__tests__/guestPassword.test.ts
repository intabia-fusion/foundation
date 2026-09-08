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
import { type WorkspaceUuid } from '@hcengineering/core'
import { buildMeetingLinkPayload } from '@hcengineering/love'
import { GuestManager } from '../guests'
import { WorkspaceClient } from '../workspaceClient'
import { hashGuestPassword } from '../passwords'
import { createMockContext } from './test-helpers'

jest.mock('../workspaceClient')

const workspace = 'workspace-1' as WorkspaceUuid
const stored = hashGuestPassword('correct-horse')

function req (body: Record<string, any>, ip = '1.2.3.4'): any {
  return { body, headers: {}, ip }
}

function res (): any {
  return { status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() }
}

function pointer (): string {
  return buildMeetingLinkPayload({ eventId: 'E1', workspace, linkVersion: 1 })
}

function wsClientWith (): any {
  return {
    findMeetingTarget: jest.fn().mockResolvedValue({
      kind: 'event',
      pointer: 'E1',
      master: { eventId: 'E1' },
      title: 'Protected meeting',
      link: { linkVersion: 1, meetingAccess: { start: 'link', afterTtl: 0, past: 'last', guestPassword: stored } }
    }),
    resolveSession: jest.fn().mockResolvedValue({ meeting: { _id: 'm1', status: 0 } })
  }
}

describe('guest link password gate', () => {
  let manager: GuestManager
  let roomClient: any
  let wsClient: any

  beforeEach(() => {
    jest.clearAllMocks()
    roomClient = { listRooms: jest.fn().mockResolvedValue([{ name: 'room' }]) }
    wsClient = wsClientWith()
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    manager = new GuestManager(createMockContext(), roomClient)
  })

  it('guestInfo reveals nothing but the flag when a password is set', async () => {
    const response = res()

    await manager.handleGuestInfo(req({ token: pointer() }), response)

    expect(response.status).toHaveBeenCalledWith(200)
    const payload = response.send.mock.calls[0][0]
    expect(payload).toEqual({
      passwordRequired: true,
      workspace,
      workspaceUrl: null,
      now: expect.any(Number)
    })
    expect(wsClient.resolveSession).not.toHaveBeenCalled()
  })

  it('guestJoin rejects a missing password', async () => {
    const response = res()

    await manager.handleGuestJoin(req({ token: pointer(), firstName: 'A', lastName: 'B' }), response)

    expect(response.status).toHaveBeenCalledWith(401)
    expect(response.send).toHaveBeenCalledWith({ error: 'Wrong password' })
  })

  it('guestJoin rejects a wrong password', async () => {
    const response = res()

    await manager.handleGuestJoin(req({ token: pointer(), password: 'nope', firstName: 'A', lastName: 'B' }), response)

    expect(response.status).toHaveBeenCalledWith(401)
    expect(response.send).toHaveBeenCalledWith({ error: 'Wrong password' })
  })

  it('guestJoin accepts the correct password', async () => {
    wsClient.ensurePersonByName = jest.fn().mockResolvedValue('person-1')
    const response = res()

    await manager.handleGuestJoin(
      req({ token: pointer(), password: 'correct-horse', firstName: 'A', lastName: 'B' }),
      response
    )

    expect(response.status).toHaveBeenCalledWith(200)
    expect(wsClient.resolveSession).toHaveBeenCalled()
  })

  it('locks the link+IP out after 10 failed attempts, until a window passes', async () => {
    for (let i = 0; i < 10; i++) {
      const response = res()
      // eslint-disable-next-line no-await-in-loop
      await manager.handleGuestJoin(req({ token: pointer(), password: 'nope' }), response)
      expect(response.status).toHaveBeenCalledWith(401)
    }

    const blocked = res()
    await manager.handleGuestJoin(req({ token: pointer(), password: 'correct-horse' }), blocked)
    expect(blocked.status).toHaveBeenCalledWith(429)
    // Rate limiting must not even ask the workspace for the meeting.
    expect(wsClient.resolveSession).not.toHaveBeenCalled()
  })

  it('does not lock out a different IP', async () => {
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      await manager.handleGuestJoin(req({ token: pointer(), password: 'nope' }, '9.9.9.9'), res())
    }

    wsClient.ensurePersonByName = jest.fn().mockResolvedValue('person-1')
    const response = res()
    await manager.handleGuestJoin(req({ token: pointer(), password: 'correct-horse' }, '5.5.5.5'), response)

    expect(response.status).toHaveBeenCalledWith(200)
  })

  it('resets the attempt counter after a successful join', async () => {
    wsClient.ensurePersonByName = jest.fn().mockResolvedValue('person-1')
    for (let i = 0; i < 9; i++) {
      // eslint-disable-next-line no-await-in-loop
      await manager.handleGuestJoin(req({ token: pointer(), password: 'nope' }), res())
    }
    await manager.handleGuestJoin(req({ token: pointer(), password: 'correct-horse' }), res())

    const afterSuccess = res()
    await manager.handleGuestJoin(req({ token: pointer(), password: 'nope' }), afterSuccess)
    expect(afterSuccess.status).toHaveBeenCalledWith(401)
    expect(afterSuccess.status).not.toHaveBeenCalledWith(429)
  })
})

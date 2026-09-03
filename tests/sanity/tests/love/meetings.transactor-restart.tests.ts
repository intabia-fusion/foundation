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

import { expect, test } from '@playwright/test'
import { generateToken } from '@hcengineering/server-token'
import { systemAccountUuid, type WorkspaceUuid } from '@hcengineering/core'
import { getWorkspaceToken, loadServerConfig } from '@hcengineering/api-client'
import love, { type ParticipantInfo, type Room } from '@hcengineering/love'
import { PlatformURI, PlatformUserSecond } from '../utils'
import {
  closeLoveWindows,
  closeMeetingContexts,
  firstAvailableRoom,
  getSystemRestClient,
  joinRoom,
  occupiedCells,
  openLove,
  waitForActiveMeetingsToFinish
} from './meeting-helpers'

const MEETINGS_WS = 'meetings-ws'

async function getMeetingsWorkspaceId (): Promise<WorkspaceUuid> {
  const baseUrl = (PlatformURI ?? 'http://localhost:8083').replace(/\/$/, '')
  const config = await loadServerConfig(baseUrl)
  const token = await getWorkspaceToken(
    baseUrl,
    { email: PlatformUserSecond, password: '1234', workspace: MEETINGS_WS },
    config
  )
  return token.workspaceId
}

// Same production path `backup-restore` and model-upgrade use: rebuilds the Pipeline for this
// workspace only, siblings on the shared transactor are untouched.
async function forceCloseWorkspaceSession (workspaceId: WorkspaceUuid): Promise<void> {
  const token = generateToken(systemAccountUuid, workspaceId, { service: 'test', admin: 'true' }, 'secret')
  const baseUrl = (PlatformURI ?? 'http://localhost:8083').replace(/\/$/, '')
  const res = await fetch(`${baseUrl}/_tr0/api/v1/manage?operation=force-close&wsId=${workspaceId}&token=${token}`, {
    method: 'PUT'
  })
  if (!res.ok) {
    throw new Error(`force-close failed: ${res.status} ${await res.text()}`)
  }
}

// Own contexts, not the shared windows: the test restarts the transactor, and a window left
// mid-reconnect would be inherited by every test after it.
export function registerTransactorRestartTests (): void {
  test.describe('meeting minutes - participant presence across a workspace session restart', () => {
    // The shared windows hold a live session for the same accounts this test signs in as, and two
    // sessions per user break presence and departure checks. Drop them; the next shared test pays
    // one boot to get its window back.
    test.beforeAll(async () => {
      await closeLoveWindows()
    })

    // force-close drops the shared `meetings-ws` session, and with it DOMAIN_TRANSIENT for every
    // other love test in that workspace. Manual only: LOVE_MANUAL_TESTS=true.
    test.skip(process.env.LOVE_MANUAL_TESTS !== 'true', 'Restarts the shared workspace session')

    test.beforeEach(async () => {
      await waitForActiveMeetingsToFinish()
    })

    // Defect: ParticipantInfo lives in an in-memory domain, so a session restart wipes presence
    // while LiveKit keeps everyone connected; polling sees them in both snapshots and never re-adds.
    test('participants stay on the floor after a workspace session restart (defect: DOMAIN_TRANSIENT is in-memory)', async ({
      browser
    }) => {
      test.setTimeout(90000)

      const ctxA = await browser.newContext({ storageState: '.auth/storageSecond.json' })
      const ctxB = await browser.newContext({ storageState: '.auth/storageThird.json' })
      const pageA = await ctxA.newPage()
      const pageB = await ctxB.newPage()

      try {
        await openLove(pageA)
        await openLove(pageB)

        const roomName = await firstAvailableRoom(pageA)
        test.skip(roomName === null, 'No regular room available')

        await joinRoom(pageA, roomName as string)
        await joinRoom(pageB, roomName as string)

        await expect.poll(async () => await occupiedCells(pageA, roomName as string), { timeout: 30000 }).toBe(2)

        const sys = await getSystemRestClient()
        const room = await sys.findOne(love.class.Room, { name: roomName as string })
        expect(room).toBeDefined()
        const roomId = (room as Room)._id

        const before = await sys.findAll<ParticipantInfo>(love.class.ParticipantInfo, { room: roomId })
        expect(before.length).toBe(2)

        const workspaceId = await getMeetingsWorkspaceId()
        await forceCloseWorkspaceSession(workspaceId)

        // Nobody left LiveKit, only the platform session died, so both should reappear
        // on the floor once the polling cycle runs.
        await expect
          .poll(async () => (await sys.findAll<ParticipantInfo>(love.class.ParticipantInfo, { room: roomId })).length, {
            timeout: 30000
          })
          .toBe(2)
      } finally {
        await closeMeetingContexts([
          { ctx: ctxA, pages: [pageA] },
          { ctx: ctxB, pages: [pageB] }
        ])
      }
    })
  })
}

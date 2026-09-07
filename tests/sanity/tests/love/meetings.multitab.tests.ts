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
import { MeetingStatus, type MeetingMinutes } from '@hcengineering/love'
import love from '@hcengineering/love'
import {
  closeLoveWindows,
  closeMeetingContexts,
  connectedMarker,
  firstAvailableRoom,
  getSystemRestClient,
  joinRoom,
  liveKitRoomOf,
  openLove,
  waitForActiveMeetingsToFinish,
  waitRoomMeeting
} from './meeting-helpers'

export function registerMultiTabTests (): void {
  test.describe('meeting minutes - one person in two tabs', () => {
    test.beforeAll(async () => {
      await closeLoveWindows()
    })

    test.beforeEach(async () => {
      await waitForActiveMeetingsToFinish()
    })

    // Defect: joining from a second tab left the first tab connected to its room. `infos` collapses
    // both rows of one person into the newest, so room A showed only the AI bot while a live
    // session still held it open - the room never closed, even across a page refresh.
    test('joining from a second tab evicts the first tab and closes its room', async ({ browser }) => {
      test.setTimeout(120000)

      // Same account, two independent sessions - what two browser tabs look like to the server.
      const ctxA = await browser.newContext({ storageState: '.auth/storageSecond.json' })
      const ctxB = await browser.newContext({ storageState: '.auth/storageSecond.json' })
      const tabA = await ctxA.newPage()
      const tabB = await ctxB.newPage()

      try {
        await openLove(tabA)
        const roomA = await firstAvailableRoom(tabA)
        expect(roomA).not.toBeNull()
        await joinRoom(tabA, roomA as string)
        const meetingA = await waitRoomMeeting(roomA as string)

        await openLove(tabB)
        const roomB = await firstAvailableRoom(tabB, [roomA as string])
        expect(roomB).not.toBeNull()
        await tabB
          .locator(`[data-id="room-${roomB as string}"]`)
          .first()
          .click()
        await tabB.locator('[data-id="meeting-connect"]').getByRole('button').first().click()

        // The guard warns that another session holds a meeting; confirming leaves it.
        const confirm = tabB.getByRole('button', { name: 'Ok' }).first()
        await expect(confirm).toBeVisible({ timeout: 15000 })
        await confirm.click()
        await expect.poll(async () => await connectedMarker(tabB).count(), { timeout: 45000 }).toBeGreaterThan(0)

        // Tab A must lose its session, and room A must close instead of lingering.
        await expect.poll(async () => await connectedMarker(tabA).count(), { timeout: 45000 }).toBe(0)

        const sys = await getSystemRestClient()
        await expect
          .poll(
            async () => {
              const doc = await sys.findOne<MeetingMinutes>(love.class.MeetingMinutes, { _id: meetingA._id })
              return doc?.status
            },
            { timeout: 60000, intervals: [1000] }
          )
          .toBe(MeetingStatus.Finished)

        expect(await liveKitRoomOf(meetingA._id)).toBeNull()
      } finally {
        await closeMeetingContexts([
          { ctx: ctxA, pages: [tabA] },
          { ctx: ctxB, pages: [tabB] }
        ])
      }
    })
  })
}

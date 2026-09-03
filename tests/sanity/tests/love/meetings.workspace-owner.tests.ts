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

import {
  clickFirstAvailableRoom,
  clickRoomByName,
  closeMeetingContexts,
  loveWindow,
  openMeetingMinutes,
  startOrJoin,
  waitConnected,
  waitForActiveMeetingsToFinish
} from './meeting-helpers'
import { retry } from '../retry'

export function registerWorkspaceOwnerTests (): void {
  test.describe('meeting minutes - workspace owner privileges', () => {
    test.beforeEach(async () => {
      await waitForActiveMeetingsToFinish()
    })

    /**
     * A workspace owner joins a private meeting hosted by somebody else without an invite:
     * middleware bypasses the owners-only check, so they get Connect and self-add to members.
     */
    test('workspace owner can self-join a private meeting hosted by another user', async ({ browser }) => {
      test.setTimeout(90000)

      const { ctx: ctx1, page: page1 } = await loveWindow(browser, 'first') // workspace owner (user1)
      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second') // meeting owner (user2)

      try {
        // user2 starts a public meeting and becomes its owner.
        const room = await clickFirstAvailableRoom(page2)
        test.skip(room === null, 'No regular room available')
        await startOrJoin(page2)
        await waitConnected(page2)

        // user2 closes the room → private=true, members=[user2].
        await openMeetingMinutes(page2, room as string)
        const toggle = page2.locator('[data-id="meeting-toggle-private"]').first()
        await expect(toggle).toBeVisible({ timeout: 10000 })
        await toggle.click()

        // user1 opens the same room. As workspace owner they must see the
        // Connect button (not Knock) because middleware grants them access.
        const connect = page1.locator('[data-id="meeting-connect"]').getByRole('button').first()
        // Until the privacy flip reaches user1 the panel renders Knock and Connect does not exist,
        // so waiting on it alone only burns the timeout. Re-open the room until the view settles.
        await retry(async () => {
          await clickRoomByName(page1, room as string)
          await expect(connect).toBeVisible({ timeout: 3000 })
        }, 30000)
        await connect.click()

        // The widget proves LiveKit accepted the token; a broken owner-bypass would give 403.
        await waitConnected(page1)
        // user2's widget must still be present — joining the same meeting
        // must not kick the original owner out.
        await expect(page2.locator('[data-id="meeting-widget"]')).toBeVisible()
      } finally {
        await closeMeetingContexts([
          { ctx: ctx1, pages: [page1] },
          { ctx: ctx2, pages: [page2] }
        ])
      }
    })
  })
}

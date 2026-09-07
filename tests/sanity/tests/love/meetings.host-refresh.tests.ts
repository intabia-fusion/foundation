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

import { expect, test, type Page } from '@playwright/test'
import {
  clickOfficeOf,
  closeLoveWindows,
  closeMeetingContexts,
  connectedMarker,
  knockAndWaitPending,
  openLove,
  waitForActiveMeetingsToFinish
} from './meeting-helpers'

// Personal offices carry an empty `data-id="room-"`, so pick by the visible owner name.
async function connectToOwnOffice (page: Page): Promise<void> {
  const office = page.locator('div.floorGrid-room.myOffice').first()
  await expect(office).toBeVisible({ timeout: 15000 })
  const avatarCell = office.locator('.floorGrid-room__field').first()
  await avatarCell.hover()
  await avatarCell.click()
  const startBtn = page.locator('[data-id="start-own-meeting"]').first()
  await expect(startBtn).toBeVisible({ timeout: 10000 })
  await startBtn.click()
  await expect.poll(async () => await connectedMarker(page).count(), { timeout: 30000 }).toBeGreaterThan(0)
}

// Own contexts, not the shared windows: the test reloads the host mid-meeting, the same shape
// that made `refresh-reconnect` flaky on a reused window (90s timeout, then green on retry).
export function registerHostRefreshTests (): void {
  test.describe('meeting minutes - office owner refresh', () => {
    // The shared windows hold a live session for the same accounts this test signs in as, and two
    // sessions per user break presence and departure checks. Drop them; the next shared test pays
    // one boot to get its window back.
    test.beforeAll(async () => {
      await closeLoveWindows()
    })

    test.beforeEach(async () => {
      await waitForActiveMeetingsToFinish()
    })

    // Defect: a short `departureTimeout` makes a refresh look like a leave, and the owner
    // leaving closes the whole room via `deleteRoom` - F5 by the host ended it for everyone.
    test('host refresh does not disconnect the other participant (defect: departureTimeout 3s)', async ({
      browser
    }) => {
      test.setTimeout(90000)

      // Office owner — personal office is named after this account (Dirak Kainin).
      const ownerCtx = await browser.newContext({ storageState: '.auth/storageSecond.json' })
      // Guest — knocks into the (private) office and gets accepted.
      const guestCtx = await browser.newContext({ storageState: '.auth/storageThird.json' })
      const owner = await ownerCtx.newPage()
      const guest = await guestCtx.newPage()

      try {
        await openLove(owner)
        await openLove(guest)

        await connectToOwnOffice(owner)

        await clickOfficeOf(guest, 'Dirak')
        const knockBtn = guest.locator('[data-id="meeting-knock"]').first()
        await expect(knockBtn).toBeVisible({ timeout: 30000 })
        await knockAndWaitPending(guest)

        const knockingItem = owner.locator('[data-id="knocking-item"]').first()
        await expect(knockingItem).toBeVisible({ timeout: 30000 })
        await knockingItem.locator('[data-id="knock-accept"]').click()

        await expect.poll(async () => await connectedMarker(guest).count(), { timeout: 60000 }).toBeGreaterThan(0)

        // Host refreshes the page (F5) — a transient disconnect the room
        // shouldn't treat as "left for good".
        await owner.reload({ waitUntil: 'load' })

        // Past OWNER_REJOIN_GRACE_SEC (8s on the stand): the room closes only when the owner is
        // still missing when the grace expires, so a shorter wait would pass without proving it.
        await guest.waitForTimeout(10000)

        // Defect: the guest gets disconnected because the host's refresh
        // closed the whole LiveKit room (owner-office leave -> deleteRoom).
        await expect.poll(async () => await connectedMarker(guest).count(), { timeout: 5000 }).toBeGreaterThan(0)
      } finally {
        await closeMeetingContexts([
          { ctx: ownerCtx, pages: [owner] },
          { ctx: guestCtx, pages: [guest] }
        ])
      }
    })
  })
}

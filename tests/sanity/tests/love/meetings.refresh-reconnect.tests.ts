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
  clickFirstAvailableRoom,
  clickRoomByName,
  closeLoveWindows,
  closeMeetingContexts,
  openLove,
  waitConnected,
  waitForActiveMeetingsToFinish
} from './meeting-helpers'

async function startMeeting (page: Page): Promise<void> {
  const connect = page.locator('[data-id="meeting-connect"]').first()
  await expect(connect).toBeVisible({ timeout: 10000 })
  await connect.click()
}

// Own contexts, not the shared windows: these tests reload the page and assert on the
// sessionStorage reconnect anchor. On a reused window the pooled page was seen closed under a
// running test ('Target page, context or browser has been closed'), and a stale anchor from an
// earlier test would change what a reload is supposed to restore.
export function registerRefreshReconnectTests (): void {
  test.describe('meeting minutes - refresh reconnect', () => {
    // The shared windows hold a live session for the same accounts this test signs in as, and two
    // sessions per user break presence and departure checks. Drop them; the next shared test pays
    // one boot to get its window back.
    test.beforeAll(async () => {
      await closeLoveWindows()
    })

    test.beforeEach(async () => {
      await waitForActiveMeetingsToFinish()
    })

    test('refresh during an active meeting reconnects automatically', async ({ browser }) => {
      test.setTimeout(90000)

      const ctx = await browser.newContext({ storageState: '.auth/storageSecond.json' })
      const page = await ctx.newPage()
      // A second participant keeps the room alive: the last one to leave ends the meeting within
      // seconds, so a solo reload raced the shutdown instead of testing the reconnect.
      const otherCtx = await browser.newContext({ storageState: '.auth/storageThird.json' })
      const otherPage = await otherCtx.newPage()
      try {
        await openLove(page)

        const room = await clickFirstAvailableRoom(page)
        test.skip(room === null, 'No regular room available')

        await startMeeting(page)
        await waitConnected(page)

        await openLove(otherPage)
        await clickRoomByName(otherPage, room as string)
        await startMeeting(otherPage)
        await waitConnected(otherPage)

        const anchorBefore = await page.evaluate(() => sessionStorage.getItem('love.activeMeeting'))
        expect(anchorBefore).not.toBeNull()
        expect(anchorBefore?.length ?? 0).toBeGreaterThan(0)

        await page.reload({ waitUntil: 'load' })

        await expect(page.locator('[data-id="meeting-widget"]')).toBeVisible({ timeout: 60000 })

        const anchorAfter = await page.evaluate(() => sessionStorage.getItem('love.activeMeeting'))
        expect(anchorAfter).toBe(anchorBefore)
      } finally {
        await closeMeetingContexts([
          { ctx, pages: [page] },
          { ctx: otherCtx, pages: [otherPage] }
        ])
      }
    })

    test('explicit leave stays left (no subscribe-watcher reconnect loop)', async ({ browser }) => {
      // Regression: stale PI after leave used to trigger auto-reconnect.
      test.setTimeout(90000)

      const ctx = await browser.newContext({ storageState: '.auth/storageSecond.json' })
      const page = await ctx.newPage()
      try {
        await openLove(page)

        const room = await clickFirstAvailableRoom(page)
        test.skip(room === null, 'No regular room available')

        await startMeeting(page)
        await waitConnected(page)

        await page.locator('[data-id="meeting-leave"]').first().click()
        await expect(page.locator('[data-id="meeting-widget"]')).toBeHidden({ timeout: 15000 })

        const anchor = await page.evaluate(() => sessionStorage.getItem('love.activeMeeting'))
        expect(anchor).toBeNull()

        // Hold > LK departureTimeout (3s) to catch stale-PI subscribe race.
        await expect(page.locator('[data-id="meeting-widget"]')).toBeHidden({ timeout: 8000 })

        const anchorAfter = await page.evaluate(() => sessionStorage.getItem('love.activeMeeting'))
        expect(anchorAfter).toBeNull()
      } finally {
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })

    test('refresh after explicit leave does not auto-reconnect', async ({ browser }) => {
      test.setTimeout(90000)

      const ctx = await browser.newContext({ storageState: '.auth/storageSecond.json' })
      const page = await ctx.newPage()
      try {
        await openLove(page)

        const room = await clickFirstAvailableRoom(page)
        test.skip(room === null, 'No regular room available')

        await startMeeting(page)
        await waitConnected(page)

        // Leave through the UI — should clear the reconnect anchor.
        await page.locator('[data-id="meeting-leave"]').first().click()
        await expect(page.locator('[data-id="meeting-widget"]')).toBeHidden({ timeout: 15000 })

        const anchorBefore = await page.evaluate(() => sessionStorage.getItem('love.activeMeeting'))
        expect(anchorBefore).toBeNull()

        await page.reload({ waitUntil: 'load' })

        // No reconnect — meeting widget must stay hidden for a generous
        // timeout (longer than reconnect's typical window).
        await expect(page.locator('[data-id="meeting-widget"]')).toBeHidden({ timeout: 10000 })
      } finally {
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })
  })
}

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
  closeMeetingContexts,
  loveWindow,
  startOrJoin,
  waitConnected
} from './meeting-helpers'

async function inviteByLastName (page: Page, lastName: string): Promise<void> {
  await page.locator('[data-id="invite-button"]').first().click()
  const popup = page.locator('.hulyModal-container').last()
  const search = popup.getByPlaceholder(/Search/i)
  await expect(search).toBeVisible({ timeout: 5000 })
  await search.fill(lastName)
  await popup.locator('button.row').filter({ hasText: lastName }).first().click()
  const ok = popup.locator('.hulyModal-footer').getByRole('button', { name: /^Invite$/i })
  await expect(ok).toBeEnabled({ timeout: 5000 })
  await ok.click()
}

export function registerConnectTests (): void {
  test.describe('meeting minutes - real connect', () => {
    test('user2 (non-owner of workspace) starts meeting and connects to LiveKit', async ({ browser }) => {
      test.setTimeout(60000)

      const { ctx, page } = await loveWindow(browser, 'second')
      try {
        const room = await clickFirstAvailableRoom(page)
        test.skip(room === null, 'No regular room available')

        await startOrJoin(page)
        await waitConnected(page)

        // Sanity: invite button is present once we are inside the meeting.
        await expect(page.locator('[data-id="invite-button"]').first()).toBeVisible({ timeout: 10000 })
      } finally {
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })

    test('user2 invites user3 — user3 sees knock popup, accepts and joins', async ({ browser }) => {
      test.setTimeout(60000)

      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')
      try {
        const room = await clickFirstAvailableRoom(page2)
        test.skip(room === null, 'No regular room available')

        await startOrJoin(page2)
        await waitConnected(page2)

        await inviteByLastName(page2, 'Muram')

        // user2: outgoing invite trigger is shown in left bar
        await expect(page2.locator('[data-id="outgoing-invite-trigger"]')).toBeVisible({ timeout: 10000 })

        // user3: incoming invite trigger appears in left bar — click to open popup
        const knockTrigger = page3.locator('[data-id="incoming-invite-trigger"]')
        await expect(knockTrigger).toBeVisible({ timeout: 15000 })
        await knockTrigger.click()
        const knock = page3.locator('[data-id="invite-popup"]')
        await expect(knock).toBeVisible({ timeout: 5000 })

        // Accept
        await page3.locator('[data-id="invite-join"]').click()

        // user3 connects to LiveKit
        await waitConnected(page3)

        // After accept, both invite triggers (and popups) must disappear.
        await expect(page3.locator('[data-id="incoming-invite-trigger"]')).toBeHidden({ timeout: 10000 })
        await expect(page2.locator('[data-id="outgoing-invite-trigger"]')).toBeHidden({ timeout: 10000 })
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })

    test('user2 invites user3, but user3 joins via meeting link — outgoing popup goes away (bug 2)', async ({
      browser
    }) => {
      test.setTimeout(60000)

      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')
      try {
        const room = await clickFirstAvailableRoom(page2)
        test.skip(room === null, 'No regular room available')

        await startOrJoin(page2)
        await waitConnected(page2)

        await inviteByLastName(page2, 'Muram')

        await expect(page3.locator('[data-id="incoming-invite-trigger"]')).toBeVisible({ timeout: 15000 })
        await expect(page2.locator('[data-id="outgoing-invite-trigger"]')).toBeVisible({ timeout: 10000 })

        // user3 ignores knock and joins via the room — same UX as opening the
        // meeting minutes link directly.
        await clickRoomByName(page3, room as string)
        await startOrJoin(page3)
        await waitConnected(page3)

        // Bug 2: invite triggers on both sides must clear once recipient is in
        // the meeting, even though they did not click "Join" on the knock.
        await expect(page2.locator('[data-id="outgoing-invite-trigger"]')).toBeHidden({ timeout: 15000 })
        await expect(page3.locator('[data-id="incoming-invite-trigger"]')).toBeHidden({ timeout: 5000 })
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })

    test('user3 joins the same room user2 started — both see the meeting widget', async ({ browser }) => {
      test.setTimeout(60000)

      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')
      try {
        const room = await clickFirstAvailableRoom(page2)
        test.skip(room === null, 'No regular room available')

        await startOrJoin(page2)
        await waitConnected(page2)

        // The button flips from "Start meeting" to "Join meeting" under the same data-id.
        await clickRoomByName(page3, room as string)
        await startOrJoin(page3)
        await waitConnected(page3)

        // Both peers must remain connected; widget on user2 must not have closed
        // when user3 joined.
        await expect(page2.locator('[data-id="meeting-widget"]')).toBeVisible()
        await expect(page3.locator('[data-id="meeting-widget"]')).toBeVisible()
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })
  })
}

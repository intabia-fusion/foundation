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
  knockAndWaitPending,
  loveWindow,
  openLove,
  openMeetingMinutes,
  startOrJoin,
  waitConnected,
  waitForActiveMeetingsToFinish
} from './meeting-helpers'

async function inviteByLastNames (page: Page, lastNames: string[]): Promise<void> {
  await page.locator('[data-id="invite-button"]').first().click()
  const popup = page.locator('.hulyModal-container').last()
  const search = popup.getByPlaceholder(/Search/i)
  await expect(search).toBeVisible({ timeout: 5000 })
  for (const last of lastNames) {
    await search.fill(last)
    await popup.locator('button.row').filter({ hasText: last }).first().click()
    await search.fill('')
  }
  const ok = popup.locator('.hulyModal-footer').getByRole('button', { name: /^Invite$/i })
  await expect(ok).toBeEnabled({ timeout: 5000 })
  await ok.click()
}

export function registerScenariosTests (): void {
  test.describe('meeting minutes - extended scenarios', () => {
    test.beforeEach(async () => {
      // Without this the room join lands in a meeting owned by somebody else, and owner-only
      // controls never render.
      await waitForActiveMeetingsToFinish()
    })

    test('privacy toggle: closing the room hides meeting name and shows Busy badge for outsiders', async ({
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

        // user2 is the meeting owner - close the room from MeetingMinutes detail page
        await openMeetingMinutes(page2, room as string)
        const toggle = page2.locator('[data-id="meeting-toggle-private"]').first()
        await expect(toggle).toBeVisible({ timeout: 10000 })
        await toggle.click()

        // user3 opens the same room - should see Busy badge instead of meeting details
        await clickRoomByName(page3, room as string)
        await expect(page3.locator('[data-id="busy-badge"]').first()).toBeVisible({ timeout: 15000 })

        // Toggle back to public - busy badge should go away on user3 side
        await toggle.click()
        await expect(page3.locator('[data-id="busy-badge"]')).toHaveCount(0, { timeout: 15000 })
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })

    test('non-owner of a private meeting cannot invite — recipient gets nothing', async ({ browser }) => {
      test.setTimeout(60000)

      const { ctx: ctx1, page: page1 } = await loveWindow(browser, 'first') // user1 (workspace owner, but not the meeting owner)
      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')
      try {
        // user2 starts a public meeting and invites user3 to bring them into members
        const room = await clickFirstAvailableRoom(page2)
        test.skip(room === null, 'No regular room available')
        await startOrJoin(page2)
        await waitConnected(page2)
        await inviteByLastNames(page2, ['Muram'])

        // user3 accepts -> joins the meeting -> becomes a member
        const incoming = page3.locator('[data-id="incoming-invite-trigger"]')
        await expect(incoming).toBeVisible({ timeout: 15000 })
        await incoming.click()
        await page3.locator('[data-id="invite-join"]').click()
        await waitConnected(page3)

        // user2 (owner) closes the room -> private
        await openMeetingMinutes(page2, room as string)
        const toggle = page2.locator('[data-id="meeting-toggle-private"]').first()
        await expect(toggle).toBeVisible({ timeout: 10000 })
        await toggle.click()
        // No page reload here - that would tear down the LiveKit session.
        await expect(page3.locator('[data-id="meeting-widget"]')).toBeVisible({ timeout: 10000 })

        // user3 is a member but not an owner, so `sendInvites` refuses on the client and
        // creates no invite-request at all.
        await inviteByLastNames(page3, ['Appleseed'])

        // No invite-request was created: sender (user3) gets no outgoing trigger
        // and the receiver (user1) gets no incoming trigger.
        await expect(page3.locator('[data-id="outgoing-invite-trigger"]')).toBeHidden({ timeout: 15000 })
        await expect(page1.locator('[data-id="incoming-invite-trigger"]')).toBeHidden({ timeout: 15000 })
      } finally {
        await closeMeetingContexts([
          { ctx: ctx1, pages: [page1] },
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })

    test('multi-invite + cancel: inviting two persons creates two outgoing triggers, cancel removes one', async ({
      browser
    }) => {
      test.setTimeout(60000)

      const { ctx: ctx1, page: page1 } = await loveWindow(browser, 'first')
      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')
      try {
        const room = await clickFirstAvailableRoom(page2)
        test.skip(room === null, 'No regular room available')
        await startOrJoin(page2)
        await waitConnected(page2)

        // user2 invites both user1 (Appleseed) and user3 (Muram) in one popup
        await inviteByLastNames(page2, ['Appleseed', 'Muram'])

        // user2 must have exactly two outgoing triggers
        const outgoing = page2.locator('[data-id="outgoing-invite-trigger"]')
        await expect(outgoing).toHaveCount(2, { timeout: 15000 })
        // Each recipient gets one incoming
        await expect(page1.locator('[data-id="incoming-invite-trigger"]')).toHaveCount(1, { timeout: 15000 })
        await expect(page3.locator('[data-id="incoming-invite-trigger"]')).toHaveCount(1, { timeout: 15000 })

        // Cancel the first outgoing invite via OutgoingInvitePopup
        await outgoing.first().click()
        const out = page2.locator('[data-id="outgoing-invite-popup"]')
        await expect(out).toBeVisible({ timeout: 5000 })
        await out.getByRole('button', { name: /^Cancel$/i }).click()

        // One outgoing trigger remains; one of the recipients lost their incoming
        await expect(outgoing).toHaveCount(1, { timeout: 15000 })
        const incomingTotal =
          (await page1.locator('[data-id="incoming-invite-trigger"]').count()) +
          (await page3.locator('[data-id="incoming-invite-trigger"]').count())
        expect(incomingTotal).toBe(1)
      } finally {
        await closeMeetingContexts([
          { ctx: ctx1, pages: [page1] },
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })

    test('partial leave: when one of two participants leaves, the meeting stays alive for the other', async ({
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

        await clickRoomByName(page3, room as string)
        await startOrJoin(page3)
        await waitConnected(page3)

        // user3 leaves
        await page3.locator('[data-id="meeting-leave"]').first().click()
        await expect(page3.locator('[data-id="meeting-widget"]')).toBeHidden({ timeout: 15000 })

        // user2 must still be connected
        await expect(page2.locator('[data-id="meeting-widget"]')).toBeVisible()
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })

    test('knock-to-join: outsider invites a private-meeting owner -> owner accepts -> outsider auto-joins', async ({
      browser
    }) => {
      test.setTimeout(60000)

      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')

      // Auto-join gives up silently (`joinOrCreateMeetingByInvite` returns false and only warns),
      // and the knocker is left with a manual Join button - which reads as a bare timeout here.
      const knockerLog: string[] = []
      page3.on('pageerror', (err) => knockerLog.push(`pageerror: ${err.message}`))
      page3.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') knockerLog.push(`${msg.type()}: ${msg.text()}`)
      })

      try {
        await openLove(page2)
        await openLove(page3)

        // user2 starts a meeting and closes the room (private).
        const room = await clickFirstAvailableRoom(page2)
        test.skip(room === null, 'No regular room available')
        await startOrJoin(page2)
        await waitConnected(page2)
        await openMeetingMinutes(page2, room as string)
        const toggle = page2.locator('[data-id="meeting-toggle-private"]').first()
        await expect(toggle).toBeVisible({ timeout: 10000 })
        await toggle.click()
        // Wait for the button label to flip — only then `private: true` has
        // propagated to the server.
        await expect(toggle).toHaveText(/Open room/i, { timeout: 30000 })

        // Gate on the knock button, not the busy badge: the badge derives from a join that can
        // lag in CI, while the panel resolves as soon as both sources arrive.
        await openLove(page3)
        const lockedRoom = page3.locator(`[data-id="room-${room as string}"]`).first()
        await expect(lockedRoom).toBeVisible({ timeout: 10000 })
        await lockedRoom.click()
        const knockBtn = page3.locator('[data-id="meeting-knock"]').first()
        await expect(knockBtn).toBeVisible({ timeout: 60000 })
        // After knocking the button flips to "Cancel knock".
        await knockAndWaitPending(page3)

        // user2 (owner of the private meeting) should see an incoming knock in
        // the KnockingList side panel (no popup, no sound).
        const knockingItem = page2.locator('[data-id="knocking-item"]').first()
        await expect(knockingItem).toBeVisible({ timeout: 15000 })

        // Owner admits the knocker.
        await knockingItem.locator('[data-id="knock-accept"]').click()

        // user3 should be auto-joined to user2's meeting (their widget switches
        // rooms; we only verify the widget stays connected).
        try {
          await expect(page3.locator('[data-id="meeting-widget"]')).toBeVisible({ timeout: 30000 })
        } catch (err) {
          const log = knockerLog.length > 0 ? knockerLog.join('\n') : '(nothing)'
          throw new Error(`Knocker never auto-joined. Knocker console:\n${log}`)
        }
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })
  })
}

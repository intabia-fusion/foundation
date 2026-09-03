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
  ROOM_CANDIDATES,
  clickFirstAvailableRoom,
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
  // UsersList re-queries on every keystroke, so the row can detach mid-click; each retry
  // re-resolves the locator.
  let clicked = false
  for (let attempt = 0; attempt < 5 && !clicked; attempt++) {
    const row = popup.locator('button.row').filter({ hasText: lastName }).first()
    try {
      await expect(row).toBeVisible({ timeout: 5000 })
      await row.click({ timeout: 3000 })
      clicked = true
    } catch {
      await page.waitForTimeout(300)
    }
  }
  if (!clicked) {
    throw new Error(`Failed to click invite-picker row for "${lastName}" after retries`)
  }
  const ok = popup.locator('.hulyModal-footer').getByRole('button', { name: /^Invite$/i })
  await expect(ok).toBeEnabled({ timeout: 5000 })
  await ok.click()
}

async function openInvitePopupAt (page: Page, trigger: 'incoming' | 'outgoing'): Promise<void> {
  const id = trigger === 'incoming' ? 'incoming-invite-trigger' : 'outgoing-invite-trigger'
  const btn = page.locator(`[data-id="${id}"]`)
  await expect(btn).toBeVisible({ timeout: 15000 })
  await btn.click()
}

export function registerInviteTests (): void {
  test.describe('meeting minutes - invite variants', () => {
    test('user3 rejects invite — neither side ends up in a meeting', async ({ browser }) => {
      test.setTimeout(60000)

      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')
      try {
        const room = await clickFirstAvailableRoom(page2)
        test.skip(room === null, 'No regular room available')
        await startOrJoin(page2)
        await waitConnected(page2)

        await inviteByLastName(page2, 'Muram')

        await openInvitePopupAt(page3, 'incoming')
        await page3.locator('[data-id="invite-reject"]').click()

        // Triggers go away on both sides.
        await expect(page3.locator('[data-id="incoming-invite-trigger"]')).toBeHidden({ timeout: 10000 })
        await expect(page2.locator('[data-id="outgoing-invite-trigger"]')).toBeHidden({ timeout: 10000 })

        // user3 must not have joined the meeting (no meeting widget on page3).
        await expect(page3.locator('[data-id="meeting-widget"]')).toBeHidden()
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })

    test('symmetric invites: A invites B and B invites A — both triggers visible on both sides', async ({
      browser
    }) => {
      test.setTimeout(60000)

      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')
      try {
        // user2 starts a meeting and invites user3
        const room2 = await clickFirstAvailableRoom(page2)
        test.skip(room2 === null, 'No regular room available')
        await startOrJoin(page2)
        await waitConnected(page2)
        await inviteByLastName(page2, 'Muram')

        // While invite is pending, user3 starts their own meeting and invites
        // user2 (Dirak) — this is the failing direction in the bug report.
        const ROOM_CANDIDATES_3 = ROOM_CANDIDATES.filter((c) => c !== room2)
        let roomFor3: string | null = null
        for (const name of ROOM_CANDIDATES_3) {
          const r = page3.locator(`[data-id="room-${name}"]`).first()
          if ((await r.count()) === 0) continue
          await r.click()
          roomFor3 = name
          break
        }
        test.skip(roomFor3 === null, 'No second room for user3')
        await startOrJoin(page3)
        await waitConnected(page3)
        await inviteByLastName(page3, 'Dirak')

        // Each side has one outgoing AND one incoming.
        await expect(page2.locator('[data-id="outgoing-invite-trigger"]')).toBeVisible({ timeout: 15000 })
        await expect(page2.locator('[data-id="incoming-invite-trigger"]')).toBeVisible({ timeout: 15000 })
        await expect(page3.locator('[data-id="outgoing-invite-trigger"]')).toBeVisible({ timeout: 15000 })
        await expect(page3.locator('[data-id="incoming-invite-trigger"]')).toBeVisible({ timeout: 15000 })
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })

    test('self-invite: my own user is not present in the invite picker (skipCurrentAccount)', async ({ browser }) => {
      test.setTimeout(60000)

      const { ctx, page } = await loveWindow(browser, 'second')
      try {
        const room = await clickFirstAvailableRoom(page)
        test.skip(room === null, 'No regular room available')
        await startOrJoin(page)
        await waitConnected(page)

        await page.locator('[data-id="invite-button"]').first().click()
        const popup = page.locator('.hulyModal-container').last()
        const search = popup.getByPlaceholder(/Search/i)
        await expect(search).toBeVisible({ timeout: 5000 })
        // user2 is Dirak Kainin — must not appear in their own invite list.
        await search.fill('Dirak')
        // Either the list is empty or the matching row is absent.
        await expect(popup.locator('button.row').filter({ hasText: 'Dirak Kainin' })).toHaveCount(0, { timeout: 3000 })
      } finally {
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })

    test('invite UI: sender sees "You are inviting", recipient sees "is asking you to join"', async ({ browser }) => {
      test.setTimeout(60000)

      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')
      try {
        const room = await clickFirstAvailableRoom(page2)
        test.skip(room === null, 'No regular room available')
        await startOrJoin(page2)
        await waitConnected(page2)

        await inviteByLastName(page2, 'Muram')

        // Sender (page2) — outgoing trigger button must show YouInvite label
        // and there must be NO incoming trigger on the sender.
        const senderOutgoing = page2.locator('[data-id="outgoing-invite-trigger"]')
        await expect(senderOutgoing).toBeVisible({ timeout: 10000 })
        await expect(senderOutgoing).toContainText(/You are inviting/i, { timeout: 5000 })
        await expect(page2.locator('[data-id="incoming-invite-trigger"]')).toHaveCount(0, { timeout: 1000 })

        // Recipient (page3) — incoming trigger must show "Knocking" label
        // (incoming-side label) and NO outgoing trigger on recipient.
        const recipientIncoming = page3.locator('[data-id="incoming-invite-trigger"]')
        await expect(recipientIncoming).toBeVisible({ timeout: 10000 })
        await expect(recipientIncoming).toContainText(/Knocking/i, { timeout: 5000 })
        await expect(page3.locator('[data-id="outgoing-invite-trigger"]')).toHaveCount(0, { timeout: 1000 })

        // Open the popup on the recipient and verify the message body.
        await recipientIncoming.click()
        const popup = page3.locator('[data-id="invite-popup"]')
        await expect(popup).toBeVisible({ timeout: 5000 })
        await expect(popup).toContainText(/asking you to join|is knocking|Join meeting/i, { timeout: 3000 })
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })
  })
}

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
  closeMeetingContexts,
  knockAndWaitPending,
  loveWindow,
  waitConnected,
  waitForActiveMeetingsToFinish
} from './meeting-helpers'

/** Personal offices render with an empty `data-id="room-"`, so pick by the visible owner name. */
async function connectToOwnOffice (page: Page, _lastName: string): Promise<void> {
  // By CSS class, not owner name: the label resolves asynchronously and is flaky on cold render.
  const office = page.locator('div.floorGrid-room.myOffice').first()
  await expect(office).toBeVisible({ timeout: 15000 })
  const avatarCell = office.locator('.floorGrid-room__field').first()
  await avatarCell.hover()
  await avatarCell.click()
  const startBtn = page.locator('[data-id="start-own-meeting"]').first()
  await expect(startBtn).toBeVisible({ timeout: 10000 })
  await startBtn.click()
  await waitConnected(page)
}

export function registerKnockOfficeTests (): void {
  test.describe('meeting minutes - knock into personal office', () => {
    test.beforeEach(async () => {
      await waitForActiveMeetingsToFinish()
    })

    test('knocker auto-joins owner office after knock is accepted', async ({ browser }) => {
      test.setTimeout(60000)

      // Owner — uses storageSecond. The personal office is named after this
      // person, so we filter the floor grid by their last name to find it.
      // Knocker — a different account. Storage third has a separate person.
      const { ctx: ownerCtx, page: owner } = await loveWindow(browser, 'second')
      const { ctx: knockerCtx, page: knocker } = await loveWindow(browser, 'third')

      try {
        // The office has `startPrivate: true`, so the meeting is private - the precondition for
        // the knock flow.
        const ownerLast = 'Dirak'

        await connectToOwnOffice(owner, ownerLast)

        // Not a member of the now-private meeting, so EditRoom renders Knock instead of Connect.
        await clickOfficeOf(knocker, ownerLast)
        const knockBtn = knocker.locator('[data-id="meeting-knock"]').first()
        await expect(knockBtn).toBeVisible({ timeout: 30000 })
        // The button flips to "Cancel knock" once the invite-request is created.
        await knockAndWaitPending(knocker)

        // Owner sees the incoming knock in the KnockingList side panel.
        const knockingItem = owner.locator('[data-id="knocking-item"]').first()
        await expect(knockingItem).toBeVisible({ timeout: 30000 })
        await knockingItem.locator('[data-id="knock-accept"]').click()

        // The knocker auto-joins via `joinOrCreateMeetingByInvite`, which retries `/getToken`
        // until the membership write propagates; the widget is the signal it connected.
        await expect(knocker.locator('[data-id="meeting-widget"]')).toBeVisible({ timeout: 60000 })
      } finally {
        await closeMeetingContexts([
          { ctx: ownerCtx, pages: [owner] },
          { ctx: knockerCtx, pages: [knocker] }
        ])
      }
    })

    test('repeated knocks from one person never stack in the owner list', async ({ browser }) => {
      test.setTimeout(90000)

      const { ctx: ownerCtx, page: owner } = await loveWindow(browser, 'second')
      const { ctx: knockerCtx, page: knocker } = await loveWindow(browser, 'third')

      try {
        const ownerLast = 'Dirak'
        await connectToOwnOffice(owner, ownerLast)

        await clickOfficeOf(knocker, ownerLast)
        await expect(knocker.locator('[data-id="meeting-knock"]').first()).toBeVisible({ timeout: 30000 })

        // Knock/cancel cycles race the trigger: the invite-response of a cancelled
        // request may still be in flight while the next request fans out.
        const cancelBtn = knocker.locator('[data-id="meeting-knock-pending"]').first()
        for (let i = 0; i < 4; i++) {
          await knockAndWaitPending(knocker)
          if (i < 3) {
            await cancelBtn.click()
            await expect(knocker.locator('[data-id="meeting-knock"]').first()).toBeVisible({ timeout: 15000 })
          }
        }

        const items = owner.locator('[data-id="knocking-item"]')
        await expect(items).toHaveCount(1, { timeout: 30000 })
        // Duplicates would only die on the 30s TTL, so re-check after the dust settles.
        await owner.waitForTimeout(5000)
        await expect(items).toHaveCount(1)
        await expect(owner.locator('[data-id="knocking-list"] .counter')).toHaveText('1')
      } finally {
        await closeMeetingContexts([
          { ctx: ownerCtx, pages: [owner] },
          { ctx: knockerCtx, pages: [knocker] }
        ])
      }
    })
  })
}

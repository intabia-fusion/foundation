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
  closeMeetingContexts,
  loveWindow,
  openLove,
  waitConnected,
  waitForActiveMeetingsToFinish
} from './meeting-helpers'

async function waitDisconnected (page: Page): Promise<void> {
  await expect(page.locator('[data-id="meeting-widget"]')).toBeHidden({ timeout: 30000 })
}

async function callPerson (caller: Page, lastName: RegExp): Promise<void> {
  const office = caller.locator('div.floorGrid-room').filter({ hasText: lastName }).first()
  await expect(office).toBeVisible({ timeout: 15000 })
  const avatarCell = office.locator('.floorGrid-room__field').first()
  await avatarCell.hover()
  await avatarCell.click()
  const inviteBtn = caller.locator('[data-id="person-invite-call"]').first()
  await expect(inviteBtn).toBeVisible({ timeout: 10000 })
  await inviteBtn.click()
}

async function acceptIncoming (recipient: Page): Promise<void> {
  const incoming = recipient.locator('[data-id="incoming-invite-trigger"]')
  await expect(incoming).toBeVisible({ timeout: 30000 })
  await incoming.click()
  const popup = recipient.locator('[data-id="invite-popup"]')
  await expect(popup).toBeVisible({ timeout: 5000 })
  await recipient.locator('[data-id="invite-join"]').click()
}

async function leaveMeeting (page: Page): Promise<void> {
  const leave = page.locator('[data-id="meeting-leave"]').first()
  await expect(leave).toBeVisible({ timeout: 10000 })
  await leave.click()
  await waitDisconnected(page)
}

export function registerBidirectionalLoopTests (): void {
  test.describe('meeting minutes - bidirectional call probe', () => {
    test.beforeEach(async () => {
      await waitForActiveMeetingsToFinish()
    })

    /**
     * Forward then reverse call in one pass: the second, reverse call used to leave the caller
     * stuck. Stress it with `--repeat-each=N -g "back-to-back" --workers=1`.
     */
    test('back-to-back: Dirak -> Muram, then Muram -> Dirak — both auto-join', async ({ browser }) => {
      test.setTimeout(180000)

      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')

      try {
        await test.step('forward: Dirak -> Muram', async () => {
          await callPerson(page2, /Muram/i)
          await acceptIncoming(page3)
          await waitConnected(page2)
          await waitConnected(page3)
          await expect(page2.locator('[data-id="outgoing-invite-trigger"]')).toBeHidden({ timeout: 15000 })
          await expect(page3.locator('[data-id="incoming-invite-trigger"]')).toBeHidden({ timeout: 15000 })
          // The server closes the room on the office owner leaving, so Muram drops with no
          // manual leave.
          await leaveMeeting(page2)
          await waitDisconnected(page3)
          await waitForActiveMeetingsToFinish()
          // After leaving, both clients land on the Summary panel, which covers the floor grid.
          await openLove(page2)
          await openLove(page3)
        })

        // The reverse direction: caller must auto-join, recipient accepts, both widgets appear.
        await test.step('reverse: Muram -> Dirak', async () => {
          await callPerson(page3, /Dirak/i)
          await acceptIncoming(page2)
          await waitConnected(page3)
          await waitConnected(page2)
          await expect(page3.locator('[data-id="outgoing-invite-trigger"]')).toBeHidden({ timeout: 15000 })
          await expect(page2.locator('[data-id="incoming-invite-trigger"]')).toBeHidden({ timeout: 15000 })
          // Reverse: meeting is hosted in Muram's office (caller).
          // Muram leaves → server closes room → Dirak disconnects.
          await leaveMeeting(page3)
          await waitDisconnected(page2)
          await waitForActiveMeetingsToFinish()
        })
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })
  })
}

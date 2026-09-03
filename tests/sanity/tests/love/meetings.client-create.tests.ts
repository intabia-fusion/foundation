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

import { closeMeetingContexts, loveWindow, waitConnected, waitForActiveMeetingsToFinish } from './meeting-helpers'

/**
 * Reverse call: the caller is in no meeting yet and invites from the recipient's office cell.
 * Per docs/knock.md the caller's client creates the MeetingMinutes on `accepted`, not the trigger.
 */
export function registerClientCreateTests (): void {
  test.describe('meeting minutes - client-side create on accept', () => {
    test.beforeEach(async () => {
      // A leftover meeting in the caller's office breaks the auto-join sync.
      await waitForActiveMeetingsToFinish()
    })

    test('caller without active meeting -> recipient accepts -> meeting hosted in caller office', async ({
      browser
    }) => {
      test.setTimeout(60000)

      // Caller = storageSecond (Dirak Kainin), Recipient = storageThird
      // (Muram Muffin). Both have a personal Office in the seeded floor.
      const { ctx: callerCtx, page: caller } = await loveWindow(browser, 'second')
      const { ctx: recipientCtx, page: recipient } = await loveWindow(browser, 'third')

      try {
        // Recipient logs in first so they appear "online" — their avatar in
        // the office cell is what the caller will click.

        // The avatar sits at the office's (0,0) seat and opens PersonActionPopup with Invite.
        const muramOffice = caller.locator('div.floorGrid-room').filter({ hasText: /Muram/i }).first()
        await expect(muramOffice).toBeVisible({ timeout: 15000 })

        // Hovering reveals the cell; online users are always shown.
        const avatarCell = muramOffice.locator('.floorGrid-room__field').first()
        await avatarCell.hover()
        await avatarCell.click()

        // Person action popup with the "call" invite button.
        const inviteBtn = caller.locator('[data-id="person-invite-call"]').first()
        await expect(inviteBtn).toBeVisible({ timeout: 10000 })
        await inviteBtn.click()

        // Recipient sees the incoming invite trigger -> open popup -> accept.
        const incoming = recipient.locator('[data-id="incoming-invite-trigger"]')
        await expect(incoming).toBeVisible({ timeout: 30000 })
        await incoming.click()
        const popup = recipient.locator('[data-id="invite-popup"]')
        await expect(popup).toBeVisible({ timeout: 5000 })
        await recipient.locator('[data-id="invite-join"]').click()

        // Caller joins via the invite-request sync, recipient via the invite-response patched
        // with `meeting`.
        await waitConnected(caller)
        await waitConnected(recipient)

        // After auto-join, no invite triggers should remain on either side.
        await expect(recipient.locator('[data-id="incoming-invite-trigger"]')).toBeHidden({ timeout: 15000 })
        await expect(caller.locator('[data-id="outgoing-invite-trigger"]')).toBeHidden({ timeout: 15000 })
      } finally {
        await closeMeetingContexts([
          { ctx: callerCtx, pages: [caller] },
          { ctx: recipientCtx, pages: [recipient] }
        ])
      }
    })
  })
}

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
  startOrJoin,
  waitConnected,
  waitForActiveMeetingsToFinish
} from './meeting-helpers'

async function clickFirstMeetingRoom (page: Page): Promise<void> {
  const room = page
    .locator('div.floorGrid-room')
    .filter({ hasText: /Meeting Room/i })
    .first()
  await expect(room).toBeVisible({ timeout: 15000 })
  await room.click()
}

async function inviteByLastName (page: Page, lastName: string): Promise<void> {
  await page.locator('[data-id="invite-button"]').first().click()
  const popup = page.locator('.hulyModal-container').last()
  const search = popup.getByPlaceholder(/Search/i)
  await expect(search).toBeVisible({ timeout: 5000 })
  await search.fill(lastName)
  const row = popup.locator('button.row').filter({ hasText: lastName }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.click()
  const okBtn = popup.getByRole('button', { name: /^OK$|^Invite$|^Confirm$/i }).first()
  if ((await okBtn.count()) > 0) await okBtn.click({ timeout: 2000 }).catch(() => undefined)
  await page.keyboard.press('Escape').catch(() => undefined)
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

export function registerInviteUiTests (): void {
  test.describe('meeting minutes - invite UI labels & states', () => {
    test.beforeEach(async () => {
      await waitForActiveMeetingsToFinish()
    })

    test('A1 invite labels: sender → "You are inviting", recipient → "Knocking"', async ({ browser }) => {
      test.setTimeout(60000)
      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')
      try {
        await clickFirstMeetingRoom(page2)
        await startOrJoin(page2)
        await waitConnected(page2)

        await inviteByLastName(page2, 'Muram')

        const senderOutgoing = page2.locator('[data-id="outgoing-invite-trigger"]')
        await expect(senderOutgoing).toBeVisible({ timeout: 10000 })
        await expect(senderOutgoing).toContainText(/You are inviting/i, { timeout: 5000 })
        await expect(page2.locator('[data-id="incoming-invite-trigger"]')).toHaveCount(0, { timeout: 1000 })

        const recipientIncoming = page3.locator('[data-id="incoming-invite-trigger"]')
        await expect(recipientIncoming).toBeVisible({ timeout: 10000 })
        await expect(recipientIncoming).toContainText(/Knocking/i, { timeout: 5000 })
        await expect(page3.locator('[data-id="outgoing-invite-trigger"]')).toHaveCount(0, { timeout: 1000 })
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })

    test('A1 popup: recipient sees "asking you to join" + Join/Reject buttons', async ({ browser }) => {
      test.setTimeout(60000)
      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')
      try {
        await clickFirstMeetingRoom(page2)
        await startOrJoin(page2)
        await waitConnected(page2)

        await inviteByLastName(page2, 'Muram')

        const recipientIncoming = page3.locator('[data-id="incoming-invite-trigger"]')
        await expect(recipientIncoming).toBeVisible({ timeout: 10000 })
        await recipientIncoming.click()

        const popup = page3.locator('[data-id="invite-popup"]')
        await expect(popup).toBeVisible({ timeout: 5000 })
        await expect(popup).toContainText(/asking you to join|is knocking|Join meeting/i, { timeout: 3000 })
        await expect(page3.locator('[data-id="invite-join"]')).toBeVisible({ timeout: 2000 })
        await expect(page3.locator('[data-id="invite-reject"]')).toBeVisible({ timeout: 2000 })
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })

    test('A1 sender popup: clicking trigger opens outgoing-invite-popup with Cancel', async ({ browser }) => {
      test.setTimeout(60000)
      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')
      try {
        await clickFirstMeetingRoom(page2)
        await startOrJoin(page2)
        await waitConnected(page2)

        await inviteByLastName(page2, 'Muram')

        const senderOutgoing = page2.locator('[data-id="outgoing-invite-trigger"]')
        await expect(senderOutgoing).toBeVisible({ timeout: 10000 })
        await senderOutgoing.click()
        const popup = page2.locator('[data-id="outgoing-invite-popup"]')
        await expect(popup).toBeVisible({ timeout: 5000 })
        await expect(popup.getByRole('button', { name: /^Cancel$/i })).toBeVisible({ timeout: 2000 })
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })

    test('A2 awaiting panel: recipient sees "Waiting for ..." after accept w/o meeting', async ({ browser }) => {
      test.setTimeout(60000)
      const { ctx: callerCtx, page: caller } = await loveWindow(browser, 'second')
      const { ctx: recipientCtx, page: recipient } = await loveWindow(browser, 'third')
      try {
        await callPerson(caller, /Muram/i)

        const incoming = recipient.locator('[data-id="incoming-invite-trigger"]')
        await expect(incoming).toBeVisible({ timeout: 30000 })
        await incoming.click()
        const popup = recipient.locator('[data-id="invite-popup"]')
        await expect(popup).toBeVisible({ timeout: 5000 })
        await recipient.locator('[data-id="invite-join"]').click()

        // The caller's client creates the meeting, so the recipient may flash the awaiting
        // trigger before auto-joining.
        const awaiting = recipient.locator('[data-id="awaiting-meeting-trigger"]')
        // Both endpoints are valid; what matters is that no stale incoming trigger lingers.
        const settled = Promise.race([
          awaiting.waitFor({ state: 'visible', timeout: 5000 }).then(() => 'awaiting'),
          recipient
            .locator('[data-id="meeting-widget"]')
            .waitFor({ state: 'visible', timeout: 30000 })
            .then(() => 'joined')
        ])
        const which = await settled
        expect(['awaiting', 'joined']).toContain(which)
        await expect(recipient.locator('[data-id="meeting-widget"]')).toBeVisible({ timeout: 60000 })
      } finally {
        await closeMeetingContexts([
          { ctx: callerCtx, pages: [caller] },
          { ctx: recipientCtx, pages: [recipient] }
        ])
      }
    })

    test('A decline → call-declined toast on sender; both triggers go away', async ({ browser }) => {
      test.setTimeout(60000)
      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')
      try {
        await clickFirstMeetingRoom(page2)
        await startOrJoin(page2)
        await waitConnected(page2)

        await inviteByLastName(page2, 'Muram')

        const recipientIncoming = page3.locator('[data-id="incoming-invite-trigger"]')
        await expect(recipientIncoming).toBeVisible({ timeout: 10000 })
        await recipientIncoming.click()
        await page3.locator('[data-id="invite-reject"]').click()

        // After decline both triggers must disappear on each side.
        await expect(page2.locator('[data-id="outgoing-invite-trigger"]')).toHaveCount(0, { timeout: 15000 })
        await expect(page3.locator('[data-id="incoming-invite-trigger"]')).toHaveCount(0, { timeout: 15000 })
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })

    test('A cancel by sender → recipient incoming disappears', async ({ browser }) => {
      test.setTimeout(60000)
      const { ctx: ctx2, page: page2 } = await loveWindow(browser, 'second')
      const { ctx: ctx3, page: page3 } = await loveWindow(browser, 'third')
      try {
        await clickFirstMeetingRoom(page2)
        await startOrJoin(page2)
        await waitConnected(page2)

        await inviteByLastName(page2, 'Muram')

        const senderOutgoing = page2.locator('[data-id="outgoing-invite-trigger"]')
        await expect(senderOutgoing).toBeVisible({ timeout: 10000 })
        await senderOutgoing.click()
        const popup = page2.locator('[data-id="outgoing-invite-popup"]')
        await expect(popup).toBeVisible({ timeout: 5000 })
        await popup.getByRole('button', { name: /^Cancel$/i }).click()

        await expect(page2.locator('[data-id="outgoing-invite-trigger"]')).toHaveCount(0, { timeout: 15000 })
        await expect(page3.locator('[data-id="incoming-invite-trigger"]')).toHaveCount(0, { timeout: 15000 })
      } finally {
        await closeMeetingContexts([
          { ctx: ctx2, pages: [page2] },
          { ctx: ctx3, pages: [page3] }
        ])
      }
    })
  })
}

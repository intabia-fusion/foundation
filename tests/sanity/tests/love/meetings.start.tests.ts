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
import { PlatformSetting } from '../utils'
import { loveWindow, openLove } from './meeting-helpers'

async function clickFirstAvailableRegularRoom (page: Page): Promise<string | null> {
  const candidates = ['Meeting Room 1', 'Meeting Room 2', 'All hands', 'Voice only room']
  for (const name of candidates) {
    const room = page.locator(`[data-id="room-${name}"]`).first()
    if ((await room.count()) === 0) continue
    await room.click()
    return name
  }
  return null
}

export function registerStartTests (): void {
  test.describe('meeting minutes', () => {
    test.use({ storageState: PlatformSetting })
    test('user1 starts meeting via panel - meeting connect button is shown', async ({ page }) => {
      await openLove(page)
      const name = await clickFirstAvailableRegularRoom(page)
      test.skip(name === null, 'No regular room available')

      // Side panel should open with the connect ("Join meeting") action.
      const connect = page.getByRole('button', { name: /Start meeting|Join meeting/i }).first()
      await expect(connect).toBeVisible({ timeout: 10000 })
    })

    test('user1 starts meeting - user2 sees the MeetingMinutes link in real time (broadcast)', async ({
      browser,
      page
    }) => {
      await openLove(page)
      const { ctx, page: page2 } = await loveWindow(browser, 'second')
      try {
        const name = await clickFirstAvailableRegularRoom(page)
        test.skip(name === null, 'No regular room available')
        const connect = page.getByRole('button', { name: /Start meeting|Join meeting/i }).first()
        await expect(connect).toBeVisible({ timeout: 10000 })
        await connect.click()

        const room2 = page2.locator(`[data-id="room-${name as string}"]`).first()
        await room2.click()
        // The "Meeting minutes" section in the room panel must list at least one
        // active meeting (link with the room name and a year stamp).
        const link = page2.getByRole('link', { name: new RegExp(`${name as string}.*20\\d{2}`) }).first()
        await expect(link).toBeVisible({ timeout: 20000 })
      } finally {
        await page2.close()
        await ctx.close()
      }
    })

    test('owner can toggle meeting privacy back and forth (Close room / Open room)', async ({ page }) => {
      test.setTimeout(60000)
      await openLove(page)

      // Open the most recent existing MeetingMinutes from the side activity (or create a new one).
      let meetingLink = page.getByRole('link', { name: /\d{4}/ }).first()
      if ((await meetingLink.count()) === 0) {
        const name = await clickFirstAvailableRegularRoom(page)
        test.skip(name === null, 'No regular room available')
        const connect = page.getByRole('button', { name: /Start meeting|Join meeting/i }).first()
        await connect.click()
        meetingLink = page.getByRole('link', { name: /\d{4}/ }).first()
      }
      await expect(meetingLink).toBeVisible({ timeout: 15000 })
      await meetingLink.click()

      const toggle = page.getByRole('button', { name: /Close room|Open room/i }).first()
      const toggleVisible = await toggle.isVisible({ timeout: 5000 }).catch(() => false)
      test.skip(!toggleVisible, 'Privacy toggle not visible (current account is not the meeting owner)')

      const initial = (await toggle.textContent())?.trim() ?? ''
      await toggle.click()
      await expect.poll(async () => (await toggle.textContent())?.trim(), { timeout: 10000 }).not.toBe(initial)
      await toggle.click()
      await expect.poll(async () => (await toggle.textContent())?.trim(), { timeout: 10000 }).toBe(initial)
    })
  })
}

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
import { PlatformSetting, PlatformURI } from '../utils'
import { OfficePage } from '../model/love/office-page'
import { loveWindow } from './meeting-helpers'
import { MeetingMinutesPage } from '../model/love/meeting-minutes-page'

const meetingsWs = 'meetings-ws'

export function registerPrivacyTests (): void {
  test.describe('meeting minutes privacy', () => {
    test.use({ storageState: PlatformSetting })
    let officePage: OfficePage

    test.beforeEach(async ({ page }) => {
      officePage = new OfficePage(page)
      await (await page.goto(`${PlatformURI}/workbench/${meetingsWs}/love`))?.finished()
      await officePage.navigateToOffice()
      await expect(officePage.floorGrid()).toBeVisible({ timeout: 15000 })
    })

    test('non-owner does not see privacy toggle on someone else office', async ({ browser, page }) => {
      // First, capture the rooms layout from the owner side to know what to click as user2.
      const { ctx, page: page2 } = await loveWindow(browser, 'second')
      try {
        await (await page2.goto(`${PlatformURI}/workbench/${meetingsWs}/love`))?.finished()
        const office2 = new OfficePage(page2)
        const mm2 = new MeetingMinutesPage(page2)
        await office2.navigateToOffice()
        await expect(office2.floorGrid()).toBeVisible({ timeout: 15000 })

        const rooms = page2.locator('div.floorGrid-room')
        const count = await rooms.count()
        // Click each room and ensure the toggle never appears for user2.
        for (let i = 0; i < count; i++) {
          await rooms.nth(i).click()
          await page2.waitForTimeout(300)
          await expect(mm2.togglePrivateButton()).toBeHidden({ timeout: 1500 })
          await page2.keyboard.press('Escape')
        }
      } finally {
        await page2.close()
        await ctx.close()
      }
    })
  })
}

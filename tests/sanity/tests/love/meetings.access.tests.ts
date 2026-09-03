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

const meetingsWs = 'meetings-ws'

export function registerAccessTests (): void {
  test.describe('meeting minutes access', () => {
    test.use({ storageState: PlatformSetting })
    test.beforeEach(async ({ page }) => {
      const office = new OfficePage(page)
      await (await page.goto(`${PlatformURI}/workbench/${meetingsWs}/love`))?.finished()
      await office.navigateToOffice()
      await expect(office.floorGrid()).toBeVisible({ timeout: 15000 })
    })

    test('user2 sees the floor (autoJoin worked for restored spaces)', async ({ browser }) => {
      const { ctx, page: page2 } = await loveWindow(browser, 'second')
      try {
        await (await page2.goto(`${PlatformURI}/workbench/${meetingsWs}/love`))?.finished()
        const office2 = new OfficePage(page2)
        await office2.navigateToOffice()
        await expect(office2.floorGrid()).toBeVisible({ timeout: 15000 })
        // count() does not wait, and the rooms render a frame after floorGrid itself.
        await expect(page2.locator('div.floorGrid-room').first()).toBeVisible({ timeout: 15000 })
      } finally {
        await page2.close()
        await ctx.close()
      }
    })

    test('user3 (no workspace owner role) can also see floor', async ({ browser }) => {
      const { ctx, page: page3 } = await loveWindow(browser, 'third')
      try {
        await (await page3.goto(`${PlatformURI}/workbench/${meetingsWs}/love`))?.finished()
        const office3 = new OfficePage(page3)
        await office3.navigateToOffice()
        await expect(office3.floorGrid()).toBeVisible({ timeout: 15000 })
      } finally {
        await page3.close()
        await ctx.close()
      }
    })

    test('clicking a regular room opens its meeting panel', async ({ page }) => {
      const candidates = ['Meeting Room 1', 'Meeting Room 2', 'All hands', 'Voice only room']
      // Rooms render after the grid, so without this the loop sees an empty floor and skips every candidate.
      await expect(page.locator('div.floorGrid-room').first()).toBeVisible({ timeout: 15000 })
      let opened = false
      for (const name of candidates) {
        const room = page.locator(`[data-id="room-${name}"]`).first()
        if ((await room.count()) === 0) continue
        await room.click()
        const panel = page.locator('div.antiPanel-component')
        if (await panel.isVisible({ timeout: 3000 }).catch(() => false)) {
          opened = true
          break
        }
      }
      expect(opened).toBe(true)
    })
  })
}

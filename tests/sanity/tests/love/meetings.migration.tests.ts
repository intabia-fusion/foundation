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

const meetingsWs = 'meetings-ws'

export function registerMigrationTests (): void {
  test.describe('meeting minutes migration', () => {
    test.use({ storageState: PlatformSetting })
    let officePage: OfficePage

    test.beforeEach(async ({ page }) => {
      officePage = new OfficePage(page)
      await (await page.goto(`${PlatformURI}/workbench/${meetingsWs}/love`))?.finished()
    })

    test('floor and rooms restored from backup', async ({ page }) => {
      await officePage.navigateToOffice()
      await expect(officePage.floorGrid()).toBeVisible({ timeout: 15000 })
      const rooms = page.locator('div.floorGrid-room')
      await expect(rooms.first()).toBeVisible()
      expect(await rooms.count()).toBeGreaterThan(0)
    })

    test('meeting minutes panel renders for restored office', async ({ page }) => {
      await officePage.navigateToOffice()
      await expect(officePage.floorGrid()).toBeVisible({ timeout: 15000 })

      const rooms = page.locator('div.floorGrid-room')
      await rooms.first().click()
      await expect(page.locator('span.antiSection-header__title', { hasText: 'Meeting minutes' })).toBeVisible({
        timeout: 10000
      })
    })

    test('legacy meeting-minutes domain does not break workspace load', async ({ page }) => {
      // If the legacy table was missing, the page would fail to load with a 500 from restore.
      // Reaching the office floor confirms restore succeeded end-to-end.
      await officePage.navigateToOffice()
      await expect(officePage.floorGrid()).toBeVisible({ timeout: 15000 })
    })
  })
}

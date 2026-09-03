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

import { test, expect } from '@playwright/test'
import { PlatformSetting, PlatformURI } from '../utils'
import { OfficePage } from '../model/love/office-page'

const meetingsWs = 'meetings-ws'

export function registerMeetingsTests (): void {
  test.describe('meeting minutes', () => {
    test.use({
      storageState: PlatformSetting
    })
    let officePage: OfficePage

    test.beforeEach(async ({ page }) => {
      officePage = new OfficePage(page)
      await (await page.goto(`${PlatformURI}/workbench/${meetingsWs}/love`))?.finished()
    })

    test('navigate-to-office', async ({ page }) => {
      await officePage.navigateToOffice()
      await expect(page).toHaveURL(new RegExp(`/workbench/${meetingsWs}/love`))
    })

    test('office-floor-view-rooms-visible', async () => {
      await officePage.navigateToOffice()
      await expect(officePage.floorGrid()).toBeVisible({ timeout: 15000 })
      // Should have at least one room
      const rooms = officePage.page.locator('div.floorGrid-room')
      await expect(rooms.first()).toBeVisible()
    })

    test('click-office-opens-panel', async ({ page }) => {
      await officePage.navigateToOffice()
      await expect(officePage.floorGrid()).toBeVisible({ timeout: 15000 })

      // Click first room (office)
      const rooms = officePage.page.locator('div.floorGrid-room')
      await rooms.first().click()

      // Office panel should open with Meeting minutes section header
      await expect(page.locator('span.antiSection-header__title', { hasText: 'Meeting minutes' })).toBeVisible({
        timeout: 10000
      })
    })

    test('click-regular-room-opens-edit-panel', async ({ page }) => {
      await officePage.navigateToOffice()
      await expect(officePage.floorGrid()).toBeVisible({ timeout: 15000 })

      // A regular room opens the EditRoom aside, not a popup: the popup is only rendered
      // for an already-active meeting.
      const room = page.locator('[data-id="room-Meeting Room 1"]').first()
      await expect(room).toBeVisible({ timeout: 10000 })
      await room.click()

      await expect(page.locator('[data-id="meeting-connect"]').first()).toBeVisible({ timeout: 10000 })
    })
  })
}

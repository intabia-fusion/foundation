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
import { expect, test } from '../fixtures'
import { generateId, PlatformSetting, PlatformURI } from '../utils'
import { CalendarPage } from '../model/calendar-page'
import { SidebarPage } from '../model/sidebar-page'

test.use({
  storageState: PlatformSetting
})

test.describe('Calendar tests', () => {
  test.beforeEach(async ({ page }) => {
    await (await page.goto(`${PlatformURI}/workbench/sanity-ws`))?.finished()
  })

  test('User creates an event and sees it in own calendar', async ({ page }) => {
    const title = `Calendar event ${generateId()}`

    const sidebarPage = new SidebarPage(page)
    await sidebarPage.clickSidebarPageButton('calendar')
    await sidebarPage.checkIfPlanerSidebarTabIsOpen(true)

    const calendarPage = new CalendarPage(page)
    await calendarPage.createEventInWidget(title)

    await expect(calendarPage.eventInCalendarWidget(title)).toBeVisible()
  })
})

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
import { expect, test, type Page } from '../fixtures'
import { generateId, getSecondPage, PlatformSetting, PlatformURI } from '../utils'
import { CalendarPage } from '../model/calendar-page'
import { SidebarPage } from '../model/sidebar-page'

test.use({
  storageState: PlatformSetting
})

// The stand's second account in sanity-ws: signing a fresh one up per test does not
// fit the default timeout. Surname only - popups render "Last First".
const SECOND_USER_LAST_NAME = 'Dirak'

async function openCalendarWidget (page: Page): Promise<CalendarPage> {
  await (await page.goto(`${PlatformURI}/workbench/sanity-ws`))?.finished()
  const sidebarPage = new SidebarPage(page)
  await sidebarPage.clickSidebarPageButton('calendar')
  await sidebarPage.checkIfPlanerSidebarTabIsOpen(true)
  return new CalendarPage(page)
}

test.describe('Calendar recurring events', () => {
  test('A recurring meeting is visible to a participant and expands to a later day', async ({ page, browser }) => {
    const title = `Recurring meeting ${generateId()}`

    const calendarPage = await openCalendarWidget(page)
    using _page2 = await getSecondPage(browser)
    const page2 = _page2.page
    let calendarPage2: CalendarPage

    await test.step('Create a daily recurring event with the second account as participant', async () => {
      await calendarPage.clickFreeCellInWidget()
      await calendarPage.inputEventTitle().fill(title)
      await calendarPage.addEventParticipant(SECOND_USER_LAST_NAME)
      await calendarPage.setRecurringDaily()
      await calendarPage.buttonCreateEventSubmit().click()
    })

    await test.step('Own calendar shows the event today', async () => {
      await expect(calendarPage.eventInCalendarWidget(title)).toBeVisible()
    })

    await test.step('Second account sees a copy of the event in its own calendar today', async () => {
      calendarPage2 = await openCalendarWidget(page2)
      await expect(calendarPage2.eventInCalendarWidget(title)).toBeVisible({ timeout: 15000 })
    })

    await test.step('The series expands - the participant also sees it on the next day', async () => {
      await calendarPage2.navigateWidgetForward()
      await expect(calendarPage2.eventInCalendarWidget(title)).toBeVisible({ timeout: 15000 })
    })
  })
})

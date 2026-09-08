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

const SECOND_USER_LAST_NAME = 'Dirak'

async function openCalendarWidget (page: Page): Promise<CalendarPage> {
  await (await page.goto(`${PlatformURI}/workbench/sanity-ws`))?.finished()
  const sidebarPage = new SidebarPage(page)
  await sidebarPage.clickSidebarPageButton('calendar')
  await sidebarPage.checkIfPlanerSidebarTabIsOpen(true)
  return new CalendarPage(page)
}

test.describe('Calendar RSVP', () => {
  test('A participant answers in their own copy and the organiser sees the tally', async ({ page, browser }) => {
    const title = `RSVP ${generateId()}`

    const calendarPage = await openCalendarWidget(page)
    using _page2 = await getSecondPage(browser)
    const page2 = _page2.page

    await test.step('Invite the second account', async () => {
      await calendarPage.clickFreeCellInWidget(4)
      await calendarPage.inputEventTitle().fill(title)
      await calendarPage.addEventParticipant(SECOND_USER_LAST_NAME)
      await calendarPage.buttonCreateEventSubmit().click()
      await expect(calendarPage.eventInCalendarWidget(title)).toBeVisible()
    })

    await test.step('The organiser is not asked to answer their own invitation', async () => {
      await calendarPage.eventInCalendarWidget(title).first().click()
      await expect(page.getByRole('button', { name: 'Going', exact: true })).toHaveCount(0)
      await page.keyboard.press('Escape')
    })

    await test.step('The participant answers in their copy', async () => {
      const calendarPage2 = await openCalendarWidget(page2)
      await expect(calendarPage2.eventInCalendarWidget(title)).toBeVisible({ timeout: 15000 })
      await calendarPage2.eventInCalendarWidget(title).first().click()

      const going = page2.getByRole('button', { name: 'Going', exact: true })
      await expect(going).toBeVisible({ timeout: 10000 })
      await going.click()
      await page2.keyboard.press('Escape')
    })

    await test.step('The organiser sees the answer, gathered by the server', async () => {
      // Copies live in their owners' spaces, so this count can only come from the master's summary.
      await calendarPage.eventInCalendarWidget(title).first().click()
      await expect(page.getByText('1 going')).toBeVisible({ timeout: 15000 })
    })
  })
})

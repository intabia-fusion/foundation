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

test.describe('Calendar participants isolation', () => {
  test('Account that is not a participant does not see the event', async ({ page, browser }) => {
    const title = `Not a participant ${generateId()}`

    const calendarPage = await openCalendarWidget(page)
    using _page2 = await getSecondPage(browser)
    const page2 = _page2.page

    await calendarPage.createEventInWidget(title, 3)
    await expect(calendarPage.eventInCalendarWidget(title)).toBeVisible()

    const calendarPage2 = await openCalendarWidget(page2)
    await expect(calendarPage2.eventInCalendarWidget(title)).not.toBeVisible({ timeout: 5000 })
  })

  test('Participant sees a copy of the event and the busy slot shows up when re-selected', async ({
    page,
    browser
  }) => {
    const title = `Shared with participant ${generateId()}`

    const calendarPage = await openCalendarWidget(page)
    using _page2 = await getSecondPage(browser)
    const page2 = _page2.page
    let calendarPage2: CalendarPage

    await test.step('Create an event with the second account as participant', async () => {
      await calendarPage.clickFreeCellInWidget(5)
      await calendarPage.inputEventTitle().fill(title)
      await calendarPage.addEventParticipant(SECOND_USER_LAST_NAME)
      await calendarPage.buttonCreateEventSubmit().click()
    })

    await test.step('Own calendar shows the event', async () => {
      await expect(calendarPage.eventInCalendarWidget(title)).toBeVisible()
    })

    await test.step('Second account sees a copy of the event in its own calendar', async () => {
      calendarPage2 = await openCalendarWidget(page2)
      await expect(calendarPage2.eventInCalendarWidget(title)).toBeVisible({ timeout: 15000 })
    })

    await test.step('A participant booked at that hour is marked busy', async () => {
      // The mark reflects a clash with the event being created, so the colleague has to be busy
      // at exactly that hour. They book it in their own calendar, leaving my grid cell free to
      // click - clicking my own event would open it for editing instead.
      const busyTime = await calendarPage2.createEventInWidget(`Colleague busy ${generateId()}`, 8)

      await calendarPage.emptyCellAtTime(busyTime).scrollIntoViewIfNeeded()
      await calendarPage.emptyCellAtTime(busyTime).click()
      await calendarPage.addEventParticipant(SECOND_USER_LAST_NAME)
      await expect(calendarPage.participantBusyMark(SECOND_USER_LAST_NAME)).toBeVisible({ timeout: 15000 })
      await calendarPage.closeEventPopup()
    })
  })
})

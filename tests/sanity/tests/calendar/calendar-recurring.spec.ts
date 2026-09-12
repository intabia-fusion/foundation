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
import { dropStaleCalendarEvents } from '../API/CalendarApi'

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
  // The widget shows a single day and nothing cleans it up, so a few runs' worth of events
  // fill every hour and there is no free cell left to click.
  test.beforeAll(async () => {
    await dropStaleCalendarEvents(['Recurring meeting ', 'Recurring occupancy '])
  })

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

  test('Cancelling one occurrence of a series frees that time for the other participants', async ({
    page,
    browser
  }) => {
    const title = `Recurring occupancy ${generateId()}`

    using _page2 = await getSecondPage(browser)
    const page2 = _page2.page
    const calendarPage2 = await openCalendarWidget(page2)
    let hour: string = ''

    await test.step('Second account starts a daily series tomorrow', async () => {
      // The series starts on the day the check happens: an hour free there for the second
      // account is free of everything but this series, so "no longer busy" means exactly that.
      await calendarPage2.navigateWidgetForward()
      hour = await calendarPage2.clickFreeCellInWidget()
      await calendarPage2.inputEventTitle().fill(title)
      await calendarPage2.setRecurringDaily()
      await calendarPage2.buttonCreateEventSubmit().click()
      await expect(calendarPage2.eventInCalendarWidget(title)).toBeVisible()
    })

    // The series is read through its BusySlot here: the first account is not a participant,
    // so it never sees the Event itself - only the busy mark in the participants list.
    const calendarPage = await openCalendarWidget(page)
    await calendarPage.navigateWidgetForward()

    await test.step('Tomorrow the series marks the second account busy', async () => {
      await calendarPage.clickCellAtTime(hour)
      await calendarPage.addEventParticipant(SECOND_USER_LAST_NAME)
      await expect(calendarPage.participantBusyMark(SECOND_USER_LAST_NAME)).toBeVisible({ timeout: 15000 })
      await calendarPage.closeCreateEventPopup()
    })

    await test.step('Second account cancels tomorrow occurrence only', async () => {
      await calendarPage2.deleteOccurrenceInWidget(title)
    })

    await test.step('The cancelled hour is free again, the rest of the series is not touched', async () => {
      await calendarPage.clickCellAtTime(hour)
      await calendarPage.addEventParticipant(SECOND_USER_LAST_NAME)
      await expect(calendarPage.participantBusyMark(SECOND_USER_LAST_NAME)).toBeHidden({ timeout: 15000 })
      await calendarPage.closeCreateEventPopup()

      // The next day still carries the second occurrence.
      await calendarPage.navigateWidgetForward()
      await calendarPage.clickCellAtTime(hour)
      await calendarPage.addEventParticipant(SECOND_USER_LAST_NAME)
      await expect(calendarPage.participantBusyMark(SECOND_USER_LAST_NAME)).toBeVisible({ timeout: 15000 })
      await calendarPage.closeCreateEventPopup()
    })
  })
})

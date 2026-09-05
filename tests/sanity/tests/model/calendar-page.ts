import { errors, expect, Locator, Page } from '@playwright/test'
import { CommonPage } from './common-page'

export class CalendarPage extends CommonPage {
  readonly page: Page

  constructor (page: Page) {
    super(page)
    this.page = page
  }

  buttonDatePopupToday = (): Locator => this.page.locator('div.popup div.today:not(.wrongMonth)')
  inputTargetDateDay = (): Locator =>
    this.page.locator('div.date-popup-container div.datetime-input span.digit:nth-child(1)')

  inputTargetDateMonth = (): Locator =>
    this.page.locator('div.date-popup-container div.datetime-input span.digit:nth-child(3)')

  inputTargetDateYear = (): Locator =>
    this.page.locator('div.date-popup-container div.datetime-input span.digit:nth-child(5)')

  buttonTargetDateSave = (): Locator => this.page.locator('div.date-popup-container div.footer button')
  inputPopupDateDay = (): Locator =>
    this.page.locator('div[class*="date-popup"] div.datetime-input span.digit:first-child')

  inputPopupDateMonth = (): Locator =>
    this.page.locator('div[class*="date-popup"] div.datetime-input span.digit:nth-child(3)')

  inputPopupDateYear = (): Locator =>
    this.page.locator('div[class*="date-popup"] div.datetime-input span.digit:nth-child(5)')

  inputPopupTime = (): Locator =>
    this.page.locator('div[class*="date-popup"] div.datetime-input span.digit:nth-child(7)')

  inputPopupDateSave = (): Locator => this.page.locator('div[class*="date-popup"] div.footer button')
  buttonInDays = (inDays: string): Locator =>
    this.page.locator('div.popup div.shift-container div.btn span', { hasText: inDays })

  async clickButtonDatePopupToday (): Promise<void> {
    await this.buttonDatePopupToday().click()
  }

  async fillDatePopup (day: string, month: string, year: string): Promise<void> {
    await expect(this.inputTargetDateDay()).toBeVisible()
    await this.inputTargetDateDay().pressSequentially(day)
    await this.inputTargetDateMonth().pressSequentially(month)
    await this.inputTargetDateYear().pressSequentially(year)
    await this.buttonTargetDateSave().click()
  }

  async fillDatePopupInDays (inDays: string): Promise<void> {
    await expect(this.inputTargetDateDay()).toBeVisible()
    await this.buttonInDays(inDays).click()
  }

  async fillSelectDatePopup (day: string, month: string, year: string, time: string): Promise<void> {
    await this.inputPopupDateDay().click()
    await this.inputPopupDateDay().pressSequentially(day)
    await this.inputPopupDateMonth().click()
    await this.inputPopupDateMonth().pressSequentially(month)
    await this.inputPopupDateYear().click()
    await this.inputPopupDateYear().pressSequentially(year)
    await this.inputPopupTime().click()
    await this.inputPopupTime().pressSequentially(time)
    await this.inputPopupDateSave().click()
  }

  // Calendar widget shown in the right sidebar (opened via SidebarPage.clickSidebarPageButton('calendar')).
  // Renders the same DayCalendar grid as the Planner schedule, in single-day mode.
  calendarWidget = (): Locator => this.page.locator('#sidebar .calendar-container')

  eventInCalendarWidget = (title: string): Locator =>
    this.calendarWidget().locator('div.event-container', { hasText: title })

  private readonly timeCellInCalendarWidget = (time: string): Locator =>
    this.calendarWidget().locator(`div.time-cell:text-is('${time}')`)

  // The grid has one empty-cell per day column right after its time-cell - with the widget's
  // single-day view that is always the next div in document order.
  emptyCellAtTime = (time: string): Locator => this.timeCellInCalendarWidget(time).locator('xpath=following::div[1]')

  // CalendarNavigation.svelte: Today/Back/Forward buttons, no dropdown since the widget only
  // allows CalendarMode.Day - Forward is the last of the three.
  private readonly calendarWidgetNavigation = (): Locator =>
    this.page.locator('#sidebar div.flex-row-center.gap-2', { hasText: 'Today' })

  buttonForwardDayInWidget = (): Locator => this.calendarWidgetNavigation().locator('button').last()

  async navigateWidgetForward (): Promise<void> {
    await this.buttonForwardDayInWidget().click()
  }

  // The stand is reused between runs and specs run in parallel against the same workspace, so a
  // fixed hour may already hold an event - the click would then open it instead of creating one.
  // Clicking for real (rather than probing first) keeps the check and the click atomic.
  // Same shape as DayCalendar's getTimeFormat: 0am..11am, 12pm, 1pm..11pm.
  private readonly hourLabel = (hour: number): string => `${hour > 12 ? hour - 12 : hour}${hour < 12 ? 'am' : 'pm'}`

  // Scanning starts at midnight rather than "now": other specs book the current hour and the
  // ones right after it, so the early morning is nearly always free and the scan ends at once.
  async clickFreeCellInWidget (from: number = 0): Promise<string> {
    for (let i = 0; i < 24; i++) {
      const time = this.hourLabel((from + i) % 24)
      const cell = this.emptyCellAtTime(time)
      try {
        await cell.scrollIntoViewIfNeeded({ timeout: 2000 })
        await cell.click({ timeout: 2000 })
      } catch (e) {
        // Only "the cell is covered by an event" is expected here, anything else is a real failure.
        if (!(e instanceof errors.TimeoutError)) throw e
        continue
      }
      // The click can land on a sliver of a cell that is mostly covered and open nothing, so the
      // create popup is the only proof the hour was really free.
      if (
        await this.createEventPopup()
          .isVisible({ timeout: 2000 })
          .catch(() => false)
      ) {
        return time
      }
      await this.page.keyboard.press('Escape')
    }
    throw new Error('no free hour left in the calendar widget')
  }

  async createEventInWidget (title: string, from: number = 0): Promise<string> {
    const time = await this.clickFreeCellInWidget(from)
    await this.inputEventTitle().fill(title)
    await this.buttonCreateEventSubmit().click()
    return time
  }

  // calendar.component.CreateEvent, opened by clicking an empty-cell above. Rendered through the
  // platform's generic popup shell (div.popup), same as the planning create-ToDo popup.
  createEventPopup = (): Locator => this.page.locator('div.popup div.eventPopup-container')

  inputEventTitle = (): Locator => this.createEventPopup().locator('input[placeholder="Event title"]')
  inputEventParticipants = (): Locator => this.createEventPopup().locator('input[placeholder="Add participants"]')
  // The popup also has a "Create meeting" button, so the submit one needs an exact match.
  buttonCreateEventSubmit = (): Locator => this.createEventPopup().getByRole('button', { name: 'Create', exact: true })

  // ParticipantsPopup.svelte: person rows are plain divs, not buttons, so the common
  // selectPopupApMenuItem (button.ap-menuItem) locator does not match here.
  participantsPopupItem = (name: string): Locator =>
    this.page.locator('div.antiPopup.thinStyle div.ap-menuItem', { hasText: name })

  // The search box matches the person's first/last name separately (findCompletions), but
  // ParticipantsPopup always displays "LastName FirstName" - filterText and fullName differ.
  // Matching on the last name only: the popup renders "Last First" while presenters
  // elsewhere render "First Last", and the surname alone is unique enough for tests.
  async addEventParticipant (lastName: string): Promise<void> {
    await this.inputEventParticipants().click()
    await this.inputEventParticipants().fill(lastName)
    await this.participantsPopupItem(lastName).first().click()
  }

  async closeEventPopup (): Promise<void> {
    await this.cardCloseButton().click()
  }

  // EventTimeExtraButton dispatches 'repeat', opening ReccurancePopup.svelte (div.repeatPopup-container).
  buttonRepeat = (): Locator => this.createEventPopup().getByText('Repeat', { exact: true })
  private readonly recurrencePopup = (): Locator => this.page.locator('div.repeatPopup-container')
  // The period dropdown defaults to Week (ReccurancePopup.svelte periodType).
  private readonly buttonRepeatPeriod = (): Locator => this.recurrencePopup().getByRole('button', { name: 'Week' })
  private readonly repeatPeriodMenuItem = (name: string): Locator =>
    this.page.locator('div.selectPopup button.menu-item', { hasText: name })

  buttonRepeatSave = (): Locator => this.recurrencePopup().getByRole('button', { name: 'Save', exact: true })

  // ReccurancePopup.svelte: the "After" radio row's sibling div holds the occurrence-count input.
  private readonly buttonRepeatAfter = (): Locator => this.recurrencePopup().getByText('After', { exact: true })
  private readonly inputRepeatCount = (): Locator =>
    this.buttonRepeatAfter()
      .locator('xpath=ancestor::div[contains(@class, "antiRadio")]/following-sibling::div[1]')
      .locator('input[type="number"]')

  // Default period is Weekly with no end date - select Daily and bound it to a few occurrences
  // so the series shows up on the next day too, without booking every day forever on a stand
  // that is reused between runs.
  async setRecurringDaily (occurrences: number = 3): Promise<void> {
    await this.buttonRepeat().click()
    await expect(this.recurrencePopup()).toBeVisible()
    await this.buttonRepeatPeriod().click()
    await this.repeatPeriodMenuItem('Day').click()
    await this.buttonRepeatAfter().click()
    await this.inputRepeatCount().fill(`${occurrences}`)
    await this.buttonRepeatSave().click()
  }

  // EventParticipantItem.svelte marks a participant already booked for the event's own time
  // with .busy-mark.busy; free participants get the same mark without the modifier.
  participantsRow = (name: string): Locator => this.createEventPopup().locator('div.antiOption', { hasText: name })
  participantBusyMark = (name: string): Locator => this.participantsRow(name).locator('.busy-mark.busy')
}

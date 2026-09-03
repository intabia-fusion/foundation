import { type Locator, type Page, expect } from '@playwright/test'
import { NewToDo, Slot } from './types'
import { CalendarPage } from '../calendar-page'
import { retry, retryIntervals, waitStable } from '../../retry'

const retryOptions = { intervals: retryIntervals, timeout: 60000 }

export class PlanningPage extends CalendarPage {
  readonly page: Page

  constructor (page: Page) {
    super(page)
    this.page = page
  }

  private readonly popup = (): Locator => this.page.locator('div.popup')
  private readonly panel = (): Locator => this.page.locator('div.hulyModal-container')
  private readonly toDosContainer = (): Locator => this.page.locator('div.toDos-container')
  private readonly schedule = (): Locator => this.page.locator('div.hulyComponent.modal')
  private readonly sidebarSchedule = (): Locator => this.page.locator('#sidebar .calendar-container')
  readonly pageHeader = (): Locator =>
    this.page.locator('div[class*="navigator"] div[class*="header"]', { hasText: 'Planning' })

  readonly buttonCreateNewToDo = (): Locator => this.toDosContainer().locator('button.button')
  readonly inputPopupCreateTitle = (): Locator => this.popup().locator('input[type="text"]')
  readonly inputPopupCreateDescription = (): Locator => this.popup().locator('div.tiptap')
  readonly inputPanelCreateDescription = (): Locator => this.panel().locator('div.tiptap')
  readonly buttonPopupCreateDueDate = (): Locator => this.popup().locator('button#dueDateButton')
  readonly buttonPanelCreateDueDate = (): Locator => this.panel().locator('button#dueDateButton')
  readonly buttonPopupCreatePriority = (): Locator => this.popup().locator('button#priorityButton')
  readonly buttonPanelCreatePriority = (): Locator => this.panel().locator('button#priorityButton')
  readonly buttonPopupCreateVisible = (): Locator => this.popup().locator('button#visibleButton')
  readonly buttonPanelCreateVisible = (): Locator => this.panel().locator('button#visibleButton')
  readonly buttonPopupVisibleToEveryone = (): Locator =>
    this.popup().getByRole('button', { name: 'Visible to everyone' })

  readonly buttonCreateRelatedIssue = (): Locator => this.page.locator('.popup button:has-text("New related issue")')

  readonly buttonPopupOnlyVisibleToYou = (): Locator =>
    this.popup().getByRole('button', { name: 'Only visible to you' })

  readonly buttonPopupSave = (): Locator => this.popup().getByRole('button', { name: 'Save' })
  readonly buttonPopupCreateAddLabel = (): Locator =>
    this.popup().locator('button.antiButton', { hasText: 'Add label' })

  readonly buttonPanelCreateAddLabel = (): Locator =>
    this.panel().locator('.hulyHeader-titleGroup > button:nth-child(2)')

  readonly buttonPopupCreateAddSlot = (): Locator => this.popup().locator('button', { hasText: 'Add Slot' })
  readonly buttonPanelCreateAddSlot = (): Locator => this.panel().locator('button', { hasText: 'Add Slot' })
  readonly buttonCalendarToday = (): Locator => this.popup().locator('div.calendar button.day.today')
  readonly buttonCreateToDo = (): Locator => this.popup().locator('button.antiButton', { hasText: 'Add Action Item' })
  readonly inputCreateToDoTitle = (): Locator =>
    this.toDosContainer().locator('input[placeholder="Add Action Item, press Enter to save"]')

  readonly buttonCardClose = (): Locator =>
    this.panel().locator('.hulyHeader-container > .hulyHeader-buttonsGroup > .font-medium-14')

  readonly textPanelToDoTitle = (): Locator =>
    this.panel().locator('div.top-content label.editbox-wrapper.ghost.large input')

  readonly textPanelToDoDescription = (): Locator => this.panel().locator('div.top-content div.tiptap > p')
  readonly textPanelDueDate = (): Locator =>
    this.panel().locator(
      'div.slots-content div.flex-row-top.justify-between div.flex-row-center .hulyButton:first-child span'
    )

  readonly textPanelPriority = (): Locator => this.panel().locator('button#priorityButton svg')
  readonly textPanelVisible = (): Locator =>
    this.panel().locator('div.hulyHeader-titleGroup > button:nth-child(3) > span')

  readonly buttonPanelLabelFirst = (): Locator =>
    this.panel().locator('div.hulyHeader-titleGroup > button:nth-child(2)')

  readonly buttonMenuDelete = (): Locator => this.page.locator('button.ap-menuItem span', { hasText: 'Delete' })
  readonly buttonPopupSelectDateNextMonth = (): Locator =>
    this.popup().locator('div.month-container > div.header > div:last-child > button:last-child')

  readonly buttonPopupSelectDatePrevMonth = (): Locator =>
    this.popup().locator('div.month-container > div.header > div:last-child > button:first-child')

  readonly buttonPrevDayInSchedule = (): Locator =>
    this.page
      .locator('div.hulyHeader-container', { hasText: 'Schedule:' })
      .locator('div.hulyHeader-buttonsGroup > button:first-child')

  readonly buttonNextDayInSchedule = (): Locator =>
    this.page
      .locator('div.hulyHeader-container', { hasText: 'Schedule:' })
      .locator('div.hulyHeader-buttonsGroup > button:last-child')

  readonly selectInputToDo = (): Locator =>
    this.toDosContainer().getByPlaceholder('Add Action Item, press Enter to save')

  readonly selectTimeCell = (time: string, column: number = 1): Locator =>
    this.schedule().locator(`div.time-cell:text-is('${time}')`).locator(`xpath=following::div[${column}]`)

  readonly eventInSchedule = (title: string): Locator =>
    this.schedule().locator('div.event-container', { hasText: title })

  readonly eventInSidebarSchedule = (title: string): Locator =>
    this.sidebarSchedule().locator('div.event-container', { hasText: title })

  readonly toDoInToDos = (hasText: string): Locator =>
    this.toDosContainer().locator('button.hulyToDoLine-container', { hasText })

  readonly checkboxToDoInToDos = (hasText: string): Locator =>
    this.toDoInToDos(hasText).locator('div.hulyToDoLine-checkbox')

  readonly buttonTagByName = (tagName: string): Locator =>
    this.page.locator(`#navGroup-tags button:has-text("${tagName}")`)

  readonly labelToDoReference = (toDoName: string): Locator =>
    this.page
      .locator('button.hulyToDoLine-container div[class$="overflow-label"]', { hasText: toDoName })
      .locator('xpath=..')
      .locator('button.reference')

  async clickButtonPrevDayInSchedule (): Promise<void> {
    await this.buttonPrevDayInSchedule().click()
  }

  async clickButtonNextDayInSchedule (): Promise<void> {
    await this.buttonNextDayInSchedule().click()
  }

  async dragToCalendar (title: string, column: number, time: string, addHalf: boolean = false): Promise<void> {
    await expect(async () => {
      // The target time depends on the hour the run starts at, and later hours sit below the fold.
      // boundingBox() reports coordinates outside the viewport all the same, so the drop would be
      // aimed at a point the mouse can never reach.
      await this.selectTimeCell(time, column).scrollIntoViewIfNeeded()
      // Hover inside the loop: a failed attempt leaves the pointer on the target cell, so the next
      // mouse.down() would grab nothing and every retry would repeat the same no-op.
      await this.toDosContainer().getByRole('button', { name: title }).hover()
      await this.page.mouse.down()
      try {
        const boundingBox = await this.selectTimeCell(time, column).boundingBox()
        expect(boundingBox).toBeTruthy()
        if (boundingBox != null) {
          const x = boundingBox.x + 10
          // Two jumps can both land before the calendar picks the drag up, and then nothing is
          // dropped and there is no error for the retry to see. Walk the pointer across.
          await this.page.mouse.move(x, boundingBox.y + 10, { steps: 10 })
          await this.page.mouse.move(x, boundingBox.y + (addHalf ? 40 : 20), { steps: 5 })
        }
      } finally {
        await this.page.mouse.up()
      }
      // Nothing else in this helper fails when the drop is lost, and then the retry has no reason
      // to run at all.
      await expect(this.eventInSchedule(title)).toBeVisible({ timeout: 5000 })
    }).toPass(retryOptions)
  }

  async moveToDoBorderByMouse (
    title: string,
    column: number,
    targetTime: string,
    size: 'top' | 'bottom'
  ): Promise<void> {
    const element = this.page.locator(`.calendar-element:has-text("${title}")`)
    const border = element.locator(`.calendar-element-${size === 'top' ? 'start' : 'end'}`)

    await expect(async () => {
      // Bring the target hour into view first - see dragToCalendar.
      await this.selectTimeCell(targetTime, column).scrollIntoViewIfNeeded()
      const before = await element.boundingBox()
      // Hover inside the loop: a failed attempt leaves the pointer on the target cell, so the next
      // mouse.down() would grab nothing and every retry would repeat the same no-op.
      await border.hover()
      await this.page.mouse.down()
      try {
        const boundingBox = await this.selectTimeCell(targetTime, column).boundingBox()
        expect(boundingBox).toBeTruthy()
        if (boundingBox != null) {
          const x = boundingBox.x + 10
          const y = size === 'bottom' ? boundingBox.y - 8 : boundingBox.y + 5
          // A single jump can land before the resize handler sees the drag, leaving the border where
          // it was and no error to retry on. Walk the pointer there and nudge it on arrival.
          await this.page.mouse.move(x, y, { steps: 10 })
          await this.page.mouse.move(x, y + 1)
          await this.page.mouse.move(x, y)
        }
      } finally {
        await this.page.mouse.up()
      }
      // A resize that changed nothing has to fail here, or the silent no-op only surfaces much
      // later as a wrong duration.
      const after = await element.boundingBox()
      expect(after?.height).not.toBe(before?.height)
      // Changed is not the same as right: if the grid scrolled between the cell lookup and the
      // drop, the border lands a row off and the duration comes out wrong with nothing to retry on.
      const cell = await this.selectTimeCell(targetTime, column).boundingBox()
      if (cell != null && after != null) {
        const edge = size === 'bottom' ? after.y + after.height : after.y
        expect(Math.abs(edge - cell.y)).toBeLessThan(cell.height / 2)
      }
    }).toPass(retryOptions)
  }

  async checkInSchedule (title: string): Promise<void> {
    await expect(this.eventInSchedule(title)).toBeVisible()
  }

  async markDoneInToDos (title: string): Promise<void> {
    const toDo = this.toDoInToDos(title)
    await expect(toDo).toBeVisible({ timeout: 20000 })
    // The list rebuilds while a todo is being marked, so a click can land on a detached node
    // and still report success. Retry until the row itself reports isDone.
    await expect(async () => {
      if (!((await toDo.getAttribute('class')) ?? '').includes('isDone')) {
        await toDo.scrollIntoViewIfNeeded()
        await toDo.hover()
        await this.checkboxToDoInToDos(title).hover()
        await this.checkboxToDoInToDos(title).click()
      }
      await expect(toDo).toHaveClass(/isDone/, { timeout: 5000 })
    }).toPass({ intervals: retryIntervals, timeout: 20000 })
  }

  async clickButtonCreateAddSlot (): Promise<void> {
    await this.buttonPanelCreateAddSlot().click({ force: true })
  }

  async clickButtonCardClose (): Promise<void> {
    await this.buttonCardClose().click()
  }

  async createNewToDoFromInput (title: string): Promise<void> {
    await this.inputCreateToDoTitle().fill(title)
    await this.page.keyboard.press('Enter')
  }

  async createNewToDo (data: NewToDo): Promise<void> {
    await this.buttonCreateNewToDo().click()

    await this.inputPopupCreateTitle().fill(data.title)
    await this.updateToDo(data, true)

    await this.buttonCreateToDo().click()
  }

  async updateToDo (data: NewToDo, popup: boolean = false): Promise<void> {
    if (data.description != null) {
      await (popup
        ? this.inputPopupCreateDescription().fill(data.description)
        : this.inputPanelCreateDescription().fill(data.description))
    }
    if (data.duedate != null) {
      const setDueDate = async (): Promise<void> => {
        await (popup ? this.buttonPopupCreateDueDate().click() : this.buttonPanelCreateDueDate().click())
        if (data.duedate === 'today') {
          await this.clickButtonDatePopupToday()
        } else {
          await this.selectMenuItem(this.page, data.duedate as string)
        }
      }
      if (popup || data.duedate !== 'today') {
        await setDueDate()
      } else {
        // A click into a still-mounting popup selects nothing and reports success, leaving the
        // seeded date in place - the test then only passed on a stand a previous run had edited.
        const now = new Date()
        const today = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`
        await expect(async () => {
          if (((await this.textPanelDueDate().textContent()) ?? '').includes(today)) return
          await setDueDate()
          await expect(this.textPanelDueDate()).toContainText(today, { timeout: 3000 })
        }).toPass({ intervals: retryIntervals, timeout: 30000 })
      }
    }
    if (data.priority != null) {
      await (popup ? this.buttonPopupCreatePriority().click() : this.buttonPanelCreatePriority().click())
      await this.selectListItem(data.priority)
    }
    if (data.visible != null) {
      await (popup ? this.buttonPopupCreateVisible().click() : this.buttonPanelCreateVisible().click())
      await this.selectPopupItem(data.visible)
    }
    if (data.labels != null && data.createLabel != null) {
      await (popup ? this.buttonPopupCreateAddLabel().click() : this.buttonPanelCreateAddLabel().click())
      if (data.createLabel) {
        await this.pressCreateButtonSelectPopup(this.page)
        await this.addNewTagPopup(this.page, data.labels, 'Tag from createNewIssue')
        await this.page.locator('.popup#TagsPopup').press('Escape')
      } else {
        await this.checkFromDropdownWithSearch(this.page, data.labels)
      }
    }
    if (data.slots != null) {
      let index = 0
      for (const slot of data.slots) {
        const addSlot = popup ? this.buttonPopupCreateAddSlot() : this.buttonPanelCreateAddSlot()
        const rows = this.slotRows(popup)
        const before = await rows.count()
        // The click is forced, so when it lands on a popup that is still closing - the tag popup
        // right above is dismissed with Escape - it adds nothing at all and reports success. Then
        // setTimeSlot waits out the whole test timeout on a row that was never created.
        await expect(async () => {
          if ((await rows.count()) === before) {
            await addSlot.click({ force: true })
          }
          await expect(rows).toHaveCount(before + 1, { timeout: 5000 })
        }).toPass({ intervals: retryIntervals, timeout: 20000 })
        await this.setTimeSlot(index, slot, popup)
        index++
      }
    }
  }

  private slotRows (popup: boolean): Locator {
    return this.page.locator(
      popup
        ? 'div.popup div.horizontalBox div.end div.scroller-container div.box div.flex-between.min-w-full'
        : 'div.hulyModal-container div.slots-content div.scroller-container div.box div.flex-between.min-w-full'
    )
  }

  /**
   * TimeInputBox decides where a digit lands from its own `startTyping` flag, so a field that was
   * already touched can swallow the first digit and clamp the hour (23 instead of 15) or push the
   * second digit into minutes (01). Retype until the field shows what we asked for.
   */
  private async typeTime (field: Locator, value: string): Promise<void> {
    const hours = value.substring(0, 2)
    const minutes = value.substring(2)
    const hourDigit = field.locator('span.digit:first-child')
    const minuteDigit = field.locator('span.digit:last-child')

    await expect(async () => {
      await hourDigit.focus()
      await hourDigit.press('Backspace')
      await hourDigit.pressSequentially(hours, { delay: 100 })
      await minuteDigit.focus()
      await minuteDigit.press('Backspace')
      await minuteDigit.pressSequentially(minutes, { delay: 100 })
      await expect(field.locator('div.datetime-input')).toHaveText(`${hours} : ${minutes}`, { timeout: 3000 })
    }).toPass({ intervals: retryIntervals, timeout: 20000 })
  }

  public async setTimeSlot (rowNumber: number, slot: Slot, popup: boolean = false): Promise<void> {
    const row = this.slotRows(popup).nth(rowNumber)

    // dateStart
    await row.locator('div.dateEditor-container:first-child > div.min-w-28:first-child .hulyButton').click()
    if (slot.dateStart === 'today') {
      await this.buttonCalendarToday().click()
    } else if (typeof slot.dateStart === 'string') {
      if (slot.dateStart === '1') {
        await this.buttonPopupSelectDateNextMonth().click()
      }
      await this.page
        .locator('div.popup div.calendar button.day')
        .filter({ has: this.page.locator(`text="${slot.dateStart}"`) })
        .click()
    } else {
      const today = new Date()
      const target = new Date(
        parseInt(slot.dateStart.year, 10),
        parseInt(slot.dateStart.month, 10) - 1,
        parseInt(slot.dateStart.day, 10)
      )
      const before: boolean = target.getTime() < today.getTime()
      const diffYear: number = Math.abs(target.getFullYear() - today.getFullYear())
      const diffMonth: number =
        diffYear === 0
          ? Math.abs(target.getMonth() - today.getMonth())
          : (diffYear - 1) * 12 +
            (before ? today.getMonth() + 12 - target.getMonth() : target.getMonth() + 12 - today.getMonth())
      for (let i = 0; i < diffMonth; i++) {
        if (before) await this.buttonPopupSelectDatePrevMonth().click()
        else await this.buttonPopupSelectDateNextMonth().click()
      }
      await this.page
        .locator('div.popup div.calendar button.day')
        .filter({ has: this.page.locator(`text="${target.getDate()}"`) })
        .click()
    }
    // timeStart
    await this.typeTime(row.locator('div.dateEditor-container:nth-child(1) .hulyButton'), slot.timeStart)

    // dateEnd + timeEnd. DateEditor opens the date+time popup from the time field only while the
    // slot fits one day. Once it spans two days that click merely focuses the field and a separate
    // date button appears, so date and time have to be set one by one.
    const endContainer = row.locator('div.dateEditor-container.difference')
    const endShown = endContainer.locator('.hulyButton > div:first-child')
    const wanted = `${slot.timeEnd.substring(0, 2)} : ${slot.timeEnd.substring(2)}`

    // The typing silently does nothing when it lands on a field that is still settling, and the
    // slot then keeps its default end - a 07:00-13:30 slot instead of 07:00-08:00.
    await expect(async () => {
      if (((await endShown.first().textContent()) ?? '').trim() === wanted) return
      const endDateButton = endContainer.locator('button.hulyButton')
      if ((await endDateButton.count()) === 0) {
        await endContainer.locator('div.hulyButton').click()
        await this.fillSelectDatePopup(slot.dateEnd.day, slot.dateEnd.month, slot.dateEnd.year, slot.timeEnd)
      } else {
        await endDateButton.click()
        // Picks the day within the month already shown - callers only ever use the current month.
        // Add month navigation here if a test ever needs an end date outside it.
        await this.page
          .locator('div.popup div.calendar button.day')
          .filter({ has: this.page.locator(`text="${slot.dateEnd.day}"`) })
          .click()
        const endDigits = endContainer.locator('div.hulyButton span.digit')
        await endDigits.first().focus()
        await endDigits.first().pressSequentially(slot.timeEnd.substring(0, 2), { delay: 100 })
        await endDigits.last().focus()
        await endDigits.last().pressSequentially(slot.timeEnd.substring(2), { delay: 100 })
      }
      await expect(endShown.first()).toHaveText(wanted, { timeout: 3000 })
    }).toPass({ intervals: retryIntervals, timeout: 30000 })
  }

  private async checkTimeSlot (rowNumber: number, slot: Slot, popup: boolean = false): Promise<void> {
    const row = this.slotRows(popup).nth(rowNumber)
    // timeStart
    await expect(
      row.locator('div.dateEditor-container:nth-child(1) .hulyButton:last-child div.datetime-input')
    ).toHaveText(slot.timeStart)
    // timeEnd
    await expect(row.locator('div.dateEditor-container.difference .hulyButton > div:first-child')).toHaveText(
      slot.timeEnd
    )
  }

  async openToDoByName (toDoName: string): Promise<void> {
    const row = this.page.locator(`button.hulyToDoLine-container:has-text("${toDoName}")`).first()
    // The list re-orders while other workers add slots, so a click can land on a neighbouring row
    // and every later check then reads a different todo's card.
    await retry(async () => {
      await row.click()
      await expect(this.textPanelToDoTitle()).toHaveValue(toDoName, { timeout: 3000 })
    })
  }

  async checkToDoNotExist (toDoName: string): Promise<void> {
    await expect(this.page.locator(`button.hulyToDoLine-container:has-text("${toDoName}")`)).toHaveCount(0)
  }

  async checkToDoExist (toDoName: string): Promise<void> {
    await expect(this.page.locator(`button.hulyToDoLine-container:has-text("${toDoName}")`)).toHaveCount(1)
  }

  async checkToDoExistAndShowDuration (toDoName: string, duration: string): Promise<void> {
    await expect(
      this.page.locator(`button.hulyToDoLine-container:has-text("${toDoName}"):has-text("${duration}")`)
    ).toHaveCount(1)
  }

  async checkToDo (data: NewToDo): Promise<void> {
    await expect(this.textPanelToDoTitle()).toHaveValue(data.title)
    if (data.description != null) {
      await expect(this.textPanelToDoDescription()).toHaveText(data.description)
    }
    if (data.duedate != null) {
      await expect(this.textPanelDueDate()).toHaveText(data.duedate)
    }
    if (data.priority != null) {
      const classAttribute = await this.textPanelPriority().getAttribute('class')
      expect(classAttribute).toContain(data.priority)
    }
    if (data.visible != null) {
      await expect(this.textPanelVisible()).toHaveText(data.visible)
    }
    if (data.labels != null) {
      // The label is rendered in the panel itself. Opening the tag popup to check it went through
      // `div.hulyHeader-titleGroup > button:nth-child(2)`, and that index shifts once a label is
      // attached, so the click landed on a different button and the popup never appeared.
      await expect(this.panel().getByText(data.labels)).toBeVisible()
    }
    if (data.slots != null) {
      let index = 0
      for (const slot of data.slots) {
        await this.checkTimeSlot(index, slot)
        index++
      }
    }
  }

  async deleteToDoByName (toDoName: string): Promise<void> {
    const line = this.page
      .locator('button.hulyToDoLine-container div[class$="overflow-label"]', { hasText: toDoName })
      .locator('xpath=..')
    const dragbox = line.locator('div.hulyToDoLine-statusPriority button.hulyToDoLine-dragbox')
    // The dragbox is rendered only while the line is hovered, and a list re-render right after the
    // hover drops it - the click then waits out the whole test timeout on an invisible button.
    await retry(async () => {
      await line.hover()
      await expect(dragbox).toBeVisible({ timeout: 2000 })
      await dragbox.click({ button: 'right', timeout: 5000 })
    })
    await this.buttonMenuDelete().click()
    await this.pressYesDeletePopup(this.page)
  }

  async selectToDoByName (toDoName: string): Promise<void> {
    await this.page
      .locator('button.hulyToDoLine-container div[class$="overflow-label"]', { hasText: toDoName })
      .locator('xpath=..')
      .locator('div.hulyToDoLine-checkbox > label')
      .click()
  }

  async openReferenceToDoByName (toDoName: string): Promise<void> {
    await this.labelToDoReference(toDoName).click()
  }

  async getReferenceNameToDoByName (toDoName: string): Promise<null | string> {
    return await this.labelToDoReference(toDoName).textContent()
  }

  async checkIfReferenceIsOpen (toDoName: string): Promise<void> {
    const referenceName = await this.getReferenceNameToDoByName(toDoName)
    await this.openReferenceToDoByName(toDoName)
    await expect(this.page.locator(`.popupPanel .hulyHeader-row:has-text("${referenceName}")`)).toBeVisible()
  }

  async clickButtonTagByName (tagName: string): Promise<void> {
    await this.buttonTagByName(tagName).click()
  }

  async checkToDoExistInCalendar (toDoName: string, count: number): Promise<void> {
    const events = this.page.locator('div.calendar-element > div.event-container >> div[class*="label"]', {
      hasText: toDoName
    })
    // The calendar keeps a stale event after a slot change (UBERF-4273), and one reload is not
    // always enough under parallel load - reload until the view catches up.
    await expect(async () => {
      await expect(events)
        .toHaveCount(count, { timeout: 7000 })
        .catch(async (err) => {
          await this.page.reload()
          throw err
        })
    }).toPass({ intervals: [1000, 2000, 3000], timeout: 45000 })
  }

  /**
   * Drops every slot the open card has. These tests assert absolute counts on seeded todos, so a
   * slot left by a previous run - or by a retry of the same test - makes them pass only once.
   */
  public async clearTimeSlots (): Promise<boolean> {
    const rows = this.slotRows(false)
    // count() does not wait, and a card that just opened reports zero slots.
    let left = await waitStable(async () => await rows.count(), { stableFor: 300, interval: 100, timeout: 10000 })
    const had = left > 0
    while (left > 0) {
      await this.deleteTimeSlot(0)
      left--
    }
    await expect(rows).toHaveCount(0)
    return had
  }

  public async deleteTimeSlot (rowNumber: number): Promise<void> {
    const rows = this.page.locator(
      'div.hulyModal-container div.slots-content div.scroller-container div.box div.flex-between.min-w-full'
    )
    // count() does not wait: read before the slots render it returns 0, and the check below then
    // waits out its timeout on a count of -1 that can never arrive.
    const before = await waitStable(async () => await rows.count(), {
      stableFor: 300,
      interval: 100,
      timeout: 10000
    })
    expect(before).toBeGreaterThan(rowNumber)
    await rows.nth(rowNumber).locator('button[data-id="btnDelete"]').click()
    await this.pressYesDeletePopup(this.page)
    // The confirmation closes before the removal round trip lands, and the caller closes the card
    // right after - a slot that never went away would only surface later, in the calendar.
    await expect(rows).toHaveCount(before - 1)
  }

  public async checkTimeSlotEndDate (rowNumber: number, dateEnd: string): Promise<void> {
    const row = this.page
      .locator('div.hulyModal-container div.slots-content div.scroller-container div.box div.flex-between.min-w-full')
      .nth(rowNumber)
    // dateEnd
    await expect(
      row.locator('div.dateEditor-container:first-child > div.min-w-28:first-child .hulyButton')
    ).toContainText(dateEnd)
  }
}

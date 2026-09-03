import { type Locator, type Page, expect } from '@playwright/test'
import { DateDivided } from './types'
import { retryIntervals, waitStable } from '../retry'

export class CommonPage {
  readonly page: Page

  constructor (page: Page) {
    this.page = page
  }

  appHeader = (): Locator => this.page.locator('.hulyNavPanel-header')
  selectPopupInput = (): Locator => this.page.locator('div.selectPopup input')
  selectPopupInputSearch = (): Locator => this.page.locator('div.popup input.search')
  selectPopupListItem = (name: string): Locator => this.page.locator('div.selectPopup div.list-item', { hasText: name })
  selectPopupListItemFirst = (): Locator => this.page.locator('div.selectPopup div.list-item')
  selectPopupApMenuItem = (hasText: string): Locator => this.page.locator('div.popup button.ap-menuItem', { hasText })
  selectPopupAddButton = (): Locator => this.page.locator('div.selectPopup button[data-id="btnAdd"]')
  selectPopupButton = (): Locator => this.page.locator('div.selectPopup button')
  selectPopupExpandButton = (): Locator => this.page.locator('div.selectPopup button[data-id="btnExpand"]')
  popupSpanLabel = (point: string): Locator =>
    this.page.locator(`div[class$="opup"] span[class*="label"]:has-text("${point}")`)

  readonly inputSearchIcon = (): Locator => this.page.locator('.hulyHeader-container .searchInput-wrapper')

  selectPopupSpanLines = (item: string): Locator =>
    this.page.locator('div.selectPopup span[class^="lines"]', { hasText: item })

  popupButtonChannelOk = (): Locator => this.page.locator('div.popup button#channel-ok')
  viewStringDeleteObjectButtonPrimary = (): Locator =>
    this.page.locator('form[id="view:string:DeleteObject"] button.primary')

  tagsStringAddTagForm = (field: string): Locator =>
    this.page.locator(`div.popup form[id="tags:string:AddTag"] :is(input, textarea)[placeholder$="${field}"]`)

  tagsStringAddTagButtonSubmit = (): Locator =>
    this.page.locator('div.popup form[id="tags:string:AddTag"] button[type="submit"]')

  notifyContainerButton = (): Locator => this.page.locator('div.notifyPopup button[data-id="btnNotifyClose"]').first()
  errorSpan = (): Locator => this.page.locator('div.ERROR span')
  infoSpan = (): Locator => this.page.locator('div.INFO span')
  popupSubmitButton = (): Locator => this.page.locator('div.popup button[type="submit"]')
  historyBoxButtonFirst = (): Locator => this.page.locator('div.history-box button:first-child')
  inboxNotyButton = (): Locator => this.page.locator('button[id$="Inbox"] > div.noty')
  mentionPopupListItem = (mentionName: string, categoryName?: string): Locator => {
    if (categoryName !== undefined && categoryName !== '') {
      return this.page.locator(`form.mentionPoup div.list-item:below(:text("${categoryName}"))`, {
        hasText: mentionName
      })
    } else {
      return this.page.locator('form.mentionPoup div.list-item', { hasText: mentionName })
    }
  }

  hulyPopupRowButton = (name: string): Locator =>
    this.page.locator('div.hulyPopup-container button.hulyPopup-row', { hasText: name })

  cardCloseButton = (): Locator => this.page.locator('div.popup button[id="card-close"]')
  menuPopupItemButton = (itemText: string): Locator =>
    this.page.locator('div.selectPopup button.menu-item', { hasText: itemText })

  buttonFilter = (): Locator => this.page.getByRole('button', { name: 'Filter' })
  inputFilterTitle = (): Locator => this.page.locator('div.selectPopup input[placeholder="Title"]')
  inputFilterName = (): Locator => this.page.locator('div.selectPopup input[placeholder="Name"]')
  inputSearch = (): Locator => this.page.locator('div.selectPopup input[placeholder="Search..."]')
  buttonFilterApply = (): Locator => this.page.locator('div.selectPopup button[type="button"]', { hasText: 'Apply' })
  buttonClearFilters = (): Locator => this.page.locator('button > span', { hasText: 'Clear filters' })
  filterButton = (index: number): Locator => this.page.locator(`div.filter-section button:nth-child(${index})`)
  selectFilterSection = (label: string): Locator =>
    this.page.locator('div.filterbar-container div.filter-section', { hasText: label })

  selectPopupMenu = (filter: string): Locator =>
    this.page.locator('div.selectPopup [class*="menu"]', { hasText: filter })

  calendarDay = (daySelector: string): Locator => this.page.locator(`div.popup div.calendar button.day${daySelector}`)

  linesFromTable = (text: string = ''): Locator =>
    this.page.locator('.hulyComponent table tbody tr').filter({ hasText: text })

  linesFromList = (text: string = ''): Locator =>
    this.page.locator('.hulyComponent .list-container div.row').filter({ hasText: text })

  firstInputFirstDigit = (): Locator =>
    this.page.locator('div.date-popup-container div.input:first-child span.digit:first-child')

  firstInputThirdDigit = (): Locator =>
    this.page.locator('div.date-popup-container div.input:first-child span.digit:nth-child(3)')

  firstInputFifthDigit = (): Locator =>
    this.page.locator('div.date-popup-container div.input:first-child span.digit:nth-child(5)')

  lastInputFirstDigit = (): Locator =>
    this.page.locator('div.date-popup-container div.input:last-child span.digit:first-child')

  lastInputThirdDigit = (): Locator =>
    this.page.locator('div.date-popup-container div.input:last-child span.digit:nth-child(3)')

  lastInputFifthDigit = (): Locator =>
    this.page.locator('div.date-popup-container div.input:last-child span.digit:nth-child(5)')

  submitButton = (): Locator => this.page.locator('div.date-popup-container button[type="submit"]')
  buttonBreadcrumb = (hasText?: string): Locator => this.page.locator('button.hulyBreadcrumb-container', { hasText })
  appsShowMenuButton = (): Locator => this.page.locator('[id="app-workbench\\:string\\:ShowMenu"]')

  async openNavigator (): Promise<void> {
    const needOpenNavigator = await this.appsShowMenuButton().isVisible()
    if (needOpenNavigator) await this.appsShowMenuButton().click()
  }

  /**
   * ListCategory folds a category holding more than 20 items whenever localStorage has no state
   * for it - which is every fresh browser context. Rows inside it are not in the DOM at all, so a
   * lookup by name waits out the whole test timeout. Categories that grow past the limit on the
   * sanity workspace: Backlog issues and components without a lead.
   */
  async expandCollapsedCategories (): Promise<void> {
    // Empty categories carry the same class and clicking them changes nothing - skipping them
    // keeps the retry below able to reach zero.
    const collapsed = this.page.locator('.categoryHeader.collapsed:not(:has(.chevron.empty))')
    await expect(async () => {
      if ((await collapsed.count()) === 0) return
      // Click them in one pass rather than counting down from the previous total: expanding one
      // category loads rows that can turn another one from empty into collapsed.
      await collapsed.evaluateAll((els) => {
        els.forEach((el) => {
          ;(el as HTMLElement).click()
        })
      })
      await expect(collapsed).toHaveCount(0, { timeout: 2000 })
    }).toPass({ intervals: retryIntervals, timeout: 15000 })
  }

  async selectMenuItem (page: Page, name: string, fullWordFilter: boolean = false): Promise<void> {
    if (name !== 'first') {
      const filterText = fullWordFilter ? name : name.split(' ')[0]
      await this.selectPopupInput().fill(filterText)
      // Wait for the list to actually re-filter: a fixed delay lets the stale first item be
      // clicked under load. Items whose text does not carry the filter fall back to the delay.
      await expect(this.selectPopupListItemFirst().first())
        .toContainText(filterText, { timeout: 5000, ignoreCase: true })
        .catch(async () => {
          await page.waitForTimeout(300)
        })
      // The filter is only the first word, so objects another worker created concurrently share it
      // and stay in the list. Take the item carrying the whole name when there is one - "first"
      // picked a teamspace from a parallel test and the document was moved into it.
      const exact = this.selectPopupListItemFirst().filter({ hasText: name })
      if ((await exact.count()) > 0) {
        await exact.first().click()
        return
      }
    }
    await this.selectPopupListItemFirst().first().click()
  }

  async pressCreateButtonSelectPopup (page: Page): Promise<void> {
    await this.selectPopupAddButton().click()
  }

  async pressShowAllButtonSelectPopup (page: Page): Promise<void> {
    await this.selectPopupExpandButton().click()
  }

  async selectFromDropdown (page: Page, point: string): Promise<void> {
    await this.popupSpanLabel(point).click()
  }

  // Opens submenu of a context menu item: MouseSpeedTracker enables submenu only after slow mouse moves
  async openSubmenu (point: string): Promise<void> {
    const item = this.popupSpanLabel(point)
    await item.hover()
    const box = await item.boundingBox()
    if (box != null) {
      for (let i = 1; i <= 3; i++) {
        await this.page.mouse.move(box.x + box.width / 2 + i * 2, box.y + box.height / 2)
        await this.page.waitForTimeout(100)
      }
    }
  }

  async checkDropdownHasNo (page: Page, item: string): Promise<void> {
    await expect(this.selectPopupSpanLines(item)).not.toBeVisible()
  }

  async fillToDropdown (page: Page, input: string): Promise<void> {
    await this.selectPopupInputSearch().fill(input)
    await this.popupButtonChannelOk().click()
  }

  async fillToSelectPopup (page: Page, input: string): Promise<void> {
    await expect(this.selectPopupInput()).toBeVisible()
    await this.selectPopupInput().fill(input)
    await this.selectPopupButton().click()
  }

  async fillEstimationPopup (page: Page, input: string): Promise<void> {
    const form = page.locator('form[id="tracker\\:string\\:Estimation"]')
    await expect(form.locator('input').first()).toBeVisible()
    await form.locator('input').first().fill(input)
    await form.locator('button', { hasText: 'Save' }).click()
  }

  async checkFromDropdown (page: Page, point: string): Promise<void> {
    const item = this.selectPopupSpanLines(point).first()
    // A tag created a moment ago can be missing from the list the popup already rendered. Filtering
    // re-runs the query instead of waiting an unchanged list out. Only the wait is retried - the
    // click itself toggles selection and must happen once.
    await expect(async () => {
      if ((await item.count()) === 0) {
        await this.selectPopupInput().fill(point)
      }
      await expect(item).toBeVisible({ timeout: 5000 })
    }).toPass({ intervals: retryIntervals, timeout: 30000 })
    await item.click()
  }

  async pressYesDeletePopup (page: Page): Promise<void> {
    await this.viewStringDeleteObjectButtonPrimary().click()
    // The button turns disabled while the removal is in flight and the form closes only once it
    // resolves - deleting a component cascades over its issues, which takes longer than a second.
    await expect(this.viewStringDeleteObjectButtonPrimary()).not.toBeVisible({ timeout: 10000 })
  }

  async addNewTagPopup (page: Page, title: string, description: string): Promise<void> {
    await this.tagsStringAddTagForm('title').fill(title)
    await this.tagsStringAddTagForm('Please type description here').fill(description)
    await this.tagsStringAddTagButtonSubmit().click()
    await this.tagsStringAddTagButtonSubmit().waitFor({ state: 'hidden' })
  }

  async selectAssignee (page: Page, name: string): Promise<void> {
    // Same popup and same trap as selectMenuItem: the filter is only the first word, so a member
    // sharing it leaves two rows and demanding exactly one just fails.
    await this.selectMenuItem(page, name)
  }

  async checkExistNewNotification (): Promise<void> {
    await expect(this.inboxNotyButton()).toBeVisible()
  }

  async pressYesForPopup (page: Page): Promise<void> {
    await expect(this.popupSubmitButton()).toBeVisible()
    await this.popupSubmitButton().click()
    await expect(this.popupSubmitButton()).not.toBeVisible({ timeout: 5000 })
  }

  async pressButtonBack (page: Page): Promise<void> {
    await this.historyBoxButtonFirst().click()
  }

  async checkFromDropdownWithSearch (page: Page, point: string): Promise<void> {
    await this.selectPopupInput().fill(point)
    const item = this.selectPopupSpanLines(point)
    // The popup keeps re-rendering while the query narrows, so a click issued right away chases a
    // moving element and can wait out the whole timeout. Let the list settle on a single match
    // first - clicking twice is not an option here, the row toggles selection.
    await expect(item).toHaveCount(1, { timeout: 15000 })
    await item.click()
  }

  // A single Escape can be swallowed while a popup is re-rendering, leaving a modal-overlay that
  // silently eats every later click. Press until no overlay is left.
  async closePopups (): Promise<void> {
    const overlay = this.page.locator('div.modal-overlay')
    await expect(async () => {
      while ((await overlay.count()) > 0) {
        await this.page.keyboard.press('Escape')
        await expect(overlay).toHaveCount(0, { timeout: 2000 })
      }
    }).toPass({ intervals: retryIntervals, timeout: 15000 })
  }

  async closeNotification (): Promise<void> {
    while (await this.notifyContainerButton().isVisible()) {
      await this.notifyContainerButton().click()
    }
  }

  async checkError (page: Page, errorMessage: string): Promise<void> {
    await expect(this.errorSpan()).toHaveText(errorMessage)
  }

  async checkInfo (page: Page, errorMessage: string): Promise<void> {
    await expect(this.infoSpan()).toHaveText(errorMessage)
  }

  async checkInfoSectionNotExist (page: Page): Promise<void> {
    await expect(this.infoSpan()).not.toBeAttached()
  }

  async selectMention (mentionName: string, categoryName?: string): Promise<void> {
    // The popup fills its categories one after another (Employees, then Cards): a click issued while
    // the list still grows selects nothing, and the popup then stays open with its overlay over the
    // send button - the next click waits out the whole test timeout.
    await waitStable(async () => await this.page.locator('form.mentionPoup div.list-item').count(), {
      stableFor: 500,
      interval: 100,
      timeout: 15000
    })
    await this.mentionPopupListItem(mentionName, categoryName).first().click()
    await expect(this.page.locator('form.mentionPoup')).toHaveCount(0, { timeout: 5000 })
  }

  async selectListItem (name: string): Promise<void> {
    await this.selectPopupListItem(name).click({ delay: 100 })
  }

  async selectPopupAp (name: string): Promise<void> {
    await this.selectPopupApMenuItem(name).click({ delay: 100 })
  }

  async selectPopupItem (name: string): Promise<void> {
    await this.hulyPopupRowButton(name).click({ delay: 100 })
  }

  async closePopup (): Promise<void> {
    await this.cardCloseButton().click()
  }

  async checkPopupItem (itemText: string): Promise<void> {
    await expect(this.menuPopupItemButton(itemText)).toBeVisible()
  }

  async clickPopupItem (itemText: string): Promise<void> {
    await this.menuPopupItemButton(itemText).first().click()
  }

  async selectFilter (filter: string, filterSecondLevel?: string): Promise<void> {
    await this.buttonFilter().click()
    // The popup re-renders while its options load, so the row can be unstable or detach mid-click.
    await expect(async () => {
      if ((await this.selectPopupMenu(filter).count()) === 0) await this.buttonFilter().click()
      await this.selectPopupMenu(filter).click({ timeout: 5000 })
    }).toPass({ intervals: retryIntervals, timeout: 30000 })

    if (filterSecondLevel !== null && typeof filterSecondLevel === 'string') {
      switch (filter) {
        case 'Title':
          await this.inputFilterTitle().fill(filterSecondLevel)
          await this.buttonFilterApply().click()
          // Wait for the list to update after applying filter
          await this.page.waitForTimeout(500)
          break
        case 'Name':
          await this.inputFilterName().fill(filterSecondLevel)
          await this.buttonFilterApply().click()
          break
        case 'Labels':
          await this.selectFromDropdown(this.page, filterSecondLevel)
          break
        case 'Skills':
          await this.inputSearch().fill(filterSecondLevel)
          await this.selectFromDropdown(this.page, filterSecondLevel)
          await this.page.keyboard.press('Escape')
          break
        default:
          await this.selectPopupMenu(filterSecondLevel).click()
      }
    }
  }

  async filterOppositeCondition (filter: string, conditionBefore: string, conditionAfter: string): Promise<void> {
    const filterSection = this.selectFilterSection(filter)
    await filterSection.locator('button', { hasText: conditionBefore }).isVisible()
    await filterSection.locator('button[data-id="btnCondition"]').click()
    await this.page.locator('div.selectPopup button.menu-item', { hasText: conditionAfter }).click()
  }

  async checkFilter (filter: string, filterSecondLevel?: string, filterThirdLevel?: string): Promise<void> {
    await expect(this.filterButton(1)).toHaveText(filter)
    if (filterSecondLevel !== undefined) {
      await expect(this.filterButton(2)).toContainText(filterSecondLevel)
    }
    if (filterThirdLevel !== undefined) {
      await expect(this.filterButton(3)).toContainText(filterThirdLevel)
    }
  }

  async updateFilterDimension (
    filterSecondLevel: string,
    dateStart?: string,
    needToOpenCalendar: boolean = false
  ): Promise<void> {
    await this.filterButton(2).click()
    await this.selectPopupMenu(filterSecondLevel).click()

    if (dateStart !== undefined) {
      if (needToOpenCalendar) {
        await this.filterButton(3).click()
      }
      await this.calendarDay(dateStart === 'Today' ? '.today' : `:has-text("${dateStart}")`).click()
    }
  }

  async fillBetweenDate (dateStart: DateDivided, dateEnd: DateDivided): Promise<void> {
    // dateStart - day
    await this.firstInputFirstDigit().click({ delay: 100, position: { x: 1, y: 1 } })
    await this.firstInputFirstDigit().pressSequentially(dateStart.day)

    // dateStart - month
    await this.firstInputThirdDigit().click({ delay: 100, position: { x: 1, y: 1 } })
    await this.firstInputThirdDigit().pressSequentially(dateStart.month)

    // dateStart - year
    await this.firstInputFifthDigit().click({ delay: 100, position: { x: 1, y: 1 } })
    await this.firstInputFifthDigit().pressSequentially(dateStart.year)

    // dateEnd - day
    await this.lastInputFirstDigit().click({ delay: 100, position: { x: 1, y: 1 } })
    await this.lastInputFirstDigit().pressSequentially(dateEnd.day)

    // dateEnd - month
    await this.lastInputThirdDigit().click({ delay: 100, position: { x: 1, y: 1 } })
    await this.lastInputThirdDigit().pressSequentially(dateEnd.month)

    // dateEnd - year
    await this.lastInputFifthDigit().click({ delay: 100, position: { x: 1, y: 1 } })
    await this.lastInputFifthDigit().pressSequentially(dateEnd.year)

    // Submit
    await this.submitButton().click({ delay: 100 })
  }

  async checkRowsInTableExist (text: string, count: number = 1): Promise<void> {
    await expect(this.linesFromTable(text)).toHaveCount(count)
  }

  async checkRowsInTableNotExist (text: string): Promise<void> {
    await expect(this.linesFromTable(text)).toHaveCount(0)
  }

  async openRowInTableByText (text: string): Promise<void> {
    await this.linesFromTable(text).locator('a', { hasText: text }).click()
  }

  async checkRowsInListExist (text: string, count: number = 1): Promise<void> {
    // Retry with timeout as list may update with delay after search/filter
    await expect(async () => {
      await expect(this.linesFromList(text)).toHaveCount(count)
    }).toPass({ intervals: retryIntervals, timeout: 15000 })
  }

  async pressEscape (): Promise<void> {
    await this.page.keyboard.press('Escape')
  }
}

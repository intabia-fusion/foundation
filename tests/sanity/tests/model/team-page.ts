import { expect, Locator, Page } from '@playwright/test'
import { CommonPage } from './common-page'

/**
 * Team views live in the Planner's calendar panel: its header carries a mode dropdown
 * (Schedule / Calendar / Team) plus the common filter bar.
 */
export class TeamPage extends CommonPage {
  readonly page: Page

  constructor (page: Page) {
    super(page)
    this.page = page
  }

  buttonMode = (): Locator => this.page.locator('div.hulyHeader-container button[data-id="planner-mode"]')

  // PlannerViewSwitch renders the todo-panel toggle right before the mode dropdown, with no
  // wrapper of its own - the dropdown itself sits inside one (see DropdownLabelsIntl.svelte).
  buttonToggleTodos = (): Locator => this.buttonMode().locator('xpath=../preceding-sibling::button[1]')

  // UserBoxList shows the "Members" label until a person is picked (contact plugin string).
  extraPersonsButton = (): Locator =>
    this.page.locator('div.hulyHeader-container .hulyHeader-buttonsGroup.actions button', { hasText: 'Members' })

  // ToDos.svelte renders this container only while the todo panel is shown.
  toDoListPanel = (): Locator => this.page.locator('div.toDos-container')

  // Root of the personal Schedule panel (PlanningCalendar.svelte) - also used to measure its
  // width against its flex-row parent once the todo panel is hidden.
  calendarPanel = (): Locator => this.page.locator('div.hulyComponent.modal')

  // A colleague's busy overlay (DayCalendar.svelte). Both shapes carry the name in the DOM: the
  // wide one prints it, the narrow stripe only has room to show it clipped.
  backgroundElement = (name?: string): Locator =>
    name != null
      ? this.page.locator('div.background-element', { hasText: name })
      : this.page.locator('div.background-element')

  buttonNextDay = (): Locator =>
    this.page.locator('div.hulyComponent div.hulyHeader-container .actions button[data-id="btnNext"]')

  // Calendar mode, no project selected: PersonCalendar.svelte lists all active employees.
  // Scoped to timeline-resource-content - the sticky header carries its own timeline-resource-cell
  // (a "N members" count) that would otherwise throw off row indexing below.
  employeeRow = (name?: string): Locator =>
    name != null
      ? this.page.locator('div.timeline-resource-content div.timeline-resource-cell', { hasText: name })
      : this.page.locator('div.timeline-resource-content div.timeline-resource-cell')

  // Occupancy mode: one column per day (Yesterday / Today / Tomorrow).
  occupancyColumn = (column: string): Locator => this.page.locator('div.hulyComponent div.item', { hasText: column })

  getItemByText = (column: string, title: string): Locator =>
    this.occupancyColumn(column).locator('div.item', { hasText: title })

  // A colleague's busy time with no shared project renders as an anonymous "Busy" row (BusySlot),
  // never the todo title - see BusyElement.svelte / PlanItem.svelte.
  busyBlock = (column: string): Locator => this.getItemByText(column, 'Busy')

  // Calendar mode's per-person grid (PersonCalendar.svelte) renders the resource names and the
  // day cells as two independent {#each persons} loops in the same order - the row index found
  // in one locates the matching row in the other, since neither carries the person's ref in the DOM.
  async findPersonRowIndex (name: string): Promise<number> {
    // The employee list loads asynchronously after switching modes - wait for the target
    // row itself rather than racing a blind count against an empty list.
    await expect(this.employeeRow(name)).toBeVisible({ timeout: 15000 })
    const rows = this.employeeRow()
    const count = await rows.count()
    for (let i = 0; i < count; i++) {
      if ((await rows.nth(i).innerText()).includes(name)) return i
    }
    throw new Error(`Person "${name}" not found in Calendar mode`)
  }

  // DayCell.svelte: an unshared busy slot renders as an anonymous "Busy" entry, same wording as
  // Occupancy's busyBlock. class:timeline-cell--today marks today's column within the row.
  busyEntryTodayForRow = (index: number): Locator =>
    this.page
      .locator('div.timeline-grid-content div.timeline-row')
      .nth(index)
      .locator('div.timeline-cell--today div.entry', { hasText: 'Busy' })

  async selectMode (name: string): Promise<void> {
    await this.buttonMode().click()
    await this.page.locator('div.selectPopup button.menu-item', { hasText: name }).click()
  }

  async openTeamCalendar (): Promise<void> {
    await this.selectMode('Calendar')
    await expect(this.buttonMode()).toContainText('Calendar')
  }

  async openTeamOccupancy (): Promise<void> {
    await this.selectMode('Team')
    await expect(this.buttonMode()).toContainText('Team')
  }

  async checkTeamPageIsOpened (): Promise<void> {
    await expect(this.buttonMode()).toBeVisible()
  }

  // The project picker is the platform filter bar: time.class.ToDo exposes exactly
  // two filters - Space (the project) and Employee (the owner).
  async selectTeam (name: string): Promise<void> {
    await this.selectFilter('Space', name)
    await this.page.keyboard.press('Escape')
  }

  async selectPerson (name: string): Promise<void> {
    await this.selectFilter('Employee', name)
    await this.page.keyboard.press('Escape')
  }

  async clearFilters (): Promise<void> {
    await this.buttonClearFilters().click()
  }

  async toggleTodos (): Promise<void> {
    await this.buttonToggleTodos().click()
  }

  // UserBoxList's popup is the generic multi-select object list (selectMenuItem/CommonPage),
  // same as the assignee picker - it updates on click and does not close itself.
  async selectExtraPerson (name: string): Promise<void> {
    await this.extraPersonsButton().click()
    await this.selectMenuItem(this.page, name)
    await this.page.keyboard.press('Escape')
  }
}

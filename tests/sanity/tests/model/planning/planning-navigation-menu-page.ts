import { type Locator, type Page, expect } from '@playwright/test'

export class PlanningNavigationMenuPage {
  readonly page: Page

  constructor (page: Page) {
    this.page = page
  }

  readonly buttonToDoAll = (): Locator =>
    this.page.locator('button[class*="hulyNavItem-container"] span[class*="hulyNavItem-label"]', {
      hasText: 'All'
    })

  readonly buttonToDoUnplanned = (): Locator =>
    this.page.locator('button[class*="hulyNavItem-container"] span[class*="hulyNavItem-label"]', {
      hasText: 'Unplanned'
    })

  readonly buttonToDoPlanned = (): Locator =>
    this.page.locator('button[class*="hulyNavItem-container"] span[class*="hulyNavItem-label"]:text-is("Planned")')

  readonly accordionContainerToDoUnplanned = (): Locator =>
    this.page.locator('div.toDos-container div.hulyAccordionItem-container', { hasText: 'Unplanned' })

  async clickOnButtonToDoAll (): Promise<void> {
    await this.buttonToDoAll().click()
  }

  async clickOnButtonUnplanned (): Promise<void> {
    await this.buttonToDoUnplanned().click()
  }

  async clickOnButtonToDoPlanned (): Promise<void> {
    await this.buttonToDoPlanned().click()
  }

  async compareCountersUnplannedToDos (): Promise<void> {
    // Both numbers have to come from one DOM snapshot. Read as two separate calls they disagree
    // whenever another worker creates a ToDo in the shared workspace in between, and since those
    // keep arriving the surrounding retry never sees them agree.
    const counts = await this.page.evaluate(() => {
      const label = Array.from(
        document.querySelectorAll('button[class*="hulyNavItem-container"] span[class*="hulyNavItem-label"]')
      ).find((s) => (s.textContent ?? '').includes('Unplanned'))
      const nav = label?.parentElement?.querySelector('span.hulyNavItem-count')?.textContent ?? ''
      const accordion = Array.from(
        document.querySelectorAll('div.toDos-container div.hulyAccordionItem-container')
      ).find((a) => (a.textContent ?? '').includes('Unplanned'))
      return {
        nav: parseInt(nav, 10),
        rows: accordion === undefined ? -1 : accordion.querySelectorAll('button.hulyToDoLine-container').length
      }
    })
    expect(counts.rows).toBe(counts.nav)
  }
}

import { expect, type Locator, type Page } from '@playwright/test'
import { retryIntervals } from '../../retry'

export class LeadsPage {
  readonly page: Page

  constructor (page: Page) {
    this.page = page
  }

  readonly leadApplication = (): Locator => this.page.locator('[id="app-lead\\:string\\:LeadApplication"]')
  readonly customersNavElement = (): Locator => this.page.locator('.antiPanel-navigator').locator('text=Customers')
  readonly newCustomerButton = (): Locator => this.page.locator('button:has-text("New Customer")')
  readonly personButton = (): Locator => this.page.locator('button:has-text("Person")')
  readonly companyButton = (): Locator => this.page.locator('button:has-text("Company")')
  readonly companyNameInput = (): Locator => this.page.locator('[placeholder="Company name"]')
  readonly createButton = (): Locator => this.page.locator('button:has-text("Create")')
  readonly antiCardFormDetached = (): Locator => this.page.locator('form.antiCard')
  readonly contactExistsMessage = (): Locator => this.page.locator('text=Contact already exists...')

  async clickLeadApplication (): Promise<void> {
    await this.leadApplication().click()
  }

  async clickCustomersNavElement (): Promise<void> {
    await this.customersNavElement().click()
  }

  async clickNewCustomerButton (): Promise<void> {
    await this.newCustomerButton().click()
  }

  async clickPersonButton (): Promise<void> {
    await this.personButton().click()
  }

  async clickCompanyButton (): Promise<void> {
    await this.companyButton().click()
  }

  async inputCompanyName (companyName: string): Promise<void> {
    await this.companyNameInput().click()
    await this.companyNameInput().fill(companyName)
  }

  async clickCreateButton (): Promise<void> {
    await this.createButton().click()
  }

  async waitForAntiCardFormDetached (): Promise<void> {
    await this.antiCardFormDetached().waitFor({ state: 'detached' })
  }

  // `CreateCustomer.svelte` looks duplicates up in a reactive block that never cancels an earlier
  // lookup, so the empty-name answer can overtake the one for the typed name and leave `matches`
  // empty for good. Nothing re-runs it on its own - retype to ask again.
  async checkContactExistsMessage (companyName: string): Promise<void> {
    await expect(async () => {
      await this.companyNameInput().fill('')
      await this.companyNameInput().fill(companyName)
      await expect(this.contactExistsMessage()).toBeVisible({ timeout: 3000 })
    }).toPass({ intervals: retryIntervals, timeout: 30000 })
  }
}

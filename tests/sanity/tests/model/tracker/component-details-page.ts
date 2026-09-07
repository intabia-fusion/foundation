import { expect, type Locator } from '@playwright/test'
import { NewComponent } from './types'
import { CommonTrackerPage } from './common-tracker-page'
import { retry, waitStable } from '../../retry'

export class ComponentsDetailsPage extends CommonTrackerPage {
  inputComponentName = (): Locator => this.page.locator('div.antiEditBox input')
  inputComponentDescription = (): Locator => this.page.locator('div.textInput div.tiptap')
  buttonLead = (): Locator => this.page.locator('//span[text()="Lead"]/following-sibling::div[1]/div/button')

  async editComponent (data: NewComponent): Promise<void> {
    const { name, description, lead } = data
    // Each field is verified on its own: the panel's query callback can put the stored value back
    // over a fresh one, and redoing the whole edit would reopen the lead popup for nothing.
    if (name != null) {
      await retry(async () => {
        await this.inputComponentName().fill(name)
        await expect(this.inputComponentName()).toHaveValue(name, { timeout: 3000 })
      })
    }
    if (description != null) {
      await retry(async () => {
        await this.inputComponentDescription().fill(description)
        // Click outside the description field to trigger save
        await this.inputComponentName().click()
        // Wait for the field to stop changing rather than for one matching read: the stored value
        // arrives over the fresh one a moment later, and the check further down then fails instead.
        const settled = await waitStable(async () => (await this.inputComponentDescription().textContent()) ?? '', {
          stableFor: 1000,
          interval: 200,
          timeout: 10000
        })
        expect(settled).toBe(description)
      })
    }
    if (lead != null) {
      await retry(async () => {
        if (((await this.buttonLead().textContent()) ?? '').includes(lead)) return
        await this.buttonLead().click()
        await this.selectMenuItem(this.page, lead)
        await expect(this.buttonLead()).toHaveText(lead, { timeout: 3000 })
      })
    }
  }

  async checkComponent (data: NewComponent): Promise<void> {
    await expect(this.inputComponentName()).toHaveValue(data.name)
    if (data.description != null) {
      await expect(this.inputComponentDescription()).toHaveText(data.description)
    }
    if (data.lead != null) {
      await expect(this.buttonLead()).toHaveText(data.lead)
    }
  }

  async deleteComponent (): Promise<void> {
    await this.buttonMoreActions().click()
    await this.selectFromDropdown(this.page, 'Delete')
    await this.pressYesDeletePopup(this.page)
  }
}

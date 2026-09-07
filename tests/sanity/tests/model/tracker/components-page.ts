import { expect, type Locator } from '@playwright/test'
import { NewComponent } from './types'
import { CommonTrackerPage } from './common-tracker-page'
import { retry } from '../../retry'

export class ComponentsPage extends CommonTrackerPage {
  buttonNewComponent = (): Locator => this.page.locator('button[type="submit"] span', { hasText: 'Component' })
  inputNewComponentModalComponentName = (): Locator => this.page.locator('form[id="tracker:string:NewComponent"] input')
  inputNewComponentModalComponentDescription = (): Locator =>
    this.page.locator('form[id="tracker:string:NewComponent"] div.tiptap')

  buttonNewComponentModalComponentLead = (): Locator =>
    this.page.locator('form[id="tracker:string:NewComponent"] div.antiCard-pool button[type="button"]')

  buttonNewComponentModalComponentCreate = (): Locator =>
    this.page.locator('form[id="tracker:string:NewComponent"] button[type="submit"]')

  componentLink = (componentName: string): Locator => this.page.locator('div.row a', { hasText: componentName })

  async createNewComponent (data: NewComponent): Promise<void> {
    await this.buttonNewComponent().click()
    await this.inputNewComponentModalComponentName().fill(data.name)
    if (data.description != null) {
      await this.inputNewComponentModalComponentDescription().fill(data.description)
    }
    if (data.lead != null) {
      await this.buttonNewComponentModalComponentLead().click()
      await this.selectMenuItem(this.page, data.lead)
    }
    // The submit can land while the form is still settling and leave it open with nothing created;
    // the caller then waits out its whole timeout on a row that never appears.
    await retry(async () => {
      await this.buttonNewComponentModalComponentCreate().click({ timeout: 5000 })
      await expect(this.page.locator('form[id="tracker:string:NewComponent"]')).toHaveCount(0, { timeout: 5000 })
    })
  }

  async openComponentByName (componentName: string): Promise<void> {
    await this.expandCollapsedCategories()
    await this.componentLink(componentName).click()
  }

  async checkComponentNotExist (componentName: string): Promise<void> {
    // Without expanding, a folded category makes this assertion pass for the wrong reason.
    await this.expandCollapsedCategories()
    await expect(this.componentLink(componentName)).toHaveCount(0)
  }
}

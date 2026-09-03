import { expect, type Locator } from '@playwright/test'
import { CommonTrackerPage } from './common-tracker-page'

export class LabelsPage extends CommonTrackerPage {
  linkSidebarLabels = (): Locator => this.page.getByRole('link', { name: 'Labels', exact: true })
  buttonAddLabel = (): Locator => this.page.locator('div.hulyHeader-container button', { hasText: 'Add label' })
  labelRow = (name: string): Locator => this.page.locator('tr.antiTable-body__row', { hasText: name })

  async openLabels (): Promise<void> {
    await this.linkSidebarLabels().click()
    await expect(this.buttonAddLabel()).toBeVisible()
  }

  async createLabel (name: string): Promise<void> {
    await this.buttonAddLabel().click()
    await this.addNewTagPopup(this.page, name, 'Tag from labels page')
    await this.checkLabelExist(name)
  }

  async checkLabelExist (name: string): Promise<void> {
    await expect(this.labelRow(name)).toHaveCount(1)
  }
}

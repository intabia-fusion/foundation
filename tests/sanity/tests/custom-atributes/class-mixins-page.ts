import { expect, type Locator, type Page } from '@playwright/test'
import { retry } from '../retry'

export class ClassMixinsPage {
  readonly page: Page

  constructor (page: Page) {
    this.page = page
  }

  classNavItem = (name: string): Locator => this.page.getByRole('button', { name, exact: true })
  createMixinButton = (): Locator => this.page.getByRole('button', { name: 'Create Mixin' })
  // Scoped to the popup: unscoped, `Name` also matches fields on the class panel behind it, so a
  // popup that never opened was filled silently and the wait for its Create button burned a minute.
  createMixinPopup = (): Locator => this.page.locator('form.antiCard')
  mixinNameInput = (): Locator => this.createMixinPopup().getByPlaceholder('Name')
  createPopupButton = (): Locator => this.createMixinPopup().getByRole('button', { name: 'Create', exact: true })
  mixinChip = (name: string): Locator => this.page.getByRole('button', { name: `Mixin: ${name}`, exact: true })
  mixinCard = (name: string): Locator => this.page.locator('.mixinItem', { hasText: `Mixin: ${name}` })
  mixinDeleteButton = (name: string): Locator => this.mixinCard(name).locator('button.button').last()
  confirmDeleteButton = (): Locator => this.page.getByRole('button', { name: 'Ok', exact: true })

  async selectClass (name: string): Promise<void> {
    await this.classNavItem(name).click()
  }

  async clickCreateMixin (): Promise<void> {
    await this.createMixinButton().click()
  }

  async fillMixinName (name: string): Promise<void> {
    await this.mixinNameInput().fill(name)
  }

  async clickCreatePopupButton (): Promise<void> {
    await this.createPopupButton().click()
  }

  /** Retried as a whole - the popup can be closed by a re-render of the freshly created workspace. */
  async createMixin (name: string): Promise<void> {
    await retry(async () => {
      if (await this.mixinChip(name).isVisible()) return
      await this.createMixinButton().click()
      await expect(this.mixinNameInput()).toBeVisible({ timeout: 5000 })
      await this.mixinNameInput().fill(name)
      await this.createPopupButton().click({ timeout: 5000 })
      await expect(this.mixinChip(name)).toBeVisible({ timeout: 10000 })
    }, 45000)
  }

  async checkMixinExists (name: string): Promise<void> {
    await expect(this.mixinChip(name)).toBeVisible()
  }

  async deleteMixin (name: string): Promise<void> {
    await this.mixinDeleteButton(name).click()
    await this.confirmDeleteButton().click()
  }
}

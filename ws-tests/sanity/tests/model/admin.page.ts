import { PlatformURI } from '@hcengineering/tests-sanity'
import { expect, type Page } from '@playwright/test'

export class AdminPage {
  readonly page: Page

  constructor (page: Page) {
    this.page = page
  }

  // ACTIONS
  async gotoAdmin (): Promise<void> {
    await (await this.page.goto(`${PlatformURI}/login/admin`))?.finished()
    await this.openAdminSession()
  }

  // Entering /admin asks for a second factor: every admin RPC refuses a token without a fresh mfaAt.
  // The panel renders the code form in place of the tabs until the session is open.
  async openAdminSession (code = '000000'): Promise<void> {
    const codeInput = this.page.locator('input[placeholder="Code"]')
    try {
      await codeInput.waitFor({ state: 'visible', timeout: 10000 })
    } catch {
      return // already inside an open session
    }
    await codeInput.fill(code)
    await this.page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await this.page.locator('[data-id="tab-workspaces"]').waitFor({ state: 'visible' })
  }

  async openWorkspacesTab (): Promise<void> {
    await this.page.locator('[data-id="tab-workspaces"]').click()
  }

  async searchWorkspace (uuid: string): Promise<void> {
    const input = this.page.locator('[data-testid="workspace-search-container"] input')
    await input.click()
    await input.fill(uuid)
  }

  // Toggles a filter checkbox by its adjacent label text (e.g. 'Show archived workspaces').
  async toggleFilter (labelText: string): Promise<void> {
    await this.page.getByText(labelText, { exact: true }).locator('xpath=following-sibling::*[1]').first().click()
  }

  async refresh (): Promise<void> {
    await this.page.getByRole('button', { name: 'Refresh' }).click()
  }

  // Opens the workspace details dialog via the third (Details) icon button in the row.
  async openWorkspaceDetails (uuid: string): Promise<void> {
    await this.page.locator(`[id="${uuid}"]`).locator('button').nth(2).click()
  }

  // The list does not auto-refresh during a test; poll Refresh until the row shows `expected`.
  async waitWorkspaceMode (uuid: string, expected: string, timeout = 90000): Promise<void> {
    await expect(async () => {
      await this.refresh()
      const cell = this.page.locator(`[id="${uuid}"]`).getByText(expected, { exact: true }).first()
      await expect(cell).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout })
  }

  // Opens the MigrationRegion ButtonMenu (currently showing `current`) and picks `target`.
  async selectMigrationRegion (current: string, target: string): Promise<void> {
    await this.page.getByRole('button', { name: current, exact: true }).first().click()
    await this.page.getByRole('button', { name: target, exact: true }).first().click()
  }

  // Enters the fixed dev OTP code (ADMIN_OTP_DEV_CODE) and confirms the dialog.
  async confirmOtp (code = '000000'): Promise<void> {
    const codeInput = this.page.locator('input[placeholder="Code"]')
    await codeInput.waitFor({ state: 'visible' })
    await codeInput.fill(code)
    await this.page.getByRole('button', { name: 'Confirm', exact: true }).click()
  }
}

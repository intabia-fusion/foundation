import {
  ApiEndpoint,
  generateId,
  LoginPage,
  SelectWorkspacePage,
  UserProfilePage
} from '@hcengineering/tests-sanity'
import { expect, test, type Page } from '@playwright/test'
import { AdminPage } from '../model/admin.page'

/**
 * The support scenario end to end: a workspace goes away, then the account behind it, and the
 * person can come back later with the same email. Both routes are covered - the admin panel and
 * the person doing it themselves.
 */
test.describe('Workspace and account deletion', () => {
  test('admin deletes a workspace and then the account behind it', async ({ page, request }) => {
    const api: ApiEndpoint = new ApiEndpoint(request)
    const wsId = generateId(5)
    const email = `admin-purge-${wsId}@example.com`

    const created = await api.createAccount(email, '1234', 'Admin', 'Purge')
    const accountUuid: string = created.result.account
    const workspaceInfo = await api.createWorkspaceWithLogin(wsId, email, '1234')

    const adminPage = new AdminPage(page)
    await adminPage.gotoAdmin()

    await test.step('delete the workspace', async () => {
      await adminPage.openWorkspacesTab()
      await adminPage.searchWorkspace(workspaceInfo.workspace)
      await page.locator(`[id="${workspaceInfo.workspace}"]`).getByRole('button', { name: 'Delete' }).click()
      await adminPage.confirmOtp()
      // Workspaces on their way out are hidden by default.
      await adminPage.toggleFilter('Show deleted workspaces')
      await adminPage.waitWorkspaceMode(workspaceInfo.workspace, 'deleted')
    })

    await test.step('delete the account', async () => {
      await adminPage.openAccountsTab()
      await adminPage.enableAccountDeletion()
      await adminPage.searchAccount(email)
      await adminPage.deleteAccount(accountUuid)
      await expect(page.locator(`[id="${accountUuid}"]`)).toHaveCount(0, { timeout: 30000 })
    })

    await test.step('the email no longer signs in', async () => {
      await expect(api.loginAndGetToken(email, '1234')).rejects.toThrow()
    })
  })

  test('owner deletes their workspace and then themselves', async ({ page, request }) => {
    const api: ApiEndpoint = new ApiEndpoint(request)
    const wsId = generateId(5)
    const email = `self-purge-${wsId}@example.com`

    await api.createAccount(email, '1234', 'Self', 'Purge')
    await api.createWorkspaceWithLogin(wsId, email, '1234')

    const loginPage = new LoginPage(page)
    const selectWorkspacePage = new SelectWorkspacePage(page)
    const userProfilePage = new UserProfilePage(page)

    await loginPage.goto()
    await loginPage.login(email, '1234')
    await selectWorkspacePage.selectWorkspace(wsId)

    await test.step('the link is hidden while the person still owns a workspace', async () => {
      await userProfilePage.openProfileMenu()
      await userProfilePage.clickSelectWorkspace()
      await expect(page.getByText('Delete account', { exact: true })).toHaveCount(0)
      await selectWorkspacePage.selectWorkspace(wsId)
    })

    await test.step('delete the workspace from its settings', async () => {
      await userProfilePage.openProfileMenu()
      await userProfilePage.clickSettings()
      await page.getByRole('button', { name: 'General' }).click()
      await page.getByRole('button', { name: 'Delete workspace' }).click()
      await page.getByRole('button', { name: 'Ok', exact: true }).click()
      // Self-service deletion is OTP-gated the same way the admin panel is.
      await adminOtp(page)
      await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 60000 })
    })

    await test.step('delete the account from the workspace list', async () => {
      const link = page.getByText('Delete account', { exact: true })
      await expect(link).toBeVisible({ timeout: 30000 })
      await link.click()

      const code = page.locator('input[placeholder="Enter code"]')
      await code.waitFor({ state: 'visible' })
      await code.fill('000000')
      await page.getByRole('button', { name: 'Delete account', exact: true }).click()

      await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 60000 })
    })

    await test.step('the email no longer signs in', async () => {
      await expect(api.loginAndGetToken(email, '1234')).rejects.toThrow()
    })
  })
})

/** The settings dialog reuses the admin OTP form: a fixed dev code on the stand. */
async function adminOtp (page: Page, code = '000000'): Promise<void> {
  const codeInput = page.locator('input[placeholder="Code"]')
  await codeInput.waitFor({ state: 'visible' })
  await codeInput.fill(code)
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
}

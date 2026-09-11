import { ApiEndpoint, generateId, LoginPage, SelectWorkspacePage, UserProfilePage } from '@hcengineering/tests-sanity'
import { expect, test, type Page } from '@playwright/test'
import { AdminPage } from '../model/admin.page'

/**
 * Deletion is deferred: both routes - the admin panel and the person themselves - only stamp a
 * deadline. Nothing is destroyed here, so the checks are about the mark being set, taken off, and
 * about the person still being able to sign in while it stands.
 */
test.describe('Workspace and account deletion', () => {
  test('admin schedules a workspace and the account behind it', async ({ page, request }) => {
    const api: ApiEndpoint = new ApiEndpoint(request)
    const wsId = generateId(5)
    const email = `admin-purge-${wsId}@example.com`

    const created = await api.createAccount(email, '1234', 'Admin', 'Purge')
    const accountUuid: string = created.result.account
    const workspaceInfo = await api.createWorkspaceWithLogin(wsId, email, '1234')

    const adminPage = new AdminPage(page)
    await adminPage.gotoAdmin()

    const row = page.locator(`[id="${workspaceInfo.workspace}"]`)

    await test.step('schedule the workspace', async () => {
      await adminPage.openWorkspacesTab()
      await adminPage.searchWorkspace(workspaceInfo.workspace)
      await row.getByRole('button', { name: 'Delete' }).click()
      await adminPage.confirmOtp()
      // The deadline replaces the Delete button with the way back.
      await expect(row.getByRole('button', { name: 'Cancel deletion' })).toBeVisible({ timeout: 30000 })
    })

    await test.step('and can call it off', async () => {
      await row.getByRole('button', { name: 'Cancel deletion' }).click()
      await adminPage.confirmOtp()
      await expect(row.getByRole('button', { name: 'Delete' })).toBeVisible({ timeout: 30000 })
    })

    await test.step('mark the account', async () => {
      await adminPage.openAccountsTab()
      await adminPage.enableAccountDeletion()
      await adminPage.searchAccount(email)
      await adminPage.deleteAccount(accountUuid)
    })

    await test.step('the email still signs in while the mark stands', async () => {
      await expect(api.loginAndGetToken(email, '1234')).resolves.toBeTruthy()
    })
  })

  test('owner schedules their workspace and then themselves', async ({ page, request }) => {
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

    await test.step('schedule the workspace from its settings', async () => {
      await userProfilePage.openProfileMenu()
      await userProfilePage.clickSettings()
      await page.getByRole('button', { name: 'General' }).click()
      await page.getByRole('button', { name: 'Delete workspace' }).click()
      await page.getByRole('button', { name: 'Ok', exact: true }).click()
      // Self-service deletion is OTP-gated the same way the admin panel is.
      await adminOtp(page)
      await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 60000 })
    })

    await test.step('schedule the account from the workspace list', async () => {
      const link = page.getByText('Delete account', { exact: true })
      await expect(link).toBeVisible({ timeout: 30000 })
      await link.click()

      const code = page.locator('input[placeholder="Enter code"]')
      await code.waitFor({ state: 'visible' })
      await code.fill('000000')
      await page.getByRole('button', { name: 'Delete account', exact: true }).click()

      await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 60000 })
    })

    await test.step('the email still signs in and is asked about the deletion', async () => {
      await expect(api.loginAndGetToken(email, '1234')).resolves.toBeTruthy()
      await loginPage.login(email, '1234')
      await expect(page.getByText('Account scheduled for deletion')).toBeVisible({ timeout: 30000 })
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

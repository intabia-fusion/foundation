import {
  ApiEndpoint,
  ButtonType,
  LoginPage,
  SelectWorkspacePage,
  UserProfilePage,
  WorkspaceSettingsPage,
  generateId,
  getSecondPage
} from '@hcengineering/tests-sanity'
import { test } from '@playwright/test'
import { AdminPage } from '../model/admin.page'

test.describe('Workspace Delete tests', () => {
  // Deletion is processed asynchronously by the workspace service; allow the full pipeline to finish.
  test.setTimeout(180000)

  test('Admin deletes workspace', async ({ browser, request }) => {
    const api: ApiEndpoint = new ApiEndpoint(request)
    const wsId = generateId(5)
    const workspaceInfo = await api.createWorkspaceWithLogin(wsId, 'user1', '1234')

    using adminSecondPage = await getSecondPage(browser)
    const page2 = adminSecondPage.page
    const adminPage = new AdminPage(page2)

    await test.step('Delete workspace via admin panel', async () => {
      const loginPage2 = new LoginPage(page2)
      await loginPage2.goto()
      await loginPage2.login('admin', '1234')
      await page2.waitForURL((url) => {
        return url.pathname.startsWith('/login/selectWorkspace') || url.pathname.startsWith('/workbench/')
      })

      await adminPage.gotoAdmin()
      await adminPage.openWorkspacesTab()
      await adminPage.searchWorkspace(workspaceInfo.workspace)

      // Delete button is behind the super-admin 'Enable deletion' checkbox.
      await adminPage.toggleFilter('Enable deletion')
      await page2.locator(`[id="${workspaceInfo.workspace}"]`).getByRole('button', { name: 'Delete' }).click()
      // Deletion is OTP-gated; enter the dev code.
      await adminPage.confirmOtp()
    })

    await test.step('Wait until workspace mode reaches deleted', async () => {
      // Deleting workspaces are hidden by default; enable the filter to see the row.
      await adminPage.toggleFilter('Show deleted workspaces')
      await adminPage.waitWorkspaceMode(workspaceInfo.workspace, 'deleted', 150000)
    })
  })

  test('Owner deletes workspace from settings', async ({ page, browser, request }) => {
    const api: ApiEndpoint = new ApiEndpoint(request)
    const wsId = generateId(5)
    const workspaceInfo = await api.createWorkspaceWithLogin(wsId, 'user1', '1234')

    await test.step('Owner deletes workspace', async () => {
      const loginPage = new LoginPage(page)
      await loginPage.goto()
      await loginPage.login('user1', '1234')

      const selectWorkspacePage = new SelectWorkspacePage(page)
      await selectWorkspacePage.selectWorkspace(wsId)

      const userProfilePage = new UserProfilePage(page)
      await userProfilePage.openProfileMenu()
      await userProfilePage.clickSettings()

      const workspaceSettingsPage = new WorkspaceSettingsPage(page)
      await workspaceSettingsPage.selectWorkspaceSettingsTab(ButtonType.General)

      await page.getByRole('button', { name: 'Delete workspace' }).click()
      await page.getByRole('button', { name: 'Ok', exact: true }).click()
      // After deletion the user is navigated back to login.
      await page.waitForURL((url) => url.pathname.startsWith('/login'))
    })

    using adminSecondPage = await getSecondPage(browser)
    const page2 = adminSecondPage.page
    const adminPage = new AdminPage(page2)

    await test.step('Check workspace mode reaches deleted', async () => {
      const loginPage2 = new LoginPage(page2)
      await loginPage2.goto()
      await loginPage2.login('admin', '1234')
      await page2.waitForURL((url) => {
        return url.pathname.startsWith('/login/selectWorkspace') || url.pathname.startsWith('/workbench/')
      })

      await adminPage.gotoAdmin()
      await adminPage.openWorkspacesTab()
      await adminPage.searchWorkspace(workspaceInfo.workspace)
      await adminPage.toggleFilter('Show deleted workspaces')
      await adminPage.waitWorkspaceMode(workspaceInfo.workspace, 'deleted', 150000)
    })
  })
})

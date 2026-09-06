import { faker } from '@faker-js/faker'
import { LoginPage, SignUpData, SignUpPage, generateId, getSecondPage } from '@hcengineering/tests-sanity'
import { expect, test } from '@playwright/test'
import { AdminPage } from '../model/admin.page'

test.describe('Account Delete tests', () => {
  test('Admin deletes account', async ({ page, browser }) => {
    const newUser: SignUpData = {
      firstName: `FirstName-${generateId()}`,
      lastName: `LastName-${generateId()}`,
      email: faker.internet.email().toLowerCase(),
      password: '1234'
    }

    await test.step('Sign up a new account without workspace', async () => {
      const loginPage = new LoginPage(page)
      await loginPage.goto()
      await loginPage.clickSignUp()
      const signUpPage = new SignUpPage(page)
      await signUpPage.signUp(newUser)
      // Account exists once we land on the create-workspace step. Do NOT create a workspace:
      // an account that is the sole owner of a workspace cannot be deleted.
      await page.waitForURL((url) => url.pathname.startsWith('/login/createWorkspace'))
    })

    using adminSecondPage = await getSecondPage(browser)
    const page2 = adminSecondPage.page
    const adminPage = new AdminPage(page2)

    await test.step('Delete account via admin panel', async () => {
      const loginPage2 = new LoginPage(page2)
      await loginPage2.goto()
      await loginPage2.login('admin', '1234')
      await page2.waitForURL((url) => {
        return url.pathname.startsWith('/login/selectWorkspace') || url.pathname.startsWith('/workbench/')
      })

      await adminPage.gotoAdmin()
      await adminPage.openAccountsTab()
      await adminPage.searchAccount(newUser.email)
      await expect(page2.getByText(newUser.email)).toBeVisible()

      // Delete button is behind the super-admin 'Enable deletion' checkbox.
      await adminPage.toggleFilter('Enable deletion')
      await page2.locator('tr', { hasText: newUser.email }).getByRole('button', { name: 'Delete' }).click()
      // Deletion is OTP-gated; enter the dev code.
      await adminPage.confirmOtp()

      // The list reloads after deletion; the account row must be gone.
      await expect(page2.getByText(newUser.email)).toHaveCount(0)
    })

    await test.step('Deleted account can no longer log in', async () => {
      const loginPage = new LoginPage(page)
      await loginPage.goto()
      await loginPage.login(newUser.email, newUser.password)
      await loginPage.checkIfErrorMessageIsShown('wrong-credentials')
    })
  })
})

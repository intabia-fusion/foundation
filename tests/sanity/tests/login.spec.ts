import { test, expect } from './fixtures'
import { PlatformUser, checkIfUrlContains } from './utils'
import { retryIntervals } from './retry'
import { LoginPage } from './model/login-page'
import { SelectWorkspacePage } from './model/select-workspace-page'
import { CommonTrackerPage } from './model/tracker/common-tracker-page'
import { TrackerNavigationMenuPage } from './model/tracker/tracker-navigation-menu-page'
import { SignUpPage } from './model/signup-page'

test.describe('login test', () => {
  let loginPage: LoginPage
  let commonTrackerPage: CommonTrackerPage
  let signupPage: SignUpPage
  let trackerNavigationMenuPage: TrackerNavigationMenuPage
  let selectWorkspacePage: SelectWorkspacePage

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page)
    commonTrackerPage = new CommonTrackerPage(page)
    signupPage = new SignUpPage(page)
    trackerNavigationMenuPage = new TrackerNavigationMenuPage(page)
    selectWorkspacePage = new SelectWorkspacePage(page)
    await loginPage.goto()
  })

  test('check login', async () => {
    await loginPage.login(PlatformUser, '1234')
    await selectWorkspacePage.selectWorkspace('sanity-ws')
    await commonTrackerPage.checkIfMainPanelIsVisible()
    await trackerNavigationMenuPage.checkIfTrackerSidebarIsVisible()
  })

  test('check login with wrong user and if the button is disabled ', async ({ page }) => {
    await loginPage.checkIfLoginButtonIsDisabled()
    await loginPage.login(PlatformUser, 'wrong-password')
    // Wait a bit for the error message to appear after login attempt
    await expect(async () => {
      await loginPage.checkIfErrorMessageIsShown('wrong-credentials')
    }).toPass({ intervals: retryIntervals, timeout: 30000 })
  })

  test('check if user is able to go to to recovery, then login and then signup', async ({ page }) => {
    await checkIfUrlContains(page, '/login')
    await loginPage.checkIfLoginButtonIsDisabled()
    await loginPage.checkIfLoginButtonIsDisabled()
    await loginPage.clickOnRecover()
    await checkIfUrlContains(page, '/password')
    await loginPage.checkIfPasswordRecoveryIsVisible()
    await loginPage.clickOnRecoveryLogin()
    await checkIfUrlContains(page, '/login')
    await loginPage.checkIfLoginButtonIsDisabled()
    await loginPage.clickOnRecover()
    await loginPage.clickOnRecoverySignUp()
    await signupPage.checkIfSignUpButtonIsDisabled()
    await checkIfUrlContains(page, '/signup')
  })
})

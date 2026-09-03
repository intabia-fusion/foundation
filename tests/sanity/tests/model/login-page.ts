import { expect, type Locator, type Page } from '@playwright/test'
import { PlatformURI } from '../utils'
import { retryIntervals } from '../retry'

export class LoginPage {
  readonly page: Page

  constructor (page: Page) {
    this.page = page
  }

  inputEmail = (): Locator => this.page.locator('input[name=email]')
  inputPassword = (): Locator => this.page.locator('input[name=current-password]')
  buttonLogin = (): Locator => this.page.locator('button', { hasText: 'Log In' })
  loginWithPassword = (): Locator => this.page.locator('a', { hasText: 'Login with password' })
  loginWithCodeLink = (): Locator => this.page.locator('a', { hasText: 'Login with code' })
  linkSignUp = (): Locator => this.page.locator('a.title', { hasText: 'Sign Up' })
  invalidCredentialsMessage = (): Locator =>
    this.page.getByText('Account not found or the provided credentials are incorrect')

  recoverLink = (): Locator => this.page.getByRole('link', { name: 'Recover' })
  passwordRecovery = (): Locator => this.page.getByText('Password recovery')
  recoveryLoginText = (): Locator => this.page.getByText('Know your password? Log In')
  recoverySignUpText = (): Locator => this.page.getByText('Do not have an account? Sign Up')
  recoveryLogin = (): Locator => this.page.getByRole('link', { name: 'Log In' })
  recoverySignUp = (): Locator => this.page.getByRole('link', { name: 'Sign Up' })

  // Shown only when the form is opened with a live session, so there is a way back.
  signedInAs = (): Locator => this.page.getByText(/^Signed in as /)
  buttonSelectWorkspace = (): Locator => this.page.locator('button', { hasText: 'Select workspace' })

  profileButton = (): Locator => this.page.locator('#profile-button')
  popupItemButton = (hasText: string): Locator => this.page.locator('div.popup button[class*="menu"]', { hasText })

  // ACTIONS
  async goto (): Promise<void> {
    await (await this.page.goto(`${PlatformURI}/login/login`))?.finished()
  }

  // ACTIONS
  async gotoAdmin (): Promise<void> {
    await (await this.page.goto(`${PlatformURI}/admin`))?.finished()
  }

  async clickSignUp (): Promise<void> {
    await this.linkSignUp().click()
  }

  async clickOnRecover (): Promise<void> {
    await this.recoverLink().click()
  }

  async clickOnRecoveryLogin (): Promise<void> {
    await this.recoveryLogin().click()
  }

  async clickOnRecoverySignUp (): Promise<void> {
    await this.recoverySignUp().click()
  }

  // Stands differ: with USE_OTP the code form comes up first and has no password field.
  // isVisible does not auto-wait, so the form has to be mounted before asking.
  async switchToPasswordIfNeeded (): Promise<void> {
    await this.inputEmail().waitFor({ state: 'visible' })
    if (await this.inputPassword().isVisible()) return
    await this.loginWithPassword().click()
    await this.inputPassword().waitFor({ state: 'visible' })
  }

  // Requests a code and lands on the six-box screen, see OtpPage.
  async loginWithCode (email: string): Promise<void> {
    await this.inputEmail().waitFor({ state: 'visible' })
    if (await this.inputPassword().isVisible()) {
      await this.loginWithCodeLink().click()
      await expect(this.inputPassword()).toBeHidden()
    }
    await this.inputEmail().fill(email)
    await this.buttonLogin().click()
  }

  async login (email: string, password: string): Promise<void> {
    await this.switchToPasswordIfNeeded()
    await this.inputEmail().fill(email)
    await this.inputPassword().fill(password)
    expect(await this.buttonLogin().isEnabled()).toBe(true)
    await this.buttonLogin().click()
  }

  async openProfileMenu (): Promise<void> {
    await this.profileButton().click()
  }

  // ASSERTS

  async checkIfErrorMessageIsShown (message: string): Promise<void> {
    if (message === 'wrong-credentials') {
      // Wait for error message with increased timeout to allow for network latency
      // Using retry pattern as error message may take time to appear
      await expect(async () => {
        await expect(this.invalidCredentialsMessage()).toBeVisible({ timeout: 3000 })
      }).toPass({ intervals: retryIntervals, timeout: 25000 })
    }
  }

  async checkIfLoginButtonIsDisabled (): Promise<void> {
    await expect(this.buttonLogin()).toBeDisabled()
  }

  async checkIfSignedInIsShown (): Promise<void> {
    await expect(this.signedInAs()).toBeVisible()
    await expect(this.buttonSelectWorkspace()).toBeVisible()
  }

  async checkIfSignedInIsHidden (): Promise<void> {
    await expect(this.buttonSelectWorkspace()).toBeHidden()
  }

  async clickSelectWorkspace (): Promise<void> {
    await this.buttonSelectWorkspace().click()
  }

  async checkIfPasswordRecoveryIsVisible (): Promise<void> {
    await expect(this.passwordRecovery()).toBeVisible()
    await expect(this.recoveryLoginText()).toBeVisible()
    await expect(this.recoverySignUpText()).toBeVisible()
  }
}

import { expect, type Locator, type Page } from '@playwright/test'
import { SignUpData, SignUpOtpData } from './common-types'
import { CommonPage } from './common-page'
import { getOtpCode } from '../API/AccountDb'
import { retryIntervals } from '../retry'

/** Where sign up lands once it is done: password flow, OTP flow and join link each end elsewhere. */
const afterSignUp = (url: URL): boolean =>
  url.pathname.startsWith('/login/selectWorkspace') ||
  url.pathname.startsWith('/login/createWorkspace') ||
  url.pathname.startsWith('/workbench/')

export class SignUpPage extends CommonPage {
  readonly page: Page

  constructor (page: Page) {
    super(page)
    this.page = page
  }

  inputFirstName = (): Locator => this.page.locator('input[name="given-name"]')
  inputLastName = (): Locator => this.page.locator('input[name="family-name"]')
  inputEmail = (): Locator => this.page.locator('input[name="email"]')
  inputPhone = (): Locator => this.page.locator('input[name="phone-number"]')
  inputNewPassword = (): Locator => this.page.locator('input[name="password"]')
  inputRepeatPassword = (): Locator => this.page.locator('input[name="password2"]')
  checkboxPersonalData = (): Locator => this.page.locator('[data-testid="checkbox-personal-data"]')
  checkboxRules = (): Locator => this.page.locator('[data-testid="checkbox-rules"]')
  checkboxSetPasswordNow = (): Locator => this.page.getByRole('checkbox', { name: 'Set password now' })
  buttonSignUp = (): Locator => this.page.locator('button', { hasText: 'Sign Up' })
  codeInput = (): Locator => this.page.locator('input[name="otp1"]')

  async enterFirstName (firstName: string): Promise<void> {
    await this.inputFirstName().fill(firstName)
  }

  async enterLastName (lastName: string): Promise<void> {
    await this.inputLastName().fill(lastName)
  }

  async enterEmail (email: string): Promise<void> {
    await this.inputEmail().fill(email)
  }

  async enterPassword (password: string): Promise<void> {
    await this.inputNewPassword().fill(password)
  }

  async enterRepeatPassword (password: string): Promise<void> {
    await this.inputRepeatPassword().fill(password)
  }

  async checkPersonalData (): Promise<void> {
    await this.checkboxPersonalData().check()
  }

  async checkRules (): Promise<void> {
    await this.checkboxRules().check()
  }

  async acceptConsents (): Promise<void> {
    await this.checkPersonalData()
    await this.checkRules()
  }

  async clickSignUp (): Promise<void> {
    await this.buttonSignUp().click()
  }

  // With USE_OTP the password fields only appear behind the "Set password now" checkbox.
  async ensurePasswordFields (): Promise<void> {
    await this.inputEmail().waitFor({ state: 'visible' })
    if (await this.inputNewPassword().isVisible()) return
    await this.checkboxSetPasswordNow().check()
    await this.inputNewPassword().waitFor({ state: 'visible' })
  }

  async signUp (data: SignUpData): Promise<void> {
    await this.enterFirstName(data.firstName)
    await this.enterLastName(data.lastName)
    await this.enterEmail(data.email)
    await this.ensurePasswordFields()
    await this.enterPassword(data.password)
    await this.enterRepeatPassword(data.password)
    await this.acceptConsents()
    expect(await this.buttonSignUp().isEnabled()).toBe(true)
    await this.buttonSignUp().click()
    // On an OTP stand sign up always goes through the code screen, even with a password set.
    await this.confirmOtpIfNeeded(data.email)
  }

  async confirmOtpIfNeeded (email: string): Promise<void> {
    // A stand without OTP never shows the code screen. Polling both outcomes leaves as soon as one
    // of them holds; racing two waitFors instead left the loser burning its whole timeout.
    await expect
      .poll(async () => (await this.codeInput().isVisible()) || afterSignUp(new URL(this.page.url())), {
        intervals: retryIntervals,
        timeout: 30000
      })
      .toBe(true)
    if (!(await this.codeInput().isVisible())) return
    const code = await getOtpCode(email)
    for (let i = 0; i < 6; i++) {
      await this.page.locator(`input[name="otp${i + 1}"]`).fill(code[i])
    }

    // Password sign up ends on the create form, OTP sign up on select workspace, and a sign up
    // through a join link goes straight into the workspace. Callers expect the create form, so take
    // the extra click here rather than in every spec.
    await this.page.waitForURL(afterSignUp)
    if (this.page.url().includes('/login/selectWorkspace')) {
      await this.page.locator('button > span', { hasText: 'Create workspace' }).click()
      await this.page.waitForURL((url) => url.pathname.startsWith('/login/createWorkspace'))
    }
  }

  // With USE_OTP the form has no password fields and submitting leads to the code screen.
  async signUpOtp (data: SignUpOtpData): Promise<void> {
    await this.enterFirstName(data.firstName)
    await this.enterLastName(data.lastName)
    await this.enterEmail(data.email)
    if (data.phone !== undefined) {
      await this.inputPhone().fill(data.phone)
    }
    await this.acceptConsents()
    expect(await this.buttonSignUp().isEnabled()).toBe(true)
    await this.buttonSignUp().click()
  }

  async checkIfSignUpButtonIsDisabled (): Promise<void> {
    await expect(this.buttonSignUp()).toBeDisabled()
  }
}

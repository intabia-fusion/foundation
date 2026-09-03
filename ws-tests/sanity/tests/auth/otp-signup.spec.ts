//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { expect, test } from '@playwright/test'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import { type PersonUuid } from '@hcengineering/core'
import { generateToken } from '@hcengineering/server-token'
import {
  closeAccountDb,
  getOtpCode,
  getServiceAccountClient,
  LocalUrl,
  LoginPage,
  OtpPage,
  PlatformURI,
  RegistrationPage,
  SignUpPage
} from '@hcengineering/tests-sanity'

// This stand runs with USE_OTP on, so the forms below are the real ones users see. The mail queue has
// no consumer here, so the code is read straight from account_db - see API/AccountDb.
test.describe('otp signup', () => {
  const firstName = 'Test'
  const lastName = 'Person'
  const phone = '+7-900-000-00-11'
  const normalizedPhone = '+79000000011'

  let loginPage: LoginPage
  let signUpPage: SignUpPage
  let otpPage: OtpPage
  let registrationPage: RegistrationPage
  let runId: string

  const anon = getAccountClient(LocalUrl)

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page)
    signUpPage = new SignUpPage(page)
    otpPage = new OtpPage(page)
    registrationPage = new RegistrationPage(page)
    runId = `${Date.now()}`
  })

  test.afterAll(async () => {
    await closeAccountDb()
  })

  // Fresh addresses per run: a person left without an account would already have one next run.
  function email (name: string): string {
    return `otp-${runId}-${name}@test.local`
  }

  async function gotoSignUp (page: import('@playwright/test').Page): Promise<void> {
    await (await page.goto(`${PlatformURI}/login/signup`))?.finished()
  }

  async function personOf (value: string): Promise<PersonUuid | undefined> {
    const service = await getServiceAccountClient('tool')
    return await service.findPersonBySocialKey(`email:${value}`)
  }

  async function accountOf (value: string): Promise<PersonUuid | undefined> {
    const service = await getServiceAccountClient('tool')
    return await service.findPersonBySocialKey(`email:${value}`, true)
  }

  test('sign up with a real code creates the account', async ({ page }) => {
    const value = email('code')

    await gotoSignUp(page)
    await signUpPage.signUpOtp({ firstName, lastName, email: value, phone })
    await otpPage.checkIfCodeScreenIsShown(value)

    // Person exists but the account only appears once the code is entered.
    expect(await personOf(value)).toBeDefined()
    expect(await accountOf(value)).toBeUndefined()

    await otpPage.enterCode(await getOtpCode(value))

    await page.waitForURL((url) => url.pathname.startsWith('/login/selectWorkspace'))
    expect(await accountOf(value)).toBeDefined()
  })

  test('a wrong code is rejected and the account is not created', async ({ page }) => {
    const value = email('wrong-code')

    await gotoSignUp(page)
    await signUpPage.signUpOtp({ firstName, lastName, email: value, phone })
    await otpPage.enterCode('000000')

    await expect(otpPage.invalidCodeMessage()).toBeVisible()
    expect(await accountOf(value)).toBeUndefined()
  })

  test('restarting the sign up with the same phone is not blocked', async ({ page }) => {
    const value = email('same-phone')

    await gotoSignUp(page)
    await signUpPage.signUpOtp({ firstName, lastName, email: value, phone })
    await otpPage.checkIfCodeScreenIsShown(value)

    // Used to throw PhoneAlreadyExists on the person's own phone, locking the user out for good.
    await gotoSignUp(page)
    await signUpPage.signUpOtp({ firstName, lastName, email: value, phone })
    await otpPage.checkIfCodeScreenIsShown(value)

    await otpPage.enterCode(await getOtpCode(value))
    await page.waitForURL((url) => url.pathname.startsWith('/login/selectWorkspace'))

    const service = await getServiceAccountClient('tool')
    const info = await service.getPersonInfo((await personOf(value)) as PersonUuid)
    expect(info.phoneHint).toBe(normalizedPhone)
    expect(info.socialIds.some((s) => s.type === 'phone')).toBe(false)
  })

  test('an unfinished sign up can be completed from the login form', async ({ page }) => {
    const value = email('unfinished')

    // Leave a person without an account, exactly like closing the tab before entering the code.
    await anon.signUpOtp(value, firstName, lastName, phone)
    expect(await accountOf(value)).toBeUndefined()

    await loginPage.goto()
    await loginPage.loginWithCode(value)
    await otpPage.checkIfCodeScreenIsShown(value)

    // Used to throw AccountNotFound: the person had no account yet, so login was a dead end.
    await otpPage.enterCode(await getOtpCode(value))
    await page.waitForURL((url) => url.pathname.startsWith('/login/selectWorkspace'))
    expect(await accountOf(value)).toBeDefined()
  })

  test('an unknown address gets the code screen and a wrong code, never a hint', async ({ page }) => {
    const value = email('unknown')

    await loginPage.goto()
    await loginPage.loginWithCode(value)

    // Nothing is created and nothing is revealed - the screen looks like any other sign in.
    await otpPage.checkIfCodeScreenIsShown(value)
    expect(await personOf(value)).toBeUndefined()

    await otpPage.enterCode('000000')
    await expect(otpPage.invalidCodeMessage()).toBeVisible()
  })

  test('the activation link completes a sign up whose code was never entered', async ({ page }) => {
    const value = email('link')

    await anon.signUpOtp(value, firstName, lastName, phone)
    const person = (await personOf(value)) as PersonUuid
    const token = generateToken(person, undefined, { confirmEmail: value }, 'secret', {
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
    })

    await registrationPage.openConfirmLink(token)

    await page.waitForURL((url) => url.pathname.startsWith('/login/registered'))
    await registrationPage.checkRegistrationComplete(`${firstName} ${lastName}`)
    expect(await accountOf(value)).toBe(person)

    // The link is single use: the email is verified now, so a second visit only offers a way on.
    await registrationPage.openConfirmLink(token)
    await registrationPage.checkAlreadyRegistered()
  })
})

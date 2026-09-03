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

import { expect, test } from './fixtures'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import { type PersonUuid, systemAccountUuid } from '@hcengineering/core'
import { generateToken } from '@hcengineering/server-token'

import { getServiceAccountClient } from './API/AccountClient'
import { LocalUrl, PlatformURI, PlatformUser } from './utils'
import { LoginPage } from './model/login-page'
import { RegistrationPage } from './model/registration-page'
import { SelectWorkspacePage } from './model/select-workspace-page'

// Sign up writes a person and an email social id before the OTP code is entered; the account itself
// appears only on validateOtp or on following the activation link from the email.
//
// The code is random and goes to a mail queue with no consumer on the stand, so the link is rebuilt
// here with the stand secret - same trick as tests/API/AccountClient.ts uses for service tokens.
test.describe('registration test', () => {
  const secret = 'secret'
  const week = 7 * 24 * 60 * 60
  const firstName = 'Test'
  const lastName = 'Person'
  const phone = '+7-900-000-00-11'
  const normalizedPhone = '+79000000011'

  let loginPage: LoginPage
  let registrationPage: RegistrationPage
  let selectWorkspacePage: SelectWorkspacePage
  let runId: string

  const anon = getAccountClient(LocalUrl)

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page)
    registrationPage = new RegistrationPage(page)
    selectWorkspacePage = new SelectWorkspacePage(page)
    runId = `${Date.now()}`
  })

  // Fresh addresses per run: a person left without an account would already have one next run.
  function email (name: string): string {
    return `signup-${runId}-${name}@test.local`
  }

  function confirmToken (person: PersonUuid, value: string, expSec: number): string {
    return generateToken(person, undefined, { confirmEmail: value }, secret, {
      exp: Math.floor(Date.now() / 1000) + expSec
    })
  }

  async function startSignUp (value: string): Promise<PersonUuid> {
    const otp = await anon.signUpOtp(value, firstName, lastName, phone)
    expect(otp.sent).toBe(true)

    const service = await getServiceAccountClient('tool')
    const person = await service.findPersonBySocialKey(`email:${value}`)
    expect(person).toBeDefined()
    // The account only appears once the sign up is confirmed.
    expect(await service.findPersonBySocialKey(`email:${value}`, true)).toBeUndefined()

    return person as PersonUuid
  }

  async function accountOf (value: string): Promise<PersonUuid | undefined> {
    const service = await getServiceAccountClient('tool')
    return await service.findPersonBySocialKey(`email:${value}`, true)
  }

  test('activation link completes the sign up and lands on the registered page', async ({ page }) => {
    const value = email('link')
    const person = await startSignUp(value)

    await registrationPage.openConfirmLink(confirmToken(person, value, week))

    await page.waitForURL((url) => url.pathname.startsWith('/login/registered'))
    await registrationPage.checkRegistrationComplete(`${firstName} ${lastName}`)
    expect(await accountOf(value)).toBe(person)
  })

  test('registered page leads to workspace creation', async ({ page }) => {
    const value = email('create-ws')
    const person = await startSignUp(value)

    await registrationPage.openConfirmLink(confirmToken(person, value, week))
    await page.waitForURL((url) => url.pathname.startsWith('/login/registered'))
    await registrationPage.clickCreateWorkspace()

    await page.waitForURL((url) => url.pathname.startsWith('/login/createWorkspace'))
  })

  test('a second visit reports that the account already exists', async ({ page }) => {
    const value = email('second-visit')
    const person = await startSignUp(value)
    const token = confirmToken(person, value, week)

    await registrationPage.openConfirmLink(token)
    await page.waitForURL((url) => url.pathname.startsWith('/login/registered'))

    // The email is verified now, so confirmEmail refuses it - that is what makes the link single use.
    await registrationPage.openConfirmLink(token)
    await registrationPage.checkAlreadyRegistered()

    await registrationPage.clickContinue()
    await page.waitForURL((url) => url.pathname.startsWith('/login/selectWorkspace'))
  })

  test('an expired activation link is rejected and creates no account', async () => {
    const value = email('expired')
    const person = await startSignUp(value)

    await registrationPage.openConfirmLink(confirmToken(person, value, -60))

    await registrationPage.checkExpiredLink()
    expect(await accountOf(value)).toBeUndefined()
  })

  test('a short activation link works and stops working once used', async ({ page, request }) => {
    const value = email('short-link')
    const person = await startSignUp(value)

    // The email carries a short id rather than a raw JWT; mail clients mangle long tokens.
    const serviceToken = generateToken(systemAccountUuid, undefined, { service: 'tool' }, secret)
    const created = await request.post(`${LocalUrl}api/v1/createShortLink`, {
      headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
      data: { payload: confirmToken(person, value, week), workspaceId: '' }
    })
    expect(created.status()).toBe(200)
    const shortId = (await created.json()).shortId

    await registrationPage.openConfirmLink(shortId)
    await page.waitForURL((url) => url.pathname.startsWith('/login/registered'))
    expect(await accountOf(value)).toBe(person)

    // confirm drops the row, so resolving it now 404s and the page reports an invalid link.
    await registrationPage.openConfirmLink(shortId)
    await registrationPage.checkInvalidLink()
  })

  test('the phone is kept as a hint and never blocks a repeated sign up', async () => {
    const value = email('phone')

    await startSignUp(value)
    // Used to throw PhoneAlreadyExists on the person's own phone, locking the user out for good.
    await expect(anon.signUpOtp(value, firstName, lastName, phone)).resolves.toMatchObject({ sent: true })
    // The same phone on another address must not be blocked either.
    await expect(anon.signUpOtp(email('phone-other'), firstName, lastName, phone)).resolves.toMatchObject({
      sent: true
    })

    const service = await getServiceAccountClient('tool')
    const person = (await service.findPersonBySocialKey(`email:${value}`)) as PersonUuid
    const info = await service.getPersonInfo(person)

    expect(info.phoneHint).toBe(normalizedPhone)
    expect(info.socialIds.some((s) => s.type === 'phone')).toBe(false)
  })

  test('sign in and sign up never reveal whether an address is known', async () => {
    const unknown = email('never-seen')

    await expect(anon.loginOtp(unknown)).resolves.toMatchObject({ sent: true })
    const service = await getServiceAccountClient('tool')
    expect(await service.findPersonBySocialKey(`email:${unknown}`)).toBeUndefined()

    // A wrong code and an unknown address must fail the same way, or the pair of calls is an oracle.
    await expect(anon.validateOtp(unknown, '000000')).rejects.toThrow(/InvalidOtp/)
    const known = email('known')
    await startSignUp(known)
    await expect(anon.validateOtp(known, '000000')).rejects.toThrow(/InvalidOtp/)
  })

  test('the login form offers a way back when a session is already open', async ({ page }) => {
    await loginPage.goto()
    await loginPage.checkIfSignedInIsHidden()

    await loginPage.login(PlatformUser, '1234')
    await page.waitForURL((url) => url.pathname.startsWith('/login/selectWorkspace'))

    // Coming back to the login form with a live cookie used to be a dead end.
    await (await page.goto(`${PlatformURI}/login/login`))?.finished()
    await loginPage.checkIfSignedInIsShown()

    await loginPage.clickSelectWorkspace()
    await page.waitForURL((url) => url.pathname.startsWith('/login/selectWorkspace'))
    await selectWorkspacePage.checkIfWorkspaceExists('sanity-ws')
  })
})

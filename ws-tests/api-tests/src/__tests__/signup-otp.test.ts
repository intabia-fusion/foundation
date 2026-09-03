/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

import { loadServerConfig, type ServerConfig } from '@hcengineering/api-client'
import { type PersonUuid, systemAccountUuid } from '@hcengineering/core'
import { type AccountClient, getClient as getAccountClient } from '@hcengineering/account-client'
import { generateToken } from '@hcengineering/server-token'

// Sign up writes a person before the OTP code is entered; the account appears only on validateOtp or
// on the activation link. These cover the state in between.
// The code goes to a mail queue with no consumer on the stand, so the link is rebuilt with the stand
// secret instead - same trick as admin-otp.test.ts.
describe('signup-otp', () => {
  const secret = 'secret'
  const phone = '+7-900-000-00-11'
  const normalizedPhone = '+79000000011'
  const week = 7 * 24 * 60 * 60

  let config: ServerConfig
  let anon: AccountClient
  let service: AccountClient
  let runId: string

  beforeAll(async () => {
    config = await loadServerConfig('http://localhost:8083')
    anon = getAccountClient(config.ACCOUNTS_URL)
    // findPersonBySocialKey wants a service token, getPersonInfo takes admin or a service - one token for both.
    service = getAccountClient(
      config.ACCOUNTS_URL,
      generateToken(systemAccountUuid, undefined, { service: 'tool', admin: 'true' }, secret)
    )
    runId = `${Date.now()}`
  }, 30000)

  // Fresh addresses per run: a person left without an account would already have one next run.
  function email (name: string): string {
    return `signup-otp-${runId}-${name}@test.local`
  }

  function confirmToken (person: PersonUuid, value: string, expSec: number): string {
    return generateToken(person, undefined, { confirmEmail: value }, secret, {
      exp: Math.floor(Date.now() / 1000) + expSec
    })
  }

  async function personOf (value: string): Promise<PersonUuid | undefined> {
    return await service.findPersonBySocialKey(`email:${value}`)
  }

  async function accountOf (value: string): Promise<PersonUuid | undefined> {
    return await service.findPersonBySocialKey(`email:${value}`, true)
  }

  it('leaves a person without an account until the sign up is confirmed', async () => {
    const value = email('pending')

    const otp = await anon.signUpOtp(value, 'Test', 'Person', phone)
    expect(otp.sent).toBe(true)

    expect(await personOf(value)).toBeDefined()
    expect(await accountOf(value)).toBeUndefined()
  })

  it('stores the phone as a normalized hint, never as a social id', async () => {
    const value = email('phone-hint')

    await anon.signUpOtp(value, 'Test', 'Person', phone)

    const person = await personOf(value)
    expect(person).toBeDefined()

    const info = await service.getPersonInfo(person as PersonUuid)
    expect(info.phoneHint).toBe(normalizedPhone)
    expect(info.socialIds.some((s) => s.type === 'phone')).toBe(false)
  })

  it('does not block a repeated sign up with the same phone', async () => {
    const value = email('retry')

    await anon.signUpOtp(value, 'Test', 'Person', phone)
    // Used to throw PhoneAlreadyExists on the person's own phone, locking the user out for good.
    await expect(anon.signUpOtp(value, 'Test', 'Person', phone)).resolves.toMatchObject({ sent: true })

    const other = email('retry-other-email')
    await expect(anon.signUpOtp(other, 'Other', 'Person', phone)).resolves.toMatchObject({ sent: true })
  })

  it('completes the sign up through the activation link', async () => {
    const value = email('link')

    await anon.signUpOtp(value, 'Test', 'Person', phone)
    const person = await personOf(value)
    expect(await accountOf(value)).toBeUndefined()

    const client = getAccountClient(config.ACCOUNTS_URL, confirmToken(person as PersonUuid, value, week))
    const info = await client.confirm()

    expect(info.account).toBe(person)
    expect(info.token).toBeDefined()
    expect(await accountOf(value)).toBe(person)
  })

  it('burns the activation link after the first use', async () => {
    const value = email('single-use')

    await anon.signUpOtp(value, 'Test', 'Person', phone)
    const person = await personOf(value)
    const token = confirmToken(person as PersonUuid, value, week)

    await getAccountClient(config.ACCOUNTS_URL, token).confirm()
    // The email is verified now, so confirmEmail refuses it - that is what makes the link single use.
    await expect(getAccountClient(config.ACCOUNTS_URL, token).confirm()).rejects.toThrow()
  })

  it('rejects an expired activation link', async () => {
    const value = email('expired')

    await anon.signUpOtp(value, 'Test', 'Person', phone)
    const person = await personOf(value)

    const token = confirmToken(person as PersonUuid, value, -60)
    await expect(getAccountClient(config.ACCOUNTS_URL, token).confirm()).rejects.toThrow()
    expect(await accountOf(value)).toBeUndefined()
  })

  it('resends the code for an unfinished sign up from the login form', async () => {
    const value = email('login-pending')

    await anon.signUpOtp(value, 'Test', 'Person', phone)
    // Used to throw AccountNotFound: the person had no account yet, so login was a dead end.
    await expect(anon.loginOtp(value)).resolves.toMatchObject({ sent: true })
  })

  it('does not reveal whether an email is known', async () => {
    const unknown = email('never-seen')

    await expect(anon.loginOtp(unknown)).resolves.toMatchObject({ sent: true })
    expect(await personOf(unknown)).toBeUndefined()

    const existing = email('already-signed-up')
    await anon.signUpOtp(existing, 'Test', 'Person', phone)
    const person = await personOf(existing)
    await getAccountClient(config.ACCOUNTS_URL, confirmToken(person as PersonUuid, existing, week)).confirm()

    // An account exists now; sign up must answer like any other attempt instead of AccountAlreadyExists.
    await expect(anon.signUpOtp(existing, 'Test', 'Person', phone)).resolves.toMatchObject({ sent: true })
  })

  it('does not let the sign up form rename an existing account', async () => {
    const value = email('rename')

    await anon.signUpOtp(value, 'Test', 'Person', phone)
    const person = await personOf(value)
    await getAccountClient(config.ACCOUNTS_URL, confirmToken(person as PersonUuid, value, week)).confirm()

    await anon.signUpOtp(value, 'Attacker', 'Rename', '+7-999-000-11-22')

    const info = await service.getPersonInfo(person as PersonUuid)
    expect(info.name).not.toContain('Attacker')
    expect(info.phoneHint).toBe(normalizedPhone)
  })
})

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

import { expect, type Locator, type Page } from '@playwright/test'
import { CommonPage } from './common-page'
import { PlatformURI } from '../utils'

/**
 * Screens reached through the sign up activation link sent in the OTP email:
 * /login/confirm and the /login/registered page it lands on.
 */
export class RegistrationPage extends CommonPage {
  readonly page: Page

  constructor (page: Page) {
    super(page)
    this.page = page
  }

  title = (hasText: string): Locator => this.page.locator('div.title', { hasText })
  subtitle = (): Locator => this.page.locator('div.fs-title')
  buttonByLabel = (hasText: string): Locator => this.page.locator('button', { hasText })
  linkByName = (name: string): Locator => this.page.getByRole('link', { name })

  registrationCompleteTitle = (): Locator => this.title('Registration is complete')
  registrationCompleteHint = (): Locator =>
    this.page.getByText('Create your own workspace, or ask the owner of an existing one for an access link.')

  alreadyRegisteredTitle = (): Locator => this.title('You are already registered on the platform')
  invalidLinkTitle = (): Locator => this.title('This link is no longer valid')
  expiredLinkTitle = (): Locator => this.title('This invite link has expired')
  confirmationFailedTitle = (): Locator => this.title('Could not complete the registration')

  buttonCreateWorkspace = (): Locator => this.buttonByLabel('Create workspace')
  buttonContinue = (): Locator => this.buttonByLabel('Continue')
  buttonLogIn = (): Locator => this.buttonByLabel('Log In')
  linkSelectWorkspace = (): Locator => this.linkByName('Select workspace')

  // ACTIONS

  async openConfirmLink (id: string): Promise<void> {
    await (await this.page.goto(`${PlatformURI}/login/confirm?id=${id}`))?.finished()
  }

  async clickCreateWorkspace (): Promise<void> {
    await this.buttonCreateWorkspace().click()
  }

  async clickContinue (): Promise<void> {
    await this.buttonContinue().click()
  }

  // ASSERTS

  async checkRegistrationComplete (name: string): Promise<void> {
    await expect(this.registrationCompleteTitle()).toBeVisible()
    await expect(this.subtitle()).toHaveText(name)
    await expect(this.registrationCompleteHint()).toBeVisible()
    await expect(this.buttonCreateWorkspace()).toBeVisible()
  }

  async checkAlreadyRegistered (): Promise<void> {
    await expect(this.alreadyRegisteredTitle()).toBeVisible()
    await expect(this.buttonContinue()).toBeVisible()
  }

  async checkInvalidLink (): Promise<void> {
    await expect(this.invalidLinkTitle()).toBeVisible()
    await expect(this.buttonLogIn()).toBeVisible()
  }

  async checkExpiredLink (): Promise<void> {
    await expect(this.expiredLinkTitle()).toBeVisible()
    await expect(this.buttonLogIn()).toBeVisible()
  }
}

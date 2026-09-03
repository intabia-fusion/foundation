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

/**
 * The six-box code screen shown after requesting an OTP.
 * The code itself is read back from the account service, see getTestOtp in API/AccountClient.
 */
export class OtpPage extends CommonPage {
  readonly page: Page

  constructor (page: Page) {
    super(page)
    this.page = page
  }

  title = (): Locator => this.page.locator('div.title', { hasText: 'Enter code' })
  sentTo = (email: string): Locator => this.page.getByText(email)
  codeInput = (index: number): Locator => this.page.locator(`input[name="otp${index}"]`)
  linkResendCode = (): Locator => this.page.getByRole('link', { name: 'Resend code' })
  linkChangeEmail = (): Locator => this.page.getByRole('link', { name: 'Change email' })
  invalidCodeMessage = (): Locator => this.page.getByText('Invalid code')

  // ACTIONS

  async enterCode (code: string): Promise<void> {
    expect(code).toHaveLength(6)
    // The form submits itself as soon as the last box is filled.
    for (let i = 0; i < 6; i++) {
      await this.codeInput(i + 1).fill(code[i])
    }
  }

  async clickChangeEmail (): Promise<void> {
    await this.linkChangeEmail().click()
  }

  // ASSERTS

  async checkIfCodeScreenIsShown (email: string): Promise<void> {
    await expect(this.title()).toBeVisible()
    await expect(this.sentTo(email)).toBeVisible()
  }
}

import { IssuesPage } from './issues-page'
import { type Locator, expect } from '@playwright/test'

export class PublicLinkPopup extends IssuesPage {
  textPublicLink = (): Locator => this.page.locator('form[id="guest:string:PublicLink"] div.link')
  buttonRevoke = (): Locator => this.page.locator('form[id="guest:string:PublicLink"] button', { hasText: 'Revoke' })
  buttonCopy = (): Locator => this.page.locator('form[id="guest:string:PublicLink"] button', { hasText: 'Copy' })
  buttonClose = (): Locator => this.page.locator('form[id="guest:string:PublicLink"] button', { hasText: 'Close' })
  buttonOk = (): Locator => this.page.locator('div.popup button[type="submit"]', { hasText: 'Ok' })

  async getPublicLink (): Promise<string> {
    const link = await this.textPublicLink().textContent()
    expect(link).toContain('http')
    return link ?? ''
  }

  async revokePublicLink (): Promise<void> {
    await this.buttonRevoke().click()
    await this.buttonOk().click()
    // Ok closes the confirmation only once the removal round trip is done, and the link form closes
    // with it. Returning earlier lets a guest page opened right after still find the link and render
    // the issue - and the guest checks the link once at boot, so waiting there never recovers.
    await expect(this.textPublicLink()).toHaveCount(0)
  }
}

import { type Locator, type Page } from '@playwright/test'
import { CommonPage } from './common-page'

export class LeftSideMenuPage extends CommonPage {
  readonly page: Page

  constructor (page: Page) {
    super(page)
    this.page = page
  }

  buttonChunter = (): Locator => this.page.locator('button[id$="ApplicationLabelChunter"]')
  buttonContacts = (): Locator => this.page.locator('button[id$="Contacts"]')
  buttonTracker = (): Locator => this.page.locator('button[id$="TrackerApplication"]')
  buttonRecruiting = (): Locator => this.page.locator('[id="app-recruit\\:string\\:RecruitApplication"]')
  buttonNotification = (): Locator => this.page.locator('button[id$="app-notification:string:Inbox"]')
  buttonDocuments = (): Locator => this.page.locator('button[id$="document:string:DocumentApplication"]')
  buttonPlanner = (): Locator => this.page.locator('button[id$="app-time:string:Planner"]')
  profileButton = (): Locator => this.page.locator('#profile-button')
  inviteToWorkspaceButton = (): Locator => this.page.locator('button:has-text("Invite to workspace")')
  getInviteLinkButton = (): Locator => this.page.locator('button:has-text("Get invite link")')
  clickCloseOnInviteLinkButton = (): Locator => this.page.getByRole('button', { name: 'Close' })

  // Actions
  async openProfileMenu (): Promise<void> {
    await this.profileButton().click()
  }

  async inviteToWorkspace (): Promise<void> {
    await this.inviteToWorkspaceButton().click()
  }

  async getInviteLink (): Promise<void> {
    await this.getInviteLinkButton().click()
  }

  // Clicking the icon of the app that is already open toggles the navigator shut, and every
  // later lookup in it then waits out its timeout on a panel that is not there.
  private async openApp (button: Locator, alias: string): Promise<void> {
    if (new URL(this.page.url()).pathname.split('/')[3] === alias) return
    await button.click()
  }

  async clickChunter (): Promise<void> {
    await this.openApp(this.buttonChunter(), 'chunter')
  }

  async clickContacts (): Promise<void> {
    await this.openApp(this.buttonContacts(), 'contact')
  }

  async clickTracker (): Promise<void> {
    await this.openApp(this.buttonTracker(), 'tracker')
  }

  async clickNotification (): Promise<void> {
    await this.openApp(this.buttonNotification(), 'notification')
  }

  async clickDocuments (): Promise<void> {
    await this.openApp(this.buttonDocuments(), 'document')
  }

  async clickPlanner (): Promise<void> {
    await this.openApp(this.buttonPlanner(), 'time')
  }

  async clickRecruiting (): Promise<void> {
    await this.openApp(this.buttonRecruiting(), 'recruit')
  }

  async clickOnCloseInvite (): Promise<void> {
    await this.clickCloseOnInviteLinkButton().click()
  }
}

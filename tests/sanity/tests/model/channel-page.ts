import { expect, type Locator, type Page } from '@playwright/test'
import { CommonPage } from './common-page'
import { LinkedChannelTypes } from './types'
import { retry, retryIntervals } from '../retry'

export class ChannelPage extends CommonPage {
  readonly page: Page

  constructor (page: Page) {
    super(page)
    this.page = page
  }

  readonly inputMessage = (): Locator => this.page.locator('div[class~="text-editor-view"]')
  readonly buttonSendMessage = (): Locator => this.page.locator('g#Send')
  readonly textMessage = (messageText: string, strict = false): Locator =>
    strict
      ? this.page.locator('.hulyComponent .activityMessage div[data-delivered]', { hasText: messageText })
      : this.page.locator('.hulyComponent .activityMessage', { hasText: messageText })

  readonly textMessageInSidebar = (messageText: string, strict = false): Locator =>
    strict
      ? this.page.locator('#sidebar .activityMessage div[data-delivered]', { hasText: messageText })
      : this.page.locator('#sidebar .activityMessage', { hasText: messageText })

  readonly channelName = (channel: string): Locator =>
    this.page.locator('[data-testid="section-chunter:class:Channel"]').getByRole('button', { name: channel })

  readonly browserTab = (): Locator => this.page.getByRole('link', { name: 'Browser' }).getByRole('button')
  readonly channelsAndDmsTab = (): Locator =>
    this.page.getByRole('link', { name: 'Channels & DMs' }).getByRole('button')

  readonly channelsTab = (): Locator =>
    this.page.locator('label.switcher-element__wrapper[data-view="chunter:string:Channels"]')

  readonly channelTable = (): Locator => this.page.getByRole('table')
  readonly channel = (channel: string): Locator => this.page.getByRole('button', { name: channel })
  readonly channelNameOnDetail = (channel: string): Locator =>
    this.page
      .locator('span.labelOnPanel', { hasText: 'Name' })
      .locator('xpath=following-sibling::div[1]')
      .locator('button', { hasText: channel })

  readonly chooseChannel = (channel: string): Locator =>
    this.page.locator('div.antiPanel-navigator').getByRole('button', { name: channel })

  readonly closePopupWindow = (): Locator => this.page.locator('.notifyPopup button[data-id="btnNotifyClose"]')
  readonly openAddMemberToChannel = (userName: string): Locator => this.page.getByRole('button', { name: userName })
  readonly addMemberToChannelTableButton = (userName: string): Locator =>
    this.page.locator('.antiTable-body__row').getByText(userName)

  readonly addMemberToChannelButton = (userName: string): Locator => this.page.getByText(userName)
  readonly joinChannelButton = (): Locator => this.page.getByRole('button', { name: 'Join' })
  readonly selectEmoji = (emoji: string): Locator => this.page.getByText(emoji)

  // Action popup exists in DOM for every message and is only visible while that message is hovered,
  // so it must be scoped to the message instead of picked globally.
  readonly messageActionButton = (message: string, dataIdSelector: string): Locator =>
    this.textMessage(message).last().locator(`.activityMessage-actionPopup > button[${dataIdSelector}]`)

  readonly messageSaveMarker = (): Locator => this.page.locator('.saveMarker')
  readonly saveMessageTab = (): Locator => this.page.getByRole('button', { name: 'Saved' })
  readonly pinnedMessageButton = (): Locator => this.page.getByRole('button', { name: 'pinned' })
  readonly pinnedMessage = (message: string): Locator => this.page.locator('.antiPopup').getByText(message)
  readonly closeReplyButton = (): Locator => this.page.locator('.hulyHeader-container > button.iconOnly')
  readonly openReplyMessage = (): Locator => this.page.getByText('1 reply Last reply less than')
  readonly editMessageButton = (): Locator => this.page.getByRole('button', { name: 'Edit' })
  readonly copyLinkButton = (): Locator => this.page.getByRole('button', { name: 'Copy link' })
  readonly deleteMessageButton = (): Locator => this.page.getByRole('button', { name: 'Delete' })
  readonly updateButton = (): Locator => this.page.getByRole('button', { name: 'Update' })
  readonly openChannelDetails = (): Locator => this.page.getByTestId('aside-toggle')
  readonly changeChannelNameConfirm = (): Locator => this.page.locator('.selectPopup button')
  readonly privateOrPublicChangeButton = (change: string, autoJoin: boolean): Locator =>
    this.page
      .locator('span.labelOnPanel', { hasText: autoJoin ? 'Auto join' : 'Private' })
      .locator('xpath=following-sibling::div[1]')
      .locator('button', { hasText: change })

  readonly privateOrPublicPopupButton = (change: string): Locator =>
    this.page.locator('div.popup div.menu-item', { hasText: change })

  readonly userAdded = (user: string): Locator => this.page.locator('.members').getByText(user)
  private readonly addMemberPreview = (): Locator => this.page.getByRole('button', { name: 'Add members' })
  private readonly addButtonPreview = (): Locator => this.page.getByRole('button', { name: 'Add', exact: true })

  readonly inputSearchChannel = (): Locator => this.page.locator('.hulyHeader-container').getByPlaceholder('Search')

  readonly channelContainers = (): Locator => this.page.locator('.hulyNavItem-container')

  readonly starredChannelContainers = (): Locator =>
    this.page.locator('#navGroup-starred').locator('.hulyNavItem-container')

  readonly issueChannelContainers = (): Locator =>
    this.page.locator('#navGroup-tracker\\:class\\:Issue').locator('.hulyNavItem-container')

  readonly vacancyChannelContainers = (): Locator =>
    this.page.locator('#navGroup-recruit\\:class\\:Vacancy').locator('.hulyNavItem-container')

  readonly applicationChannelContainers = (): Locator =>
    this.page.locator('#navGroup-recruit\\:class\\:Applicant').locator('.hulyNavItem-container')

  async sendMessage (message: string): Promise<void> {
    await this.inputMessage().fill(message)
    await this.buttonSendMessage().click()
  }

  async sendMention (message: string, categoryName?: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      try {
        await this.inputMessage().fill(`@${message}`)
        // Wait for mention popup to appear with a 5-second timeout
        // If it times out, close the popup and retry
        await this.selectMentionWithTimeout(message, categoryName, 5000)
        break
      } catch (error: any) {
        if (i === 2) {
          throw error
        }
        // Close the mention popup by pressing Escape if it's stuck
        await this.page.keyboard.press('Escape')
        // Wait for popup to close
        await this.page.waitForSelector('form.mentionPoup', { state: 'detached', timeout: 5000 }).catch(() => {})
        // Clear the input and try again
        await this.inputMessage().fill('')
        // Wait for input to be cleared
        await expect(this.inputMessage().locator('div.tiptap'))
          .toHaveText('', { timeout: 5000 })
          .catch(() => {})
      }
    }

    await this.buttonSendMessage().click()
  }

  async selectMentionWithTimeout (
    mentionName: string,
    categoryName: string | undefined,
    timeoutMs: number
  ): Promise<void> {
    const mentionLocator = this.mentionPopupListItem(mentionName, categoryName).first()
    // Wait for the mention popup item to be visible with retry
    // Using longer intervals since the popup may need time to load data
    await expect(async () => {
      await expect(mentionLocator).toBeVisible({ timeout: 3000 })
    }).toPass({ intervals: retryIntervals, timeout: timeoutMs })
    await mentionLocator.click()
  }

  async clickOnOpenChannelDetails (): Promise<void> {
    await this.openChannelDetails().click()
  }

  async clickChannel (channel: string): Promise<void> {
    await this.channelName(channel).click()
  }

  async changeChannelName (channel: string): Promise<void> {
    await this.channelNameOnDetail(channel).click()
    await this.page.keyboard.type('New Channel Name')
    await this.changeChannelNameConfirm().click()
  }

  async changeChannelPrivacyOrAutoJoin (
    change: string,
    YesNo: string,
    changed: string,
    autoJoin: boolean = false
  ): Promise<void> {
    // The new value lands through a server round trip that can lose the race with the panel
    // re-render, leaving the old one on the button. Picking the same value again is idempotent.
    await retry(async () => {
      if (await this.privateOrPublicChangeButton(changed, autoJoin).isVisible()) return
      await this.privateOrPublicChangeButton(change, autoJoin).click({ timeout: 5000 })
      await expect(this.privateOrPublicPopupButton(YesNo)).toBeVisible({ timeout: 5000 })
      await this.privateOrPublicPopupButton(YesNo).click()
      await expect(this.privateOrPublicChangeButton(changed, autoJoin)).toBeVisible({ timeout: 5000 })
    })
  }

  async clickDeleteMessageButton (): Promise<void> {
    await this.deleteMessageButton().click()
  }

  async clickDeleteMessageConfirmationButton (): Promise<void> {
    await this.deleteMessageButton().click()
  }

  async clickSaveMessageTab (): Promise<void> {
    await this.saveMessageTab().click()
  }

  async addMemberToChannelPreview (user: string): Promise<void> {
    await this.addMemberPreview().click()
    const popup = this.page.locator('.hulyModal-container')
    const item = popup.getByText(user)
    // A member who joined the workspace moments ago can be missing from the list the popup
    // loaded: reopen it so the query is re-issued instead of waiting an empty list out.
    await expect(async () => {
      if ((await item.count()) === 0) {
        await this.page.keyboard.press('Escape')
        await this.addMemberPreview().click()
      }
      await expect(item).toBeVisible({ timeout: 5000 })
    }).toPass({ intervals: retryIntervals, timeout: 30000 })
    await item.click()
    await this.addButtonPreview().click()
    await expect(this.userAdded(user)).toBeVisible()
  }

  async checkIfUserIsAdded (user: string, added: boolean): Promise<void> {
    if (added) {
      await expect(this.userAdded(user)).toBeHidden()
    } else {
      await expect(this.userAdded(user)).toBeVisible()
    }
  }

  async clickOpenMoreButton (message: string): Promise<void> {
    await this.clickMessageAction(message, 'data-id="btnMoreActions"')
  }

  // The action popup lives only while the message is hovered, and a re-render drops it.
  // last(): dozens of specs send 'Test message' here, and the newest is the one just sent.
  private async clickMessageAction (message: string, dataIdSelector: string): Promise<void> {
    const button = this.messageActionButton(message, dataIdSelector)
    await retry(async () => {
      await this.textMessage(message).last().hover()
      await expect(button).toBeVisible({ timeout: 2000 })
      await button.click({ timeout: 5000 })
    })
  }

  async clickEditMessageButton (editedMessage: string): Promise<void> {
    await this.editMessageButton().click()
    // Best effort - the result is swallowed and typing works without focus landing here, so a
    // long timeout only buys waiting.
    await expect(this.inputMessage().locator('div.tiptap'))
      .toBeFocused({ timeout: 1500 })
      .catch(() => {})
    await this.page.keyboard.type(editedMessage)
  }

  async clickCopyLinkButton (): Promise<void> {
    await this.copyLinkButton().click()
  }

  async clickOnUpdateButton (): Promise<void> {
    await this.updateButton().click()
  }

  async getClipboardCopyMessage (): Promise<string> {
    return await this.page.evaluate(async () => {
      return await navigator.clipboard.readText()
    })
  }

  async checkIfMessageIsCopied (message: string): Promise<void> {
    expect(await this.getClipboardCopyMessage()).toContain(message)
  }

  async clickChooseChannel (channel: string): Promise<void> {
    // The navigator re-renders while a chat is being added, and the click then waits out the test
    // on an element that has already been detached.
    await retry(async () => {
      await expect(this.chooseChannel(channel)).toBeVisible({ timeout: 5000 })
      await this.chooseChannel(channel).click({ timeout: 5000 })
    })
  }

  async addEmoji (textMessage: string, emoji: string): Promise<void> {
    await this.clickMessageAction(textMessage, 'data-id$="AddReactionAction"')
    await this.selectEmoji(emoji).click()
  }

  async saveMessage (message: string): Promise<void> {
    await this.clickMessageAction(message, 'data-id$="SaveForLaterAction"')
    await expect(this.messageSaveMarker()).toBeVisible()
  }

  async pinMessage (message: string): Promise<void> {
    await this.clickMessageAction(message, 'data-id$="PinMessageAction"')
    await this.pinnedMessageButton().click()
    await expect(this.pinnedMessage(message)).toBeVisible()
  }

  async replyMessage (message: string): Promise<void> {
    await this.clickMessageAction(message, 'data-id="activity:action:Reply"')
  }

  async sendReply (messageReply: string): Promise<void> {
    // First click on the sidebar input to ensure it's focused
    await this.page.locator('#sidebar div.text-editor-view').click()
    await this.page.keyboard.type(messageReply)
    await this.page.keyboard.press('Enter')
    // Wait for the message to appear in sidebar with retry
    await expect(async () => {
      await expect(this.textMessageInSidebar(messageReply, true)).toBeVisible({ timeout: 5000 })
    }).toPass({ intervals: retryIntervals, timeout: 15000 })
  }

  async closeAndOpenReplyMessage (): Promise<void> {
    await this.closeReplyButton().click()
    await this.openReplyMessage().click()
  }

  async clickChannelTab (): Promise<void> {
    await this.channelsAndDmsTab().click()
    await this.channelsTab().click()
  }

  async clickOnClosePopupButton (): Promise<void> {
    await this.closePopupWindow().click()
  }

  async clickOnUser (user: string): Promise<void> {
    await this.addMemberToChannelTableButton(user).click()
  }

  async addMemberToChannel (user: string): Promise<void> {
    await this.openAddMemberToChannel(user).click()
  }

  async clickJoinChannelButton (): Promise<void> {
    await this.joinChannelButton().click()
  }

  async getChannelsGroupLocatorByType (channelType: LinkedChannelTypes, channelName: string): Promise<Locator> {
    const mapTypesToLocator = {
      [LinkedChannelTypes.Issue]: this.issueChannelContainers(),
      [LinkedChannelTypes.Vacancy]: this.vacancyChannelContainers(),
      [LinkedChannelTypes.Application]: this.applicationChannelContainers()
    } as const

    const groupLocator: Locator = mapTypesToLocator[channelType] ?? this.issueChannelContainers()
    return groupLocator.filter({ has: this.page.locator(`span:has-text("${channelName}")`) })
  }

  async checkIfChannelDefaultExist (shouldExist: boolean, channel: string): Promise<void> {
    if (shouldExist) {
      await expect(this.channelName(channel)).toBeVisible()
    } else {
      await expect(this.channelName(channel)).toBeHidden()
    }
  }

  async checkIfChannelTableExist (channel: string, publicChannel: boolean): Promise<void> {
    if (publicChannel) {
      await expect(this.channelTable()).toBeVisible()
      await expect(this.channelTable()).toContainText(channel)
    } else {
      await expect(this.channelTable()).not.toContainText(channel)
    }
  }

  async checkIfMessageExist (messageExists: boolean, messageText: string): Promise<void> {
    if (messageExists) {
      await expect(this.textMessage(messageText)).toBeVisible()
    } else {
      await expect(this.textMessage(messageText)).toBeHidden()
    }
  }

  async checkMessageExist (message: string, messageExists: boolean, messageText: string): Promise<void> {
    if (messageExists) {
      await expect(this.textMessage(messageText, true)).toBeVisible()
    } else {
      await expect(this.textMessage(messageText)).toBeHidden()
    }
  }

  async checkIfMessageExistInSidebar (messageExists: boolean, messageText: string): Promise<void> {
    if (messageExists) {
      await expect(this.textMessageInSidebar(messageText, true)).toBeVisible()
    } else {
      await expect(this.textMessageInSidebar(messageText)).toBeHidden()
    }
  }

  async checkIfEmojiIsAdded (emoji: string): Promise<void> {
    await expect(this.selectEmoji(emoji + ' 1')).toBeVisible()
  }

  async checkIfNameIsChanged (channel: string): Promise<void> {
    await expect(this.channelContainers().filter({ hasText: channel })).toBeVisible()
    await expect(this.buttonBreadcrumb(channel)).toBeVisible()
  }

  async makeActionWithChannelInMenu (channelName: string, action: string): Promise<void> {
    await this.openNavigator()
    await this.channelContainers().filter({ hasText: channelName }).hover()
    await this.channelContainers().filter({ hasText: channelName }).locator('.hulyNavItem-actions').click()
    await this.selectFromDropdown(this.page, action)
  }

  async openChannelSubmenuInMenu (channelName: string, action: string): Promise<void> {
    await this.openNavigator()
    await this.channelContainers().filter({ hasText: channelName }).hover()
    await this.channelContainers().filter({ hasText: channelName }).locator('.hulyNavItem-actions').click()
    await this.openSubmenu(action)
  }

  async checkChannelStarred (shouldExist: boolean, channelName: string): Promise<void> {
    if (shouldExist) {
      await expect(this.starredChannelContainers().filter({ hasText: channelName })).toHaveCount(1)
    } else {
      await expect(this.starredChannelContainers().filter({ hasText: channelName })).toHaveCount(0)
    }
  }

  async searchChannel (channelName: string): Promise<void> {
    await this.inputSearchIcon().click()
    await this.inputSearchChannel().fill(channelName)
  }

  async checkLinkedChannelIsExist (channelName: string, linkedChannelType: LinkedChannelTypes): Promise<void> {
    await expect(await this.getChannelsGroupLocatorByType(linkedChannelType, channelName)).toHaveCount(1)
  }

  async openLinkedChannelIsExist (channelName: string, linkedChannelType: LinkedChannelTypes): Promise<void> {
    await (await this.getChannelsGroupLocatorByType(linkedChannelType, channelName)).click()
  }
}

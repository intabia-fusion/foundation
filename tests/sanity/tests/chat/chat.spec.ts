import { expect, test } from '../fixtures'
import { ApiEndpoint } from '../API/Api'
import { ChannelPage } from '../model/channel-page'
import { ChunterPage } from '../model/chunter-page'
import { SignUpData } from '../model/common-types'
import { LeftSideMenuPage } from '../model/left-side-menu-page'
import { SidebarPage } from '../model/sidebar-page'
import {
  createAccountAndWorkspace,
  generateTestData,
  getInviteLink,
  generateUser,
  createAccount,
  getSecondPageByInvite
} from '../utils'

test.describe.configure({ mode: 'parallel' })

test.describe('Channel tests', () => {
  let leftSideMenuPage: LeftSideMenuPage
  let chunterPage: ChunterPage
  let channelPage: ChannelPage
  let sidebarPage: SidebarPage
  let api: ApiEndpoint
  let newUser2: SignUpData
  let data: { workspaceName: string, userName: string, firstName: string, lastName: string, channelName: string }

  test.beforeEach(async ({ page, request }) => {
    data = generateTestData()
    newUser2 = generateUser()

    leftSideMenuPage = new LeftSideMenuPage(page)
    chunterPage = new ChunterPage(page)
    channelPage = new ChannelPage(page)
    sidebarPage = new SidebarPage(page)
    api = new ApiEndpoint(request)
    // Straight into the workspace from the account token: the login form plus the workspace picker
    // are three page loads and cost about a second per test.
    await createAccountAndWorkspace(page, request, data, 'chunter')
  })

  test('Create new private channel and check if the messages stays on it', async ({ browser, page }) => {
    await chunterPage.clickAddChannel()
    await chunterPage.createChannel(data.channelName, true)
    await channelPage.checkIfChannelDefaultExist(true, data.channelName)
    await channelPage.sendMessage('Test message')
    await channelPage.checkMessageExist('Test message', true, 'Test message')
    await channelPage.clickChannel('general')
    await channelPage.checkMessageExist('Test message', false, 'Test message')
    await channelPage.clickChannel(data.channelName)
    await channelPage.checkMessageExist('Test message', true, 'Test message')
    await page.reload()
    await channelPage.checkMessageExist('Test message', true, 'Test message')
  })

  test('Create new public channel and check if the messages stays on it', async ({ browser, page }) => {
    await chunterPage.clickAddChannel()
    await chunterPage.createChannel(data.channelName, false)
    await channelPage.checkIfChannelDefaultExist(true, data.channelName)
    await channelPage.sendMessage('Test message')
    await channelPage.checkMessageExist('Test message', true, 'Test message')
    await channelPage.clickChannel('general')
    await channelPage.checkMessageExist('Test message', false, 'Test message')
    await channelPage.clickChannel(data.channelName)
    await channelPage.checkMessageExist('Test message', true, 'Test message')
    await page.reload()
    await channelPage.checkMessageExist('Test message', true, 'Test message')
  })

  test('Create new private channel tests and check if the new user have access to it', async ({ browser, page }) => {
    await chunterPage.clickAddChannel()
    await chunterPage.createChannel(data.channelName, true)
    await channelPage.checkIfChannelDefaultExist(true, data.channelName)
    await channelPage.sendMessage('Test message')
    await channelPage.checkMessageExist('Test message', true, 'Test message')

    const linkText = await getInviteLink(page)
    await api.createAccount(newUser2.email, newUser2.password, newUser2.firstName, newUser2.lastName)
    using _page2 = await getSecondPageByInvite(browser, linkText, newUser2)
    const page2 = _page2.page

    const leftSideMenuPageSecond = new LeftSideMenuPage(page2)
    const channelPageSecond = new ChannelPage(page2)

    await leftSideMenuPageSecond.clickChunter()
    await channelPageSecond.checkIfChannelDefaultExist(false, data.channelName)
    await channelPageSecond.clickChannelTab()
    await channelPageSecond.checkIfChannelTableExist(data.channelName, false)
  })

  test('Create new public channel tests and check if the new user have access to it by default', async ({
    browser,
    page
  }) => {
    await chunterPage.clickAddChannel()
    await chunterPage.createChannel(data.channelName, false)
    await channelPage.checkIfChannelDefaultExist(true, data.channelName)
    await channelPage.sendMessage('Test message')
    await channelPage.checkMessageExist('Test message', true, 'Test message')

    const linkText = await getInviteLink(page)
    await api.createAccount(newUser2.email, newUser2.password, newUser2.firstName, newUser2.lastName)
    using _page2 = await getSecondPageByInvite(browser, linkText, newUser2)
    const page2 = _page2.page

    const leftSideMenuPageSecond = new LeftSideMenuPage(page2)
    const channelPageSecond = new ChannelPage(page2)
    await leftSideMenuPageSecond.clickChunter()
    await channelPageSecond.checkIfChannelDefaultExist(false, data.channelName)
    await channelPageSecond.clickChannelTab()
    await channelPageSecond.checkIfChannelTableExist(data.channelName, true)
  })

  test('Create new private channel and test if the user can exchange the messages', async ({ browser, page }) => {
    await chunterPage.clickAddChannel()
    await chunterPage.createChannel(data.channelName, false)
    await channelPage.checkIfChannelDefaultExist(true, data.channelName)
    await channelPage.sendMessage('Test message')
    await channelPage.checkMessageExist('Test message', true, 'Test message')

    const linkText = await getInviteLink(page)
    await api.createAccount(newUser2.email, newUser2.password, newUser2.firstName, newUser2.lastName)
    using _page2 = await getSecondPageByInvite(browser, linkText, newUser2)
    const page2 = _page2.page

    const leftSideMenuPageSecond = new LeftSideMenuPage(page2)
    const channelPageSecond = new ChannelPage(page2)

    await leftSideMenuPageSecond.clickChunter()
    await channelPageSecond.checkIfChannelDefaultExist(false, data.channelName)
    await channelPageSecond.clickChannelTab()
    await channelPageSecond.checkIfChannelTableExist(data.channelName, true)
    await channelPageSecond.clickJoinChannelButton()
    await channelPageSecond.clickChooseChannel(data.channelName)
    const checkJoinButton = await page2.locator('button[data-id="btnJoin"]').isVisible({ timeout: 1500 })
    if (checkJoinButton) await page2.locator('button[data-id="btnJoin"]').click()
    await channelPageSecond.checkMessageExist('Test message', true, 'Test message')
    await channelPageSecond.sendMessage('My dream is to fly')
    await channelPageSecond.checkMessageExist('My dream is to fly', true, 'My dream is to fly')
    await channelPage.checkMessageExist('My dream is to fly', true, 'My dream is to fly')
  })

  test('Create new private channel add user to it', async ({ browser, page }) => {
    await chunterPage.clickAddChannel()
    await chunterPage.createChannel(data.channelName, true)
    await channelPage.checkIfChannelDefaultExist(true, data.channelName)
    await channelPage.sendMessage('Test message')
    await channelPage.checkMessageExist('Test message', true, 'Test message')

    const linkText = await getInviteLink(page)
    await api.createAccount(newUser2.email, newUser2.password, newUser2.firstName, newUser2.lastName)
    using _page2 = await getSecondPageByInvite(browser, linkText, newUser2)
    const page2 = _page2.page

    const leftSideMenuPageSecond = new LeftSideMenuPage(page2)
    const channelPageSecond = new ChannelPage(page2)

    await leftSideMenuPageSecond.clickChunter()
    await channelPage.clickChannelTab()
    await channelPage.clickOnUser(data.lastName + ' ' + data.firstName)
    await channelPage.addMemberToChannel(newUser2.lastName + ' ' + newUser2.firstName)
    await channelPage.pressEscape()
    await channelPageSecond.checkIfChannelDefaultExist(true, data.channelName)
    await channelPageSecond.clickChannelTab()
    await channelPageSecond.checkIfChannelTableExist(data.channelName, true)
    await channelPageSecond.clickChooseChannel(data.channelName)
    await channelPageSecond.checkMessageExist('Test message', true, 'Test message')
    await channelPageSecond.sendMessage('One two')
    await channelPageSecond.checkMessageExist('One two', true, 'One two')
    await channelPage.clickChooseChannel(data.channelName)
    await channelPage.checkMessageExist('One two', true, 'One two')
  })

  test('Go to general channel add user to it', async ({ browser, page }) => {
    await channelPage.clickChannel('general')

    await channelPage.sendMessage('Test message')
    await channelPage.checkMessageExist('Test message', true, 'Test message')

    const linkText = await getInviteLink(page)
    await api.createAccount(newUser2.email, newUser2.password, newUser2.firstName, newUser2.lastName)
    using _page2 = await getSecondPageByInvite(browser, linkText, newUser2)
    const page2 = _page2.page

    const leftSideMenuPageSecond = new LeftSideMenuPage(page2)
    const channelPageSecond = new ChannelPage(page2)

    await leftSideMenuPageSecond.clickChunter()
    await channelPageSecond.clickChannel('general')
    await channelPageSecond.checkMessageExist('Test message', true, 'Test message')
    await channelPageSecond.sendMessage('One two')
    await channelPageSecond.checkMessageExist('One two', true, 'One two')
    await channelPage.clickChannel('random')
    await channelPage.clickChannel('general')
    await channelPage.checkMessageExist('One two', true, 'One two')
  })

  test('Go to random channel add user to it', async ({ browser, page }) => {
    await channelPage.clickChannel('random')

    await channelPage.sendMessage('Test message')
    await channelPage.checkMessageExist('Test message', true, 'Test message')

    const linkText = await getInviteLink(page)
    await api.createAccount(newUser2.email, newUser2.password, newUser2.firstName, newUser2.lastName)
    using _page2 = await getSecondPageByInvite(browser, linkText, newUser2)
    const page2 = _page2.page

    const leftSideMenuPageSecond = new LeftSideMenuPage(page2)
    const channelPageSecond = new ChannelPage(page2)

    await leftSideMenuPageSecond.clickChunter()
    await channelPageSecond.clickChannel('random')
    await channelPageSecond.checkMessageExist('Test message', true, 'Test message')
    await channelPageSecond.sendMessage('One two')
    await channelPageSecond.checkMessageExist('One two', true, 'One two')
    await channelPage.clickChannel('general')
    await channelPage.clickChannel('random')
    await channelPage.checkMessageExist('One two', true, 'One two')
  })

  test('Check if user can add emoji', async () => {
    await channelPage.clickChannel('random')
    await channelPage.sendMessage('Test message')
    await channelPage.checkMessageExist('Test message', true, 'Test message')
    await channelPage.addEmoji('Test message', '😤')
    await channelPage.checkIfEmojiIsAdded('😤')
  })

  test('Check if user can save message', async () => {
    await channelPage.clickChannel('random')
    await channelPage.sendMessage('Test message')
    await channelPage.saveMessage('Test message')
    await channelPage.sendMessage('Test message')
    await channelPage.clickSaveMessageTab()
    await channelPage.checkIfMessageExist(true, 'Test message')
  })

  test('Check if user can reply message', async () => {
    await channelPage.clickChannel('random')
    await channelPage.sendMessage('Test message')
    await channelPage.replyMessage('Test message')
    await sidebarPage.checkIfSidebarIsOpen(true)
    await sidebarPage.checkIfSidebarHasVerticalTab(true, 'random')
    await sidebarPage.checkIfChatSidebarTabIsOpen(true, 'Thread')
    await sidebarPage.checkIfChatSidebarTabIsOpen(true, 'random')
    await channelPage.sendReply('Reply message')
    await channelPage.checkIfMessageExistInSidebar(true, 'Reply message')
    await channelPage.closeAndOpenReplyMessage()
    await channelPage.checkIfMessageExistInSidebar(true, 'Reply message')
  })

  test('Check if user can edit message', async ({ page }) => {
    await channelPage.clickChannel('random')
    await channelPage.sendMessage('Test message')
    await channelPage.clickOpenMoreButton('Test message')
    await channelPage.clickEditMessageButton(' edited message')
    await page.keyboard.press('Enter')
    await channelPage.checkIfMessageExist(true, 'Test message edited message')
    await channelPage.clickOpenMoreButton('Test message edited message')
    await channelPage.clickEditMessageButton(' 1')
    await channelPage.clickOnUpdateButton()
    await channelPage.checkIfMessageExist(true, 'Test message edited message 1')
  })

  test('Check if user can copy message', async ({ page }) => {
    const baseURL = process.env.PLATFORM_URI ?? 'http://localhost:8083'
    await leftSideMenuPage.clickChunter()
    await channelPage.clickChannel('random')
    // Take the workspace segment from the URL: when the generated name is already taken the
    // account service appends a suffix, and the workspace url stops matching its name.
    const workspaceUrl = new URL(page.url()).pathname.split('/')[2]
    const expectedUrl = `${baseURL}/workbench/${workspaceUrl}/chunter/chunter%3Aspace%3ARandom%7Cchunter%3Aclass%3AChannel?message=`
    await channelPage.sendMessage('Test message')
    await channelPage.clickOpenMoreButton('Test message')
    await channelPage.clickCopyLinkButton()
    const clipboardContent = await page.evaluate(async () => {
      return await navigator.clipboard.readText()
    })
    expect(clipboardContent).toContain(expectedUrl)
  })

  test('Check if user can delete messages', async ({ page }) => {
    await channelPage.clickChannel('random')
    await channelPage.sendMessage('Test message')
    await channelPage.clickOpenMoreButton('Test message')
    await channelPage.clickDeleteMessageButton()
    await channelPage.clickDeleteMessageConfirmationButton()
    await channelPage.checkIfMessageExist(false, 'Test message')
  })

  test('Check if user can change the name of chat', async ({ browser, page }) => {
    await chunterPage.clickAddChannel()
    await chunterPage.createChannel(data.channelName, false)
    await channelPage.checkIfChannelDefaultExist(true, data.channelName)
    await channelPage.clickOnOpenChannelDetails()
    await channelPage.changeChannelName(data.channelName)
    await channelPage.checkIfNameIsChanged('New Channel Name')
  })

  test('Check if user can switch to private or public', async ({ browser, page }) => {
    await chunterPage.clickAddChannel()
    await chunterPage.createChannel(data.channelName, false)
    await channelPage.checkIfChannelDefaultExist(true, data.channelName)
    await channelPage.clickOnOpenChannelDetails()
    await channelPage.changeChannelPrivacyOrAutoJoin('No', 'Yes', 'Yes')
    await channelPage.changeChannelPrivacyOrAutoJoin('Yes', 'No', 'No')
  })

  test('Check if user can switch auto join', async ({ browser, page }) => {
    await chunterPage.clickAddChannel()
    await chunterPage.createChannel(data.channelName, false)
    await channelPage.checkIfChannelDefaultExist(true, data.channelName)
    await channelPage.clickOnOpenChannelDetails()
    await channelPage.changeChannelPrivacyOrAutoJoin('N/A', 'Yes', 'Yes', true)
  })

  test('Check if the user can be added through preview tab', async ({ browser, page }) => {
    const linkText = await getInviteLink(page)
    await api.createAccount(newUser2.email, newUser2.password, newUser2.firstName, newUser2.lastName)
    using _page2 = await getSecondPageByInvite(browser, linkText, newUser2)
    const page2 = _page2.page

    const leftSideMenuPageSecond = new LeftSideMenuPage(page2)
    const channelPageSecond = new ChannelPage(page2)

    await leftSideMenuPageSecond.clickChunter()
    await channelPageSecond.clickChannel('general')
    await channelPageSecond.clickOnOpenChannelDetails()
    await channelPageSecond.checkIfUserIsAdded(data.lastName + ' ' + data.firstName, false)
  })

  test('Check if we can create new public channel tests and check if the new user have can be added through preview', async ({
    browser,
    page
  }) => {
    await chunterPage.clickAddChannel()
    await chunterPage.createChannel(data.channelName, false)
    await channelPage.checkIfChannelDefaultExist(true, data.channelName)

    const linkText = await getInviteLink(page)
    await api.createAccount(newUser2.email, newUser2.password, newUser2.firstName, newUser2.lastName)
    using _page2 = await getSecondPageByInvite(browser, linkText, newUser2)
    const page2 = _page2.page
    const leftSideMenuPageSecond = new LeftSideMenuPage(page2)
    await leftSideMenuPageSecond.clickChunter()

    await channelPage.clickChannel('general')
    await channelPage.clickChannel(data.channelName)
    await channelPage.clickOnOpenChannelDetails()
    await channelPage.addMemberToChannelPreview(newUser2.lastName + ' ' + newUser2.firstName)
  })

  test('Checking backlinks in the Chat', async ({ browser, page, request }) => {
    await createAccount(request, newUser2)
    const linkText = await getInviteLink(page)
    using _page2 = await getSecondPageByInvite(browser, linkText, newUser2)
    const page2 = _page2.page

    const leftSideMenuPageSecond = new LeftSideMenuPage(page2)
    const channelPageSecond = new ChannelPage(page2)
    await leftSideMenuPageSecond.clickChunter()

    await leftSideMenuPage.clickChunter()
    await channelPage.clickChannel('general')
    const mentionName = `${newUser2.lastName} ${newUser2.firstName}`
    await channelPage.sendMention(mentionName, 'EMPLOYEES')
    await channelPage.checkMessageExist(`@${mentionName}`, true, `@${mentionName}`)

    await channelPageSecond.clickChannel('general')
    await channelPageSecond.checkMessageExist(`@${mentionName}`, true, `@${mentionName}`)
  })

  test('User is able to star and unstar a channel', async () => {
    await test.step('Prepare channel', async () => {
      await chunterPage.clickAddChannel()
      await chunterPage.createChannel(data.channelName, false)
      await channelPage.checkIfChannelDefaultExist(true, data.channelName)
    })

    await test.step('Star channel', async () => {
      await channelPage.makeActionWithChannelInMenu(data.channelName, 'Star')
      await channelPage.checkChannelStarred(true, data.channelName)
      await channelPage.checkIfChannelDefaultExist(false, data.channelName)
    })

    await test.step('Unstar channel', async () => {
      await channelPage.makeActionWithChannelInMenu(data.channelName, 'Unstar')
      await channelPage.checkChannelStarred(false, data.channelName)
      await channelPage.checkIfChannelDefaultExist(true, data.channelName)
    })
  })

  test('User is able to change channel icon via context menu', async ({ page }) => {
    const emoji = '😤'
    await test.step('Prepare channel', async () => {
      await chunterPage.clickAddChannel()
      await chunterPage.createChannel(data.channelName, false)
      await channelPage.checkIfChannelDefaultExist(true, data.channelName)
    })

    await test.step('Change icon from submenu', async () => {
      await channelPage.openChannelSubmenuInMenu(data.channelName, 'Change icon')
      await channelPage.selectEmoji(emoji).click()
      // Submenu popup must not reopen after selection
      await page.waitForTimeout(500)
      await expect(page.locator('div.popup')).toHaveCount(0)
      await expect(channelPage.channelContainers().filter({ hasText: data.channelName }).getByText(emoji)).toBeVisible()
    })
  })

  test('User is able to leave and join a channel', async () => {
    await test.step('Prepare channel', async () => {
      await chunterPage.clickAddChannel()
      await chunterPage.createChannel(data.channelName, false)
      await channelPage.checkIfChannelDefaultExist(true, data.channelName)

      await channelPage.clickChooseChannel(data.channelName)
      await channelPage.sendMessage('Test message')
      await channelPage.checkMessageExist('Test message', true, 'Test message')
    })

    await test.step('Leave channel #1', async () => {
      await channelPage.makeActionWithChannelInMenu(data.channelName, 'Leave channel')
    })

    await test.step('Join channel from channels page', async () => {
      await channelPage.checkIfChannelDefaultExist(false, data.channelName)
      await channelPage.clickChannelTab()
      await channelPage.checkIfChannelTableExist(data.channelName, true)
      await channelPage.clickJoinChannelButton()
      await channelPage.checkIfChannelDefaultExist(true, data.channelName)
      await channelPage.clickChooseChannel(data.channelName)
      await channelPage.checkMessageExist('Test message', true, 'Test message')
    })

    await test.step('Open another channel and check that joined channel is visible', async () => {
      await channelPage.clickChooseChannel('random')
      await channelPage.checkIfChannelDefaultExist(true, data.channelName)
    })
  })

  test('User is able to filter channels in table', async () => {
    await test.step('Prepare channel', async () => {
      await chunterPage.clickAddChannel()
      await chunterPage.createChannel(data.channelName, false)
      await channelPage.checkIfChannelDefaultExist(true, data.channelName)
      await channelPage.clickChannelTab()
    })

    await test.step('Test filtering by name', async () => {
      await channelPage.selectFilter('Name', data.channelName)
      await channelPage.checkFilter('Name', 'contains', data.channelName)
      await channelPage.checkIfChannelTableExist(data.channelName, true)
      await channelPage.checkIfChannelTableExist('general', false)
    })

    await test.step('Clear Filters', async () => {
      await channelPage.buttonClearFilters().click()
      await channelPage.checkIfChannelTableExist('general', true)
    })
  })

  test('User is able to search channel in table', async () => {
    await test.step('Prepare channel', async () => {
      await chunterPage.clickAddChannel()
      await chunterPage.createChannel(data.channelName, false)
      await channelPage.checkIfChannelDefaultExist(true, data.channelName)
      await channelPage.clickChannelTab()
    })

    await test.step('Search channel by fillName and find channel', async () => {
      await channelPage.searchChannel(data.channelName)
      await channelPage.page.keyboard.press('Enter')
      await channelPage.checkIfChannelTableExist(data.channelName, true)
      await channelPage.checkIfChannelTableExist('general', false)
    })

    await test.step('Clear search and show all channels', async () => {
      await channelPage.searchChannel('')
      await channelPage.page.keyboard.press('Enter')
      await channelPage.checkIfChannelTableExist(data.channelName, true)
      await channelPage.checkIfChannelTableExist('general', true)
    })
  })

  test('User is able to work with a channel in a sidebar', async () => {
    await test.step('Prepare channel', async () => {
      await chunterPage.clickAddChannel()
      await chunterPage.createChannel(data.channelName, false)
      await channelPage.checkIfChannelDefaultExist(true, data.channelName)
      await channelPage.clickChooseChannel(data.channelName)
      await channelPage.sendMessage('Test message')
    })

    await test.step('Open channel in sidebar', async () => {
      await sidebarPage.checkIfSidebarPageButtonIsExist(false, 'chat')
      await channelPage.makeActionWithChannelInMenu(data.channelName, 'Open in sidebar')

      await sidebarPage.checkIfSidebarPageButtonIsExist(true, 'chat')
      await sidebarPage.checkIfSidebarHasVerticalTab(true, data.channelName)
      await sidebarPage.checkIfSidebarIsOpen(true)
      await sidebarPage.checkIfChatSidebarTabIsOpen(true, data.channelName)
    })

    await test.step('Go to another page and check if sidebar will be keeping', async () => {
      await leftSideMenuPage.clickTracker()
      await sidebarPage.checkIfSidebarIsOpen(true)
      await sidebarPage.checkIfChatSidebarTabIsOpen(true, data.channelName)
      await leftSideMenuPage.clickChunter()
    })

    await test.step('Close channel in sidebar', async () => {
      await sidebarPage.closeOpenedVerticalTab()
      await sidebarPage.checkIfSidebarHasVerticalTab(false, data.channelName)
      await sidebarPage.checkIfSidebarIsOpen(false)
    })

    await test.step('Reopen channel in sidebar', async () => {
      await channelPage.makeActionWithChannelInMenu(data.channelName, 'Open in sidebar')
      await sidebarPage.checkIfSidebarHasVerticalTab(true, data.channelName)
      await sidebarPage.checkIfChatSidebarTabIsOpen(true, data.channelName)
    })

    await test.step('Open general in sidebar - it replaces the preview tab', async () => {
      await sidebarPage.checkIfVerticalTabIsPreview(true, data.channelName)
      await channelPage.makeActionWithChannelInMenu('general', 'Open in sidebar')
      await sidebarPage.checkNumberOfVerticalTabs(1)
      await sidebarPage.checkIfSidebarHasVerticalTab(false, data.channelName)
      await sidebarPage.checkIfSidebarHasVerticalTab(true, 'general')
      await sidebarPage.checkIfChatSidebarTabIsOpen(true, 'general')
    })

    await test.step('Pinned tab survives when another channel is opened', async () => {
      await sidebarPage.pinVerticalTab('general')
      await sidebarPage.checkIfVerticalTabIsPinned(true, 'general')

      await channelPage.makeActionWithChannelInMenu(data.channelName, 'Open in sidebar')
      await sidebarPage.checkNumberOfVerticalTabs(2)
      await sidebarPage.checkIfSidebarHasVerticalTab(true, 'general')
      await sidebarPage.checkIfSidebarHasVerticalTab(true, data.channelName)
      await sidebarPage.checkIfChatSidebarTabIsOpen(true, data.channelName)
    })

    await test.step('Reopening a channel focuses the existing tab instead of duplicating it', async () => {
      await channelPage.makeActionWithChannelInMenu('general', 'Open in sidebar')
      await sidebarPage.checkNumberOfVerticalTabs(2)
      await sidebarPage.checkIfChatSidebarTabIsOpen(true, 'general')
    })

    await test.step('Unpinning leaves the tab kept, not preview', async () => {
      await sidebarPage.unpinVerticalTab('general')
      await sidebarPage.checkIfVerticalTabIsPinned(false, 'general')
      await sidebarPage.checkIfVerticalTabIsPreview(false, 'general')

      // Only the preview tab is replaced - the kept one survives.
      await channelPage.makeActionWithChannelInMenu('random', 'Open in sidebar')
      await sidebarPage.checkNumberOfVerticalTabs(2)
      await sidebarPage.checkIfSidebarHasVerticalTab(true, 'general')
      await sidebarPage.checkIfSidebarHasVerticalTab(true, 'random')
      await sidebarPage.checkIfSidebarHasVerticalTab(false, data.channelName)
      await sidebarPage.checkIfVerticalTabIsPreview(true, 'random')
    })

    await test.step('Double click promotes a preview tab so it is no longer replaced', async () => {
      await sidebarPage.doubleClickVerticalTab('random')
      await sidebarPage.checkIfVerticalTabIsPreview(false, 'random')

      await channelPage.makeActionWithChannelInMenu(data.channelName, 'Open in sidebar')
      await sidebarPage.checkNumberOfVerticalTabs(3)
      await sidebarPage.checkIfSidebarHasVerticalTab(true, 'general')
      await sidebarPage.checkIfSidebarHasVerticalTab(true, 'random')
      await sidebarPage.checkIfSidebarHasVerticalTab(true, data.channelName)
    })

    await test.step('Close sidebar tab by close button in vertical tab', async () => {
      await sidebarPage.clickVerticalTab(data.channelName)
      await sidebarPage.closeVerticalTabByCloseButton(data.channelName)
      await sidebarPage.checkIfSidebarHasVerticalTab(false, data.channelName)
    })

    await test.step('Close sidebar tab by context menu', async () => {
      await sidebarPage.closeVerticalTabByRightClick('random')
      await sidebarPage.checkIfSidebarHasVerticalTab(false, 'random')
      await sidebarPage.closeVerticalTabByRightClick('general')
      await sidebarPage.checkIfSidebarHasVerticalTab(false, 'general')
    })

    await test.step('Sidebar is closed when the last channel tab is gone', async () => {
      await sidebarPage.checkIfSidebarIsOpen(false)
      await sidebarPage.checkIfSidebarPageButtonIsExist(false, 'chat')
    })
  })

  test('User is able to create thread automatically in Sidebar', async ({ page }) => {
    await test.step('Prepare channel', async () => {
      await chunterPage.clickAddChannel()
      await chunterPage.createChannel(data.channelName, false)
      await channelPage.checkIfChannelDefaultExist(true, data.channelName)
      await channelPage.clickChooseChannel(data.channelName)
      await channelPage.sendMessage('Test message')
      await channelPage.sendMessage('Second message')
    })

    await test.step('Open channel in Sidebar', async () => {
      await channelPage.replyMessage('Test message')
      await sidebarPage.checkIfSidebarIsOpen(true)
      await sidebarPage.checkIfSidebarHasVerticalTab(true, data.channelName)
      await sidebarPage.checkIfChatSidebarTabIsOpen(true, 'Thread')
      await sidebarPage.checkIfChatSidebarTabIsOpen(true, data.channelName)
      await channelPage.sendReply('Reply message')
    })

    await test.step('Another thread replaces the unpinned thread tab', async () => {
      await channelPage.replyMessage('Second message')
      await sidebarPage.checkNumberOfVerticalTabs(1)
      await sidebarPage.checkIfChatSidebarTabIsOpen(true, 'Thread')
    })

    await test.step('User goes to another chat and the thread stays in the Sidebar', async () => {
      await channelPage.openNavigator()
      await channelPage.clickChannel('random')
      await sidebarPage.checkIfSidebarIsOpen(true)
      await sidebarPage.checkNumberOfVerticalTabs(1)
      await sidebarPage.checkIfChatSidebarTabIsOpen(true, 'Thread')
    })

    await test.step('User switches to another app and the thread stays in the Sidebar', async () => {
      await leftSideMenuPage.clickTracker()
      await sidebarPage.checkIfSidebarIsOpen(true)
      await sidebarPage.checkNumberOfVerticalTabs(1)
      await sidebarPage.checkIfChatSidebarTabIsOpen(true, 'Thread')
    })
  })
})

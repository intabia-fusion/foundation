import { expect, test } from '../fixtures'
import { openBotDirect } from '../API/AiBot'
import { ChannelPage } from '../model/channel-page'
import { ChunterPage } from '../model/chunter-page'
import { LeftSideMenuPage } from '../model/left-side-menu-page'
import { createAccountAndWorkspace, generateTestData } from '../utils'

// Tool scenarios on the `low` level: the prompt scripts the call (`call:<tool> {json}`), so the
// same tool runs with the same arguments every time.

test.describe.configure({ mode: 'parallel' })

test.describe('ai-bot tool calls', () => {
  let leftSideMenuPage: LeftSideMenuPage
  let chunterPage: ChunterPage
  let channelPage: ChannelPage
  let data: { workspaceName: string, userName: string, firstName: string, lastName: string, channelName: string }

  test.beforeEach(async ({ page, request }) => {
    data = generateTestData()
    leftSideMenuPage = new LeftSideMenuPage(page)
    chunterPage = new ChunterPage(page)
    channelPage = new ChannelPage(page)
    // Straight into the workspace from the account token: the login form plus the workspace
    // picker are three page loads and cost about a second per test.
    await createAccountAndWorkspace(page, request, data)
  })

  test('propose_task posts a task proposal card', async ({ page }) => {
    await openBotDirect(leftSideMenuPage, chunterPage, channelPage)

    const title = `Buy coffee ${Date.now()}`
    await channelPage.sendMessage(
      `оформи задачу\ncall:propose_task {"title":"${title}","description":"beans and filters"}`
    )

    const card = page
      .locator('.hulyComponent .activityMessage')
      .filter({ has: page.locator('[data-id="aiTaskProposal"]') })
    await expect(card).toBeVisible({ timeout: 60000 })
    // The title lands in an editable field, so it is the input value and not the card's text.
    await expect(card.locator('input').first()).toHaveValue(title, { timeout: 10000 })
    // Nothing is created until the user presses the button.
    await expect(card.getByRole('button', { name: 'Create task' })).toBeVisible()
  })

  test('propose_task with subtasks lists them on the card', async ({ page }) => {
    await openBotDirect(leftSideMenuPage, chunterPage, channelPage)

    await channelPage.sendMessage(
      'разбей на подзадачи\ncall:propose_task {"title":"Release checklist","subtasks":[{"title":"Write notes"},' +
        '{"title":"Tag the build"}]}'
    )

    const card = page
      .locator('.hulyComponent .activityMessage')
      .filter({ has: page.locator('[data-id="aiTaskProposal"]') })
    await expect(card).toBeVisible({ timeout: 60000 })
    await expect(card).toContainText('Write notes', { timeout: 10000 })
    await expect(card).toContainText('Tag the build')
  })

  test('an unknown tool leaves the bot answering instead of failing', async ({ page }) => {
    await openBotDirect(leftSideMenuPage, chunterPage, channelPage)

    await channelPage.sendMessage('call:no_such_tool {}')

    // The sent message repeats the tool name, so match the reply by what only it can contain.
    const reply = page.locator('.hulyComponent .activityMessage', { hasText: 'does not exist' })
    await expect(reply).toBeVisible({ timeout: 60000 })
    await expect(reply).toContainText('no_such_tool')
  })
})

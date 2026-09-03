import { expect, test } from '../fixtures'
import { ApiEndpoint } from '../API/Api'
import { openBotDirect, setWorkspaceAiLevel } from '../API/AiBot'
import { ChannelPage } from '../model/channel-page'
import { ChunterPage } from '../model/chunter-page'
import { LeftSideMenuPage } from '../model/left-side-menu-page'
import { LoginPage } from '../model/login-page'
import { SelectWorkspacePage } from '../model/select-workspace-page'
import { PlatformURI, generateTestData } from '../utils'

// Real-LLM suite (@llm): the `middle` level is served by the aibot_client_llm worker against a
// local model on the host. Run via `rushx run-uitests`; setup in tests/readme.md.

test.describe.configure({ mode: 'serial' })

test.describe('ai-bot with a real local model @llm', () => {
  let leftSideMenuPage: LeftSideMenuPage
  let chunterPage: ChunterPage
  let channelPage: ChannelPage
  let loginPage: LoginPage
  let api: ApiEndpoint
  let data: { workspaceName: string, userName: string, firstName: string, lastName: string, channelName: string }

  // A real model is far slower than the mock.
  const REPLY_TIMEOUT = 180000

  // Own messages are activity messages too — exclude what we sent to isolate bot replies.
  function botReplies (page: import('@playwright/test').Page, sent: string[]): import('@playwright/test').Locator {
    let loc = page.locator('.hulyComponent .activityMessage')
    for (const s of sent) {
      loc = loc.filter({ hasNotText: s })
    }
    return loc
  }

  test.beforeEach(async ({ page, request }) => {
    data = generateTestData()
    leftSideMenuPage = new LeftSideMenuPage(page)
    chunterPage = new ChunterPage(page)
    channelPage = new ChannelPage(page)
    loginPage = new LoginPage(page)
    api = new ApiEndpoint(request)
    await api.createAccount(data.userName, '1234', data.firstName, data.lastName)
    const wsInfo = await api.createWorkspaceWithLogin(data.workspaceName, data.userName, '1234')
    // `middle` is the clisr-backed level; the mock serves `low`.
    await setWorkspaceAiLevel(wsInfo.workspace, 'middle')

    await (await page.goto(`${PlatformURI}`))?.finished()
    await loginPage.login(data.userName, '1234')
    const swp = new SelectWorkspacePage(page)
    await swp.selectWorkspace(data.workspaceName)

    await openBotDirect(leftSideMenuPage, chunterPage, channelPage)
  })

  test('answers a factual question', async ({ page }) => {
    const question = 'Сколько будет два плюс два? Ответь только числом.'
    await channelPage.sendMessage(question)
    await expect(
      botReplies(page, [question])
        .filter({ hasText: /4|четыре|four/i })
        .first()
    ).toBeVisible({
      timeout: REPLY_TIMEOUT
    })
  })

  test('keeps context across turns', async ({ page }) => {
    const first = 'Запомни: моё любимое число — 17. Просто подтверди.'
    await channelPage.sendMessage(first)
    await expect(botReplies(page, [first]).first()).toBeVisible({ timeout: REPLY_TIMEOUT })

    const second = 'Какое моё любимое число? Ответь только числом.'
    await channelPage.sendMessage(second)
    // The answer must come from the earlier turn, so the thread context reached the model.
    await expect(botReplies(page, [first, second]).filter({ hasText: /17/ }).last()).toBeVisible({
      timeout: REPLY_TIMEOUT
    })
  })
})

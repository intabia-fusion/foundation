import { expect, test } from '../fixtures'
import { openBotDirect } from '../API/AiBot'
import { ApiEndpoint } from '../API/Api'
import { setWorkspacePlanByUuid } from '../API/Billing'
import { ChannelPage } from '../model/channel-page'
import { ChunterPage } from '../model/chunter-page'
import { LeftSideMenuPage } from '../model/left-side-menu-page'
import { LoginPage } from '../model/login-page'
import { SelectWorkspacePage } from '../model/select-workspace-page'
import { PlatformURI, generateTestData } from '../utils'
import { waitStable, retryIntervals } from '../retry'

// Base ai-bot suite on the `low` level: mock provider in echo mode (tests/config-aibot.yaml)
// replies with the received context as markdown, so we assert what actually reached the model.

test.describe.configure({ mode: 'parallel' })

test.describe('ai-bot direct chat', () => {
  let leftSideMenuPage: LeftSideMenuPage
  let chunterPage: ChunterPage
  let channelPage: ChannelPage
  let loginPage: LoginPage
  let api: ApiEndpoint
  let data: { workspaceName: string, userName: string, firstName: string, lastName: string, channelName: string }
  let wsInfo: Awaited<ReturnType<ApiEndpoint['createWorkspaceWithLogin']>>

  test.beforeEach(async ({ page, request }) => {
    data = generateTestData()
    leftSideMenuPage = new LeftSideMenuPage(page)
    chunterPage = new ChunterPage(page)
    channelPage = new ChannelPage(page)
    loginPage = new LoginPage(page)
    api = new ApiEndpoint(request)
    await api.createAccount(data.userName, '1234', data.firstName, data.lastName)
    wsInfo = await api.createWorkspaceWithLogin(data.workspaceName, data.userName, '1234')
    await (await page.goto(`${PlatformURI}`))?.finished()
    await loginPage.login(data.userName, '1234')
    const swp = new SelectWorkspacePage(page)
    await swp.selectWorkspace(data.workspaceName)
  })

  test('bot replies and echoes the prompt back', async ({ page }) => {
    await openBotDirect(leftSideMenuPage, chunterPage, channelPage)

    const question = 'какая сегодня погода'
    await channelPage.sendMessage(question)

    const reply = page.locator('.hulyComponent .activityMessage', { hasText: 'echo' })
    await expect(reply).toBeVisible({ timeout: 60000 })
    await expect(reply).toContainText('prompt')
    await expect(reply).toContainText(question)
  })

  test('bot answers once and does not reply to itself', async ({ page }) => {
    await openBotDirect(leftSideMenuPage, chunterPage, channelPage)

    await channelPage.sendMessage('один вопрос')

    const messages = page.locator('.hulyComponent .activityMessage')
    const echo = page.locator('.hulyComponent .activityMessage', { hasText: 'echo' })
    // The bot's own message lands in the same direct, so a missing self-filter turns one question
    // into an endless exchange - it would echo its own reply.
    await expect(echo).toHaveCount(1, { timeout: 60000 })
    // The welcome the bot posts on member join arrives asynchronously, so the total is not a fixed
    // number. Wait for the count to stop moving instead of sleeping out the slowest case.
    const settled = await waitStable(async () => await messages.count(), { stableFor: 5000 })
    expect(await messages.count()).toBe(settled)
    await expect(echo).toHaveCount(1)
  })

  test('direct context carries previous messages', async ({ page }) => {
    await openBotDirect(leftSideMenuPage, chunterPage, channelPage)

    await channelPage.sendMessage('первое сообщение')
    await expect(page.locator('.hulyComponent .activityMessage', { hasText: 'echo' }).first()).toBeVisible({
      timeout: 60000
    })

    await channelPage.sendMessage('второе сообщение')
    // The second dump must list the first turn in its history section.
    await expect(async () => {
      const last = page.locator('.hulyComponent .activityMessage', { hasText: 'history' }).last()
      await expect(last).toContainText('первое сообщение', { timeout: 5000 })
    }).toPass({ intervals: retryIntervals, timeout: 60000 })
  })

  test('tool definitions reach the model', async ({ page }) => {
    await openBotDirect(leftSideMenuPage, chunterPage, channelPage)

    await channelPage.sendMessage('привет')
    const reply = page.locator('.hulyComponent .activityMessage', { hasText: 'echo' })
    await expect(reply).toBeVisible({ timeout: 60000 })
    // Without tool definitions tool calling silently degrades, so assert they are passed.
    await expect(reply).toContainText('tools')
  })

  test('monthly token window limit blocks the bot with a limit message', async ({ page }) => {
    // Tiny monthly window: first request (used 0 < 1) proceeds and bills, next one is blocked.
    await setWorkspacePlanByUuid(wsInfo.workspace, 'business', { windowMonth: 1, status: 'active', users: 10 })
    await openBotDirect(leftSideMenuPage, chunterPage, channelPage)

    await test.step('First request goes through', async () => {
      await channelPage.sendMessage('hello')
      await expect(page.locator('.hulyComponent .activityMessage', { hasText: 'echo' }).first()).toBeVisible({
        timeout: 60000
      })
    })

    // Usage propagates through the billing queue, so keep sending until the block appears.
    await test.step('Next request is blocked with the monthly limit message', async () => {
      // aibot AI_DEFAULT_LANGUAGE defaults to 'ru', so the block message is Russian.
      const blockText = 'Закончились токены ИИ'
      await expect(async () => {
        await channelPage.sendMessage('ping again')
        await expect(page.locator('.hulyComponent .activityMessage', { hasText: blockText })).toBeVisible({
          timeout: 10000
        })
      }).toPass({ intervals: retryIntervals, timeout: 120000 })
    })
  })
})

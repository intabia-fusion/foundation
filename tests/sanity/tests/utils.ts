import type { WorkspaceLoginInfo } from '@hcengineering/account'
import { faker } from '@faker-js/faker'
import { APIRequestContext, Browser, BrowserContext, Locator, Page, expect, test } from '@playwright/test'
import { attachment } from 'allure-js-commons'
import path from 'path'
import { ApiEndpoint } from './API/Api'
import { TestData } from './chat/types'
import { SignUpData } from './model/common-types'
import { LeftSideMenuPage } from './model/left-side-menu-page'
import { LoginPage } from './model/login-page'
import { SelectWorkspacePage } from './model/select-workspace-page'
import { SignInJoinPage } from './model/signin-page'
import { waitStable } from './retry'

export const PlatformURI = process.env.PLATFORM_URI as string
export const PlatformTransactor = process.env.PLATFORM_TRANSACTOR as string
export const PlatformUser = process.env.PLATFORM_USER as string
export const PlatformUserSecond = process.env.PLATFORM_USER_SECOND as string
export const PlatformUserThird = process.env.PLATFORM_USER_THIRD as string
export const PlatformAdmin = process.env.PLATFORM_ADMIN as string
export const PlatformWs = process.env.PLATFORM_WS as string
export const PlatformSetting = process.env.SETTING as string
export const PlatformSettingSecond = process.env.SETTING_SECOND as string
export const PlatformSettingThird = process.env.SETTING_THIRD as string
export const PlatformWorkspaceRegion = process.env.WORKSPACE_REGION as string

export const DefaultWorkspace = 'sanity-ws'
export const LocalUrl = process.env.LOCAL_URL as string
export const DevUrl = process.env.DEV_URL as string
export const StagingUrl = process.env.STAGING_URL as string

export function generateTestData (): TestData {
  const generateWordStartingWithA = (): string => {
    // faker's word list contains one-letter words, and a channel named "A" matches every
    // getByRole({ name }) lookup in the navigator - keep the name long enough to be unique.
    const randomWord = faker.lorem.word({ length: { min: 5, max: 10 } })
    return 'A' + randomWord.slice(1)
  }

  return {
    workspaceName: faker.lorem.word(),
    userName: faker.internet.userName(),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    channelName: generateWordStartingWithA()
  }
}

export function getTimeForPlanner (plusHours: number = 0, cropHours: number = 0): string {
  let hour = new Date().getHours()
  hour = hour < 1 + cropHours ? 1 + cropHours : hour >= 22 - cropHours ? 22 - cropHours : hour
  hour += plusHours
  const ampm = hour < 12 || hour === 24 ? 'am' : 'pm'
  hour -= hour > 12 ? 12 : 0

  return `${hour}${ampm}`
}

export function getNextHourTimeForPlanner (): string {
  let hour = new Date().getHours() + 1
  const ampm = hour < 13 ? 'am' : 'pm'
  hour = hour < 1 ? 1 : hour >= 11 && hour < 13 ? 11 : hour >= 22 ? 10 : hour > 12 ? hour - 12 : hour

  return `${hour}${ampm}`
}

// Consistent data
export const workspaceName = faker.lorem.word()
export const userName = faker.internet.userName()
export const firstName = faker.person.firstName()
export const lastName = faker.person.lastName()
export const channelName = faker.lorem.word()
export const email = faker.internet.email()

function toHex (value: number, chars: number): string {
  const result = value.toString(16)
  if (result.length < chars) {
    return '0'.repeat(chars - result.length) + result
  }
  return result
}

let counter = 0
const random = toHex((Math.random() * (1 << 24)) | 0, 6) + toHex((Math.random() * (1 << 16)) | 0, 4)

function timestamp (): string {
  const time = (Date.now() / 1000) | 0
  return toHex(time, 8)
}

function count (): string {
  const val = counter++ & 0xffffff
  return toHex(val, 6)
}

export async function setTestOptions (page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem('#platform.notification.timeout', '0')
    localStorage.setItem('#platform.testing.enabled', 'true')
    localStorage.setItem('#platform.lazy.loading', 'false')
  })
}

/**
 * @public
 * @returns
 */
export function generateId (len = 100): string {
  const v = timestamp() + random
  let s = v.length - len
  if (s < 0) {
    s = 0
  }
  const r = v.slice(s, v.length) + count()
  return r
}

/**
 * Finds a search field on the page, fills it with
 * the provided string, and returns a locator
 *
 * @export
 * @param {Page} page
 * @param {string} search
 * @returns {Promise<Locator>}
 */
export async function fillSearch (page: Page, search: string): Promise<Locator> {
  await page.locator('.searchInput-wrapper').click()
  const searchBox = page.locator('input[placeholder="Search"]')

  await searchBox.fill(search)
  await searchBox.press('Enter')

  return searchBox
}

export async function getSecondPage (browser: Browser): Promise<{ page: Page, context: BrowserContext } & Disposable> {
  const userSecondContext = await browser.newContext({ storageState: PlatformSettingSecond })
  const newPage = await userSecondContext.newPage()
  return {
    page: newPage,
    context: userSecondContext,
    [Symbol.dispose]: () => {
      void newPage
        .close()
        .finally(() => {
          void userSecondContext.close().catch(() => {})
        })
        .catch(() => {})
    }
  }
}

export async function getSecondPageByInvite (
  browser: Browser,
  linkText: string | null,
  newUser: SignUpData
): Promise<{ page: Page, context: BrowserContext } & Disposable> {
  const userSecondContext = await browser.newContext({ storageState: PlatformSettingSecond })
  const newPage = await userSecondContext.newPage()
  await newPage.goto(linkText ?? '')
  const joinPage: SignInJoinPage = new SignInJoinPage(newPage)
  await joinPage.join(newUser)

  return {
    page: newPage,
    context: userSecondContext,
    [Symbol.dispose]: () => {
      void newPage
        .close()
        .finally(() => {
          void userSecondContext.close().catch(() => {})
        })
        .catch(() => {})
    }
  }
}

export function expectToContainsOrdered (val: Locator, text: string[], timeout?: number): Promise<void> {
  const origIssuesExp = new RegExp('.*' + text.join('.*') + '.*')
  return expect(val).toHaveText(origIssuesExp, { timeout })
}

/**
 * Walks matched elements. Pass `limit` where the check is per-element and the list grows with the
 * data other tests leave behind - otherwise the test slows down as the stand fills up.
 */
export async function * iterateLocator (locator: Locator, limit?: number): AsyncGenerator<Locator> {
  // count() never waits: read right after a filter is applied it still sees the pre-filter rows,
  // and every nth() yielded then points at a row that is about to be replaced.
  const total = await waitStable(async () => await locator.count(), { stableFor: 500, interval: 100, timeout: 15000 })
  const max = limit !== undefined ? Math.min(limit, total) : total
  for (let index = 0; index < max; index++) {
    yield locator.nth(index)
  }
}

export async function attachScreenshot (name: string, page: Page): Promise<void> {
  await attachment(name, await page.screenshot(), {
    contentType: 'image/png'
  })
  await page.screenshot({ path: `screenshots/${name}` })
}

export async function checkIfUrlContains (page: Page, url: string): Promise<void> {
  expect(page.url()).toContain(url)
}

export async function waitForNetworIdle (page: Page, timeout = 2000): Promise<void> {
  await Promise.race([page.waitForLoadState('networkidle'), new Promise((resolve) => setTimeout(resolve, timeout))])
}

// Check for text in the page
export const checkTextChunksVisibility = async (page: Page, textChunks: string[]): Promise<void> => {
  for (const textChunk of textChunks) {
    await expect(page.locator(`text=${textChunk}`)).toBeVisible()
  }
}

/**
 * Resolves the file path for a given file name located in the same directory as the test.
 *
 * @param fileName - name of the file to be resolved
 * @returns - resolved file path
 */

function resolveFilePath (fileName: string): string {
  return path.resolve(__dirname, '.', 'files', fileName)
}

/**
 * Uploads a single file using a file chooser in Playwright.
 *
 * @param page - Playwright Page object
 * @param fileName - name of the file to be uploaded
 * @param fileUploadTestId - test ID of the file input element (default: '@upload-file')
 */
export async function uploadFile (page: Page, fileName: string, fileUploadTestId = 'Attached photo'): Promise<void> {
  const uploadFileElement = page.getByText(fileUploadTestId)

  const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), uploadFileElement.click()])

  // Resolve the file path using the 'resolveFilePath' function
  const filePath = resolveFilePath(fileName)
  await fileChooser.setFiles(filePath)

  // Replace with a more reliable condition for determining when the upload is complete, if possible.
  await page.waitForTimeout(2000)
}

export async function getInviteLink (page: Page): Promise<string | null> {
  const leftSideMenuPage = new LeftSideMenuPage(page)
  // Settle the initial render, or a navigate closes the popup mid-flight. Bounded and optional:
  // a freshly created workspace has no nav panel, and the toPass loop below retries anyway.
  await leftSideMenuPage
    .appHeader()
    .waitFor({ state: 'visible', timeout: 5000 })
    .catch(() => {})
  const linkLocator = page.locator('.antiPopup .link')
  // Redo the whole chain on retry: when a click lands on a popup that is still mounting, no link is
  // ever generated and re-checking its visibility alone can only wait the timeout out.
  let linkText: string | null = null
  await expect(async () => {
    if ((await linkLocator.count()) === 0) {
      await page.keyboard.press('Escape')
      await leftSideMenuPage.openProfileMenu()
      await leftSideMenuPage.inviteToWorkspace()
      await leftSideMenuPage.getInviteLink()
    }
    await expect(linkLocator).toBeVisible({ timeout: 5000 })
    // Read it here: the popup can close between the check and the read, and an unbounded
    // textContent() then waits out the whole test timeout instead of redoing the chain.
    linkText = await linkLocator.textContent({ timeout: 5000 })
  }).toPass({ intervals: [200, 500, 1000], timeout: 20000 })
  expect(linkText).not.toBeNull()
  // Escape instead of the Close button: with a document open behind, its floating editor toolbar
  // overlays the button and swallows the click.
  await page.keyboard.press('Escape')
  await expect(linkLocator).toHaveCount(0)
  return linkText
}

export function generateUser (): SignUpData {
  return {
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    email: faker.internet.email(),
    password: '1234'
  }
}

export async function createAccount (request: APIRequestContext, data: SignUpData): Promise<void> {
  const api: ApiEndpoint = new ApiEndpoint(request)
  await api.createAccount(data.email, data.password, data.firstName, data.lastName)
}

export async function reLogin (page: Page, data: TestData): Promise<void> {
  const loginPage: LoginPage = new LoginPage(page)
  await (await page.goto(`${PlatformURI}/login/login`))?.finished()
  await loginPage.login(data.userName, '1234')
  const swp = new SelectWorkspacePage(page)
  await swp.selectWorkspace(data.workspaceName)
}

/**
 * Opens the workspace straight from an account token instead of walking the login form and the
 * workspace picker. The client restores the session itself: with LastAccount set and the account
 * cookie present it fetches the token via getAccount() on first load, so one navigation replaces
 * three page loads.
 */
// Pushes the analytics batch out before a context closes - tests are shorter than the 10s ping
// tick and the 5s batch timer, so without this most ws traffic is never reported.
export async function flushTelemetry (page: Page): Promise<void> {
  // The flush is a round trip to the collector per context - CLIENT_TELEMETRY=0 measures its cost.
  if (process.env.CLIENT_TELEMETRY === '0') return
  try {
    await page.evaluate(async () => {
      await (window as any).__analyticsFlush?.()
    })
  } catch {
    // Page already gone, or an older bundle without the hook.
  }
}

export async function loginByToken (
  page: Page,
  accountToken: string,
  ws: WorkspaceLoginInfo,
  app?: string
): Promise<void> {
  await page.context().addCookies([{ name: 'account-metadata-Token', value: accountToken, url: PlatformURI }])
  await page.context().addInitScript(
    ([account, endpoint]) => {
      localStorage.setItem('login:metadata:LastAccount', account)
      localStorage.setItem('login:metadata:LoginAccount', account)
      localStorage.setItem('login:metadata:LoginEndpoint', endpoint)
      // Without this notifications stay up for their default 10s and cover the sidebar, so the
      // next click on it waits the toast out.
      localStorage.setItem('#platform.notification.timeout', '0')
    },
    [ws.account, ws.endpoint]
  )
  // Landing straight on the app costs the same as the bare workbench url and saves the ~900ms
  // the left-menu click spends loading the same chunk afterwards.
  await (
    await page.goto(`${PlatformURI}/workbench/${ws.workspaceUrl}${app !== undefined ? `/${app}` : ''}`)
  )?.finished()
}

export async function createAccountAndWorkspace (
  page: Page,
  request: APIRequestContext,
  data: TestData,
  app?: string
): Promise<void> {
  const api: ApiEndpoint = new ApiEndpoint(request)
  // Two steps, not one: the per-test setup is a quarter of the Platform lane, and without the split
  // the step report cannot say whether that is the account service or the client booting a new
  // workspace.
  const { ws, token } = await test.step('setup: account and workspace', async () => {
    await api.createAccount(data.userName, '1234', data.firstName, data.lastName)
    const created = await api.createWorkspaceWithLogin(data.workspaceName, data.userName, '1234')
    // The login has to come after the workspace: a token issued before it does not carry the new
    // membership, and the browser lands in a workspace it is not a member of.
    return { ws: created, token: await api.loginAndGetToken(data.userName, '1234') }
  })
  await test.step('setup: open the workspace', async () => {
    await loginByToken(page, token, ws, app)
  })
}

export const convertDate = (date: Date): { day: string, month: string, year: string } => {
  return {
    day: date.getDate().toString(),
    month: (date.getMonth() + 1).toString(),
    year: date.getFullYear().toString()
  }
}

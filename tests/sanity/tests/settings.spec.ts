import { test } from './fixtures'
import { PlatformSetting, PlatformURI, generateId } from './utils'
import { UserProfilePage } from './model/profile/user-profile-page'
import { TemplatePage } from './model/tracker/templates-page'
import { SettingsPage } from './model/settings-page'
import { IssuesPage } from './model/tracker/issues-page'

test.use({
  storageState: PlatformSetting
})
test.describe('settings tests', () => {
  let userProfilePage: UserProfilePage
  let templatePage: TemplatePage
  let settingsPage: SettingsPage
  const platformUri = `${PlatformURI}/workbench/sanity-ws`
  const expectedProfileUrl = `${PlatformURI}/workbench/sanity-ws/setting/profile`

  test.beforeEach(async ({ page }) => {
    userProfilePage = new UserProfilePage(page)
    templatePage = new TemplatePage(page)
    settingsPage = new SettingsPage(page)
    await (await page.goto(`${PlatformURI}/workbench/sanity-ws`))?.finished()
  })

  test('update-profile', async () => {
    await userProfilePage.gotoProfile(platformUri)
    await userProfilePage.openProfileMenu()
    await userProfilePage.selectProfileByName('Appleseed John')
    await userProfilePage.verifyProfilePageUrl(expectedProfileUrl)
    await userProfilePage.updateLocation('LoPlaza')
    await userProfilePage.addOrEditPhone()
    await userProfilePage.applyChanges()
  })

  test('create-template', async () => {
    await templatePage.navigateToWorkspace(platformUri)
    await templatePage.openProfileMenu()
    await templatePage.openSettings()
    await templatePage.goToNotifications()
    await templatePage.selectTextTemplates()
    await templatePage.createTemplate('t1', 'some text value')
    await templatePage.editTemplate('some more2 value')
  })

  test('add-task-types', async () => {
    const spaceName = `TT-${generateId(4)}`
    await settingsPage.navigateToWorkspace(platformUri)
    await settingsPage.openProfileMenu()
    await settingsPage.openSettings()
    await settingsPage.createSpaceType(spaceName, 'Tracker')
    await settingsPage.selectSpaceType(spaceName, 'Tracker')
    await settingsPage.addTaskType('Issue')
    await settingsPage.checkTaskType('Issue')
    await settingsPage.openTaskType('Issue')
    await settingsPage.checkOpened(spaceName, 'Issue')
  })

  test('customize-task-types', async ({ page }) => {
    // The test edits the shared 'Default' space type, and its statuses live on the space type,
    // not on the task type. A fixed new name collides with the one a previous run left behind:
    // the rename then merges into that status and the state keeps its old name.
    const suffix = generateId(4)
    const taskTypeName = `Bug-${suffix}`
    const attentionState = `Needs Attention ${suffix}`
    const reviewState = `Under Review ${suffix}`
    await settingsPage.navigateToWorkspace(platformUri)
    await settingsPage.openProfileMenu()
    await settingsPage.openSettings()
    await settingsPage.selectSpaceType('Default', 'Tracker')
    await settingsPage.addTaskType(taskTypeName)
    await settingsPage.checkTaskType(taskTypeName)
    await settingsPage.openTaskType(taskTypeName)
    await settingsPage.checkOpened('Default', taskTypeName)
    await settingsPage.changeIcon()
    await settingsPage.checkState('Todo')
    await settingsPage.changeState('Todo', attentionState, 'Firework')
    await settingsPage.checkState(attentionState)
    await settingsPage.checkState('In Progress')
    await settingsPage.changeState('In Progress', reviewState, 'Sunshine')
    await settingsPage.checkState(reviewState)
    const issuesPage = new IssuesPage(page)
    await issuesPage.clickOnApplicationButton()
    await issuesPage.createAndOpenIssue('Minor bug', 'Appleseed John', attentionState, taskTypeName)
  })

  // TODO: Need rework.
  test.skip('manage-templates', async () => {
    await templatePage.navigateToWorkspace(platformUri)
    await templatePage.openProfileMenu()
    await templatePage.openSettings()
    await templatePage.goToNotifications()
    await templatePage.selectVacancies()

    // await page.getByRole('button', { name: 'Recruiting', exact: true }).click()
    // await page.locator('#navGroup-statuses').getByText('New Recruiting project type').first().click()

    // // Click #create-template div
    // await page.click('#create-template div')
    // const tid = 'template-' + generateId()
    // const t = page.locator('#templates div:has-text("New project type")').first()
    // await t.click()
    // await t.locator('input').fill(tid)
    // // await page.locator(`#templates >> .container:has-text("${tid}")`).type('Enter')

    // await page.locator('.states >> svg >> nth=1').click()
    // await page.locator('text=Rename').click()
    // await page.locator('.box > .antiEditBox input').fill('State1')
    // await page.locator('button:has-text("Save")').click()
    // await page.waitForSelector('form.antiCard', { state: 'detached' })
    // await page.click('text=STATUS >> div')
    // await page.locator('.box > .antiEditBox input').fill('State2')
    // await page.locator('button:has-text("Save")').click()
    // await page.waitForSelector('form.antiCard', { state: 'detached' })
    // await page.click('text=STATUS >> div')
    // await page.locator('.box > .antiEditBox input').fill('State3')
    // await page.locator('button:has-text("Save")').click()
    // await page.waitForSelector('form.antiCard', { state: 'detached' })
  })
})

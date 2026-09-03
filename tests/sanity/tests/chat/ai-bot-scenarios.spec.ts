import { expect, test, type Page } from '../fixtures'
import { DocumentContentPage } from '../model/documents/document-content-page'
import { DocumentsPage } from '../model/documents/documents-page'
import { IssuesPage } from '../model/tracker/issues-page'
import { LeftSideMenuPage } from '../model/left-side-menu-page'
import { TrackerNavigationMenuPage } from '../model/tracker/tracker-navigation-menu-page'
import { NewProjectPage } from '../model/tracker/new-project-page'
import { type NewProject } from '../model/tracker/types'
import { prepareNewIssueWithOpenStep } from '../tracker/common-steps'
import { generateProjectId } from '../tracker/tracker.utils'
import { PlatformURI, createAccountAndWorkspace, generateId, generateTestData } from '../utils'
import { retryIntervals } from '../retry'

// Whole-flow assistant scenarios on the `low` level: the prompt scripts the tool call
// (`call:<tool> {json}`, llms/mock.ts), the test asserts what the user gets.

test.describe.configure({ mode: 'parallel' })

// Navigator starts collapsed and holds the project tree. Kept one project: two make the card ask.
const DEFAULT_PROJECT = 'Default'

async function openDefaultProject (page: Page): Promise<void> {
  const projectsGroup = page.locator('#navGroup-tree-projects')
  // The group renders a moment after the app itself; toggling the navigator in that gap hides it.
  const shown = await projectsGroup
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false)
  if (!shown) {
    await page.locator('.topmenu-container button').click()
    await expect(projectsGroup).toBeVisible({ timeout: 15000 })
  }
  await new TrackerNavigationMenuPage(page).openIssuesForProject(DEFAULT_PROJECT)
}

// The conversation is provisioned on click, so an early click leaves the sidebar closed - retry.
async function openAssistant (page: Page): Promise<void> {
  await expect(async () => {
    await page.locator('[data-id="btnDiscussWithAI"]').click()
    await expect(page.locator('#sidebar div.text-editor-view')).toBeVisible({ timeout: 15000 })
  }).toPass({ intervals: retryIntervals, timeout: 90000 })
}

/** The assistant thread lives in the chat sidebar, next to whatever object opened it. */
async function sendToAssistant (page: Page, text: string): Promise<void> {
  const input = page.locator('#sidebar div.text-editor-view')
  await expect(input).toBeVisible({ timeout: 30000 })
  await input.fill(text)
  await page.locator('#sidebar g#Send').click()
}

/** A brand new teamspace + document, opened with the assistant thread beside it. */
async function openFreshDocumentWithAssistant (page: Page, menu: LeftSideMenuPage): Promise<void> {
  const documentsPage = new DocumentsPage(page)
  const teamspace = { title: `Teamspace-${generateId()}`, description: 'ai', autoJoin: true }
  const document = { title: `Document-${generateId()}`, space: teamspace.title }

  await menu.clickDocuments()
  await documentsPage.checkTeamspaceNotExist(teamspace.title)
  await documentsPage.createNewTeamspace(teamspace)
  await documentsPage.clickOnButtonCreateDocument()
  await documentsPage.createDocument(document)
  await documentsPage.openDocument(document.title)
  await new DocumentContentPage(page).checkDocumentTitle(document.title)

  await openAssistant(page)
}

test.describe('ai-bot scenarios', () => {
  let leftSideMenuPage: LeftSideMenuPage
  let data: { workspaceName: string, userName: string, firstName: string, lastName: string, channelName: string }

  test.beforeEach(async ({ page, request }) => {
    data = generateTestData()
    leftSideMenuPage = new LeftSideMenuPage(page)
    // Straight into the workspace from the account token: the login form plus the workspace
    // picker are three page loads and cost about a second per test.
    await createAccountAndWorkspace(page, request, data, 'tracker')
  })

  test('assistant button in the issue editor opens a thread and proposes a task', async ({ page }) => {
    const issueTitle = `Issue for assist ${generateId()}`

    await openDefaultProject(page)
    await prepareNewIssueWithOpenStep(page, {
      title: issueTitle,
      description: 'assistant scenario',
      projectName: DEFAULT_PROJECT
    })

    await openAssistant(page)

    const proposedTitle = `Follow-up ${generateId()}`
    await sendToAssistant(page, `сделай задачу\ncall:propose_task {"title":"${proposedTitle}"}`)

    const card = page.locator('#sidebar .activityMessage').filter({ has: page.locator('[data-id="aiTaskProposal"]') })
    await expect(card).toBeVisible({ timeout: 60000 })
    await expect(card.locator('input').first()).toHaveValue(proposedTitle, { timeout: 15000 })

    await test.step('Creating from the card produces a real issue', async () => {
      // Hovering a message floats its action bar over the card, so park the pointer first.
      await page.mouse.move(0, 0)
      const createButton = card.getByRole('button', { name: 'Create task' })
      await expect(createButton).toBeEnabled({ timeout: 15000 })
      await createButton.click()
      await expect(card.getByRole('button', { name: 'Task created' })).toBeVisible({ timeout: 60000 })
    })
  })

  test('new context button resets the assistant thread', async ({ page }) => {
    const issueTitle = `Issue for context ${generateId()}`

    await openDefaultProject(page)
    await prepareNewIssueWithOpenStep(page, {
      title: issueTitle,
      description: 'context reset',
      projectName: DEFAULT_PROJECT
    })

    await openAssistant(page)
    await sendToAssistant(page, 'первое сообщение')
    await expect(page.locator('#sidebar .activityMessage', { hasText: 'первое сообщение' })).toBeVisible({
      timeout: 60000
    })
    // Unscripted text gets the mock's menu of available calls, not an answer.
    await expect(page.locator('#sidebar .activityMessage', { hasText: 'Мок-модель' })).toBeVisible({
      timeout: 60000
    })

    // The button only shows up for an AI context root, so its presence is part of the assertion.
    await page.locator('#sidebar [data-id="btnAiNewContext"]').click()
    await page.locator('.popup button[type="submit"]').click()

    // The echo reply quotes the prompt, so there is more than one match to clear - count them.
    await expect(page.locator('#sidebar .activityMessage', { hasText: 'первое сообщение' })).toHaveCount(0, {
      timeout: 60000
    })
  })

  test('proposed document edit lands in the document once applied', async ({ page }) => {
    await openFreshDocumentWithAssistant(page, leftSideMenuPage)

    const body = `Rewritten by the assistant ${generateId()}`
    await sendToAssistant(page, `перепиши документ\ncall:propose_new_document {"markdown":"# Plan\\n\\n${body}"}`)

    const card = page.locator('#sidebar .activityMessage').filter({ has: page.locator('[data-id="aiEditProposal"]') })
    await expect(card).toBeVisible({ timeout: 60000 })

    await test.step('Apply writes the proposal into the open document', async () => {
      // Apply goes through the open editor, so the document must stay on screen - that is exactly
      // the state under test; with it closed the card offers "Open document" instead.
      await card.getByRole('button', { name: 'Apply', exact: true }).click()
      // Not documentContentPage.inputContent(): the card's diff preview is a tiptap view too, and
      // only the document's own editor is editable.
      const docEditor = page.locator('div.textInput div.tiptap[contenteditable="true"]')
      await expect(docEditor).toContainText(body, { timeout: 60000 })
      await expect(card.getByRole('button', { name: 'Applied' })).toBeVisible({ timeout: 30000 })
    })
  })

  test('assistant panel in the create-issue dialog rewrites the draft', async ({ page }) => {
    const issuesPage = new IssuesPage(page)

    await openDefaultProject(page)
    await issuesPage.clickButtonCreateNewIssue()

    await page.locator('[data-id="btnIssueAssist"]').click()
    const panel = page.locator('.assist')
    await expect(panel).toBeVisible({ timeout: 30000 })

    const drafted = `Drafted by the assistant ${generateId()}`
    const input = panel.locator('div.text-editor-view')
    await expect(input).toBeVisible({ timeout: 60000 })
    await input.fill(`поправь черновик\ncall:edit_issue_draft {"title":"${drafted}"}`)
    await panel.locator('g#Send').click()

    // The tool only stages the draft; the card's own button is what pushes it into the form.
    const card = panel.locator('.activityMessage').filter({ has: page.locator('[data-id="aiTaskProposal"]') })
    await expect(card).toBeVisible({ timeout: 60000 })

    // Nothing is created from a draft card - the dialog behind it owns the project, so the card
    // must not offer its own project selector.
    await expect(card.locator('[id="space.selector"]')).toHaveCount(0)

    await page.mouse.move(0, 0)
    await card.getByRole('button', { name: 'Apply', exact: true }).click()

    await expect(issuesPage.inputPopupCreateNewIssueTitle()).toHaveValue(drafted, { timeout: 30000 })
  })

  test('project picked on the proposal card survives a reload', async ({ page }) => {
    const projectId = generateProjectId()
    const target: NewProject = { title: `AiTarget-${projectId}`, identifier: projectId }
    const issueTitle = `Issue for project pick ${generateId()}`

    await leftSideMenuPage.clickTracker()
    await openDefaultProject(page)

    await test.step('A second project, so the card has something to switch to', async () => {
      const trackerNavigationMenuPage = new TrackerNavigationMenuPage(page)
      await trackerNavigationMenuPage.pressCreateProjectButton()
      await new NewProjectPage(page).createNewProject(target)
      await trackerNavigationMenuPage.checkProjectExist(target.title)
      await openDefaultProject(page)
    })

    await prepareNewIssueWithOpenStep(page, {
      title: issueTitle,
      description: 'project pick',
      projectName: DEFAULT_PROJECT
    })

    await openAssistant(page)
    await sendToAssistant(page, `сделай задачу\ncall:propose_task {"title":"Pick ${generateId()}"}`)

    const card = page.locator('#sidebar .activityMessage').filter({ has: page.locator('[data-id="aiTaskProposal"]') })
    await expect(card).toBeVisible({ timeout: 60000 })

    const selector = card.locator('[id="space.selector"]')
    await expect(selector).toBeVisible({ timeout: 30000 })

    await page.mouse.move(0, 0)
    await selector.click()
    await page.locator('div.selectPopup div.list-item', { hasText: target.title }).click()
    await expect(selector).toContainText(target.title, { timeout: 15000 })

    await test.step('The pick is stored on the message, not just in the component', async () => {
      await page.reload()
      await openAssistant(page)
      const reloaded = page
        .locator('#sidebar .activityMessage')
        .filter({ has: page.locator('[data-id="aiTaskProposal"]') })
      await expect(reloaded.locator('[id="space.selector"]')).toContainText(target.title, { timeout: 60000 })
    })
  })

  test('task proposal card folds and unfolds from its caption', async ({ page }) => {
    const issueTitle = `Issue for fold ${generateId()}`

    await leftSideMenuPage.clickTracker()
    await openDefaultProject(page)
    await prepareNewIssueWithOpenStep(page, {
      title: issueTitle,
      description: 'fold scenario',
      projectName: DEFAULT_PROJECT
    })

    await openAssistant(page)

    const proposedTitle = `Foldable ${generateId()}`
    await sendToAssistant(page, `сделай задачу\ncall:propose_task {"title":"${proposedTitle}"}`)

    const card = page.locator('#sidebar .activityMessage').filter({ has: page.locator('[data-id="aiTaskProposal"]') })
    await expect(card).toBeVisible({ timeout: 60000 })

    const body = card.locator('[data-id="aiTaskProposalBody"]')
    await expect(body).toBeVisible({ timeout: 15000 })

    // The caption is the Expandable header: clicking it collapses the body, clicking again restores it.
    // ExpandCollapse keeps the node mounted and toggles `hidden`, so assert visibility, not count.
    await page.mouse.move(0, 0)
    await card.locator('[data-id="aiTaskProposal"]').click()
    await expect(body).toBeHidden({ timeout: 15000 })

    await card.locator('[data-id="aiTaskProposal"]').click()
    await expect(body).toBeVisible({ timeout: 15000 })
  })

  test('a long proposed document is cropped behind show more', async ({ page }) => {
    await openFreshDocumentWithAssistant(page, leftSideMenuPage)

    // ShowMore crops at 240px, so the proposal has to be clearly taller than that. No braces in
    // the text: the mock matches the tool arguments up to the first closing brace.
    const marker = `Tail ${generateId()}`
    const long = [...Array(40).keys()].map((i) => `Paragraph ${i} of a long rewrite`).join('\\n\\n')
    await sendToAssistant(page, `перепиши документ\ncall:propose_new_document {"markdown":"${long}\\n\\n${marker}"}`)

    const card = page.locator('#sidebar .activityMessage').filter({ has: page.locator('[data-id="aiEditProposal"]') })
    await expect(card).toBeVisible({ timeout: 60000 })

    const showMore = card.locator('.showMore')
    await expect(showMore).toContainText('Show more', { timeout: 30000 })

    await test.step('Expanding reveals the end of the proposal', async () => {
      await page.mouse.move(0, 0)
      await showMore.click()
      await expect(showMore).toContainText('Show less', { timeout: 15000 })
      await expect(card).toContainText(marker, { timeout: 15000 })
    })
  })

  test('AI level cards switch the workspace level', async ({ page }) => {
    await (await page.goto(`${PlatformURI}/workbench/${data.workspaceName}/setting/ai-settings/basic`))?.finished()

    // Levels come from the router (GET /levels), so the cards appear only once it has answered.
    const low = page.locator('[data-id="btnAiLevel-low"]')
    const middle = page.locator('[data-id="btnAiLevel-middle"]')
    await expect(low).toBeVisible({ timeout: 30000 })
    await expect(low).toHaveClass(/pressed/, { timeout: 15000 })

    await middle.click()
    await expect(middle).toHaveClass(/pressed/, { timeout: 15000 })
    await expect(low).not.toHaveClass(/pressed/, { timeout: 15000 })

    await test.step('The pick survives a reload', async () => {
      await (await page.goto(`${PlatformURI}/workbench/${data.workspaceName}/setting/ai-settings/basic`))?.finished()
      await expect(page.locator('[data-id="btnAiLevel-middle"]')).toHaveClass(/pressed/, { timeout: 30000 })
    })
  })
})

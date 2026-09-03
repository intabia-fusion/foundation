//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { expect, test, type Page } from '../fixtures'
import { SettingsPage } from '../model/settings-page'
import { IssuesDetailsPage } from '../model/tracker/issues-details-page'
import { IssuesPage } from '../model/tracker/issues-page'
import { NewProjectPage } from '../model/tracker/new-project-page'
import { TrackerNavigationMenuPage } from '../model/tracker/tracker-navigation-menu-page'
import { ProjectWorkflowsPage, WorkflowPage } from '../model/workflow-page'
import { createAccountAndWorkspace, generateId, generateTestData, setTestOptions } from '../utils'
import { retryIntervals } from '../retry'

test.describe.configure({ mode: 'serial' })

test.describe('Workflow in tracker', () => {
  let page: Page
  let settings: SettingsPage
  let workflows: WorkflowPage
  let projectWorkflows: ProjectWorkflowsPage
  let navigation: TrackerNavigationMenuPage
  let newProject: NewProjectPage
  let issues: IssuesPage
  let issueDetails: IssuesDetailsPage

  const typeName = `Tracked-${generateId(4)}`
  const workflowName = `Flow-${generateId(4)}`
  const projectId = `WF${generateId(3).toUpperCase().slice(0, 3)}`
  const projectName = `Guarded-${generateId(4)}`
  const freeProjectId = `FR${generateId(3).toUpperCase().slice(0, 3)}`
  const freeProjectName = `Free-${generateId(4)}`
  const issueTitle = `Issue-${generateId(4)}`
  const freeIssueTitle = `Free issue-${generateId(4)}`

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await createAccountAndWorkspace(page, page.request, generateTestData())
    await setTestOptions(page)
    await page.reload()

    settings = new SettingsPage(page)
    workflows = new WorkflowPage(page)
    projectWorkflows = new ProjectWorkflowsPage(page)
    navigation = new TrackerNavigationMenuPage(page)
    newProject = new NewProjectPage(page)
    issues = new IssuesPage(page)
    issueDetails = new IssuesDetailsPage(page)

    await settings.openProfileMenu()
    await settings.openSettings()
    await settings.createSpaceType(typeName, 'Tracker')
    await settings.selectSpaceType(typeName, 'Tracker')
    await settings.addTaskType('Issue')

    await workflows.createWorkflow(workflowName)
    await workflows.openWorkflow(workflowName)
    await workflows.addTransition('Plan', ['Backlog'], 'Todo')
    await workflows.addTransition('Start', ['Todo'], 'In Progress')
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('the new project modal offers workflow configuration for a custom type', async () => {
    await issues.clickOnApplicationButton()
    await navigation.pressCreateProjectButton()
    await newProject.projectTypeButton().click()
    await newProject.selectMenuItem(page, typeName)
    await expect(projectWorkflows.configureButton()).toBeVisible()
  })

  test('shows no configured label before a workflow is picked', async () => {
    await expect(projectWorkflows.configuredLabel()).toHaveCount(0)
  })

  test('binds a workflow to the task type', async () => {
    await projectWorkflows.setWorkflow('Issue', workflowName)
    await expect(projectWorkflows.configuredLabel()).toBeVisible()
  })

  test('creates the project with the mapping', async () => {
    await newProject.inputTitle().fill(projectName)
    await newProject.inputIdentifier().fill(projectId)
    await newProject.buttonCreateProject().click()
    await navigation.checkProjectExist(projectName)
  })

  test('keeps the mapping when the project is reopened for editing', async () => {
    // The project appears in the navigator before its workflow mixin lands, and CreateProject reads
    // the mapping once at mount - a dialog opened in that window never shows the label, no matter
    // how long it is waited on. Reopen it instead.
    await expect(async () => {
      await page.keyboard.press('Escape')
      await navigation.makeActionWithProject(projectName, 'Edit project')
      await expect(projectWorkflows.configuredLabel()).toBeVisible({ timeout: 3000 })
    }).toPass({ intervals: retryIntervals, timeout: 30000 })
    await page.keyboard.press('Escape')
  })

  test('creates an issue in the guarded project', async () => {
    await navigation.openIssuesForProject(projectName)
    await issues.createNewIssue({ title: issueTitle, description: 'Guarded by a workflow' })
    await issues.searchIssueByName(issueTitle)
    await issues.openIssueByName(issueTitle)
    await expect(issueDetails.buttonStatus()).toBeVisible()
  })

  test('offers only the statuses the workflow allows', async () => {
    await issueDetails.buttonStatus().click()
    const options = await page.locator('div.selectPopup div.list-item span.overflow-label').allTextContents()
    await page.keyboard.press('Escape')
    expect(options.map((it) => it.trim())).toEqual(expect.arrayContaining(['Todo']))
    expect(options.map((it) => it.trim())).not.toContain('Done')
    expect(options.map((it) => it.trim())).not.toContain('Canceled')
  })

  test('applies an allowed transition', async () => {
    await issueDetails.editIssue({ status: 'Todo' })
    await expect(issueDetails.buttonStatus()).toHaveText('Todo')
  })

  test('offers the next allowed status after the move', async () => {
    await issueDetails.buttonStatus().click()
    const options = (await page.locator('div.selectPopup div.list-item span.overflow-label').allTextContents()).map(
      (it) => it.trim()
    )
    await page.keyboard.press('Escape')
    expect(options).toEqual(expect.arrayContaining(['In Progress']))
    expect(options).not.toContain('Backlog')
  })

  test('creates a project of the same type without a workflow', async () => {
    await navigation.pressCreateProjectButton()
    await newProject.projectTypeButton().click()
    await newProject.selectMenuItem(page, typeName)
    await newProject.inputTitle().fill(freeProjectName)
    await newProject.inputIdentifier().fill(freeProjectId)
    await newProject.buttonCreateProject().click()
    await navigation.checkProjectExist(freeProjectName)
  })

  test('leaves the unbound project unrestricted', async () => {
    await navigation.openIssuesForProject(freeProjectName)
    await issues.createNewIssue({ title: freeIssueTitle, description: 'No workflow here' })
    await issues.searchIssueByName(freeIssueTitle)
    await issues.openIssueByName(freeIssueTitle)
    await issueDetails.buttonStatus().click()
    const options = (await page.locator('div.selectPopup div.list-item span.overflow-label').allTextContents()).map(
      (it) => it.trim()
    )
    await page.keyboard.press('Escape')
    expect(options).toEqual(expect.arrayContaining(['Backlog', 'Todo', 'In Progress', 'Done', 'Canceled']))
  })
})

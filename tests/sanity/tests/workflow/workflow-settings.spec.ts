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
import { WorkflowPage } from '../model/workflow-page'
import { createAccountAndWorkspace, generateId, generateTestData, setTestOptions } from '../utils'

test.describe.configure({ mode: 'serial' })

test.describe('Workflow settings', () => {
  let page: Page
  let settings: SettingsPage
  let workflows: WorkflowPage
  const typeName = `WF Type-${generateId(4)}`
  const workflowName = `Main-${generateId(4)}`

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await createAccountAndWorkspace(page, page.request, generateTestData())
    // localStorage is only reachable once a document from the platform origin is loaded.
    await setTestOptions(page)
    await page.reload()

    settings = new SettingsPage(page)
    workflows = new WorkflowPage(page)

    await settings.openProfileMenu()
    await settings.openSettings()
    await settings.createSpaceType(typeName, 'Tracker')
    await settings.selectSpaceType(typeName, 'Tracker')
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('the add-workflow button is disabled until a task type exists', async () => {
    await expect(workflows.addWorkflowButton()).toBeDisabled()
  })

  test('a task type enables the add-workflow button', async () => {
    await settings.addTaskType('Issue')
    await expect(workflows.addWorkflowButton()).toBeEnabled()
  })

  test('creates a workflow', async () => {
    await workflows.createWorkflow(workflowName)
    await expect(workflows.workflowRow(workflowName)).toBeVisible()
  })

  test('shows the task type on the workflow row', async () => {
    await expect(workflows.workflowRow(workflowName)).toContainText('Issue')
  })

  test('opens the workflow editor', async () => {
    await workflows.openWorkflow(workflowName)
    await expect(workflows.workflowTitleInput()).toHaveValue(workflowName)
    await expect(workflows.addTransitionButton()).toBeVisible()
  })

  test('starts with no transitions', async () => {
    await expect(workflows.transitionRows()).toHaveCount(0)
  })

  test('adds a transition', async () => {
    await workflows.addTransition('Plan', ['Backlog'], 'Todo')
    await expect(workflows.transitionRow('Plan')).toBeVisible()
  })

  test('adds a second transition', async () => {
    await workflows.addTransition('Start', ['Todo'], 'In Progress')
    await expect(workflows.transitionRows()).toHaveCount(2)
  })

  test('adds a transition from any status', async () => {
    await workflows.addTransition('Cancel', 'Any status', 'Canceled')
    await expect(workflows.transitionRow('Cancel')).toContainText('Any status')
  })

  test('rejects a self transition', async () => {
    await workflows.fillTransition('Loop', ['Done'], 'Done')
    await expect(workflows.errorRow()).toContainText('itself is not allowed')
    await expect(workflows.popupButton('Create')).toBeDisabled()
    await page.keyboard.press('Escape')
  })

  test('rejects a conflicting transition', async () => {
    await workflows.fillTransition('Plan again', ['Backlog'], 'Todo')
    await expect(workflows.errorRow()).toContainText('already exists')
    await expect(workflows.popupButton('Create')).toBeDisabled()
    await page.keyboard.press('Escape')
  })

  test('keeps the transition count after the rejected attempts', async () => {
    await expect(workflows.transitionRows()).toHaveCount(3)
  })

  test('opens a transition in the aside editor', async () => {
    await workflows.openTransition('Plan')
    await expect(workflows.transitionToDropdown()).toBeVisible()
  })

  test('adds a field-required validator', async () => {
    await workflows.addRule('validators', 'Validate details', 'Field required')
    await workflows.selectRuleFields(['Due date'])
    await workflows.popupButton('Add').click()
    await expect(workflows.ruleCardNamed('Field required')).toBeVisible()
  })

  test('marks the transition row as having rules', async () => {
    await expect(workflows.transitionRulesMarker('Plan')).toBeVisible()
    await expect(workflows.transitionRulesMarker('Start')).toHaveCount(0)
  })

  test('adds a clear-field post-function', async () => {
    await workflows.addRule('postFunctions', 'Perform actions', 'Clear field value')
    await workflows.selectRuleFields(['Due date'])
    await workflows.popupButton('Add').click()
    await expect(workflows.ruleCardNamed('Clear field value')).toBeVisible()
  })

  test('lists both rules on the transition', async () => {
    await expect(workflows.ruleCard()).toHaveCount(2)
  })

  test('removes a transition', async () => {
    await workflows.openTransition('Cancel')
    await workflows.removeTransition()
    await expect(workflows.transitionRow('Cancel')).toHaveCount(0)
    await expect(workflows.transitionRows()).toHaveCount(2)
  })

  test('sets initial statuses', async () => {
    await workflows.setInitialStatuses(['Backlog'])
    await expect(workflows.initialStatusesDropdown()).toContainText('Backlog')
  })

  test('renames the workflow', async () => {
    const renamed = `${workflowName}-renamed`
    await workflows.renameWorkflow(renamed)
    await settings.breadcrumbButton(typeName).click()
    await expect(workflows.workflowRow(renamed)).toBeVisible()
    await expect(workflows.workflowRow(workflowName)).toHaveCount(0)
  })

  test('lists one class option per task type plus the shared one', async () => {
    const options = await workflows.screenClassOptions()
    expect(options).toEqual(['Any task type', 'Issue'])
  })

  test('creates a screen', async () => {
    const screenName = `Screen-${generateId(4)}`
    await workflows.createScreen(screenName, 'Issue')
    await expect(workflows.screenRow(screenName)).toContainText('Issue')
  })

  test('creates a second workflow for the same task type', async () => {
    const second = `Second-${generateId(4)}`
    await workflows.createWorkflow(second)
    await expect(workflows.workflowRows()).toHaveCount(2)
  })

  test('deletes a workflow', async () => {
    const renamed = `${workflowName}-renamed`
    await workflows.openWorkflow(renamed)
    await workflows.deleteWorkflow()
    await expect(workflows.workflowRow(renamed)).toHaveCount(0)
    await expect(workflows.workflowRows()).toHaveCount(1)
  })
})

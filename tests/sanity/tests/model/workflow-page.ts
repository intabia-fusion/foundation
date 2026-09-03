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

import { expect, type Locator, type Page } from '@playwright/test'
import { retry } from '../retry'

export type RuleCategory = 'requests' | 'validators' | 'postFunctions'

/** Settings -> Space types -> <project type> -> Workflows, and everything reachable from there. */
export class WorkflowPage {
  readonly page: Page

  constructor (page: Page) {
    this.page = page
  }

  // Workflow list inside a project type
  addWorkflowButton = (): Locator => this.page.locator('button[data-id="btnAddWorkflow"]')
  workflowRow = (name: string): Locator =>
    this.page.locator(`button[data-id="workflow-row"][data-workflow-name="${name}"]`)

  workflowRows = (): Locator => this.page.locator('button[data-id="workflow-row"]')

  // Screens list inside a project type
  addScreenButton = (): Locator => this.page.locator('button[data-id="btnAddScreen"]')
  screenRow = (name: string): Locator => this.page.locator(`button[data-id="screen-row"][data-screen-name="${name}"]`)
  screenClassDropdown = (): Locator => this.asideModal().locator('div.modern-dropdown-container button').first()

  // Create workflow aside
  asideModal = (): Locator => this.page.locator('div.hulyModal-container.type-aside')
  popupModal = (): Locator => this.page.locator('div.hulyModal-container.type-popup')
  asideNameInput = (): Locator => this.asideModal().locator('div.hulyModal-content__titleGroup input')
  taskTypeDropdown = (): Locator => this.page.locator('button[data-id="workflow-taskType"]')
  asideButton = (name: string): Locator =>
    this.asideModal().locator('div.hulyModal-footer').getByRole('button', { name, exact: true })

  popupButton = (name: string): Locator =>
    this.popupModal().locator('div.hulyModal-footer').getByRole('button', { name, exact: true })

  // Dropdown popup shared by ModernDropdown and ModernDropdownLabels
  dropdownRow = (name: string): Locator =>
    this.page.locator('div.hulyPopup-container .hulyPopup-row', { hasText: name })

  dropdownRows = (): Locator => this.page.locator('div.hulyPopup-container .hulyPopup-row')

  // Workflow editor
  workflowTitleInput = (): Locator => this.page.getByPlaceholder('Untitled')
  initialStatusesDropdown = (): Locator => this.page.locator('button[data-id="initial-statuses"]')
  addTransitionButton = (): Locator => this.page.locator('button[data-id="btnAddTransition"]')
  transitionRow = (name: string): Locator =>
    this.page.locator(`button[data-id="transition-row"][data-transition-name="${name}"]`)

  transitionRows = (): Locator => this.page.locator('button[data-id="transition-row"]')
  transitionRulesMarker = (name: string): Locator => this.transitionRow(name).locator('[data-id="transition-rules"]')

  deleteWorkflowButton = (): Locator => this.page.locator('button[data-id="btnDeleteWorkflow"]')

  // Create transition popup
  popupNameInput = (): Locator => this.popupModal().locator('div.hulyModal-content__titleGroup input')
  transitionFromDropdown = (): Locator => this.page.locator('button[data-id="transition-from"]')
  transitionToDropdown = (): Locator => this.page.locator('button[data-id="transition-to"]')
  errorRow = (): Locator => this.page.locator('div.hulyModal-container div.error-row')

  // Transition aside editor
  removeTransitionButton = (): Locator => this.page.locator('button[data-id="btnRemoveTransition"]')
  addRuleButton = (category: RuleCategory): Locator => this.page.locator(`button[data-testid="action-add-${category}"]`)

  ruleCard = (): Locator => this.page.locator('div[data-id="rule-card"]')
  ruleCardNamed = (name: string): Locator => this.ruleCard().filter({ hasText: name })

  // Add rule popup
  ruleSidebarItem = (name: string): Locator => this.page.locator('button.rules-sidebar--item', { hasText: name })
  ruleListCard = (name: string): Locator => this.page.locator('div.rules-list div.rule-card', { hasText: name })

  // Confirmation dialogs (MessageBox)
  confirmDialog = (): Locator => this.page.locator('div.msgbox-container')
  confirmButton = (): Locator => this.confirmDialog().locator('div.footer button').first()

  /**
   * A multiselect dropdown stays open after a pick and its overlay swallows every other click.
   * Escape would close the surrounding modal too, so dismiss it by clicking the overlay instead.
   */
  async closeDropdown (): Promise<void> {
    const popup = this.page.locator('div.hulyPopup-container')
    if ((await popup.count()) === 0) return
    await this.page
      .locator('.modal-overlay')
      .last()
      .click({ position: { x: 5, y: 5 } })
    await expect(popup).toHaveCount(0)
  }

  async createWorkflow (name: string, taskType?: string): Promise<void> {
    await this.openAside(this.addWorkflowButton())
    await this.fillAsideName(name)
    if (taskType !== undefined) {
      await this.taskTypeDropdown().click()
      await this.dropdownRow(taskType).click()
    }
    await this.clickAsideCreate()
    await expect(this.workflowRow(name)).toBeVisible()
  }

  async createScreen (name: string, targetClass?: string): Promise<void> {
    await this.openAside(this.addScreenButton())
    await this.fillAsideName(name)
    if (targetClass !== undefined) {
      await this.screenClassDropdown().click()
      await this.dropdownRow(targetClass).click()
    }
    await this.clickAsideCreate()
    await expect(this.screenRow(name)).toBeVisible()
  }

  // A reopened aside drops what was typed, and Create stays disabled on an empty name - the click
  // then waits out the whole test instead of failing.
  private async fillAsideName (name: string): Promise<void> {
    await retry(async () => {
      await this.asideNameInput().fill(name)
      await expect(this.asideNameInput()).toHaveValue(name, { timeout: 3000 })
    })
  }

  private async clickAsideCreate (): Promise<void> {
    const create = this.asideButton('Create')
    await expect(create).toBeEnabled({ timeout: 15000 })
    await create.click()
  }

  // Both asides carry a Create button, so a leftover one from the previous step cannot be told
  // apart by the footer - close whatever is open and open ours from scratch.
  private async openAside (button: Locator): Promise<void> {
    await retry(async () => {
      if (await this.asideModal().isVisible()) {
        await this.page.keyboard.press('Escape')
        await expect(this.asideModal()).toHaveCount(0, { timeout: 3000 })
      }
      await button.click()
      await expect(this.asideButton('Create')).toBeVisible({ timeout: 3000 })
    })
  }

  async screenClassOptions (): Promise<string[]> {
    await this.addScreenButton().click()
    await this.screenClassDropdown().click()
    const options = (await this.dropdownRows().allTextContents()).map((it) => it.trim())
    await this.closeDropdown()
    await this.asideModal().locator('div.hulyModal-footer').getByRole('button', { name: 'Cancel' }).click()
    return options
  }

  async openWorkflow (name: string): Promise<void> {
    await this.workflowRow(name).click()
    await expect(this.addTransitionButton()).toBeVisible()
  }

  async renameWorkflow (newName: string): Promise<void> {
    await this.workflowTitleInput().fill(newName)
    // The title editbox saves on change, so move the focus out to commit it.
    await this.workflowTitleInput().press('Tab')
  }

  async deleteWorkflow (): Promise<void> {
    await this.deleteWorkflowButton().click()
    await this.confirmButton().click()
    await expect(this.confirmDialog()).toHaveCount(0)
  }

  async addTransition (name: string, from: string[] | 'Any status', to: string): Promise<void> {
    await this.addTransitionButton().click()
    await this.popupNameInput().fill(name)
    // "Any status" is the default selection - clicking it would toggle it off and leave nothing.
    if (from !== 'Any status') {
      await this.transitionFromDropdown().click()
      for (const status of from) {
        await this.dropdownRow(status).click()
      }
      await this.closeDropdown()
    }
    await this.transitionToDropdown().click()
    await this.dropdownRow(to).click()
    await this.popupButton('Create').click()
  }

  /** Fills the create-transition popup but leaves it open so the validation state can be read. */
  async fillTransition (name: string, from: string[] | 'Any status', to: string): Promise<void> {
    await this.addTransitionButton().click()
    await this.popupNameInput().fill(name)
    // "Any status" is the default selection - clicking it would toggle it off and leave nothing.
    if (from !== 'Any status') {
      await this.transitionFromDropdown().click()
      for (const status of from) {
        await this.dropdownRow(status).click()
      }
      await this.closeDropdown()
    }
    await this.transitionToDropdown().click()
    await this.dropdownRow(to).click()
  }

  async openTransition (name: string): Promise<void> {
    await this.transitionRow(name).click()
    await expect(this.removeTransitionButton()).toBeVisible()
  }

  async removeTransition (): Promise<void> {
    await this.removeTransitionButton().click()
    await this.confirmButton().click()
    await expect(this.confirmDialog()).toHaveCount(0)
  }

  async setInitialStatuses (statuses: string[]): Promise<void> {
    await this.initialStatusesDropdown().click()
    for (const status of statuses) {
      await this.dropdownRow(status).click()
    }
    await this.closeDropdown()
  }

  async addRule (category: RuleCategory, sidebarItem: string, rule: string): Promise<void> {
    await this.addRuleButton(category).click()
    await this.ruleSidebarItem(sidebarItem).click()
    await this.ruleListCard(rule).click()
  }

  /** Both the field-required validator and the clear-field post-function pick fields the same way. */
  async selectRuleFields (fields: string[]): Promise<void> {
    await this.page.locator('div.rule-editor--body button.hulyButton').first().click()
    for (const field of fields) {
      await this.dropdownRow(field).click()
    }
    await this.closeDropdown()
  }
}

/** New/Edit project modal: the workflow mapping block added by the workflow feature. */
export class ProjectWorkflowsPage {
  readonly page: Page

  constructor (page: Page) {
    this.page = page
  }

  configureButton = (): Locator => this.page.locator('button[data-id="btnConfigureWorkflows"]')
  configuredLabel = (): Locator => this.page.locator('span.workflows-status-label')
  mappingDropdown = (taskType: string): Locator => this.page.locator(`button[data-id="workflow-for-${taskType}"]`)

  dropdownRow = (name: string): Locator =>
    this.page.locator('div.hulyPopup-container .hulyPopup-row', { hasText: name })

  saveButton = (): Locator =>
    this.page
      .locator('div.hulyModal-container.type-popup')
      .locator('div.hulyModal-footer')
      .getByRole('button', { name: 'Save', exact: true })

  async setWorkflow (taskType: string, workflowName: string): Promise<void> {
    await this.configureButton().click()
    await this.mappingDropdown(taskType).click()
    await this.dropdownRow(workflowName).click()
    await this.saveButton().click()
  }
}

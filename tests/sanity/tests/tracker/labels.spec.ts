import { test } from '../fixtures'
import { generateId, PlatformSetting, PlatformURI } from '../utils'
import { IssuesDetailsPage } from '../model/tracker/issues-details-page'
import { IssuesPage } from '../model/tracker/issues-page'
import { LabelsPage } from '../model/tracker/labels-page'
import { NewProjectPage } from '../model/tracker/new-project-page'
import { SettingsPage } from '../model/settings-page'
import { TrackerNavigationMenuPage } from '../model/tracker/tracker-navigation-menu-page'
import { NewIssue, NewProject } from '../model/tracker/types'
import { prepareNewIssueWithOpenStep } from './common-steps'
import { generateProjectId } from './tracker.utils'

test.use({
  storageState: PlatformSetting
})

test.describe('Tracker labels tests', () => {
  let issuesDetailsPage: IssuesDetailsPage
  let issuesPage: IssuesPage
  let labelsPage: LabelsPage

  test.beforeEach(async ({ page }) => {
    issuesDetailsPage = new IssuesDetailsPage(page)
    issuesPage = new IssuesPage(page)
    labelsPage = new LabelsPage(page)
    await (await page.goto(`${PlatformURI}/workbench/sanity-ws`))?.finished()
  })

  test('Label created from an issue appears on the Labels page', async ({ page }) => {
    const label = `LABEL-FROM-ISSUE-${generateId(5)}`
    const newIssue: NewIssue = {
      title: `Issue to create a label-${generateId()}`,
      description: 'Issue to create a label description',
      projectName: 'Default'
    }

    await prepareNewIssueWithOpenStep(page, newIssue)
    await issuesDetailsPage.editIssue({ createLabel: true, labels: label })
    await issuesDetailsPage.checkIssue({ ...newIssue, labels: label })

    await labelsPage.openLabels()
    await labelsPage.checkLabelExist(label)
  })

  test('Label created on the Labels page can be added to an issue', async ({ page }) => {
    const label = `LABEL-FROM-PAGE-${generateId(5)}`
    const newIssue: NewIssue = {
      title: `Issue to use an existing label-${generateId()}`,
      description: 'Issue to use an existing label description',
      projectName: 'Default'
    }

    await labelsPage.openLabels()
    await labelsPage.createLabel(label)

    await prepareNewIssueWithOpenStep(page, newIssue)
    await issuesDetailsPage.addExistingLabel(label)
    await issuesDetailsPage.checkIssue({ ...newIssue, labels: label })
  })

  test('Labels work in a project of a custom project type', async ({ page }) => {
    const settingsPage = new SettingsPage(page)
    const trackerNavigationMenuPage = new TrackerNavigationMenuPage(page)
    const newProjectPage = new NewProjectPage(page)

    const projectTypeName = `LabelType-${generateId(4)}`
    const projectId = generateProjectId()
    const newProject: NewProject = {
      title: `LabelProject-${projectId}`,
      identifier: projectId,
      type: projectTypeName
    }
    const sharedLabel = `LABEL-SHARED-${generateId(5)}`
    const customTypeLabel = `LABEL-CUSTOM-TYPE-${generateId(5)}`

    await labelsPage.openLabels()
    await labelsPage.createLabel(sharedLabel)

    await test.step('Create a custom project type', async () => {
      await settingsPage.openProfileMenu()
      await settingsPage.openSettings()
      await settingsPage.createSpaceType(projectTypeName, 'Tracker')
      await settingsPage.selectSpaceType(projectTypeName, 'Tracker')
      await settingsPage.addTaskType('Issue')
    })

    await test.step('Create a project of that type', async () => {
      await issuesPage.clickOnApplicationButton()
      await trackerNavigationMenuPage.pressCreateProjectButton()
      await newProjectPage.createNewProject(newProject)
      await trackerNavigationMenuPage.checkProjectExist(newProject.title)
    })

    const issueWithNewLabel: NewIssue = {
      title: `Issue with a new label-${generateId()}`,
      description: 'Issue with a new label description',
      projectName: newProject.title
    }
    await test.step('New label created in the custom type project is shown on the Labels page', async () => {
      await prepareNewIssueWithOpenStep(page, issueWithNewLabel)
      await issuesDetailsPage.editIssue({ createLabel: true, labels: customTypeLabel })
      await issuesDetailsPage.checkIssue({ ...issueWithNewLabel, labels: customTypeLabel })
    })

    const issueWithSharedLabel: NewIssue = {
      title: `Issue with a shared label-${generateId()}`,
      description: 'Issue with a shared label description',
      projectName: newProject.title
    }
    await test.step('Label created in a classic project is available in the custom type project', async () => {
      await prepareNewIssueWithOpenStep(page, issueWithSharedLabel)
      await issuesDetailsPage.addExistingLabel(sharedLabel)
      await issuesDetailsPage.checkIssue({ ...issueWithSharedLabel, labels: sharedLabel })
    })

    await labelsPage.openLabels()
    await labelsPage.checkLabelExist(customTypeLabel)
  })
})

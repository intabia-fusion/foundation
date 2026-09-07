import { test } from '../fixtures'
import { generateId, PlatformSetting, PlatformURI } from '../utils'
import { Issue, NewIssue } from '../model/tracker/types'
import { TrackerNavigationMenuPage } from '../model/tracker/tracker-navigation-menu-page'
import { TemplatePage } from '../model/tracker/templates-page'
import { TemplateDetailsPage } from '../model/tracker/template-details-page'
import { TEST_ESTIMATIONS } from './tracker.utils'
import tracker from '@hcengineering/tracker'
import { connectTracker } from '../API/TrackerApi'

test.use({
  storageState: PlatformSetting
})

test.describe('Tracker template tests', () => {
  let trackerNavigationMenuPage: TrackerNavigationMenuPage
  let templatePage: TemplatePage
  let templateDetailsPage: TemplateDetailsPage

  // Nothing removes the templates these tests create, and the assignee group is virtualised - past
  // forty rows the freshly created one never renders.
  test.beforeAll(async () => {
    const { client } = await connectTracker()
    const stale = (await client.findAll(tracker.class.IssueTemplate, {})).filter((it) =>
      /^Template (with all parameters|for edit|for delete)-/.test(it.title)
    )
    for (const template of stale) {
      await client.remove(template)
    }
  })

  test.beforeEach(async ({ page }) => {
    trackerNavigationMenuPage = new TrackerNavigationMenuPage(page)
    templatePage = new TemplatePage(page)
    templateDetailsPage = new TemplateDetailsPage(page)
    await (await page.goto(`${PlatformURI}/workbench/sanity-ws`))?.finished()
  })

  test('Create a Template', async () => {
    const newTemplate: NewIssue = {
      title: `Template with all parameters-${generateId()}`,
      description: 'Created template with all parameters',
      priority: 'Urgent',
      assignee: 'Dirak Kainin',
      createLabel: true,
      labels: `CREATE-TEMPLATE-${generateId()}`,
      component: 'No component',
      estimation: '2',
      milestone: 'No Milestone'
    }

    await trackerNavigationMenuPage.openTemplateForProject('Default')
    await templatePage.createNewTemplate(newTemplate)
    await templatePage.openTemplate(newTemplate.title)
    await templateDetailsPage.checkTemplate(newTemplate)
  })

  test('Edit a Template', async ({ page }) => {
    const newTemplate: NewIssue = {
      title: `Template for edit-${generateId()}`,
      description: 'Created template for edit'
    }

    const editTemplate: Issue = {
      priority: 'High',
      assignee: 'Dirak Kainin',
      createLabel: true,
      labels: `EDIT-TEMPLATE-${generateId()}`,
      component: 'No component',
      estimation: '8',
      duedate: 'today'
    }
    await trackerNavigationMenuPage.openTemplateForProject('Default')
    await templatePage.createNewTemplate(newTemplate)
    await templatePage.openTemplate(newTemplate.title)
    await templateDetailsPage.editTemplate(editTemplate)
    await templateDetailsPage.checkTemplate({
      ...newTemplate,
      ...editTemplate
    })

    await templateDetailsPage.checkActivityContent(`New template: ${newTemplate.title}`)

    for (const input of TEST_ESTIMATIONS) {
      await templateDetailsPage.editTemplate({
        estimation: input
      })
      await templateDetailsPage.checkTemplate({
        ...newTemplate,
        ...editTemplate,
        estimation: input
      })
    }
  })

  test('Delete a Template', async () => {
    const deleteTemplate: NewIssue = {
      title: `Template for delete-${generateId()}`,
      description: 'Created template for delete'
    }
    await trackerNavigationMenuPage.openTemplateForProject('Default')
    await templatePage.createNewTemplate(deleteTemplate)
    await templatePage.openTemplate(deleteTemplate.title)
    await templateDetailsPage.deleteTemplate()
    await templatePage.checkTemplateNotExist(deleteTemplate.title)
  })
})

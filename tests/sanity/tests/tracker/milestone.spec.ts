import { test } from '../fixtures'
import { generateId, PlatformSetting, PlatformURI } from '../utils'
import { TrackerNavigationMenuPage } from '../model/tracker/tracker-navigation-menu-page'
import { MilestonesPage } from '../model/tracker/milestones-page'
import { NewMilestone } from '../model/tracker/types'
import { MilestonesDetailsPage } from '../model/tracker/milestones-details-page'

test.use({
  storageState: PlatformSetting
})

test.describe('Tracker milestone tests', () => {
  let trackerNavigationMenuPage: TrackerNavigationMenuPage
  let milestonesPage: MilestonesPage
  let milestonesDetailsPage: MilestonesDetailsPage

  test.beforeEach(async ({ page }) => {
    trackerNavigationMenuPage = new TrackerNavigationMenuPage(page)
    milestonesPage = new MilestonesPage(page)
    milestonesDetailsPage = new MilestonesDetailsPage(page)
    await (await page.goto(`${PlatformURI}/workbench/sanity-ws`))?.finished()
  })

  test('Create a Milestone', async () => {
    const newMilestone: NewMilestone = {
      name: `Created Milestone-${generateId()}`,
      description: 'Create a Milestone',
      status: 'In progress',
      targetDateInDays: 'in 3 days'
    }
    await trackerNavigationMenuPage.openMilestonesForProject('Default')
    await milestonesPage.createNewMilestone(newMilestone)
    await milestonesPage.openMilestoneByName(newMilestone.name)
    await milestonesDetailsPage.checkIssue(newMilestone)
  })

  test('Edit a Milestone', async () => {
    const commentText = 'Edit Milestone comment'
    // Created here on purpose: editing the seeded milestone appends one more "Status set to" message
    // to its activity on every run/retry, so the activity check hits a strict mode violation.
    const editMilestone: NewMilestone = {
      name: `Edit Milestone-${generateId()}`,
      description: 'Edit Milestone Description',
      status: 'Completed',
      targetDateInDays: 'in 30 days'
    }
    await trackerNavigationMenuPage.openMilestonesForProject('Default')
    await milestonesPage.createNewMilestone({
      name: editMilestone.name,
      description: 'Milestone description before edit',
      status: 'In progress'
    })
    await milestonesPage.openMilestoneByName(editMilestone.name)
    await milestonesDetailsPage.editIssue(editMilestone)
    await milestonesDetailsPage.checkIssue(editMilestone)
    await milestonesDetailsPage.addComment(commentText)
    await milestonesDetailsPage.checkCommentExist(commentText)
    await milestonesDetailsPage.checkActivityContentExist(`New milestone: ${editMilestone.name}`)
    await milestonesDetailsPage.checkActivityContentExist(`Status set to ${editMilestone.status}`)
    await milestonesDetailsPage.checkActivityExist('changed description')
  })

  test('Delete a Milestone', async () => {
    // Created here on purpose: the test destroys it, so seeded data would only survive one run.
    const deleteMilestone: NewMilestone = {
      name: `Delete Milestone-${generateId()}`,
      description: 'Delete Milestone Description',
      status: 'Canceled'
    }
    await trackerNavigationMenuPage.openMilestonesForProject('Default')
    await milestonesPage.createNewMilestone(deleteMilestone)
    await milestonesPage.openMilestoneByName(deleteMilestone.name)
    await milestonesDetailsPage.checkIssue(deleteMilestone)
    await milestonesDetailsPage.deleteMilestone()
    await milestonesPage.checkMilestoneNotExist(deleteMilestone.name)
  })
})

import { test } from '../fixtures'
import { ChannelPage } from '../model/channel-page'
import { LeftSideMenuPage } from '../model/left-side-menu-page'
import { createAccountAndWorkspace, generateId, generateTestData } from '../utils'
import { LinkedChannelTypes } from '../model/types'
import { VacanciesPage } from '../model/recruiting/vacancies-page'
import { TalentsPage } from '../model/recruiting/talents-page'
import { TalentName } from '../model/recruiting/types'
import { UserProfilePage } from '../model/profile/user-profile-page'

test.describe.configure({ mode: 'parallel' })

test.describe('Dynamic reqruting chats', () => {
  let leftSideMenuPage: LeftSideMenuPage
  let channelPage: ChannelPage
  let vacanciesPage: VacanciesPage
  let talentsPage: TalentsPage
  let data: { workspaceName: string, userName: string, firstName: string, lastName: string, channelName: string }

  test.beforeEach(async ({ page, request }) => {
    data = generateTestData()

    leftSideMenuPage = new LeftSideMenuPage(page)
    channelPage = new ChannelPage(page)
    vacanciesPage = new VacanciesPage(page)
    talentsPage = new TalentsPage(page)

    // Straight into the workspace from the account token: the login form plus the workspace
    // picker are three page loads and cost about a second per test.
    await createAccountAndWorkspace(page, request, data)
    const userProfilePage = new UserProfilePage(page)
    await userProfilePage.openProfileMenu()
    await userProfilePage.clickSettings()
    await userProfilePage.clickConfigure()
    await userProfilePage.enableRecruiting()
  })

  test('User can work with a vacancy/talent/aplications and see linked chat', async () => {
    await leftSideMenuPage.clickRecruiting()
    const newVacancyTitle = `Vacancy ${generateId()}`
    let talentName: TalentName

    await test.step('Create vacancy', async () => {
      await vacanciesPage.createVacancy(newVacancyTitle)
    })

    await test.step('User has linked vacancy chat', async () => {
      await leftSideMenuPage.clickChunter()
      await channelPage.checkLinkedChannelIsExist(newVacancyTitle, LinkedChannelTypes.Vacancy)
    })

    await test.step('Prepare a talent', async () => {
      await leftSideMenuPage.clickRecruiting()
      await talentsPage.clickTalentsTab()
      talentName = await talentsPage.createNewTalent()
      await talentsPage.openTalentByTalentName(talentName)
    })

    await test.step('Create application', async () => {
      await talentsPage.clickAddApplication()
      await talentsPage.selectSpace()
      await talentsPage.searchAndSelectVacancy(newVacancyTitle)
      await talentsPage.waitForHRInterviewVisible()
      await talentsPage.createApplication()
      await talentsPage.clickVacancyApplication(newVacancyTitle)
      await talentsPage.assignRecruiter()
      await talentsPage.selectRecruterToAssignByName(`${data.lastName} ${data.firstName}`)
    })

    await test.step('User has linked application chat', async () => {
      await leftSideMenuPage.clickChunter()
      await channelPage.checkLinkedChannelIsExist(
        `${talentName.lastName} ${talentName.firstName}`,
        LinkedChannelTypes.Application
      )
    })
  })
})

import { test } from '../fixtures'
import { createAccountAndWorkspace, generateId, generateTestData } from '../utils'
import { LeftSideMenuPage } from '../model/left-side-menu-page'
import { faker } from '@faker-js/faker'
import { WorkspaceSettingsPage, ButtonType } from '../model/workspace/workspace-settings-page'
import { UserProfilePage } from '../model/profile/user-profile-page'
import { CustomAttributesPage, CustomAttributesButtons } from './custom-attributes-page'
import { ClassProperties, DataType } from './class-properties-page'
import { NewCompany } from '../model/recruiting/types'
import { NavigationMenuPage } from '../model/recruiting/navigation-menu-page'
import { CompaniesPage } from '../model/recruiting/companies-page'
import { CompanyDetailsPage } from '../model/recruiting/company-details-page'

test.describe.skip('Custom attributes tests', () => {
  let leftSideMenuPage: LeftSideMenuPage
  let userProfilePage: UserProfilePage
  let workspaceSettingsPage: WorkspaceSettingsPage
  let customAttributesPage: CustomAttributesPage
  let classProperties: ClassProperties
  let navigationMenuPage: NavigationMenuPage
  let companyDetailsPage: CompanyDetailsPage
  let companiesPage: CompaniesPage
  let data: { workspaceName: string, userName: string, firstName: string, lastName: string, channelName: string }

  test.beforeEach(async ({ page, request }) => {
    data = generateTestData()
    leftSideMenuPage = new LeftSideMenuPage(page)
    userProfilePage = new UserProfilePage(page)
    workspaceSettingsPage = new WorkspaceSettingsPage(page)
    customAttributesPage = new CustomAttributesPage(page)
    classProperties = new ClassProperties(page)
    navigationMenuPage = new NavigationMenuPage(page)
    companiesPage = new CompaniesPage(page)
    companyDetailsPage = new CompanyDetailsPage(page)
    // Straight into the workspace from the account token: the login form plus the workspace
    // picker are three page loads and cost about a second per test.
    await createAccountAndWorkspace(page, request, data)
    // await (await page.goto(`${PlatformURI}/workbench/${data.workspaceName}`))?.finished()
  })

  test('Check if all custom attributes exists', async ({ browser, page }) => {
    await userProfilePage.openProfileMenu()
    await userProfilePage.clickSettings()
    await workspaceSettingsPage.selectWorkspaceSettingsTab(ButtonType.Classes)
    await customAttributesPage.checkIfClassesExists()
  })

  test('create company add custom string attribute and check if it exists in member section', async ({
    browser,
    page
  }) => {
    const customAttribute = faker.word.words()
    const addStringCustomAttribute = faker.word.words()
    const newCompany: NewCompany = {
      name: `Create a new Company test-${generateId()}`,
      socials: [
        {
          type: 'Phone',
          value: '3213221321213'
        },
        {
          type: 'Email',
          value: 'test+321313123@gmail.com'
        }
      ]
    }
    await userProfilePage.openProfileMenu()
    await userProfilePage.clickSettings()
    await userProfilePage.clickConfigure()
    await userProfilePage.enableRecruiting()
    await userProfilePage.enableEmail()
    await workspaceSettingsPage.selectWorkspaceSettingsTab(ButtonType.Classes)
    await customAttributesPage.selectEntityTab(CustomAttributesButtons.Member)
    await customAttributesPage.clickAddAttribute()
    await classProperties.selectDataType(DataType.String)
    await classProperties.fillName(customAttribute)
    await classProperties.clickCreateButton()
    await leftSideMenuPage.clickRecruiting()

    await navigationMenuPage.clickButtonCompanies()
    await companiesPage.createNewCompany(newCompany)
    await companiesPage.openCompanyByName(newCompany.name)
    await companyDetailsPage.addMember(data.lastName + ' ' + data.firstName)
    await classProperties.clickCustomAttribute(customAttribute)
    await classProperties.fillEnterTextString(addStringCustomAttribute)
    await classProperties.clickConfirmChange()
    await classProperties.checkIfStringIsUpdated(addStringCustomAttribute)
  })
})

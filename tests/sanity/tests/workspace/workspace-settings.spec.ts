import { SignUpData } from '../model/common-types'
import { test, type APIRequestContext, type Page } from '../fixtures'
import { generateId, loginByToken, uploadFile } from '../utils'
import { ApiEndpoint } from '../API/Api'
import { UserProfilePage } from '../model/profile/user-profile-page'
import { ButtonType, WorkspaceSettingsPage } from '../model/workspace/workspace-settings-page'
import { OwnersPage } from '../model/workspace/owner-pages'
import { faker } from '@faker-js/faker'
import { ClassesPage } from '../model/workspace/classes-pages'

test.describe('Workspace tests', () => {
  let userProfilePage: UserProfilePage
  let workspaceSettingsPage: WorkspaceSettingsPage
  let ownersPage: OwnersPage
  let newUser: SignUpData
  let classesPage: ClassesPage

  // Signing up through the UI costs ~10s per test; the API path plus a token login lands on the
  // workspace directly and these tests assert settings tabs, not the signup flow.
  async function signUpAndOpenWorkspace (
    page: Page,
    request: APIRequestContext,
    user: SignUpData,
    workspaceName: string
  ): Promise<void> {
    const api = new ApiEndpoint(request)
    await api.createAccount(user.email, user.password, user.firstName, user.lastName)
    const ws = await api.createWorkspaceWithLogin(workspaceName, user.email, user.password)
    const token = await api.loginAndGetToken(user.email, user.password)
    await loginByToken(page, token, ws)
  }

  test.beforeEach(async ({ page }) => {
    userProfilePage = new UserProfilePage(page)
    workspaceSettingsPage = new WorkspaceSettingsPage(page)
    ownersPage = new OwnersPage(page)
    classesPage = new ClassesPage(page)
  })

  test('User the owner is showing inside the owner tab', async ({ page, request }) => {
    newUser = {
      firstName: faker.person.firstName(),
      lastName: faker.person.lastName(),
      email: faker.internet.email(),
      password: '1234'
    }
    const newWorkspaceName = `New Workspace Name - ${generateId(2)}`
    await signUpAndOpenWorkspace(page, request, newUser, newWorkspaceName)
    await userProfilePage.openProfileMenu()
    await userProfilePage.clickSettings()
    await workspaceSettingsPage.selectWorkspaceSettingsTab(ButtonType.Owners)
    await ownersPage.checkIfOwnerExists(newUser.firstName)
  })

  test.skip('User is able to set himself as an spaces admin', async ({ page, request }) => {
    newUser = {
      firstName: faker.person.firstName(),
      lastName: faker.person.lastName(),
      email: faker.internet.email(),
      password: '1234'
    }
    const newWorkspaceName = `New Workspace Name - ${generateId(2)}`
    await signUpAndOpenWorkspace(page, request, newUser, newWorkspaceName)
    await userProfilePage.openProfileMenu()
    await userProfilePage.clickSettings()
    await workspaceSettingsPage.selectWorkspaceSettingsTab(ButtonType.Spaces)
    await ownersPage.addMember(newUser.firstName)
  })

  test('User is able to change workspace picture', async ({ page, request }) => {
    newUser = {
      firstName: faker.person.firstName(),
      lastName: faker.person.lastName(),
      email: faker.internet.email(),
      password: '1234'
    }
    const newWorkspaceName = `New Workspace Name - ${generateId(2)}`
    await signUpAndOpenWorkspace(page, request, newUser, newWorkspaceName)
    await userProfilePage.openProfileMenu()
    await userProfilePage.clickSettings()
    await workspaceSettingsPage.selectWorkspaceSettingsTab(ButtonType.General)
    await ownersPage.clickOnWorkspaceLogo()
    await uploadFile(page, 'cat3.jpeg')
    await ownersPage.saveUploadedLogo()
    await ownersPage.checkIfPictureIsUploaded()
  })

  test('User is able to create template', async ({ page, request }) => {
    newUser = {
      firstName: faker.person.firstName(),
      lastName: faker.person.lastName(),
      email: faker.internet.email(),
      password: '1234'
    }
    const newWorkspaceName = `New Workspace Name - ${generateId(2)}`
    const newTemplateName = faker.word.words(2)
    await signUpAndOpenWorkspace(page, request, newUser, newWorkspaceName)
    await userProfilePage.openProfileMenu()
    await userProfilePage.clickSettings()
    await workspaceSettingsPage.selectWorkspaceSettingsTab(ButtonType.TextTemplate)
    await ownersPage.createTemplateWithName(newTemplateName)
  })

  test.skip('User is able to see all the classes', async ({ page, request }) => {
    newUser = {
      firstName: faker.person.firstName(),
      lastName: faker.person.lastName(),
      email: faker.internet.email(),
      password: '1234'
    }
    const newWorkspaceName = `New Workspace Name - ${generateId(2)}`
    await signUpAndOpenWorkspace(page, request, newUser, newWorkspaceName)
    await userProfilePage.openProfileMenu()
    await userProfilePage.clickSettings()
    await workspaceSettingsPage.selectWorkspaceSettingsTab(ButtonType.Classes)
    await classesPage.checkIfClassesExists()
  })

  test('User is able to create Enum', async ({ page, request }) => {
    newUser = {
      firstName: faker.person.firstName(),
      lastName: faker.person.lastName(),
      email: faker.internet.email(),
      password: '1234'
    }
    const newWorkspaceName = `New Workspace Name - ${generateId(2)}`
    const enumTitle = faker.word.words(2)
    const enumName = faker.word.words(2)
    await signUpAndOpenWorkspace(page, request, newUser, newWorkspaceName)
    await userProfilePage.openProfileMenu()
    await userProfilePage.clickSettings()
    await workspaceSettingsPage.selectWorkspaceSettingsTab(ButtonType.Enums)
    await ownersPage.createEnumWithName(enumTitle, enumName)
  })

  // Seems that there is currently a bug
  test.skip('User is able to create Enums', async ({ page, request }) => {
    newUser = {
      firstName: faker.person.firstName(),
      lastName: faker.person.lastName(),
      email: faker.internet.email(),
      password: '1234'
    }
    const newWorkspaceName = `New Workspace Name - ${generateId(2)}`
    const enumTitle = faker.word.words(2)
    const enumName = faker.word.words(2)
    await signUpAndOpenWorkspace(page, request, newUser, newWorkspaceName)
    await userProfilePage.openProfileMenu()
    await userProfilePage.clickSettings()
    await workspaceSettingsPage.selectWorkspaceSettingsTab(ButtonType.InviteSettings)
    await ownersPage.createEnumWithName(enumTitle, enumName)
  })
})

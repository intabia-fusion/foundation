import { Page, test } from './fixtures'
import { PlatformSetting, PlatformURI } from './utils'

test.use({
  storageState: PlatformSetting
})

export async function createDepartment (page: Page, departmentName: string): Promise<void> {
  await page.click('button:has-text("Department")')
  const departmentNameField = page.locator('[placeholder="Department"]')
  await departmentNameField.click()
  await departmentNameField.fill(departmentName)
  await page.locator('.antiCard button:has-text("Create")').click()
  await page.waitForSelector('form.antiCard', { state: 'detached' })
}

test.describe('hr tests', () => {
  test.beforeEach(async ({ page }) => {
    await (await page.goto(`${PlatformURI}/workbench/sanity-ws`))?.finished()
  })

})

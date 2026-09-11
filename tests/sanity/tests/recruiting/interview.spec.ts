import { test } from '../fixtures'
import { PlatformSetting, PlatformURI } from '../utils'

test.use({
  storageState: PlatformSetting
})

test.describe('interview tests', () => {
  test.beforeEach(async ({ page }) => {
    await (await page.goto(`${PlatformURI}/workbench/sanity-ws/recruit`))?.finished()
  })

})

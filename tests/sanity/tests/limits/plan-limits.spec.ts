import { expect, test } from '../fixtures'
import { PlatformSettingSecond, PlatformURI } from '../utils'

test.describe('Plan limits', () => {
  test.describe('seat limit banner (seatless member)', () => {
    test.use({ storageState: PlatformSettingSecond })

    // Blocked: seatless member onboarding is rejected by SeatLimitsMiddleware, so user2 can't load
    // the workbench.
    test.fixme('seatless member sees the read-only banner', async ({ page }) => {
      await (await page.goto(`${PlatformURI}/workbench/limits-ws`))?.finished()
      // user2 holds no seat (usersLimit=1, taken by the owner) -> ReadOnlyBanner is shown.
      await expect(page.locator('[data-id="billingReadOnlyBanner"]')).toBeVisible({ timeout: 15000 })
    })
  })
})

import { expect, test } from '../fixtures'
import { AccountRole } from '@hcengineering/core'
import { PlatformSetting, PlatformURI, PlatformUserSecond, generateId, getSecondPage } from '../utils'
import { retryIntervals } from '../retry'
import { addStoragePackage, assignMember, setWorkspacePlanByUuid } from '../API/Billing'
import { ApiEndpoint } from '../API/Api'
import { TrackerNavigationMenuPage } from '../model/tracker/tracker-navigation-menu-page'
import type { Page } from '@playwright/test'

// Attach `count` unique 0.5 MB files into the New Issue form, watching for the datalake 413
// (the "storage limit exceeded" response). Returns whether a 413 fired. `stopOnReject` breaks
// the loop as soon as a 413 is seen (block A); leave false to upload the full count (block A2).
async function uploadChunksWatching413 (page: Page, count: number, stopOnReject: boolean): Promise<boolean> {
  let rejected = false
  page.on('response', (r) => {
    if (r.status() === 413 && r.url().includes('/upload/')) {
      rejected = true
    }
  })

  const CHUNK = 512 * 1024 // 0.5 MB
  const fileInput = page.locator('form[id="tracker:string:NewIssue"] input[type="file"]#file')
  // The button toggles to "Resume draft" once a draft exists, so open via id (either variant).
  const openForm = page.locator('#tracker-string-NewIssue, #tracker-string-ResumeDraft')

  for (let i = 0; i < count; i++) {
    if (stopOnReject && rejected) break
    // Unique content per file — billing dedups storage deltas by sha256, so identical zero-filled
    // buffers would all collapse to one chunk and never cross the limit via the delta path.
    const buffer = Buffer.alloc(CHUNK, i + 1)
    await openForm.first().click()
    // Wait for the upload response itself instead of a flat 2s guess, then leave a short margin
    // for billing to record the delta before the next chunk goes up.
    const uploaded = page.waitForResponse((r) => r.url().includes('/upload/'), { timeout: 15000 }).catch(() => null)
    await fileInput.setInputFiles({ name: `big-${i}.bin`, mimeType: 'application/octet-stream', buffer })
    await uploaded
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
  }
  return rejected
}

// ── A. disk limit (honest upload) ───────────────────────────────────────────
test.describe('disk limit (honest upload)', () => {
  test.use({ storageState: PlatformSetting })

  test('uploading beyond the storage limit is rejected', async ({ page, request }) => {
    const api = new ApiEndpoint(request)
    const wsInfo = await api.createWorkspaceWithLogin(`disk-${generateId(8)}`, 'user1', '1234')
    const wsUrl = wsInfo.workspaceUrl
    await setWorkspacePlanByUuid(wsInfo.workspace, 'start', { storageGB: 0.001 })

    await (await page.goto(`${PlatformURI}/workbench/${wsUrl}/tracker`))?.finished()

    const trackerNav = new TrackerNavigationMenuPage(page)
    await trackerNav.openIssuesForProject('Default')

    // Upload 0.5 MB chunks past the 1 MB tier limit; the server rejects with a 413 once crossed.
    const rejected = await uploadChunksWatching413(page, 12, true)
    expect(rejected).toBe(true)
  })
})

// ── A2. disk package raises the enforced storage limit ───────────────────────
// A purchased disk package (type=package) adds its storageGB on top of the tier base. Server-side
// enforcement (billing getEffectiveLimit) must sum tier+package, so an upload that would exceed the
// tier alone is accepted once the package covers it. Mirrors block A but expects NO 413.
test.describe('disk package raises storage limit', () => {
  test.use({ storageState: PlatformSetting })

  test('upload above the tier limit is accepted when a disk package covers it', async ({ page, request }) => {
    const api = new ApiEndpoint(request)
    const wsInfo = await api.createWorkspaceWithLogin(`pkg-${generateId(8)}`, 'user1', '1234')
    const wsUrl = wsInfo.workspaceUrl
    // Tiny tier (1 MB) + a package adding 20 MB -> effective limit ~21 MB. Uploading ~5 MB crosses
    // the tier alone but stays under tier+package, so it must NOT be rejected.
    await setWorkspacePlanByUuid(wsInfo.workspace, 'start', { storageGB: 0.001 })
    await addStoragePackage(wsInfo.workspace, '100gb', 0.02)

    await (await page.goto(`${PlatformURI}/workbench/${wsUrl}/tracker`))?.finished()

    const trackerNav = new TrackerNavigationMenuPage(page)
    await trackerNav.openIssuesForProject('Default')

    // ~5 MB total (10 x 0.5 MB) — above the 1 MB tier, below the 21 MB tier+package limit -> no 413.
    const rejected = await uploadChunksWatching413(page, 10, false)
    expect(rejected).toBe(false)
  })
})

// ── B. unpaid stays usable, no hard read-only ────────────────────────────────
// past_due is inside the grace window: the tier still grants the paid plan (full access), so the
// workspace shows NO free-plan chip and NO read-only. A tier canceled directly in the DB does not
// grant a plan, but limits fail open (never a hard read-only from billing state alone). Neither of
// these is the free-plan chip: that appears only for readonly/expired-with-free, or for a real
// Active-free subscription auto-provisioned by pod-payment on a user cancel (queue-driven, not
// reachable through adminCreateSubscription). Seat over-limit read-only is block F.
test.describe('unpaid stays usable', () => {
  test.use({ storageState: PlatformSetting })

  test('past-due workspace stays on full paid access (grace): no free chip, no read-only', async ({
    page,
    request
  }) => {
    const api = new ApiEndpoint(request)
    const wsInfo = await api.createWorkspaceWithLogin(`unpaid-${generateId(8)}`, 'user1', '1234')
    const wsUrl = wsInfo.workspaceUrl
    await setWorkspacePlanByUuid(wsInfo.workspace, 'start', { status: 'past_due' })

    // The limits indicator proves billing mounted; grace keeps it on paid access -> no chip/banner.
    await expect(async () => {
      await (await page.goto(`${PlatformURI}/workbench/${wsUrl}`))?.finished()
      await expect(page.locator('[data-id="billingLimitsIndicator"]')).toBeVisible({ timeout: 5000 })
      await expect(page.locator('[data-id="billingFreePlanBanner"]')).toBeHidden({ timeout: 5000 })
      await expect(page.locator('[data-id="billingReadOnlyBanner"]')).toBeHidden({ timeout: 5000 })
    }).toPass({ intervals: retryIntervals, timeout: 30000 })
  })

  test('a directly-canceled tier is not a hard read-only (no billing read-only banner)', async ({ page, request }) => {
    const api = new ApiEndpoint(request)
    const wsInfo = await api.createWorkspaceWithLogin(`unpaid-${generateId(8)}`, 'user1', '1234')
    const wsUrl = wsInfo.workspaceUrl
    await setWorkspacePlanByUuid(wsInfo.workspace, 'start', { status: 'active' })

    await (await page.goto(`${PlatformURI}/workbench/${wsUrl}`))?.finished()
    await expect(page.locator('[data-id="billingLimitsIndicator"]')).toBeVisible({ timeout: 15000 })

    // Canceled directly in the DB is NOT the user-cancel queue event, so no Active-free is provisioned
    // and canceled alone shows no free chip. Limits fail open -> no billing read-only banner either.
    await setWorkspacePlanByUuid(wsInfo.workspace, 'start', { status: 'canceled' })
    await expect(async () => {
      await (await page.goto(`${PlatformURI}/workbench/${wsUrl}`))?.finished()
      await expect(page.locator('[data-id="billingReadOnlyBanner"]')).toBeHidden({ timeout: 5000 })
    }).toPass({ intervals: retryIntervals, timeout: 30000 })
  })
})

// ── D. limits indicator ───────────────────────────────────────────────────────
test.describe('limits indicator', () => {
  test.use({ storageState: PlatformSetting })

  test('owner sees limits indicator and usage popup', async ({ page, request }) => {
    const api = new ApiEndpoint(request)
    const wsInfo = await api.createWorkspaceWithLogin(`ind-${generateId(8)}`, 'user1', '1234')
    const wsUrl = wsInfo.workspaceUrl
    await setWorkspacePlanByUuid(wsInfo.workspace, 'start', {})

    await (await page.goto(`${PlatformURI}/workbench/${wsUrl}/tracker`))?.finished()

    const indicator = page.locator('[data-id="billingLimitsIndicator"]')
    await expect(indicator).toBeVisible({ timeout: 15000 })

    await indicator.hover()
    await expect(page.locator('[data-id="billingUsageSection"]')).toBeVisible({ timeout: 5000 })
  })
})

// NOTE: flat-tier plan switch (storage-mini <-> storage-medium) via UI was removed. Those are
// test-only synthetic plans (priceMonthly, not per-user) that the tbank provider's catalog does not
// carry — tbank handles the real per-seat business tier + add-on packages, covered in billing-ui.spec.ts.

// ── F. seat downgrade puts the over-limit member into read-only ──────────────
// A FRESH workspace per run (no shared state): user1 OWNER + user2 USER, plan usersLimit=2 so both
// finish onboarding while two seats are free. Downgrading to usersLimit=1 keeps the owner (priority
// seat) and pushes user2 over the limit -> read-only banner for user2, none for the owner.
// Per-test workspace avoids the self-corruption a shared seat-ws had: once a member's first-login
// onboarding is rejected by the seat limit, its Employee mixin is never created and every later run
// inherits the broken state.
test.describe('seat downgrade read-only', () => {
  test('downgrading to 1 seat keeps the owner active and makes the second member read-only', async ({
    browser,
    request
  }) => {
    // Fresh workspace owned by user1, with user2 assigned as a USER and a 2-seat plan.
    const api = new ApiEndpoint(request)
    const wsName = `seat-${generateId(8)}`
    const wsInfo = await api.createWorkspaceWithLogin(wsName, 'user1', '1234')
    const wsUrl = wsInfo.workspaceUrl
    await assignMember(PlatformUserSecond, wsInfo.workspace, AccountRole.User)
    await setWorkspacePlanByUuid(wsInfo.workspace, 'start', { users: 2 })

    const ownerContext = await browser.newContext({ storageState: PlatformSetting })
    const ownerPage = await ownerContext.newPage()
    using member = await getSecondPage(browser)
    const memberPage = member.page

    // Owner loads first and takes seat #1. The limits indicator only mounts once the Employee mixin
    // is active, so it is a positive proof of onboarding (an absent read-only banner is not — the
    // whole billing extension is hidden until the mixin exists).
    await (await ownerPage.goto(`${PlatformURI}/workbench/${wsUrl}`))?.finished()
    await expect(ownerPage.locator('[data-id="billingLimitsIndicator"]')).toBeVisible({ timeout: 20000 })

    // Member onboarding races the async plan publish (LimitsChanged -> shared plan map). If the seat
    // limit is still stale at 1 when the member first connects, its mixin activation is rejected and
    // never retried in that session. Reload until the indicator mounts -> mixin created on 2 seats.
    await expect(async () => {
      await (await memberPage.goto(`${PlatformURI}/workbench/${wsUrl}`))?.finished()
      await expect(memberPage.locator('[data-id="billingLimitsIndicator"]')).toBeVisible({ timeout: 5000 })
      await expect(memberPage.locator('[data-id="billingReadOnlyBanner"]')).toBeHidden({ timeout: 5000 })
    }).toPass({ intervals: retryIntervals, timeout: 40000 })

    // Downgrade to a single seat.
    await setWorkspacePlanByUuid(wsInfo.workspace, 'start', { users: 1 })

    // The second member (lower priority than the owner) loses the seat -> read-only banner.
    await expect(async () => {
      await (await memberPage.goto(`${PlatformURI}/workbench/${wsUrl}`))?.finished()
      await expect(memberPage.locator('[data-id="billingReadOnlyBanner"]')).toBeVisible({ timeout: 5000 })
    }).toPass({ intervals: retryIntervals, timeout: 40000 })

    // The owner keeps the seat -> no banner.
    await (await ownerPage.goto(`${PlatformURI}/workbench/${wsUrl}`))?.finished()
    await expect(ownerPage.locator('[data-id="billingReadOnlyBanner"]')).toBeHidden({ timeout: 10000 })

    await ownerContext.close()
  })
})

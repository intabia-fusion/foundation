import { expect, test } from '../fixtures'
import { PlatformSetting, generateId } from '../utils'
import { getTierSubscription, setWorkspacePlanByUuid } from '../API/Billing'
import { ApiEndpoint } from '../API/Api'

// A fresh workspace is auto-provisioned (async, by the payment pod) with a Business trial per
// tests/plan-config.yaml `trial:` (14 days, 10 seats). Buying Business early supersedes the trial.
test.describe('business trial', () => {
  test.use({ storageState: PlatformSetting })

  test('a Business trial grants the plan and shows a future trialEnd', async ({ request }) => {
    const api = new ApiEndpoint(request)
    const wsInfo = await api.createWorkspaceWithLogin(`trial-${generateId(8)}`, 'user1', '1234')

    const trialEnd = Date.now() + 14 * 24 * 3600 * 1000
    await setWorkspacePlanByUuid(wsInfo.workspace, 'business', { status: 'trialing', trialEnd, users: 10 })

    const tier = await getTierSubscription(wsInfo.workspace)
    expect(tier).toBeDefined()
    expect(tier?.status).toBe('trialing')
    expect(tier?.plan).toBe('business')
    expect(tier?.usersLimit).toBe(10)
    expect(tier?.trialEnd).toBeGreaterThan(Date.now())
  })

  test('buying Business early supersedes the trial', async ({ request }) => {
    const api = new ApiEndpoint(request)
    const wsInfo = await api.createWorkspaceWithLogin(`trial-buy-${generateId(8)}`, 'user1', '1234')

    const trialEnd = Date.now() + 14 * 24 * 3600 * 1000
    await setWorkspacePlanByUuid(wsInfo.workspace, 'business', { status: 'trialing', trialEnd, users: 10 })
    expect((await getTierSubscription(wsInfo.workspace))?.status).toBe('trialing')

    // Simulate an early purchase: an active Business tier with a chosen seat count.
    await setWorkspacePlanByUuid(wsInfo.workspace, 'business', { status: 'active', users: 3 })

    const tier = await getTierSubscription(wsInfo.workspace)
    expect(tier?.status).toBe('active')
    expect(tier?.plan).toBe('business')
    expect(tier?.usersLimit).toBe(3)
    expect(tier?.trialEnd ?? null).toBeNull() // trial gone (DB NULL -> null)
  })

  // Upgrading from a free plan to Business must re-resolve limits to the Business tier, not silently
  // keep the free fallback (regression guard for limitsProvider picking the wrong Active row).
  test('upgrading from free (start) to Business recomputes limits to the business tier', async ({ request }) => {
    const api = new ApiEndpoint(request)
    const wsInfo = await api.createWorkspaceWithLogin(`upg-${generateId(8)}`, 'user1', '1234')

    // Free plan first: 5 seats.
    await setWorkspacePlanByUuid(wsInfo.workspace, 'start', { status: 'active', users: 5 })
    expect((await getTierSubscription(wsInfo.workspace))?.usersLimit).toBe(5)

    // Upgrade to Business: seats must reflect the new plan, not the old free limit.
    await setWorkspacePlanByUuid(wsInfo.workspace, 'business', { status: 'active', users: 7 })
    const tier = await getTierSubscription(wsInfo.workspace)
    expect(tier?.plan).toBe('business')
    expect(tier?.status).toBe('active')
    expect(tier?.usersLimit).toBe(7)
  })
})

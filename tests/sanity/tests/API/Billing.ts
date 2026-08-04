import { getClient as getClientRaw, type AccountClient } from '@hcengineering/account-client'
import { AccountRole, type WorkspaceUuid } from '@hcengineering/core'
import { LocalUrl, PlatformAdmin } from '../utils'
import { getServiceAccountClient } from './AccountClient'

let adminClient: AccountClient | undefined

async function getAdmin (): Promise<AccountClient> {
  if (adminClient != null) return adminClient
  const unauth = getClientRaw(LocalUrl)
  const loginInfo = await unauth.login(PlatformAdmin, '1234')
  if (loginInfo == null) throw new Error('Failed to login as admin')
  adminClient = getClientRaw(LocalUrl, loginInfo.token)
  return adminClient
}

/** Resolve workspace uuid by its url-name (e.g. 'limits-unpaid-ws') via admin listing. */
export async function resolveWorkspaceUuid (urlName: string): Promise<WorkspaceUuid> {
  const client = await getAdmin()
  const all = await client.listWorkspaces()
  const ws = all.find((w) => w.url === urlName)
  if (ws == null) throw new Error(`Workspace not found by url: ${urlName}`)
  return ws.uuid
}

export interface PlanLimitsInput {
  status?: string // active|past_due|canceled|expired|trialing
  storageGB?: number // fractional allowed (0.05 = 50MB)
  users?: number
  tokens?: number
  meetingMinutes?: number
  trialEnd?: number // set with status='trialing' to create a real trial subscription
  windowMonth?: number // billed-token monthly window (0 = unlimited)
}

/** Assign an existing account to a workspace with the given role (requires a service token). */
export async function assignMember (email: string, workspaceUuid: WorkspaceUuid, role: AccountRole): Promise<void> {
  const client = await getServiceAccountClient('tool')
  await client.assignWorkspace(email, workspaceUuid, role)
}

interface SubscriptionLimits {
  usersLimit: number
  storageLimitGB: number
  trafficLimitGB: number
  tokenLimit: number
  meetingMinutesLimit: number
  windowMonthLimit: number
}

function buildLimits (input: PlanLimitsInput = {}): SubscriptionLimits {
  return {
    usersLimit: input.users ?? 0,
    storageLimitGB: input.storageGB ?? 0,
    trafficLimitGB: 0,
    tokenLimit: input.tokens ?? 0,
    meetingMinutesLimit: input.meetingMinutes ?? 0,
    windowMonthLimit: input.windowMonth ?? 0
  }
}

/**
 * Wait until the workspace has a tier subscription (the payment pod auto-provisions one — free or
 * trial — asynchronously on workspace creation). Set the plan only after it lands, so the explicit
 * plan wins deterministically instead of racing the async auto-provision.
 */
export async function waitForTier (workspaceUuid: WorkspaceUuid, timeoutMs = 15000): Promise<void> {
  const client = await getAdmin()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const subs = await client.getSubscriptions(workspaceUuid, false)
    if (subs.some((s) => s.type === 'tier')) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

/** Read the current tier subscription (active or trialing) for assertions. */
export async function getTierSubscription (workspaceUuid: WorkspaceUuid): Promise<
| {
  plan: string
  status: string
  usersLimit: number | undefined
  trialEnd: number | undefined
  // Provider payload — carries the recurring-charge consent and the saved-card token.
  providerData: { recurrent?: boolean, rebillId?: string, period?: string } | undefined
}
| undefined
> {
  const client = await getAdmin()
  const subs = await client.getSubscriptions(workspaceUuid, false)
  const tier = subs.find((s) => s.type === 'tier' && (s.status === 'active' || s.status === 'trialing'))
  if (tier == null) return undefined
  return {
    plan: tier.plan,
    status: tier.status,
    usersLimit: tier.limits?.usersLimit,
    trialEnd: tier.trialEnd,
    providerData: tier.providerData as { recurrent?: boolean, rebillId?: string, period?: string } | undefined
  }
}

/** Set a workspace plan by uuid (used for freshly created, per-test workspaces). */
export async function setWorkspacePlanByUuid (
  workspaceUuid: WorkspaceUuid,
  plan: string,
  input: PlanLimitsInput = {}
): Promise<void> {
  // Let the async auto-provisioned tier land first, then supersede it (adminCreateSubscription
  // cancels every prior tier), so a late trial/free never coexists with the explicit plan.
  await waitForTier(workspaceUuid)
  const client = await getAdmin()
  await client.adminCreateSubscription({
    workspaceUuid,
    plan,
    type: 'tier',
    status: input.status ?? 'active',
    trialEnd: input.trialEnd,
    limits: buildLimits(input)
  })
}

/** Attach a disk add-on package (type=package) that adds storageGB on top of the tier limit. */
export async function addStoragePackage (workspaceUuid: WorkspaceUuid, plan: string, storageGB: number): Promise<void> {
  const client = await getAdmin()
  await client.adminCreateSubscription({
    workspaceUuid,
    plan,
    type: 'package',
    status: 'active',
    limits: buildLimits({ storageGB })
  })
}

/** Drive the same admin path the AdminUI uses to (re)create a manual tier subscription. */
export async function setWorkspacePlan (urlName: string, plan: string, input: PlanLimitsInput = {}): Promise<void> {
  const client = await getAdmin()
  const workspaceUuid = await resolveWorkspaceUuid(urlName)
  await client.adminCreateSubscription({
    workspaceUuid,
    plan,
    type: 'tier',
    status: input.status ?? 'active',
    limits: buildLimits(input)
  })
}

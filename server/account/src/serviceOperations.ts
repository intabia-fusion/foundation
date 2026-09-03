//
// Copyright © 2022-2024 Hardcore Engineering Inc.
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//
import {
  AccountRole,
  type Data,
  generateId,
  isActiveMode,
  type MeasureContext,
  SocialIdType,
  type Version,
  type WorkspaceMode,
  type PersonInfo,
  type BackupStatus,
  type Branding,
  type PersonId,
  type PersonUuid,
  type WorkspaceUuid,
  type AccountUuid,
  type UsageStatus,
  type Timestamp,
  readOnlyGuestAccountUuid
} from '@hcengineering/core'
import platform, { getMetadata, PlatformError, Severity, Status, unknownError } from '@hcengineering/platform'
import { decodeTokenVerbose, generateToken, isHumanAdmin, type Token } from '@hcengineering/server-token'

import {
  LimitCategory,
  LimitStatus,
  subscriptionEvents,
  workspaceEvents,
  type QueueWorkspaceMessage
} from '@hcengineering/server-core'

import { isHumanAdminLogin, requireAdminOp, requireAdminSession, verifyAdminOtpLimited } from './adminOp'

import { accountPlugin } from './plugin'
import { SubscriptionStatus, SubscriptionType } from './types'
import type {
  WorkspaceLoginInfo,
  AccountAggregatedInfo,
  AccountsFilter,
  AccountsSortKey,
  AdminActionsQuery,
  AdminActionsResult,
  AccountDB,
  TransactorEndpointInfo,
  AccountMethodHandler,
  Integration,
  IntegrationKey,
  IntegrationSecret,
  IntegrationSecretKey,
  Query,
  OtpInfo,
  SocialId,
  Subscription,
  SubscriptionUpsert,
  PaymentIntent,
  PaymentOperation,
  PaymentOperationStats,
  PaymentOperationFilter,
  PaymentMonthlyStats,
  WorkspacePurchase,
  WorkspacePurchaseStatus,
  Workspace,
  WorkspaceEvent,
  WorkspaceInfoWithStatus,
  WorkspaceOperation,
  WorkspaceStatus,
  WorkspacesPagedQuery,
  WorkspacesPagedResult,
  WorkspacesSummary,
  RegistrationStats,
  WorkspaceActivityPoint,
  WorkspaceMemberDetails,
  AccountActivityStats,
  TierLimits
} from './types'
import {
  integrationServices,
  findExistingIntegration,
  cleanEmail,
  getAccount,
  getEmailSocialId,
  getRegionConfig,
  getRegions,
  getRolePower,
  getSocialIdByKey,
  EndpointKind,
  getEndpoint,
  getWorkspaceById,
  getWorkspaceByUrl,
  getWorkspacesInfoWithStatusByIds,
  verifyAllowedServices,
  wrap,
  addSocialIdBase,
  getWorkspaces,
  updateWorkspaceRole,
  getPersonName,
  doMergeAccounts,
  assignableRoles,
  requestAdminOtp,
  logAdminAction,
  doReleaseSocialId,
  publishMembersChanged
} from './utils'

/** An impersonation session is for a quick look, not for working: it dies in half an hour. */
const IMPERSONATION_TTL_SEC = 1800

// Note: it is IMPORTANT to always destructure params passed here to avoid sending extra params
// to the database layer when searching/inserting as they may contain SQL injection
// !!! NEVER PASS "params" DIRECTLY in any DB functions !!!

// Move to config?
const processingTimeoutMs = 30 * 1000

export async function listWorkspaces (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    region?: string | null
    mode?: WorkspaceMode | null
    visited?: number | null
  }
): Promise<WorkspaceInfoWithStatus[]> {
  const { region, mode, visited } = params
  const { extra } = decodeTokenVerbose(ctx, token)

  if (
    // 'love' polls recently visited workspaces to find meetings left hanging after a restart.
    !['tool', 'backup', 'admin', 'github', 'workspace', 'love', 'billing'].includes(extra?.service) &&
    extra?.admin !== 'true' &&
    extra?.billingAdmin !== 'true'
  ) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  return await getWorkspaces(db, false, region, mode, visited)
}

function checkAdmin (ctx: MeasureContext, token: string): void {
  const { extra } = requireAdminSession(ctx, token)
  if (extra?.admin !== 'true') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
}

// Read-only admin gate: full admin OR billing (view-only) tokens pass.
function checkAdminRead (ctx: MeasureContext, token: string): void {
  requireAdminSession(ctx, token)
}

// Before the session exists: the caller may still ask for an OTP and open one.
function checkHumanAdminLogin (ctx: MeasureContext, token: string): Token {
  const decoded = decodeTokenVerbose(ctx, token)
  if (!isHumanAdminLogin(decoded)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  return decoded
}

export async function listWorkspacesPaged (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: WorkspacesPagedQuery
): Promise<WorkspacesPagedResult> {
  checkAdminRead(ctx, token)
  return await db.listWorkspacesPaged(params)
}

export async function getWorkspacesSummary (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  _params: Record<string, unknown>
): Promise<WorkspacesSummary> {
  checkAdminRead(ctx, token)
  return await db.getWorkspacesSummary()
}

export async function getRegistrationStats (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { from: Timestamp, to: Timestamp }
): Promise<RegistrationStats> {
  checkAdminRead(ctx, token)
  return await db.getRegistrationStats(params.from, params.to)
}

export async function getWorkspaceActivityStats (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { workspace: WorkspaceUuid, from: Timestamp }
): Promise<WorkspaceActivityPoint[]> {
  checkAdminRead(ctx, token)
  return await db.getWorkspaceActivityStats(params.workspace, params.from)
}

export async function getWorkspaceMembersInfo (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { workspace: WorkspaceUuid }
): Promise<WorkspaceMemberDetails[]> {
  checkAdminRead(ctx, token)
  return await db.getWorkspaceMembersInfo(params.workspace)
}

export async function getAccountActivityStats (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { account: AccountUuid, from: Timestamp }
): Promise<AccountActivityStats> {
  checkAdminRead(ctx, token)
  return await db.getAccountActivityStats(params.account, params.from)
}

export async function requestAdminOperationOtp (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  _params: Record<string, unknown>
): Promise<OtpInfo> {
  checkHumanAdminLogin(ctx, token)
  return await requestAdminOtp(ctx, db, branding, token)
}

/**
 * Opens an admin session: consumes the second factor and returns a token stamped with `mfaAt`.
 * Every other admin entry point demands that stamp and refuses it once ADMIN_SESSION_TTL_SEC passes.
 */
export async function verifyAdminSession (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { otpCode: string }
): Promise<{ account: AccountUuid, token: string }> {
  const { account, extra } = checkHumanAdminLogin(ctx, token)
  await verifyAdminOtpLimited(ctx, db, token, params.otpCode)
  const mfaAt = String(Math.floor(Date.now() / 1000))
  await logAdminAction(ctx, db, token, 'admin_session')
  return { account, token: generateToken(account, undefined, { ...extra, mfaAt }) }
}

/**
 * Confirms an operator's intent to export a report. The pages themselves are readable by an admin
 * session; this records the intent under a second factor so an unusual export is visible afterwards.
 */
export async function adminConfirmExport (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { kind: string, filter?: Record<string, any>, otpCode: string }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'export_report', params.otpCode, params.kind)
  await logAdminAction(ctx, db, token, 'export_report', params.kind, undefined, { filter: params.filter })
}

export async function listAdminActions (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: AdminActionsQuery
): Promise<AdminActionsResult> {
  checkAdminRead(ctx, token)
  return await db.listAdminActions(params)
}

/** Release (soft-delete) one social id of any person. OTP-gated and audited. */
export async function adminReleaseSocialId (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { personUuid: PersonUuid, type: SocialIdType, value: string, otpCode: string }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'release_social_id', params.otpCode)
  const { account } = decodeTokenVerbose(ctx, token)
  const { personUuid, type, value } = params

  if (personUuid === account) {
    // Admins must not cut their own login - that would also break the OTP-email lookup.
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  await doReleaseSocialId(db, personUuid, type, value, account, true)
  await logAdminAction(ctx, db, token, 'release_social_id', personUuid, `${type}:${value}`)
  ctx.info('admin: social id released', { personUuid, type })
}

/** Purge an unfinished signup (person without an account row). OTP-gated and audited. */
export async function adminDeletePerson (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { personUuid: PersonUuid, otpCode: string }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'delete_person', params.otpCode)
  const { personUuid } = params

  const person = await db.person.findOne({ uuid: personUuid })
  if (person == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }
  // A finished account must go through deleteAccount - it has workspace/ownership checks.
  const existingAccount = await db.account.findOne({ uuid: personUuid as AccountUuid })
  if (existingAccount != null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const socialIds = await db.socialId.find({ personUuid })
  const label = `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim()
  await db.deletePerson(personUuid)
  await logAdminAction(ctx, db, token, 'delete_person', personUuid, label, {
    socialIds: socialIds.map((s) => `${s.type}:${s.value}`)
  })
  ctx.info('admin: unfinished signup purged', { personUuid })
}

async function ensureNotLastOwner (db: AccountDB, workspace: WorkspaceUuid, target: AccountUuid): Promise<void> {
  const currentRole = await db.getWorkspaceRole(target, workspace)
  if (currentRole === AccountRole.Owner) {
    const owners = (await db.getWorkspaceMembers(workspace)).filter((m) => m.role === AccountRole.Owner)
    if (owners.length === 1) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
  }
}

export async function adminUpdateWorkspaceRole (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { workspace: WorkspaceUuid, targetAccount: AccountUuid, role: AccountRole, otpCode: string }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'update_workspace_role', params.otpCode)
  const { workspace, targetAccount, role } = params
  if (!assignableRoles.includes(role)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }
  const currentRole = await db.getWorkspaceRole(targetAccount, workspace)
  if (currentRole == null || currentRole === role) return
  if (role !== AccountRole.Owner) {
    await ensureNotLastOwner(db, workspace, targetAccount)
  }
  await db.updateWorkspaceRole(targetAccount, workspace, role)
  ctx.info('admin: workspace role updated', { workspace, targetAccount, role })
  await logAdminAction(ctx, db, token, 'update_workspace_role', workspace, undefined, { targetAccount, role })
  await publishMembersChanged(ctx, workspace)
}

export async function adminAddWorkspaceMember (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { workspace: WorkspaceUuid, email: string, role: AccountRole, otpCode: string }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'add_workspace_member', params.otpCode)
  const { workspace, email, role } = params
  if (!assignableRoles.includes(role)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }
  const emailSocialId = await getEmailSocialId(db, cleanEmail(email))
  if (emailSocialId == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, { account: email }))
  }
  const target = emailSocialId.personUuid as AccountUuid
  const currentRole = await db.getWorkspaceRole(target, workspace)
  if (currentRole != null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }
  await db.assignWorkspace(target, workspace, role)
  ctx.info('admin: workspace member added', { workspace, target, role })
  await logAdminAction(ctx, db, token, 'add_workspace_member', workspace, email, { target, role })
  await publishMembersChanged(ctx, workspace)
}

async function sendReindex (ctx: MeasureContext, workspace: WorkspaceUuid): Promise<void> {
  const producer = getMetadata(accountPlugin.metadata.FulltextQueue)
  if (producer === undefined) {
    throw new PlatformError(unknownError('Fulltext queue is not configured'))
  }
  await producer.send(ctx, workspace, [workspaceEvents.fullReindex()])
}

export async function adminReindexWorkspace (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { workspace: WorkspaceUuid, otpCode: string }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'reindex', params.otpCode, params.workspace)
  await sendReindex(ctx, params.workspace)
  ctx.info('admin: reindex requested', { workspace: params.workspace })
  await logAdminAction(ctx, db, token, 'reindex', params.workspace)
}

/**
 * Broadcasts a global maintenance warning. Replaces the account `PUT /api/v1/manage?operation=maintenance`
 * endpoint, which carried the token in the query string and had no audit trail.
 */
export async function adminSetMaintenance (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { timeoutMinutes: number, message?: string, otpCode: string }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'set_maintenance', params.otpCode)
  const producer = getMetadata(accountPlugin.metadata.WorkspaceQueue)
  if (producer === undefined) {
    throw new PlatformError(unknownError('Workspace queue is not configured'))
  }
  // Global event: every transactor consumes the workspace topic in its own group,
  // the workspace key carries no meaning here.
  const nilWorkspace = '00000000-0000-0000-0000-000000000000' as WorkspaceUuid
  await producer.send(ctx, nilWorkspace, [workspaceEvents.maintenance(params.timeoutMinutes, params.message)])
  ctx.info('admin: maintenance broadcast', { timeoutMinutes: params.timeoutMinutes })
  await logAdminAction(ctx, db, token, 'set_maintenance', undefined, undefined, {
    timeoutMinutes: params.timeoutMinutes,
    message: params.message
  })
}

/**
 * Drops every live session of a workspace. Previously the admin panel fanned this out to each
 * transactor from the browser; now one queued event reaches whichever transactor holds the workspace.
 */
export async function adminForceCloseWorkspace (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { workspace: WorkspaceUuid, otpCode: string }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'force_close', params.otpCode, params.workspace)
  const producer = getMetadata(accountPlugin.metadata.WorkspaceQueue)
  if (producer === undefined) {
    throw new PlatformError(unknownError('Workspace queue is not configured'))
  }
  await producer.send(ctx, params.workspace, [workspaceEvents.forceClose()])
  ctx.info('admin: force close requested', { workspace: params.workspace })
  await logAdminAction(ctx, db, token, 'force_close', params.workspace)
}

/**
 * Opens a read-only session inside a workspace as one of its members, so an operator can see exactly
 * what that person sees. The token carries `impersonatedBy` and `readonly`; the transactor refuses
 * every write, so an operator can never act as the user.
 */
export async function adminImpersonate (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { workspace: WorkspaceUuid, account: AccountUuid, otpCode: string }
): Promise<WorkspaceLoginInfo> {
  const { account: adminAccount } = await requireAdminOp(
    ctx,
    db,
    token,
    'impersonate',
    params.otpCode,
    params.workspace
  )

  const workspace = await getWorkspaceById(db, params.workspace)
  if (workspace == null) {
    throw new PlatformError(
      new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid: params.workspace })
    )
  }

  // Only a real member can be impersonated: this is "see their screen", not "get in anywhere".
  const role = await db.getWorkspaceRole(params.account, params.workspace)
  if (role == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const exp = Math.floor(Date.now() / 1000) + IMPERSONATION_TTL_SEC
  const impersonated = generateToken(
    params.account,
    workspace.uuid,
    { impersonatedBy: adminAccount, readonly: 'true' },
    undefined,
    { exp }
  )

  await logAdminAction(ctx, db, token, 'impersonate', params.workspace, workspace.name, {
    target: params.account,
    role
  })

  return {
    account: params.account,
    token: impersonated,
    endpoint: getEndpoint(workspace.uuid, workspace.region, EndpointKind.External),
    workspace: workspace.uuid,
    workspaceUrl: workspace.url,
    workspaceDataId: workspace.dataId,
    role,
    disabledFeaturesOverride: workspace.disabledFeaturesOverride
  }
}

export async function adminReindexAllWorkspaces (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { otpCode: string }
): Promise<number> {
  await requireAdminOp(ctx, db, token, 'reindex_all', params.otpCode)
  const workspaces = await getWorkspaces(db, false, null, 'active')
  for (const ws of workspaces) {
    await sendReindex(ctx, ws.uuid)
  }
  ctx.info('admin: reindex-all requested', { count: workspaces.length })
  await logAdminAction(ctx, db, token, 'reindex_all', undefined, undefined, { count: workspaces.length })
  return workspaces.length
}

export async function adminRemoveWorkspaceMember (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { workspace: WorkspaceUuid, targetAccount: AccountUuid, otpCode: string }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'remove_workspace_member', params.otpCode)
  const { workspace, targetAccount } = params
  await ensureNotLastOwner(db, workspace, targetAccount)
  await db.unassignWorkspace(targetAccount, workspace)
  ctx.info('admin: workspace member removed', { workspace, targetAccount })
  await logAdminAction(ctx, db, token, 'remove_workspace_member', workspace, undefined, { targetAccount })
  await publishMembersChanged(ctx, workspace)
}

const emptyTierLimits: TierLimits = {
  storageLimitGB: 0,
  trafficLimitGB: 0,
  meetingMinutesLimit: 0,
  tokenLimit: 0,
  usersLimit: 0
}

export async function adminUpdateSubscription (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    subscriptionId: string
    seats?: number
    periodEndMs?: number
    amount?: number
    windowMonthLimit?: number
    otpCode: string
  }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'update_subscription', params.otpCode)
  const { subscriptionId, seats, periodEndMs, amount, windowMonthLimit } = params

  const existing = await db.subscription.findOne({ id: subscriptionId })
  if (existing == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }
  if (existing.status === SubscriptionStatus.Canceled) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const updates: Partial<Subscription> = {}
  if (seats != null) {
    if (!Number.isFinite(seats) || seats < 1) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
    }
    const baseLimits = existing.limits ?? emptyTierLimits
    const perUserStorage =
      existing.limits != null && (existing.limits.usersLimit ?? 0) > 0
        ? Math.round((existing.limits.storageLimitGB ?? 0) / existing.limits.usersLimit)
        : 0
    updates.limits = {
      ...baseLimits,
      usersLimit: Math.round(seats),
      storageLimitGB: perUserStorage > 0 ? perUserStorage * Math.round(seats) : (baseLimits.storageLimitGB ?? 0)
    }
  }
  if (windowMonthLimit != null) {
    // The admin UI computes new token limits and sends the value
    if (!Number.isInteger(windowMonthLimit) || windowMonthLimit < 0) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
    }
    updates.limits = { ...(updates.limits ?? existing.limits ?? emptyTierLimits), windowMonthLimit }
  }
  if (amount != null) {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
    }
    updates.amount = amount
  }
  if (periodEndMs != null) {
    if (!Number.isFinite(periodEndMs)) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
    }
    updates.periodEnd = Math.round(periodEndMs)
    // For a trial the UI/limits key off trialEnd, so keep it in sync with the edited period end.
    if (existing.status === SubscriptionStatus.Trialing) {
      updates.trialEnd = Math.round(periodEndMs)
    }
  }
  if (Object.keys(updates).length === 0) return

  const now = Date.now()
  const oldProviderData: Record<string, any> = (existing.providerData as Record<string, any>) ?? {}
  // Updating the row in db instead of inserting new row: PaymentId stays the same.
  await db.subscription.update(
    { id: existing.id },
    {
      ...updates,
      updatedOn: now,
      providerData: {
        ...oldProviderData,
        // Renewal and the ledger read seats from quantity, not from limits.
        ...(seats != null && { quantity: Math.round(seats) }),
        reason: 'ADMIN_EDITED',
        modifiedAt: now
      }
    }
  )
  ctx.info('admin: subscription updated', {
    id: existing.id,
    workspaceUuid: existing.workspaceUuid,
    seats,
    periodEndMs,
    amount,
    windowMonthLimit
  })
  await logAdminAction(ctx, db, token, 'update_subscription', existing.workspaceUuid, existing.plan, {
    subscriptionId,
    seats,
    periodEndMs,
    amount,
    windowMonthLimit
  })
  // Also record it in the payment ledger to keep the billing timeline consistent.
  try {
    await db.logPaymentOperation({
      provider: existing.provider,
      operation: 'update',
      status: 'ADMIN_EDITED',
      paymentId: existing.providerSubscriptionId,
      orderId: oldProviderData.orderId as string | undefined,
      subscriptionId: existing.id,
      workspaceUuid: existing.workspaceUuid,
      accountUuid: existing.accountUuid,
      actionId: oldProviderData.actionId as string | undefined,
      actor: 'admin',
      // The new recurring price, or the unchanged one when the edit left it alone.
      amount: updates.amount ?? (existing.amount != null ? Number(existing.amount) : undefined),
      raw: {
        plan: existing.plan,
        type: existing.type,
        reason: 'ADMIN_EDITED',
        seatsBefore: oldProviderData.quantity ?? existing.limits?.usersLimit,
        seatsAfter: seats,
        periodEndBefore: existing.periodEnd,
        periodEndAfter: updates.periodEnd,
        windowBefore: existing.limits?.windowMonthLimit,
        windowAfter: windowMonthLimit,
        amountBefore: existing.amount != null ? Number(existing.amount) : undefined,
        amountAfter: updates.amount
      },
      createdOn: now
    })
  } catch (err: any) {
    ctx.error('Failed to log admin subscription edit to payment ledger', { subscriptionId: existing.id, err })
  }

  if (existing.type === SubscriptionType.Tier) {
    await publishLimitsEvents(ctx, existing.workspaceUuid, [
      workspaceEvents.limitsChanged(LimitCategory.Plan, LimitStatus.Ok)
    ])
  }
}

export async function adminCancelSubscription (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { subscriptionId: string, otpCode: string }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'cancel_subscription', params.otpCode)
  const existing = await db.subscription.findOne({ id: params.subscriptionId })
  if (existing == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }
  if (existing.status === SubscriptionStatus.Canceled) return

  const now = Date.now()
  const oldProviderData: Record<string, any> = (existing.providerData as Record<string, any>) ?? {}
  await db.subscription.update(
    { id: existing.id },
    {
      status: SubscriptionStatus.Canceled,
      canceledAt: now,
      updatedOn: now,
      providerData: { ...oldProviderData, pending: false, status: 'ADMIN_CANCELED', modifiedAt: now }
    }
  )
  ctx.info('admin: subscription canceled', { id: existing.id, workspaceUuid: existing.workspaceUuid })
  await logAdminAction(ctx, db, token, 'cancel_subscription', existing.workspaceUuid, existing.plan, {
    subscriptionId: existing.id
  })
  // Also record it in the payment ledger to keep the billing timeline consistent.
  try {
    await db.logPaymentOperation({
      provider: existing.provider,
      operation: 'cancel',
      status: 'ADMIN_CANCELED',
      paymentId: existing.providerSubscriptionId,
      orderId: oldProviderData.orderId as string | undefined,
      subscriptionId: existing.id,
      workspaceUuid: existing.workspaceUuid,
      accountUuid: existing.accountUuid,
      actionId: oldProviderData.actionId as string | undefined,
      actor: 'admin',
      amount: existing.amount,
      raw: { plan: existing.plan, seats: oldProviderData.quantity, type: existing.type, reason: 'ADMIN_CANCELED' },
      createdOn: now
    })
  } catch (err: any) {
    ctx.error('Failed to log admin cancel to payment ledger', { subscriptionId: existing.id, err })
  }

  if (existing.type === SubscriptionType.Tier) {
    await publishLimitsEvents(ctx, existing.workspaceUuid, [
      workspaceEvents.limitsChanged(LimitCategory.Plan, LimitStatus.Ok)
    ])
    // pod-payment owns the free-plan config, so it decides whether a free fallback follows this cancel.
    await publishAdminCanceled(ctx, { ...existing, status: SubscriptionStatus.Canceled, canceledAt: now })
  }
}

export async function adminUpdateWorkspaceName (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { workspace: WorkspaceUuid, name: string, otpCode: string }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'rename_workspace', params.otpCode, params.workspace)
  const name = params.name.trim()
  if (name.length === 0) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }
  const ws = await getWorkspaceById(db, params.workspace)
  if (ws == null) {
    throw new PlatformError(
      new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid: params.workspace })
    )
  }
  await db.workspace.update({ uuid: params.workspace }, { name })
  ctx.info('admin: workspace renamed', { workspace: params.workspace, name })
  await logAdminAction(ctx, db, token, 'rename_workspace', params.workspace, name)
}

export async function adminUpdateWorkspaceDisabledFeatures (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { workspace: WorkspaceUuid, features: string[], otpCode: string }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'set_disabled_features', params.otpCode, params.workspace)
  const ws = await getWorkspaceById(db, params.workspace)
  if (ws == null) {
    throw new PlatformError(
      new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid: params.workspace })
    )
  }
  await db.workspace.update({ uuid: params.workspace }, { disabledFeaturesOverride: params.features })
  ctx.info('admin: workspace disabled features override updated', {
    workspace: params.workspace,
    features: params.features
  })
  await logAdminAction(ctx, db, token, 'set_disabled_features', params.workspace, params.features.join(', '))
}

export async function adminUpdateWorkspaceUrl (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { workspace: WorkspaceUuid, url: string, otpCode: string }
): Promise<void> {
  await requireAdminOp(ctx, db, token, 'change_workspace_url', params.otpCode)
  const url = params.url.trim().toLowerCase()
  if (url.length === 0) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }
  const ws = await getWorkspaceById(db, params.workspace)
  if (ws == null) {
    throw new PlatformError(
      new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid: params.workspace })
    )
  }
  const clash = await getWorkspaceByUrl(db, url)
  if (clash != null && clash.uuid !== params.workspace) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceAlreadyExists, { workspace: url }))
  }
  await db.workspace.update({ uuid: params.workspace }, { url })
  ctx.info('admin: workspace url changed', { workspace: params.workspace, url })
  await logAdminAction(ctx, db, token, 'change_workspace_url', params.workspace, url)
}

/** All configured transactor endpoints (admin-only), for targeting manage calls at a specific transactor */
export async function getTransactorEndpoints (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<TransactorEndpointInfo[]> {
  checkAdmin(ctx, token)
  const config = getRegionConfig()
  const res: TransactorEndpointInfo[] = []
  for (const [region, eps] of Object.entries(config.regions)) {
    for (const t of eps.transactors) {
      res.push({ region, name: eps.name, external: t.external })
    }
  }
  return res
}

export async function listAccounts (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    search?: string
    skip?: number
    limit?: number
    sort?: AccountsSortKey
    filter?: AccountsFilter
    order?: 'asc' | 'desc'
  }
): Promise<AccountAggregatedInfo[]> {
  const { extra } = decodeTokenVerbose(ctx, token)

  if (extra?.service !== 'workspace') {
    checkAdminRead(ctx, token)
  }

  const { skip, limit, search, sort, filter, order } = params

  const accounts = await db.listAccounts(search, skip, limit, sort, filter, order)
  if (extra?.service === undefined) {
    // Reading other people's emails and activity is PII access: record who looked at what.
    await logAdminAction(ctx, db, token, 'read_accounts', undefined, search, { filter, count: accounts.length })
  }
  return accounts
}

export async function performWorkspaceOperation (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  parameters: {
    workspaceId: WorkspaceUuid | WorkspaceUuid[]
    event: 'archive' | 'migrate-to' | 'unarchive' | 'delete' | 'reset-attempts'
    params: any[]
    otpCode?: string
  }
): Promise<boolean> {
  const { workspaceId, event, params, otpCode } = parameters
  const { extra, workspace, account } = decodeTokenVerbose(ctx, token)

  const isAdminUser = isHumanAdmin({ account, extra })

  if (extra?.admin !== 'true') {
    if (event !== 'unarchive' || workspaceId !== workspace) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
  }

  // Every workspace operation by a human admin requires an emailed OTP and lands in the audit trail.
  // System/service tokens (backup/workspace/tool) run unattended and are exempt.
  if (isAdminUser) {
    await requireAdminOp(ctx, db, token, `workspace_${event}`, otpCode ?? '')
  }

  const workspaceUuids = Array.isArray(workspaceId) ? workspaceId : [workspaceId]

  const workspaces = await getWorkspacesInfoWithStatusByIds(db, workspaceUuids)
  if (workspaces.length === 0) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, {}))
  }

  let ops = 0
  for (const workspace of workspaces) {
    const update: Partial<WorkspaceStatus> = {}
    switch (event) {
      case 'reset-attempts':
        update.processingAttempts = 0
        update.lastProcessingTime = Date.now() - processingTimeoutMs // To not wait for next step
        break
      case 'delete':
        if (workspace.status.mode !== 'active') {
          throw new PlatformError(unknownError('Delete allowed only for active workspaces'))
        }

        update.mode = 'pending-deletion'
        update.processingAttempts = 0
        update.processingProgress = 0
        update.lastProcessingTime = Date.now() - processingTimeoutMs // To not wait for next step
        break
      case 'archive':
        if (!isActiveMode(workspace.status.mode)) {
          throw new PlatformError(unknownError('Archiving allowed only for active workspaces'))
        }

        update.mode = 'archiving-pending-backup'
        update.processingAttempts = 0
        update.processingProgress = 0
        update.lastProcessingTime = Date.now() - processingTimeoutMs // To not wait for next step
        break
      case 'unarchive':
        if (event === 'unarchive') {
          if (workspace.status.mode !== 'archived') {
            throw new PlatformError(unknownError('Unarchive allowed only for archived workspaces'))
          }
        }

        update.mode = 'pending-restore'
        update.processingAttempts = 0
        update.processingProgress = 0
        update.lastProcessingTime = Date.now() - processingTimeoutMs // To not wait for next step
        break
      case 'migrate-to': {
        if (!isActiveMode(workspace.status.mode)) {
          return false
        }
        if (params.length !== 1 && params[0] == null) {
          throw new PlatformError(unknownError('Invalid region passed to migrate operation'))
        }
        const regions = getRegions()
        if (regions.find((it) => it.region === params[0]) === undefined) {
          throw new PlatformError(unknownError('Invalid region passed to migrate operation'))
        }
        if ((workspace.region ?? '') === params[0]) {
          throw new PlatformError(unknownError('Invalid region passed to migrate operation'))
        }

        update.mode = 'migration-pending-backup'
        // NOTE: will only work for Mongo accounts
        update.targetRegion = params[0]
        update.processingAttempts = 0
        update.processingProgress = 0
        update.lastProcessingTime = Date.now() - processingTimeoutMs // To not wait for next step
        break
      }
      default:
        break
    }

    if (Object.keys(update).length !== 0) {
      await db.workspaceStatus.update({ workspaceUuid: workspace.uuid }, update)
      ops++
    }
  }

  // Only human admin actions belong in the audit trail; service tokens run unattended.
  if (isAdminUser && ops > 0) {
    for (const workspace of workspaces) {
      await logAdminAction(ctx, db, token, `workspace_${event}`, workspace.uuid, workspace.name, { params })
    }
  }
  return ops > 0
}

export async function updateWorkspaceRoleBySocialKey (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    socialKey: string
    targetRole: AccountRole
  }
): Promise<void> {
  const { socialKey, targetRole } = params

  if (socialKey == null || socialKey === '' || targetRole == null || !assignableRoles.includes(targetRole)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { extra } = decodeTokenVerbose(ctx, token)
  verifyAllowedServices(['workspace', 'tool'], extra)

  const socialId = await getSocialIdByKey(db, socialKey.toLowerCase() as PersonId)
  if (socialId == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, {}))
  }

  await updateWorkspaceRole(ctx, db, branding, token, { targetAccount: socialId.personUuid as AccountUuid, targetRole })
}

/**
 * Retrieves one workspace for which there are things to process.
 *
 * Workspace is provided for 30seconds. This timeout is reset
 * on every progress update.
 * If no progress is reported for the workspace during this time,
 * it will become available again to be processed by another executor.
 */
export async function getPendingWorkspace (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    region: string
    version: Data<Version>
    operation: WorkspaceOperation
  }
): Promise<WorkspaceInfoWithStatus | undefined> {
  const { region, version, operation } = params
  const { extra } = decodeTokenVerbose(ctx, token)
  if (extra?.service !== 'workspace') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const wsLivenessDays = getMetadata(accountPlugin.metadata.WsLivenessDays)
  const wsLivenessMs = wsLivenessDays !== undefined ? wsLivenessDays * 24 * 60 * 60 * 1000 : undefined

  const result = await db.getPendingWorkspace(region, version, operation, processingTimeoutMs, wsLivenessMs)

  if (result != null) {
    ctx.info('getPendingWorkspace', {
      workspaceId: result.uuid,
      workspaceName: result.name,
      dataId: result.dataId,
      mode: result.status.mode,
      operation,
      region,
      major: result.status.versionMajor,
      minor: result.status.versionMinor,
      patch: result.status.versionPatch,
      requestedVersion: version
    })
  }

  return result
}

export async function updateWorkspaceInfo (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    workspaceUuid: WorkspaceUuid
    event: WorkspaceEvent
    version: Data<Version> // A worker version
    progress: number
    message?: string
  }
): Promise<void> {
  const { workspaceUuid, event, version, message } = params

  const { extra } = decodeTokenVerbose(ctx, token)
  if (!['workspace', 'tool'].includes(extra?.service)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  if (workspaceUuid == null || workspaceUuid === '' || event == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  let progress = params.progress

  const wsExists = await db.workspace.exists({ uuid: workspaceUuid })
  if (!wsExists) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }
  progress = Math.round(progress)

  const ts = Date.now()
  const update: Partial<WorkspaceStatus> = {}
  const wsUpdate: Partial<Workspace> = {}
  const query: Query<WorkspaceStatus> = { workspaceUuid }

  // Only read status for certain events because it is not needed for others
  // and it interferes with status updates when concurrency is high
  let wsStatus: WorkspaceStatus | null = null
  if (['create-started', 'upgrade-started', 'migrate-clean-done'].includes(event)) {
    wsStatus = await db.workspaceStatus.findOne({ workspaceUuid })
  }
  switch (event) {
    case 'create-started':
      update.mode = 'creating'
      if (wsStatus != null && wsStatus.mode !== 'creating') {
        update.processingAttempts = 0
      }
      update.processingProgress = progress
      break
    case 'upgrade-started':
      if (wsStatus != null && wsStatus.mode !== 'upgrading') {
        update.processingAttempts = 0
      }
      update.mode = 'upgrading'
      update.processingProgress = progress
      break
    case 'create-done':
      ctx.info('Updating workspace info on create-done', { workspaceUuid, event, version, progress })
      update.mode = 'active'
      update.isDisabled = false
      update.versionMajor = version.major
      update.versionMinor = version.minor
      update.versionPatch = version.patch
      update.processingProgress = progress
      break
    case 'upgrade-done':
      ctx.info('Updating workspace info on upgrade-done', { workspaceUuid, event, version, progress })
      update.mode = 'active'
      update.versionMajor = version.major
      update.versionMinor = version.minor
      update.versionPatch = version.patch
      update.processingProgress = progress
      break
    case 'progress':
      update.processingProgress = progress
      query.processingProgress = { $lte: progress }
      break
    case 'migrate-backup-started':
      update.mode = 'migration-backup'
      update.processingProgress = progress
      break
    case 'migrate-backup-done':
      update.mode = 'migration-pending-clean'
      update.processingProgress = progress
      update.lastProcessingTime = Date.now() - processingTimeoutMs // To not wait for next step
      break
    case 'migrate-clean-started':
      update.mode = 'migration-clean'
      update.processingAttempts = 0
      update.processingProgress = progress
      break
    case 'migrate-clean-done':
      wsUpdate.region = wsStatus?.targetRegion ?? ''
      update.mode = 'pending-restore'
      update.processingProgress = progress
      update.lastProcessingTime = Date.now() - processingTimeoutMs // To not wait for next step
      break
    case 'restore-started':
      update.mode = 'restoring'
      update.processingAttempts = 0
      update.processingProgress = progress
      break
    case 'restore-done':
      update.mode = 'active'
      update.processingProgress = 100
      update.lastProcessingTime = Date.now() - processingTimeoutMs // To not wait for next step
      break
    case 'archiving-backup-started':
      update.mode = 'archiving-backup'
      update.processingAttempts = 0
      update.processingProgress = progress
      break
    case 'archiving-backup-done':
      update.mode = 'archiving-pending-clean'
      update.processingProgress = progress
      update.lastProcessingTime = Date.now() - processingTimeoutMs // To not wait for next step
      break
    case 'archiving-clean-started':
      update.mode = 'archiving-clean'
      update.processingAttempts = 0
      update.processingProgress = progress
      break
    case 'archiving-clean-done':
      update.mode = 'archived'
      update.processingProgress = 100
      break
    // Without these two the worker drops the DB while the row stays in pending-deletion: every
    // re-pick bumps processing_attempts and past the retry cap the workspace falls out for good.
    case 'delete-started':
      update.mode = 'deleting'
      update.processingAttempts = 0
      update.processingProgress = progress
      break
    case 'delete-done':
      update.mode = 'deleted'
      update.processingProgress = 100
      break
    case 'ping':
    default:
      query.lastProcessingTime = { $lte: ts }
      break
  }

  if (message != null) {
    update.processingMessage = message
  }

  await db.workspaceStatus.update(query, {
    lastProcessingTime: ts, // Some operations override it.
    ...update
  })

  if (Object.keys(wsUpdate).length !== 0) {
    await db.workspace.update({ uuid: workspaceUuid }, wsUpdate)
  }
}

export async function workerHandshake (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    region: string
    version: Data<Version>
    operation: WorkspaceOperation
  }
): Promise<void> {
  const { region, version, operation } = params
  const { extra } = decodeTokenVerbose(ctx, token)
  if (extra?.service !== 'workspace') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  ctx.info('Worker handshake happened', { region, version, operation })
  // Nothing else to do now but keeping to have track of workers in logs
}

export async function updateBackupInfo (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { backupInfo: BackupStatus }
): Promise<void> {
  const { backupInfo } = params
  const { extra, workspace } = decodeTokenVerbose(ctx, token)
  if (extra?.service !== 'backup') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const workspaceInfo = await getWorkspaceById(db, workspace)
  if (workspaceInfo === null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid: workspace }))
  }

  await db.workspaceStatus.update(
    { workspaceUuid: workspace },
    {
      backupInfo
    }
  )
}

export async function updateUsageInfo (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { usageInfo: UsageStatus }
): Promise<void> {
  const { usageInfo } = params
  const { extra, workspace } = decodeTokenVerbose(ctx, token)
  if (extra?.service !== 'billing') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const workspaceInfo = await getWorkspaceById(db, workspace)
  if (workspaceInfo === null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid: workspace }))
  }

  await db.workspaceStatus.update(
    { workspaceUuid: workspace },
    {
      usageInfo
    }
  )
}

export async function assignWorkspace (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    email: string
    workspaceUuid: WorkspaceUuid
    role: AccountRole
  }
): Promise<void> {
  const { email, workspaceUuid, role } = params
  const { extra } = decodeTokenVerbose(ctx, token)
  if (!['aibot', 'tool', 'workspace'].includes(extra?.service)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  if (
    email == null ||
    email === '' ||
    workspaceUuid == null ||
    workspaceUuid === '' ||
    role == null ||
    !assignableRoles.includes(role)
  ) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const normalizedEmail = cleanEmail(email)
  const emailSocialId = await getEmailSocialId(db, normalizedEmail)

  if (emailSocialId == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, {}))
  }

  const account = await getAccount(db, emailSocialId.personUuid as AccountUuid)

  if (account == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, {}))
  }

  const workspace = await getWorkspaceById(db, workspaceUuid)

  if (workspace == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  const currentRole = await db.getWorkspaceRole(account.uuid, workspaceUuid)

  if (currentRole == null) {
    await db.assignWorkspace(account.uuid, workspaceUuid, role)
    await publishMembersChanged(ctx, workspaceUuid)
  } else if (getRolePower(currentRole) < getRolePower(role)) {
    await db.updateWorkspaceRole(account.uuid, workspaceUuid, role)
    await publishMembersChanged(ctx, workspaceUuid)
  }
}

export async function getPersonInfo (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { account: PersonUuid }
): Promise<PersonInfo> {
  const { account } = params
  const { extra } = decodeTokenVerbose(ctx, token)
  if (extra?.admin !== 'true') {
    verifyAllowedServices(['workspace', 'tool', 'gmail', 'huly-mail', 'mail-service', 'export', 'payment'], extra)
  }

  if (account == null || account === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const person = await db.person.findOne({ uuid: account })

  if (person == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.PersonNotFound, { person: account }))
  }

  const verifiedSocialIds = await db.socialId.find({ personUuid: account, verifiedOn: { $gt: 0 } })

  return {
    personUuid: account,
    name: getPersonName(person),
    socialIds: verifiedSocialIds,
    phoneHint: person.phoneHint
  }
}

export async function addSocialIdToPerson (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { person: PersonUuid, type: SocialIdType, value: string, confirmed: boolean, displayValue?: string }
): Promise<PersonId> {
  const { person, type, value, confirmed, displayValue } = params
  const { extra } = decodeTokenVerbose(ctx, token)

  // Services only: attaching an identity to a person is not an admin-panel action.
  verifyAllowedServices(
    ['github', 'telegram-bot', 'gmail', 'tool', 'workspace', 'hulygram', 'google-calendar', 'ai-assistant'],
    extra
  )

  if (person == null || person === '' || !Object.values(SocialIdType).includes(type) || value == null || value === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  return await addSocialIdBase(db, person, type, value, confirmed, displayValue)
}

export async function updateSocialId (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { personId: PersonId, displayValue: string }
): Promise<void> {
  const { personId, displayValue } = params
  const { extra } = decodeTokenVerbose(ctx, token)

  verifyAllowedServices(['telegram-bot', 'gmail'], extra)

  if (personId == null || personId === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const socialId = await db.socialId.findOne({ _id: personId })
  if (socialId != null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.SocialIdNotFound, { _id: personId }))
  }

  await db.socialId.update({ _id: personId }, { displayValue })
}

export async function createIntegration (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: Integration
): Promise<void> {
  const { extra, account } = decodeTokenVerbose(ctx, token)
  // it checks params and throws BadRequest if params are invalid
  const existing = await findExistingIntegration(account, db, params, extra)
  if (existing != null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationAlreadyExists, {}))
  }

  const { socialId, kind, workspaceUuid, data } = params
  const social = await db.socialId.findOne({ _id: socialId })

  if (social?.personUuid === readOnlyGuestAccountUuid) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  await db.integration.insertOne({ socialId, kind, workspaceUuid, data })
}

export async function updateIntegration (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: Integration
): Promise<void> {
  const { extra, account } = decodeTokenVerbose(ctx, token)
  // it checks params and throws BadRequest if params are invalid
  const existing = await findExistingIntegration(account, db, params, extra)
  if (existing == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationNotFound, {}))
  }

  const { socialId, kind, workspaceUuid, data } = params
  await db.integration.update({ socialId, kind, workspaceUuid }, { data })
}

export async function deleteIntegration (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: IntegrationKey
): Promise<void> {
  const { extra, account } = decodeTokenVerbose(ctx, token)
  // it checks params and throws BadRequest if params are invalid
  const existing = await findExistingIntegration(account, db, params, extra)
  if (existing == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationNotFound, {}))
  }

  const { socialId, kind, workspaceUuid } = params
  await db.integrationSecret.deleteMany({ socialId, kind, workspaceUuid })
  await db.integration.deleteMany({ socialId, kind, workspaceUuid })
}

export async function listIntegrations (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: Partial<IntegrationKey>
): Promise<Integration[]> {
  const { account, extra } = decodeTokenVerbose(ctx, token)
  const isAllowedService = verifyAllowedServices(integrationServices, extra, false)
  const { socialId, kind, workspaceUuid } = params
  let socialIds: PersonId[] | undefined

  if (isAllowedService) {
    socialIds = socialId != null ? [socialId] : undefined
  } else {
    const socialIdObjs = await db.socialId.find({ personUuid: account, verifiedOn: { $gt: 0 } })

    if (socialIdObjs.length === 0) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }

    const allowedSocialIds = socialIdObjs.map((it) => it._id)

    if (socialId !== undefined) {
      if (!allowedSocialIds.includes(socialId)) {
        throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      }

      socialIds = [socialId]
    } else {
      socialIds = allowedSocialIds
    }
  }

  return await db.integration.find({
    ...(socialIds != null ? { socialId: { $in: socialIds } } : {}),
    kind,
    workspaceUuid
  })
}

export async function getIntegration (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: IntegrationKey
): Promise<Integration | null> {
  const { account, extra } = decodeTokenVerbose(ctx, token)
  const isAllowedService = verifyAllowedServices(integrationServices, extra, false)
  const { socialId, kind, workspaceUuid } = params

  if (kind == null || kind === '' || socialId == null || socialId === '' || workspaceUuid === undefined) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  if (!isAllowedService) {
    const existingSocialId = await db.socialId.findOne({ _id: socialId, personUuid: account, verifiedOn: { $gt: 0 } })

    if (existingSocialId == null) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
  }

  return await db.integration.findOne({ socialId, kind, workspaceUuid })
}

export async function addIntegrationSecret (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: IntegrationSecret
): Promise<void> {
  const { extra, account } = decodeTokenVerbose(ctx, token)
  const { socialId, kind, workspaceUuid, key, secret } = params
  if (
    kind == null ||
    kind === '' ||
    socialId == null ||
    socialId === '' ||
    workspaceUuid === undefined ||
    key == null
  ) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const existingIntegration = await findExistingIntegration(account, db, params, extra)
  if (existingIntegration == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationNotFound, {}))
  }

  const secretKey: IntegrationSecretKey = { socialId, kind, workspaceUuid, key }
  const existingSecret = await db.integrationSecret.findOne(secretKey)
  if (existingSecret != null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationSecretAlreadyExists, {}))
  }

  await db.integrationSecret.insertOne({ ...secretKey, secret })
}

export async function updateIntegrationSecret (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: IntegrationSecret
): Promise<void> {
  const { extra, account } = decodeTokenVerbose(ctx, token)
  const { socialId, kind, workspaceUuid, key, secret } = params
  if (
    kind == null ||
    kind === '' ||
    socialId == null ||
    socialId === '' ||
    workspaceUuid === undefined ||
    key == null
  ) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const existingIntegration = await findExistingIntegration(account, db, params, extra)
  if (existingIntegration == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationNotFound, {}))
  }

  const secretKey: IntegrationSecretKey = { socialId, kind, workspaceUuid, key }
  const existingSecret = await db.integrationSecret.findOne(secretKey)
  if (existingSecret == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationSecretNotFound, {}))
  }

  await db.integrationSecret.update(secretKey, { secret })
}

export async function deleteIntegrationSecret (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: IntegrationSecretKey
): Promise<void> {
  const { extra, account } = decodeTokenVerbose(ctx, token)
  const { socialId, kind, workspaceUuid, key } = params
  if (
    kind == null ||
    kind === '' ||
    socialId == null ||
    socialId === '' ||
    workspaceUuid === undefined ||
    key == null
  ) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const existingIntegration = await findExistingIntegration(account, db, params, extra)
  if (existingIntegration == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationNotFound, {}))
  }

  const secretKey: IntegrationSecretKey = { socialId, kind, workspaceUuid, key }
  const existingSecret = await db.integrationSecret.findOne(secretKey)
  if (existingSecret == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationSecretNotFound, {}))
  }

  await db.integrationSecret.deleteMany(secretKey)
}

export async function getIntegrationSecret (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: IntegrationSecretKey
): Promise<IntegrationSecret | null> {
  const { extra } = decodeTokenVerbose(ctx, token)
  verifyAllowedServices(integrationServices, extra)
  const { socialId, kind, workspaceUuid, key } = params

  if (
    kind == null ||
    kind === '' ||
    socialId == null ||
    socialId === '' ||
    workspaceUuid === undefined ||
    key == null
  ) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }
  const existing = await db.integrationSecret.findOne({ socialId, kind, workspaceUuid, key })

  return existing
}

export async function listIntegrationsSecrets (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: Partial<IntegrationSecretKey>
): Promise<IntegrationSecret[]> {
  const { extra } = decodeTokenVerbose(ctx, token)
  verifyAllowedServices(integrationServices, extra)
  const { socialId, kind, workspaceUuid, key } = params

  return await db.integrationSecret.find({ socialId, kind, workspaceUuid, key })
}

export async function findFullSocialIdBySocialKey (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { socialKey: string }
): Promise<SocialId | null> {
  const { extra } = decodeTokenVerbose(ctx, token)
  verifyAllowedServices(['telegram-bot', 'gmail', 'tool', 'workspace', 'google-calendar', 'notifications'], extra)

  const { socialKey } = params

  if (socialKey == null || socialKey === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  return await db.socialId.findOne({ key: socialKey })
}

export async function findFullSocialIds (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { socialIds: PersonId[] }
): Promise<SocialId[]> {
  const { socialIds } = params
  const { extra } = decodeTokenVerbose(ctx, token)
  verifyAllowedServices(['gmail', 'tool', 'workspace', 'huly-mail', 'mail-service', 'rating'], extra)

  if (socialIds == null || socialIds.length === 0) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  // Add validation to social Ids

  return await db.socialId.find({ _id: { $in: socialIds } })
}

export async function mergeSpecifiedAccounts (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    primaryAccount: AccountUuid
    secondaryAccount: AccountUuid
  }
): Promise<void> {
  const { extra } = decodeTokenVerbose(ctx, token)
  verifyAllowedServices(['tool', 'workspace'], extra)

  const { primaryAccount, secondaryAccount } = params
  if (primaryAccount == null || primaryAccount === '' || secondaryAccount == null || secondaryAccount === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  await doMergeAccounts(db, primaryAccount, secondaryAccount)
}

export async function findPersonBySocialKey (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { socialString: string, requireAccount?: boolean }
): Promise<PersonUuid | undefined> {
  const { socialString } = params

  if (socialString == null || socialString === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { extra } = decodeTokenVerbose(ctx, token)

  // 'transactor': SeatLimitsMiddleware resolves system/AI account uuids (aibot) via this call to
  // exclude them from seat counting; without it the resolve throws and the AI bot wrongly takes a seat.
  // 'payment': resolves the AI bot to exclude it from the per-seat purchase floor (billableMembersCount).
  verifyAllowedServices(
    ['tool', 'workspace', 'aibot', 'billing', 'payment', 'transactor', ...integrationServices],
    extra
  )

  const socialId = await db.socialId.findOne({ key: socialString })

  if (socialId == null) {
    return
  }

  if (params.requireAccount === true) {
    const account = await db.account.findOne({ uuid: socialId.personUuid as AccountUuid })

    return account?.uuid
  }

  return socialId.personUuid
}

/** Fire-and-forget edge events to QueueTopic.Workspace; producer set by account-service via metadata. */
async function publishLimitsEvents (
  ctx: MeasureContext,
  workspaceUuid: WorkspaceUuid,
  events: QueueWorkspaceMessage[]
): Promise<void> {
  if (events.length === 0) return
  const producer = getMetadata(accountPlugin.metadata.WorkspaceQueue)
  if (producer === undefined) {
    ctx.warn('WorkspaceQueue producer is not configured, limits events skipped', { workspaceUuid })
    return
  }
  try {
    await producer.send(ctx, workspaceUuid, events)
  } catch (err: any) {
    ctx.error('Failed to publish limits events', { workspaceUuid, err })
  }
}

/** Tell pod-payment about an operator cancel so it can provision the free fallback plan. */
async function publishAdminCanceled (ctx: MeasureContext, sub: Subscription): Promise<void> {
  const producer = getMetadata(accountPlugin.metadata.SubscriptionQueue)
  if (producer === undefined) {
    ctx.warn('SubscriptionQueue producer is not configured, free fallback skipped', {
      subscriptionId: sub.id,
      workspaceUuid: sub.workspaceUuid
    })
    return
  }
  try {
    await producer.send(ctx, sub.workspaceUuid, [subscriptionEvents.adminCanceled(sub, sub.provider)])
  } catch (err: any) {
    ctx.error('Failed to publish admin cancel event', { subscriptionId: sub.id, err })
  }
}

export async function upsertSubscription (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: SubscriptionUpsert
): Promise<void> {
  const { extra } = decodeTokenVerbose(ctx, token)

  // Only payment service can upsert subscriptions
  if (extra?.service !== 'payment') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  await doUpsertSubscription(ctx, db, params)
}

async function doUpsertSubscription (ctx: MeasureContext, db: AccountDB, params: SubscriptionUpsert): Promise<void> {
  const { workspaceUuid, provider, providerSubscriptionId } = params

  // Verify workspace exists
  const workspace = await getWorkspaceById(db, workspaceUuid)
  if (workspace === null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  // account_uuid is NOT NULL with an FK, but a free/trial tier has no payer.
  if (params.accountUuid == null) {
    const members = await db.getWorkspaceMembers(workspaceUuid)
    const owner = members.find((m) => m.role === AccountRole.Owner) ?? members[0]
    if (owner === undefined) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
    }
    params = { ...params, accountUuid: owner.person }
  }

  // Check if subscription exists by provider + providerSubscriptionId (unique external ID)
  const existing = await db.subscription.findOne({ provider, providerSubscriptionId })

  // Stale-write guard: concurrent writers (sync poll vs async webhook consumer) may carry an older
  // provider snapshot. Skip when the incoming modifiedAt is not newer than what we already stored.
  const existingModifiedAt = existing?.providerData?.modifiedAt
  const incomingModifiedAt = params.providerData?.modifiedAt
  if (
    existing !== null &&
    typeof existingModifiedAt === 'number' &&
    typeof incomingModifiedAt === 'number' &&
    incomingModifiedAt < existingModifiedAt
  ) {
    ctx.info('Subscription upsert skipped (stale snapshot)', {
      id: existing.id,
      workspaceUuid,
      existingModifiedAt,
      incomingModifiedAt
    })
    return
  }

  const updateData = {
    workspaceUuid: params.workspaceUuid,
    accountUuid: params.accountUuid,
    provider: params.provider,
    providerSubscriptionId: params.providerSubscriptionId,
    providerCheckoutId: params.providerCheckoutId,
    amount: params.amount,
    type: params.type,
    status: params.status,
    plan: params.plan,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    trialEnd: params.trialEnd,
    canceledAt: params.canceledAt,
    willCancelAt: params.willCancelAt,
    providerData: params.providerData,
    ...(params.limits !== undefined && { limits: params.limits }),
    updatedOn: Date.now()
  }
  // Invariant: at most one active tier subscription per workspace. Activating a tier
  // subscription cancels every other active/trialing tier (different provider/id included).
  // Trialing included so an early paid purchase supersedes the trial.
  if (params.type === SubscriptionType.Tier && params.status === SubscriptionStatus.Active) {
    const others = await db.subscription.find({
      workspaceUuid,
      type: SubscriptionType.Tier,
      status: { $in: [SubscriptionStatus.Active, SubscriptionStatus.Trialing] }
    })
    const now = Date.now()
    for (const sub of others) {
      if (sub.provider === provider && sub.providerSubscriptionId === providerSubscriptionId) continue
      const oldProviderData: Record<string, any> = (sub.providerData as Record<string, any>) ?? {}
      await db.subscription.update(
        { id: sub.id },
        {
          status: SubscriptionStatus.Canceled,
          canceledAt: now,
          updatedOn: now,
          providerData: { ...oldProviderData, pending: false, status: 'REPLACED', modifiedAt: now }
        }
      )
      ctx.info('Superseded active tier subscription canceled', { id: sub.id, workspaceUuid, plan: sub.plan })
    }
  }

  if (existing !== null) {
    // Update existing subscription
    await db.subscription.update({ id: existing.id }, updateData)
    ctx.info('Subscription updated', {
      id: existing.id,
      workspaceUuid,
      status: params.status,
      type: params.type,
      plan: params.plan
    })
  } else {
    // Create new subscription
    await db.subscription.insertOne({
      ...updateData,
      id: params.id,
      createdOn: Date.now()
    })
    ctx.info('Subscription created', {
      id: params.id,
      workspaceUuid,
      status: params.status,
      type: params.type,
      plan: params.plan
    })
  }

  // Active AI package grants tokens once per billing period via purchase-activated event.
  if (params.type === SubscriptionType.Package && params.status === SubscriptionStatus.Active) {
    const tokens = params.limits?.tokenLimit ?? 0
    if (tokens > 0 && params.periodStart !== undefined) {
      await publishLimitsEvents(ctx, workspaceUuid, [
        workspaceEvents.purchaseActivated(params.plan, `${params.id}:${params.periodStart}`, 'add-ai-tokens', tokens)
      ])
    }
  }

  // Refresh the snapshot so consumers re-read the effective limits without restart. Status matters:
  // active<->unpaid flips them (paid vs free fallback) even with the same plan. A package adds to the
  // same limits, so it has to notify too - otherwise an open billing page keeps the pre-purchase card.
  const wasActive = existing?.status === SubscriptionStatus.Active
  const isActive = params.status === SubscriptionStatus.Active
  const planChanged =
    existing === null ||
    existing.plan !== params.plan ||
    wasActive !== isActive ||
    JSON.stringify(existing.limits ?? null) !== JSON.stringify(params.limits ?? null)
  if (planChanged) {
    await publishLimitsEvents(ctx, workspaceUuid, [workspaceEvents.limitsChanged(LimitCategory.Plan, LimitStatus.Ok)])
  }
}

/**
 * Upsert many subscriptions.
 * Best-effort: every entry is attempted on its own, one bad row cannot sink the rest of the batch.
 * Callers must treat the result `ok: false` as "this one did not happen".
 * @public
 */
export async function upsertSubscriptionsBulk (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { subscriptions: SubscriptionUpsert[] }
): Promise<Array<{ id: string, ok: boolean, error?: string }>> {
  const { extra } = decodeTokenVerbose(ctx, token)

  if (extra?.service !== 'payment') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const { subscriptions } = params
  const results: Array<{ id: string, ok: boolean, error?: string }> = []

  // Sequential on purpose: doUpsertSubscription runs a read-modify-write (stale guard, supersede
  // cascade) that would race against itself for two entries of the same workspace.
  for (const sub of subscriptions) {
    try {
      await doUpsertSubscription(ctx, db, sub)
      results.push({ id: sub.id, ok: true })
    } catch (err: any) {
      ctx.error('Bulk subscription upsert entry failed', { id: sub.id, workspaceUuid: sub.workspaceUuid, err })
      results.push({ id: sub.id, ok: false, error: err?.message ?? String(err) })
    }
  }

  const failed = results.filter((r) => !r.ok).length
  ctx.info('Bulk subscription upsert done', { total: results.length, failed })
  return results
}

export async function getSubscriptionByProviderId (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    provider: string
    providerSubscriptionId: string
  }
): Promise<Subscription | null> {
  const { extra } = decodeTokenVerbose(ctx, token)

  // Only payment service can query subscriptions by provider ID
  if (extra?.service !== 'payment') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const { provider, providerSubscriptionId } = params

  // Find subscription by provider and providerSubscriptionId (unique external ID)
  const subscription = await db.subscription.findOne({
    provider,
    providerSubscriptionId
  })

  return subscription ?? null
}

/**
 * A provider's subscriptions filtered server-side by status (defaults to {active, past_due} — the
 * renewal candidates). Lets schedulers/reconcilers skip loading the whole table or other providers.
 * `trialEndBefore` narrows further to trials that already ended to sweep them.
 * @public
 */
export async function getSubscriptionsByProvider (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    provider?: string
    statuses?: SubscriptionStatus[]
    trialEndBefore?: number
  }
): Promise<Subscription[]> {
  const { extra } = decodeTokenVerbose(ctx, token)

  if (extra?.service !== 'payment') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const { provider, statuses, trialEndBefore } = params
  // No provider = every provider: a sweep that has to touch all subscriptions, whoever sold them.
  const query: Query<Subscription> = {
    ...(provider !== undefined ? { provider } : {}),
    status: { $in: statuses ?? [SubscriptionStatus.Active, SubscriptionStatus.PastDue] }
  }
  // A null trial_end never matches $lte, which is what we want: no trial end, nothing to expire.
  if (trialEndBefore !== undefined) {
    query.trialEnd = { $lte: trialEndBefore }
  }
  return await db.subscription.find(query)
}

/**
 * Atomically claim by claimKey (DB unique constraint). Returns whether THIS caller created the
 * intent; only the creator may charge. Cross-pod dedup surviving replicas and rolling updates.
 * @public
 */
export async function claimIntent (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    claimKey: string
    provider: string
    subscriptionId?: string
    workspaceUuid?: WorkspaceUuid
    amount?: number
    orderFingerprint?: string
  }
): Promise<{ claimed: boolean, intent: PaymentIntent }> {
  const { extra } = decodeTokenVerbose(ctx, token)

  if (extra?.service !== 'payment') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const { claimKey, provider, subscriptionId, workspaceUuid, amount, orderFingerprint } = params
  return await db.claimIntent(claimKey, provider, { subscriptionId, workspaceUuid, amount, orderFingerprint })
}

/**
 * Link a checkout intent to its issued charge (payment id) and save the payment URL for reuse.
 * @public
 */
export async function setIntentPayment (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { intentId: string, paymentId: string, paymentUrl?: string }
): Promise<void> {
  const { extra } = decodeTokenVerbose(ctx, token)
  if (extra?.service !== 'payment') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  await db.setIntentPayment(params.intentId, params.paymentId, params.paymentUrl)
}

/**
 * Release a checkout claim once its charge reaches a terminal webhook status. Idempotent.
 * @public
 */
export async function deleteCheckoutIntentByPaymentId (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { paymentId: string, provider: string }
): Promise<void> {
  const { extra } = decodeTokenVerbose(ctx, token)
  if (extra?.service !== 'payment') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  await db.deleteCheckoutIntentByPaymentId(params.paymentId, params.provider)
}

export async function deleteCheckoutIntentById (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { intentId: string }
): Promise<void> {
  const { extra } = decodeTokenVerbose(ctx, token)
  if (extra?.service !== 'payment') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  await db.deleteCheckoutIntentById(params.intentId)
}

export async function logPaymentOperation (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { op: PaymentOperation }
): Promise<void> {
  const { extra } = decodeTokenVerbose(ctx, token)
  if (extra?.service !== 'payment') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  await db.logPaymentOperation(params.op)
}

export async function getPaymentOperationStats (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { from: number, to: number }
): Promise<PaymentOperationStats> {
  const { extra } = decodeTokenVerbose(ctx, token)
  // payment service writes/reads for the daily summary; admin reads for the audit page.
  if (extra?.service !== 'payment' && extra?.admin !== 'true' && extra?.billingAdmin !== 'true') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  return await db.getPaymentOperationStats(params.from, params.to)
}

export async function getPaymentOperations (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: PaymentOperationFilter
): Promise<PaymentOperation[]> {
  const { extra } = decodeTokenVerbose(ctx, token)
  if (extra?.service !== 'payment' && extra?.admin !== 'true' && extra?.billingAdmin !== 'true') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  return await db.getPaymentOperations(params)
}

export async function getPaymentMonthlyStats (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { from: number, to: number }
): Promise<PaymentMonthlyStats[]> {
  const { extra } = decodeTokenVerbose(ctx, token)
  // Admin-only: the finance overview is not needed by service tokens.
  if (extra?.admin !== 'true' && extra?.billingAdmin !== 'true') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  return await db.getPaymentMonthlyStats(params.from, params.to)
}

export async function createPurchase (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { purchase: WorkspacePurchase }
): Promise<string> {
  const { extra } = decodeTokenVerbose(ctx, token)
  if (extra?.service !== 'payment') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  return await db.createPurchase(params.purchase)
}

export async function updatePurchaseStatus (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { id: string, status: WorkspacePurchaseStatus, activatedOn?: number }
): Promise<void> {
  const { extra } = decodeTokenVerbose(ctx, token)
  // payment activates purchases; the SKU-owning pod marks them consumed.
  if (!['payment', 'ai-bot'].includes(extra?.service)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  await db.updatePurchaseStatus(params.id, params.status, params.activatedOn)
}

export async function getPurchases (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { workspaceUuid?: WorkspaceUuid }
): Promise<WorkspacePurchase[]> {
  const { account, extra, workspace: tokenWorkspace } = decodeTokenVerbose(ctx, token)
  // Payment ledger is sensitive: only payment/billing services or admins may target an arbitrary
  // workspace. A plain service token must not read another workspace's purchase history.
  const isService =
    extra?.service === 'payment' ||
    extra?.service === 'billing' ||
    extra?.admin === 'true' ||
    extra?.billingAdmin === 'true'
  const targetWorkspace = isService ? (params.workspaceUuid ?? tokenWorkspace) : tokenWorkspace
  if (targetWorkspace === undefined) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }
  // Any workspace member may read its purchase history (mirrors getSubscriptions gating).
  if (!isService && (await db.getWorkspaceRole(account, targetWorkspace)) === null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  return await db.getPurchases(targetWorkspace)
}

/**
 * Mark a previously claimed charge intent as charged (with the provider payment id) or failed.
 * @public
 */
export async function markChargeIntent (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    intentId: string
    status: 'charged' | 'failed'
    paymentId?: string
  }
): Promise<void> {
  const { extra } = decodeTokenVerbose(ctx, token)

  if (extra?.service !== 'payment') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const { intentId, status, paymentId } = params
  await db.paymentIntent.update(
    { id: intentId },
    { status, ...(paymentId !== undefined && { paymentId }), updatedOn: Date.now() }
  )
}

/**
 * Refresh a charge intent's lease while the charge is in flight (the claiming pod is alive).
 * @public
 */
export async function heartbeatChargeIntent (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { intentId: string }
): Promise<void> {
  const { extra } = decodeTokenVerbose(ctx, token)
  if (extra?.service !== 'payment') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  await db.heartbeatChargeIntent(params.intentId)
}

/**
 * Atomically take over an orphaned pending intent whose lease expired (claiming pod died mid-charge).
 * Returns true if THIS caller won the takeover. Only one pod wins.
 * @public
 */
export async function reclaimStaleChargeIntent (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { intentId: string, leaseMs: number }
): Promise<boolean> {
  const { extra } = decodeTokenVerbose(ctx, token)
  if (extra?.service !== 'payment') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  return await db.reclaimStaleChargeIntent(params.intentId, params.leaseMs)
}

/**
 * Get all subscriptions (admin only)
 * @public
 */
export async function getAllSubscriptions (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: Record<string, unknown>
): Promise<any[]> {
  checkAdminRead(ctx, token)

  const subscriptions = await db.subscription.find({})

  // Resolve owner emails for unique account UUIDs
  const accountIds = [...new Set(subscriptions.map((s) => s.accountUuid))]
  const socialIds = await db.socialId.find({ personUuid: { $in: accountIds }, type: SocialIdType.EMAIL })
  const emailMap: Record<string, string> = {}
  for (const si of socialIds) {
    if (emailMap[si.personUuid] === undefined) {
      emailMap[si.personUuid] = si.value
    }
  }

  // Resolve payer names in one batch query (avoids an N+1 person lookup per subscription).
  const persons = await db.person.find({ uuid: { $in: accountIds } })
  const personMap: Record<string, string> = {}
  for (const person of persons) {
    const fullName = [person.firstName ?? '', person.lastName ?? ''].filter(Boolean).join(' ')
    if (fullName.length > 0) personMap[person.uuid] = fullName
  }

  return subscriptions.map((s) => ({
    ...s,
    payerEmail: emailMap[s.accountUuid] ?? undefined,
    payerName: personMap[s.accountUuid] ?? undefined
  }))
}

/**
 * Admin: manually create a free subscription for a workspace
 * @public
 */
export async function adminCreateSubscription (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    workspaceUuid: WorkspaceUuid
    plan: string
    type?: SubscriptionType
    status?: SubscriptionStatus
    limits?: Subscription['limits']
    periodDays?: number
    trialEnd?: number // when set (with status=Trialing), makes this a real trial subscription
    otpCode: string
  }
): Promise<void> {
  const { account } = await requireAdminOp(ctx, db, token, 'create_subscription', params.otpCode, params.workspaceUuid)

  await createManualSubscription(ctx, db, account, params)
  await logAdminAction(ctx, db, token, 'create_subscription', params.workspaceUuid, params.plan)
}

/**
 * Replaces the live subscription of the given type with a manual one. Shared by the admin RPC and by
 * the `set-workspace-plan` CLI, which writes to the account DB directly instead of holding an admin token.
 * @public
 */
export async function createManualSubscription (
  ctx: MeasureContext,
  db: AccountDB,
  account: AccountUuid,
  params: {
    workspaceUuid: WorkspaceUuid
    plan: string
    type?: SubscriptionType
    status?: SubscriptionStatus
    limits?: Subscription['limits']
    periodDays?: number
    trialEnd?: number
  }
): Promise<void> {
  const {
    workspaceUuid,
    plan,
    type = SubscriptionType.Tier,
    status = SubscriptionStatus.Active,
    limits,
    periodDays = 30,
    trialEnd
  } = params

  // Non-numeric/negative periodDays falls back to 30 days
  const safePeriodDays = Number.isFinite(periodDays) && periodDays >= 1 ? Math.round(periodDays) : 30

  // Verify workspace exists
  const workspace = await getWorkspaceById(db, workspaceUuid)
  if (workspace === null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  const now = Date.now()

  // Cancel ALL non-canceled subscriptions of the same type (invariant: one live sub per type).
  // Includes unpaid (past_due/expired) ones so repeated admin (re)creation does not pile up duplicates.
  const existingActive = (await db.subscription.find({ workspaceUuid, type })).filter(
    (s) => s.status !== SubscriptionStatus.Canceled
  )
  for (const existing of existingActive) {
    const oldProviderData: Record<string, any> = (existing.providerData as Record<string, any>) ?? {}
    await db.subscription.update(
      { id: existing.id },
      {
        status: SubscriptionStatus.Canceled,
        canceledAt: now,
        updatedOn: now,
        providerData: {
          ...oldProviderData,
          pending: false,
          status: 'ADMIN_REPLACED',
          modifiedAt: now
        }
      }
    )
    ctx.info('Manual subscription canceled', { id: existing.id, workspaceUuid, plan, type })
  }

  // Subscription FK requires an existing account; tool/system tokens are absent
  // from the account table, so fall back to the workspace owner.
  let accountUuid = account
  if ((await db.account.findOne({ uuid: account })) === null) {
    const members = await db.getWorkspaceMembers(workspaceUuid)
    const owner = members.find((m) => m.role === AccountRole.Owner) ?? members[0]
    if (owner === undefined) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
    }
    accountUuid = owner.person
  }

  // Create new subscription
  const subId = generateId()
  await db.subscription.insertOne({
    workspaceUuid,
    accountUuid,
    provider: 'manual',
    providerSubscriptionId: subId,
    type,
    status,
    plan,
    limits,
    amount: 0,
    periodStart: now,
    periodEnd: now + safePeriodDays * 24 * 3600 * 1000,
    trialEnd,
    createdOn: now,
    updatedOn: now,
    id: subId
  })
  ctx.info('Manual subscription created', { workspaceUuid, plan, type, status })

  if (type === SubscriptionType.Tier) {
    // Refresh plan snapshot so consumers re-read free-vs-paid limits without restart.
    await publishLimitsEvents(ctx, workspaceUuid, [workspaceEvents.limitsChanged(LimitCategory.Plan, LimitStatus.Ok)])
  }
}

export type AccountServiceMethods =
  | 'getPendingWorkspace'
  | 'updateWorkspaceInfo'
  | 'workerHandshake'
  | 'updateBackupInfo'
  | 'updateUsageInfo'
  | 'assignWorkspace'
  | 'listWorkspaces'
  | 'listWorkspacesPaged'
  | 'getWorkspacesSummary'
  | 'getRegistrationStats'
  | 'getWorkspaceActivityStats'
  | 'getWorkspaceMembersInfo'
  | 'getAccountActivityStats'
  | 'requestAdminOperationOtp'
  | 'verifyAdminSession'
  | 'adminSetMaintenance'
  | 'adminForceCloseWorkspace'
  | 'adminConfirmExport'
  | 'adminImpersonate'
  | 'adminUpdateWorkspaceRole'
  | 'adminAddWorkspaceMember'
  | 'adminRemoveWorkspaceMember'
  | 'adminReindexWorkspace'
  | 'adminReindexAllWorkspaces'
  | 'adminUpdateSubscription'
  | 'adminCancelSubscription'
  | 'adminUpdateWorkspaceName'
  | 'adminUpdateWorkspaceDisabledFeatures'
  | 'adminUpdateWorkspaceUrl'
  | 'adminReleaseSocialId'
  | 'adminDeletePerson'
  | 'listAdminActions'
  | 'performWorkspaceOperation'
  | 'updateWorkspaceRoleBySocialKey'
  | 'addSocialIdToPerson'
  | 'updateSocialId'
  | 'getPersonInfo'
  | 'createIntegration'
  | 'updateIntegration'
  | 'deleteIntegration'
  | 'listIntegrations'
  | 'getIntegration'
  | 'addIntegrationSecret'
  | 'updateIntegrationSecret'
  | 'deleteIntegrationSecret'
  | 'getIntegrationSecret'
  | 'listIntegrationsSecrets'
  | 'findFullSocialIdBySocialKey'
  | 'mergeSpecifiedAccounts'
  | 'findPersonBySocialKey'
  | 'listAccounts'
  | 'findFullSocialIds'
  | 'getSubscriptionByProviderId'
  | 'getSubscriptionsByProvider'
  | 'claimIntent'
  | 'markChargeIntent'
  | 'heartbeatChargeIntent'
  | 'reclaimStaleChargeIntent'
  | 'setIntentPayment'
  | 'deleteCheckoutIntentByPaymentId'
  | 'deleteCheckoutIntentById'
  | 'logPaymentOperation'
  | 'getPaymentOperationStats'
  | 'getPaymentOperations'
  | 'getPaymentMonthlyStats'
  | 'createPurchase'
  | 'updatePurchaseStatus'
  | 'getPurchases'
  | 'upsertSubscription'
  | 'upsertSubscriptionsBulk'
  | 'getAccountWorkspaceBadgeStatuses'
  | 'setWorkspaceBadgeStatuses'
  | 'getAllSubscriptions'
  | 'adminCreateSubscription'
  | 'getTransactorEndpoints'

/**
 * @public
 */
export function getServiceMethods (): Partial<Record<AccountServiceMethods, AccountMethodHandler>> {
  return {
    getPendingWorkspace: wrap(getPendingWorkspace),
    updateWorkspaceInfo: wrap(updateWorkspaceInfo),
    workerHandshake: wrap(workerHandshake),
    updateBackupInfo: wrap(updateBackupInfo),
    updateUsageInfo: wrap(updateUsageInfo),
    assignWorkspace: wrap(assignWorkspace),
    listWorkspaces: wrap(listWorkspaces),
    listWorkspacesPaged: wrap(listWorkspacesPaged),
    getWorkspacesSummary: wrap(getWorkspacesSummary),
    getRegistrationStats: wrap(getRegistrationStats),
    getTransactorEndpoints: wrap(getTransactorEndpoints),
    getWorkspaceActivityStats: wrap(getWorkspaceActivityStats),
    getWorkspaceMembersInfo: wrap(getWorkspaceMembersInfo),
    getAccountActivityStats: wrap(getAccountActivityStats),
    requestAdminOperationOtp: wrap(requestAdminOperationOtp),
    verifyAdminSession: wrap(verifyAdminSession),
    adminSetMaintenance: wrap(adminSetMaintenance),
    adminForceCloseWorkspace: wrap(adminForceCloseWorkspace),
    adminConfirmExport: wrap(adminConfirmExport),
    adminImpersonate: wrap(adminImpersonate),
    adminUpdateWorkspaceRole: wrap(adminUpdateWorkspaceRole),
    adminAddWorkspaceMember: wrap(adminAddWorkspaceMember),
    adminRemoveWorkspaceMember: wrap(adminRemoveWorkspaceMember),
    adminReindexWorkspace: wrap(adminReindexWorkspace),
    adminReindexAllWorkspaces: wrap(adminReindexAllWorkspaces),
    adminUpdateSubscription: wrap(adminUpdateSubscription),
    adminCancelSubscription: wrap(adminCancelSubscription),
    adminUpdateWorkspaceName: wrap(adminUpdateWorkspaceName),
    adminUpdateWorkspaceDisabledFeatures: wrap(adminUpdateWorkspaceDisabledFeatures),
    adminUpdateWorkspaceUrl: wrap(adminUpdateWorkspaceUrl),
    adminReleaseSocialId: wrap(adminReleaseSocialId),
    adminDeletePerson: wrap(adminDeletePerson),
    listAdminActions: wrap(listAdminActions),
    performWorkspaceOperation: wrap(performWorkspaceOperation),
    updateWorkspaceRoleBySocialKey: wrap(updateWorkspaceRoleBySocialKey),
    addSocialIdToPerson: wrap(addSocialIdToPerson),
    updateSocialId: wrap(updateSocialId),
    getPersonInfo: wrap(getPersonInfo),
    createIntegration: wrap(createIntegration),
    updateIntegration: wrap(updateIntegration),
    deleteIntegration: wrap(deleteIntegration),
    listIntegrations: wrap(listIntegrations),
    getIntegration: wrap(getIntegration),
    addIntegrationSecret: wrap(addIntegrationSecret),
    updateIntegrationSecret: wrap(updateIntegrationSecret),
    deleteIntegrationSecret: wrap(deleteIntegrationSecret),
    getIntegrationSecret: wrap(getIntegrationSecret),
    listIntegrationsSecrets: wrap(listIntegrationsSecrets),
    findFullSocialIdBySocialKey: wrap(findFullSocialIdBySocialKey),
    findFullSocialIds: wrap(findFullSocialIds),
    mergeSpecifiedAccounts: wrap(mergeSpecifiedAccounts),
    findPersonBySocialKey: wrap(findPersonBySocialKey),
    listAccounts: wrap(listAccounts),
    getSubscriptionByProviderId: wrap(getSubscriptionByProviderId),
    getSubscriptionsByProvider: wrap(getSubscriptionsByProvider),
    claimIntent: wrap(claimIntent),
    markChargeIntent: wrap(markChargeIntent),
    heartbeatChargeIntent: wrap(heartbeatChargeIntent),
    reclaimStaleChargeIntent: wrap(reclaimStaleChargeIntent),
    setIntentPayment: wrap(setIntentPayment),
    deleteCheckoutIntentByPaymentId: wrap(deleteCheckoutIntentByPaymentId),
    deleteCheckoutIntentById: wrap(deleteCheckoutIntentById),
    logPaymentOperation: wrap(logPaymentOperation),
    getPaymentOperationStats: wrap(getPaymentOperationStats),
    getPaymentOperations: wrap(getPaymentOperations),
    getPaymentMonthlyStats: wrap(getPaymentMonthlyStats),
    createPurchase: wrap(createPurchase),
    updatePurchaseStatus: wrap(updatePurchaseStatus),
    getPurchases: wrap(getPurchases),
    upsertSubscription: wrap(upsertSubscription),
    upsertSubscriptionsBulk: wrap(upsertSubscriptionsBulk),
    getAccountWorkspaceBadgeStatuses: wrap(getAccountWorkspaceBadgeStatuses),
    setWorkspaceBadgeStatuses: wrap(setWorkspaceBadgeStatuses),
    getAllSubscriptions: wrap(getAllSubscriptions),
    adminCreateSubscription: wrap(adminCreateSubscription)
  }
}

export async function getAccountWorkspaceBadgeStatuses (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { account: AccountUuid }
): Promise<any[]> {
  const { extra } = decodeTokenVerbose(ctx, token)
  verifyAllowedServices(['workspace', 'tool', 'aibot', 'notifications'], extra)
  return await db.getAccountWorkspaceBadgeStatuses(params.account)
}

export async function setWorkspaceBadgeStatuses (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { data: Array<{ accountId: AccountUuid, workspaceId: WorkspaceUuid, hasUnread: boolean }> }
): Promise<void> {
  const { extra } = decodeTokenVerbose(ctx, token)
  // this is called by model migrations inside pod-server, and also by tools
  verifyAllowedServices(['workspace', 'tool', 'aibot', 'notifications', 'server'], extra)
  await db.batchWorkspaceBadgeStatuses(params.data)
}

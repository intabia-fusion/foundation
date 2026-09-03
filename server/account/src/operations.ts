//
// Copyright © 2022-2024 Hardcore Engineering Inc.
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
import { Analytics } from '@hcengineering/analytics'
import {
  type AccountInfo,
  AccountRole,
  type AccountUuid,
  type Branding,
  buildSocialIdString,
  concatLink,
  type IntegrationKind,
  isActiveMode,
  isDeletingMode,
  isWorkspaceCreating,
  loginSocialTypes,
  type MeasureContext,
  type Person,
  type PersonId,
  type PersonUuid,
  readOnlyGuestAccountUuid,
  SocialIdType,
  systemAccountUuid,
  type WorkspaceMemberInfo,
  type WorkspaceUuid
} from '@hcengineering/core'
import platform, { getMetadata, PlatformError, Severity, Status, translate } from '@hcengineering/platform'
import {
  decodeToken,
  decodeTokenVerbose,
  generateToken,
  type PermissionsGrant,
  type Token
} from '@hcengineering/server-token'

import { isAdminEmail, isBillingAdminEmail } from './admin'
import { requireAdminOp } from './adminOp'
import { accountPlugin, type CrmNotification } from './plugin'
import { getFreePlanLimits } from './freeLimits'
import { type AccountServiceMethods, getServiceMethods } from './serviceOperations'
import {
  type Account,
  type AccountDB,
  AccountEventType,
  type AccountMethodHandler,
  type LoginInfo,
  type LoginInfoRequest,
  type LoginInfoRequestData,
  type LoginInfoWithWorkspaces,
  type Mailbox,
  type MailboxOptions,
  type MailboxSecret,
  type Meta,
  type OtpInfo,
  type PersonWithProfile,
  type Query,
  type RegionInfo,
  type LicenseInfo,
  type SocialId,
  type Subscription,
  SubscriptionStatus,
  type UserProfile,
  type WorkspaceInfoWithStatus,
  type WorkspaceInviteInfo,
  type WorkspaceLoginInfo,
  SubscriptionType
} from './types'
import {
  addSocialIdBase,
  assignableRoles,
  checkInvite,
  checkPasswordAging,
  cleanEmail,
  confirmEmail,
  confirmHulyIds,
  createAccount,
  createWorkspaceRecord,
  doJoinByInvite,
  doMergePersons,
  assertSeatAvailable,
  getSeatsAvailable,
  doReleaseSocialId,
  EndpointKind,
  generatePassword,
  getAccount,
  getCollaboratorEndpoint,
  getEmailSocialId,
  getSeatMembers,
  getEndpoint,
  getEndpointInfo,
  getFrontUrl,
  getInviteEmail,
  getPersonName,
  getRegions,
  getRolePower,
  getWorkspaceByDataId,
  getWorkspaceById,
  getWorkspaceCollaboratorEndpoint,
  getWorkspaceEndpoint,
  getWorkspaceInfoWithStatusById,
  getWorkspaceInvite,
  getWorkspaceJoinInfo,
  getWorkspaceRole,
  getWorkspaceRoles,
  getWorkspacesInfoWithStatusByIds,
  GUEST_ACCOUNT,
  isAccountPasswordLocked,
  isAllowReadOnlyGuests,
  isEmail,
  isOtpValid,
  getOtpRetryDelayMs,
  normalizePhone,
  normalizeValue,
  publishMembersChanged,
  recordFailedLoginAttempt,
  resetFailedLoginAttempts,
  selectWorkspace,
  sendEmail,
  sendOtp,
  setPassword,
  setTimezone,
  signUpByEmail,
  signUpByGrant,
  updateAllowGuestSignUp,
  updateAllowReadOnlyGuests,
  updatePasswordAgingRule,
  updateWorkspaceRole,
  logAdminAction,
  requestAdminOtp,
  verifyAdminOtp,
  verifyAllowedRole,
  verifyAllowedServices,
  verifyPassword,
  wrap
} from './utils'

// Note: it is IMPORTANT to always destructure params passed here to avoid sending extra params
// to the database layer when searching/inserting as they may contain SQL injection
// !!! NEVER PASS "params" DIRECTLY in any DB functions !!!

const workspaceLimitPerUser =
  process.env.WORKSPACE_LIMIT_PER_USER != null ? parseInt(process.env.WORKSPACE_LIMIT_PER_USER) : 10

/* =================================== */
/* ============OPERATIONS============= */
/* =================================== */

/**
 * Given an email and password, logs the user in and returns the account information and token.
 */
export async function loginAsGuest (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<LoginInfo> {
  const guestPerson = await db.person.findOne({ uuid: readOnlyGuestAccountUuid as PersonUuid })
  if (guestPerson == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, {}))
  }
  return {
    account: guestPerson.uuid as AccountUuid,
    token: generateToken(guestPerson.uuid, undefined)
  }
}

/**
 * Given an email and password, logs the user in and returns the account information and token.
 * If the account has too many failed login attempts, password login is blocked.
 * The user must use an alternative method (e.g., OTP) to unlock the account.
 */
export async function login (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    email: string
    password: string
  }
): Promise<LoginInfo> {
  const { email, password } = params

  if (email == null || password == null || email === '' || password === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const normalizedEmail = cleanEmail(email)

  try {
    const emailSocialId = await getEmailSocialId(db, normalizedEmail)

    if (emailSocialId == null) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, {}))
    }

    const existingAccount = await db.account.findOne({ uuid: emailSocialId.personUuid as AccountUuid })

    if (existingAccount == null) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, {}))
    }

    // Check if account is locked due to too many failed login attempts
    if (isAccountPasswordLocked(existingAccount)) {
      ctx.warn('Login attempt on locked account - password login locked', {
        email: normalizedEmail,
        failedAttempts: existingAccount.failedLoginAttempts
      })
      throw new PlatformError(
        new Status(Severity.ERROR, platform.status.PasswordLoginLocked, { account: normalizedEmail })
      )
    }

    const person = await db.person.findOne({ uuid: emailSocialId.personUuid })
    if (person == null) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.InternalServerError, {}))
    }

    if (!verifyPassword(password, existingAccount.hash, existingAccount.salt)) {
      try {
        await recordFailedLoginAttempt(db, existingAccount.uuid)
      } catch (err) {
        ctx.warn('Failed to record failed login attempt', { error: err, account: existingAccount.uuid })
      }
      throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, {}))
    }

    // Successful login - reset failed attempts counter
    await resetFailedLoginAttempts(db, existingAccount.uuid)

    const isConfirmed = emailSocialId.verifiedOn != null

    const extraToken: Record<string, string> = isAdminEmail(normalizedEmail)
      ? { admin: 'true', authMethod: 'password' }
      : isBillingAdminEmail(normalizedEmail)
        ? { billingAdmin: 'true', authMethod: 'password' }
        : { authMethod: 'password' }
    ctx.info('Login succeeded', { email, normalizedEmail, isConfirmed, emailSocialId, ...extraToken })

    return {
      account: existingAccount.uuid,
      token: isConfirmed ? generateToken(existingAccount.uuid, undefined, extraToken) : undefined,
      name: getPersonName(person),
      socialId: emailSocialId._id
    }
  } catch (err: any) {
    Analytics.handleError(err)
    ctx.error('Login failed', { email, normalizedEmail, err })
    throw err
  }
}

/**
 * Given an email sends an OTP code and returns the OTP information.
 * Never reveals whether the email is known. A person without an account is an unfinished sign up.
 */
export async function loginOtp (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { email: string }
): Promise<OtpInfo> {
  const { email } = params

  if (email == null || email === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  // Note: can support OTP based on any other social logins later
  const normalizedEmail = cleanEmail(email)
  const emailSocialId = await getEmailSocialId(db, normalizedEmail)

  if (emailSocialId == null) {
    // Nothing is created: the login form must not become a sign up form. retryOn matches a fresh
    // code so the timer cannot be used to probe existence.
    return { sent: true, retryOn: Date.now() + getOtpRetryDelayMs() }
  }

  return await sendOtp(ctx, db, branding, emailSocialId)
}

/**
 * Given an email, password, first name, and last name, creates a new account, without email confirmation.
 * The email confirmation is not required if the email service is not configured.
 *
 * ---------DEPRECATED. Only to be used for dev setups without mail service. Use signUpOtp instead.
 */
export async function signUp (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    email: string
    password: string
    firstName: string
    lastName?: string
  },
  meta?: Meta
): Promise<LoginInfo> {
  const { email, password, firstName, lastName } = params

  if (email == null || password == null || firstName == null || email === '' || password === '' || firstName === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account, socialId } = await signUpByEmail(ctx, db, branding, email, password, firstName, lastName ?? '')
  const person = await db.person.findOne({ uuid: account })
  if (person == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.InternalServerError, {}))
  }

  await confirmEmail(ctx, db, account, email)
  await confirmHulyIds(ctx, db, account)

  void setTimezone(ctx, db, account, null, meta)
  return {
    account,
    name: getPersonName(person),
    socialId,
    token: generateToken(account)
  }
}

export async function signUpOtp (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    email: string
    firstName: string
    lastName?: string
    phone?: string
  }
): Promise<OtpInfo> {
  const { email, firstName, lastName, phone } = params

  if (email == null || firstName == null || email === '' || firstName === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  // Note: can support OTP based on any other social logins later
  const normalizedEmail = cleanEmail(email)
  const normalizedPhone = phone !== undefined && phone !== '' ? normalizePhone(phone) : ''
  // A phone is never verified, so claiming exclusive ownership of it would block re-signup forever.
  const personData = normalizedPhone !== '' ? { phoneHint: normalizedPhone } : {}
  let emailSocialId = await getEmailSocialId(db, normalizedEmail)

  if (emailSocialId !== null) {
    const existingAccount = await db.account.findOne({ uuid: emailSocialId.personUuid as AccountUuid })

    // Account exists -> this is a login. Touching the person would let anyone knowing an email
    // rename its owner through the sign up form.
    if (existingAccount === null) {
      await db.person.update({ uuid: emailSocialId.personUuid }, { firstName, lastName: lastName ?? '', ...personData })
    }
  } else {
    // There's no person linked to this email, so we need to create a new one
    const personUuid: PersonUuid = await db.person.insertOne({
      firstName,
      lastName: lastName ?? '',
      ...personData
    })
    const newSocialId = { type: SocialIdType.EMAIL, value: normalizedEmail, personUuid }
    const emailSocialIdId = await db.socialId.insertOne(newSocialId)
    emailSocialId = { ...newSocialId, _id: emailSocialIdId, key: buildSocialIdString(newSocialId) }
  }

  return await sendOtp(ctx, db, branding, emailSocialId)
}

/**
 * Sends CRM notification for newly created account if user has no pending invites.
 * Only users who came to create their own workspace (not invited) should be sent to CRM.
 */
async function sendCrmNotificationIfNotInvited (
  ctx: MeasureContext,
  db: AccountDB,
  email: string,
  personUuid: PersonUuid,
  meta?: Meta
): Promise<void> {
  const crmQueue = getMetadata(accountPlugin.metadata.CrmQueue)

  const person = await db.person.findOne({ uuid: personUuid })
  if (person == null) {
    ctx.warn('CRM notification skipped: person not found', { personUuid })
    return
  }

  const body: CrmNotification = {
    firstName: person.firstName,
    lastName: person.lastName,
    email,
    phone: person.phoneHint ?? null,
    cookies: meta?.cookies
  }

  await crmQueue?.send(ctx, '' as WorkspaceUuid, [body], personUuid)
  ctx.info('CRM notification sending', body)
}

/**
 * Validates email OTP for login/sign up/new social id
 */
export async function validateOtp (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    email: string
    code: string
    password?: string
    action?: 'verify'
  }
): Promise<LoginInfo> {
  const { email, code, password, action } = params

  if (email == null || code == null || email === '' || code === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  // Note: can support OTP based on any other social logins later
  const normalizedEmail = cleanEmail(email)
  try {
    let emailSocialId = await getEmailSocialId(db, normalizedEmail)

    if (emailSocialId == null) {
      // Indistinguishable from a wrong code on purpose: a separate error here would undo the
      // anti-enumeration in loginOtp - two requests would tell whether an address is registered.
      throw new PlatformError(new Status(Severity.ERROR, platform.status.InvalidOtp, {}))
    }

    const isValid = await isOtpValid(db, emailSocialId._id, code)

    if (!isValid) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.InvalidOtp, {}))
    }

    let callerAccountUuid: AccountUuid | null = null
    let callerAccount: Account | null = null

    if (action === 'verify') {
      callerAccountUuid = decodeTokenVerbose(ctx, token).account
      callerAccount = await db.account.findOne({ uuid: callerAccountUuid })

      if (callerAccount == null) {
        throw new PlatformError(
          new Status(Severity.ERROR, platform.status.AccountNotFound, { account: callerAccountUuid })
        )
      }
    }

    await db.otp.deleteMany({ socialId: emailSocialId._id })

    const targetAccount = await db.account.findOne({ uuid: emailSocialId.personUuid as AccountUuid })

    if (action !== 'verify') {
      // login/sign up
      if (emailSocialId.verifiedOn == null) {
        await db.socialId.update({ _id: emailSocialId._id }, { verifiedOn: Date.now() })
      }

      if (targetAccount == null) {
        // This is a signup
        await createAccount(db, emailSocialId.personUuid, true)
        if (password != null) {
          await setPassword(ctx, db, branding, emailSocialId.personUuid as AccountUuid, password)
        }

        ctx.info('OTP signup success', emailSocialId)
      } else {
        await confirmHulyIds(ctx, db, targetAccount.uuid)

        ctx.info('OTP login/verification success', emailSocialId)
      }
    } else {
      if (callerAccountUuid == null) {
        throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, {}))
      }

      if (targetAccount == null) {
        // only person exists means there's no verified social id associated with it -> merge it to the current account
        // doMergePersons will fail if there's a verified social id

        await doMergePersons(db, callerAccountUuid, emailSocialId.personUuid)

        // what happens to local persons referencing this person in various workspaces?
        // there can be some persons but no Employees because there's no account
        // we know where the person is migrated to so can update later as needed

        if (emailSocialId.verifiedOn == null) {
          await db.socialId.update({ _id: emailSocialId._id }, { verifiedOn: Date.now() })
        } else {
          // Normally, it should not be the case
          ctx.warn("Verifying new social id belonging to person w/o account but it's already verified", {
            emailSocialId,
            callerAccountUuid
          })
          throw new PlatformError(new Status(Severity.ERROR, platform.status.Conflict, {}))
        }
      } else {
        if (callerAccountUuid === targetAccount.uuid) {
          if (emailSocialId.verifiedOn == null) {
            await db.socialId.update({ _id: emailSocialId._id }, { verifiedOn: Date.now() })
          }
        } else {
          if (emailSocialId.verifiedOn == null) {
            // Move the target social id to current account, we can easily do this because it was not verified
            await db.socialId.update(
              { _id: emailSocialId._id },
              { personUuid: callerAccountUuid, verifiedOn: Date.now() }
            )
          } else {
            // Throw for now. Should probably be another workflow to merge accounts.
            // Alternatively, we can allow the same workflow as with not verfied here just to move
            // the social id to the current account, but need to add extra checks like there's at least one more
            // login method for the target account
            throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountAlreadyExists, {}))
          }
        }
      }

      emailSocialId = await db.socialId.findOne({ _id: emailSocialId._id })
      if (emailSocialId == null) {
        throw new PlatformError(new Status(Severity.ERROR, platform.status.InternalServerError, {}))
      }

      // We've already checked calledAccount is not null previously
      if ((callerAccount as Account).automatic === true) {
        // Drop automatic flag since the user added their social id
        await db.account.update({ uuid: callerAccountUuid }, { automatic: false })
      }
    }

    const person = await db.person.findOne({ uuid: emailSocialId.personUuid })
    if (person == null) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.InternalServerError, {}))
    }

    await resetFailedLoginAttempts(db, emailSocialId.personUuid as AccountUuid)

    const extraToken: Record<string, string> = isAdminEmail(normalizedEmail)
      ? { admin: 'true', authMethod: 'otp' }
      : isBillingAdminEmail(normalizedEmail)
        ? { billingAdmin: 'true', authMethod: 'otp' }
        : { authMethod: 'otp' }

    return {
      account: emailSocialId.personUuid as AccountUuid,
      name: getPersonName(person),
      socialId: emailSocialId._id,
      token: generateToken(emailSocialId.personUuid, undefined, extraToken)
    }
  } catch (err: any) {
    Analytics.handleError(err)
    ctx.error(action === 'verify' ? 'OTP verification error' : 'OTP login/sign up error', { email, err })
    throw err
  }
}

export async function createWorkspace (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    workspaceName: string
    region?: string
  },
  meta?: Meta
): Promise<WorkspaceLoginInfo> {
  const { workspaceName, region } = params

  if (workspaceName == null || workspaceName.length === 0) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account, extra } = decodeTokenVerbose(ctx, token)

  checkRateLimit(account, workspaceName)

  ctx.info('Creating workspace record', { workspaceName, account, region })

  // Any confirmed social ID will do
  const socialId = (await getSocialIds(ctx, db, branding, token, { confirmed: true, includeDeleted: false }))[0]

  if (socialId == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotConfirmed, {}))
  }
  const person = await db.person.findOne({ uuid: socialId.personUuid })
  if (person == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.InternalServerError, {}))
  }

  const accountObj = await db.account.findOne({ uuid: account })
  if (accountObj == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.InternalServerError, {}))
  }

  // Get a list of created workspaces
  const created = (await db.workspace.find({ createdBy: socialId.personUuid })).length

  if (created >= (accountObj.maxWorkspaces ?? workspaceLimitPerUser)) {
    ctx.warn('created-by-limit', { person: socialId.key, workspace: workspaceName })
    throw new PlatformError(
      new Status(Severity.ERROR, platform.status.WorkspaceLimitReached, { workspace: workspaceName })
    )
  }

  const { workspaceUuid, workspaceUrl } = await createWorkspaceRecord(ctx, db, branding, workspaceName, account, region)

  await db.assignWorkspace(account, workspaceUuid, AccountRole.Owner)

  ctx.info('Creating workspace record done', { workspaceName, region, account: socialId.personUuid })

  // Send CRM notification for newly created workspace
  const emailSocialId = await db.socialId.findOne({
    type: SocialIdType.EMAIL,
    personUuid: socialId.personUuid,
    verifiedOn: { $gt: 0 }
  })

  if (emailSocialId != null) {
    await sendCrmNotificationIfNotInvited(ctx, db, emailSocialId.value, socialId.personUuid, meta)
  }

  return {
    account,
    socialId: socialId._id,
    name: getPersonName(person),
    token: generateToken(account, workspaceUuid, extra),
    endpoint: getEndpoint(workspaceUuid, region, EndpointKind.External),
    collaboratorEndpoint: getCollaboratorEndpoint(workspaceUuid, region, EndpointKind.External),
    workspace: workspaceUuid,
    workspaceUrl,
    role: AccountRole.Owner
  }
}

export async function createInvite (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    exp: number
    emailMask?: string
    email?: string
    limit: number
    role: AccountRole
    autoJoin?: boolean
  }
): Promise<string> {
  const { exp, emailMask, email, limit, role, autoJoin } = params

  if (role == null || !assignableRoles.includes(role)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account, workspace: workspaceUuid, extra } = decodeTokenVerbose(ctx, token)

  const currentAccount = await db.account.findOne({ uuid: account })
  if (currentAccount == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, { account }))
  }

  const workspace = await db.workspace.findOne({ uuid: workspaceUuid })
  if (workspace == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  const callerRole = await db.getWorkspaceRole(account, workspace.uuid)
  verifyAllowedRole(callerRole, role, extra)

  if (autoJoin === true) {
    verifyAllowedServices(['schedule'], extra)
  }

  // No point handing out a link that will be rejected at join time.
  await assertSeatAvailable(ctx, db, workspace.uuid, role)

  ctx.info('Creating invite', { workspace, workspaceName: workspace.name, email, emailMask, limit, autoJoin })

  return await db.invite.insertOne({
    workspaceUuid,
    expiresOn: exp < 0 ? -1 : Date.now() + exp,
    email,
    emailPattern: emailMask,
    remainingUses: limit,
    role,
    autoJoin
  })
}

// TODO: Temporary solution to prevent spam using sendInvite
const invitesSend = new Map<
string,
{
  lastSend: number
  totalSend: number
}
>()

export async function sendInvite (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    email: string
    role: AccountRole
    expHours?: number
  }
): Promise<void> {
  const { email, role, expHours } = params

  if (email == null || email === '' || role == null || !assignableRoles.includes(role)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account, workspace: workspaceUuid, extra } = decodeTokenVerbose(ctx, token)

  const currentAccount = await db.account.findOne({ uuid: account })
  if (currentAccount == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, { account }))
  }

  const workspace = await db.workspace.findOne({ uuid: workspaceUuid })
  if (workspace == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  const callerRole = await db.getWorkspaceRole(account, workspace.uuid)
  verifyAllowedRole(callerRole, role, extra)

  const inviteLink = await createInviteLink(ctx, db, branding, token, params)
  const inviteEmail = await getInviteEmail(branding, email, inviteLink, workspace, expHours ?? 48, false)

  await sendEmail(inviteEmail, ctx)

  ctx.info('Invite has been sent', { to: inviteEmail.to, workspaceUuid: workspace.uuid, workspaceName: workspace.name })
}

export async function createAccessLink (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    role: AccountRole
    firstName?: string
    lastName?: string
    extra?: string
    navigateUrl?: string
    spaces?: string[]

    notBefore?: number
    expiration?: number
    personalized?: boolean
  }
): Promise<string> {
  const { role, firstName, lastName, navigateUrl, spaces, notBefore, expiration, personalized = true } = params
  const { account, workspace: workspaceUuid, extra } = decodeTokenVerbose(ctx, token)

  const currentAccount = await db.account.findOne({ uuid: account })
  if (currentAccount == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, { account }))
  }

  if (workspaceUuid == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const workspace = await db.workspace.findOne({ uuid: workspaceUuid })
  if (workspace == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  let extraObj: Record<string, string> | undefined

  if (params.extra != null) {
    try {
      extraObj = JSON.parse(params.extra)
    } catch (e) {
      ctx.error("Invalid extra parameter, couldn't parse JSON", { extra: params.extra })
      throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
    }
  }

  const RECENT_PAST_MS = 1577836800000 // January 1, 2020 in milliseconds

  if (notBefore !== undefined && notBefore > RECENT_PAST_MS) {
    ctx.error('Not before appears to be in milliseconds instead of seconds', { nbf: notBefore })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  if (expiration !== undefined && expiration > RECENT_PAST_MS) {
    ctx.error('Expiration appears to be in milliseconds instead of seconds', { exp: expiration })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  if (notBefore !== undefined && expiration !== undefined && expiration <= notBefore) {
    ctx.error('Expiration time must be after Not Before time', { nbf: notBefore, exp: expiration })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const callerRole = await db.getWorkspaceRole(account, workspace.uuid)
  verifyAllowedRole(callerRole, AccountRole.User, extra)
  verifyAllowedRole(callerRole, role, extra)

  const newUuid = personalized ? await db.generatePersonUuid() : undefined

  const grant = {
    workspace: workspaceUuid,
    role,
    grantedBy: account,
    firstName,
    lastName,
    extra: extraObj,
    spaces
  }

  try {
    const accessToken = generateToken(GUEST_ACCOUNT, undefined, undefined, undefined, {
      grant,
      sub: newUuid,
      exp: expiration,
      nbf: notBefore
    })
    let path = `/login/auth?token=${accessToken}`
    if (navigateUrl != null) {
      path += `&navigateUrl=${encodeURIComponent(navigateUrl.trim())}`
    }

    const front = getFrontUrl(branding)
    const link = concatLink(front, path)

    return link
  } catch (err: any) {
    ctx.error('Failed to create access link', { err })
    throw err
  }
}

export async function createInviteLink (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    email: string
    role: AccountRole
    autoJoin?: boolean
    firstName?: string
    lastName?: string
    navigateUrl?: string
    expHours?: number
  }
): Promise<string> {
  const { email, role, autoJoin, firstName, lastName, navigateUrl, expHours } = params

  if (email == null || email === '' || role == null || !assignableRoles.includes(role)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account, workspace: workspaceUuid, extra } = decodeTokenVerbose(ctx, token)

  const currentAccount = await db.account.findOne({ uuid: account })
  if (currentAccount == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, { account }))
  }

  const workspace = await db.workspace.findOne({ uuid: workspaceUuid })
  if (workspace == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  const callerRole = await db.getWorkspaceRole(account, workspace.uuid)
  verifyAllowedRole(callerRole, role, extra)

  if (autoJoin === true) {
    verifyAllowedServices(['schedule'], extra)

    if (firstName == null || firstName === '') {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
    }
  }

  const normalizedEmail = cleanEmail(email)
  const expiringInHrs = expHours ?? 48
  const exp = expiringInHrs * 60 * 60 * 1000

  const inviteId = await createInvite(ctx, db, branding, token, {
    exp,
    email: normalizedEmail,
    limit: 1,
    role,
    autoJoin
  })
  let path = `/login/join?inviteId=${inviteId}`
  if (autoJoin === true) {
    path += `&autoJoin&firstName=${encodeURIComponent((firstName ?? '').trim())}`

    if (lastName != null) {
      path += `&lastName=${encodeURIComponent(lastName.trim())}`
    }
  }
  if (navigateUrl != null) {
    path += `&navigateUrl=${encodeURIComponent(navigateUrl.trim())}`
  }

  const front = getFrontUrl(branding)
  const link = concatLink(front, path)
  ctx.info(`Created invite link: ${link}`)

  return link
}

function checkRateLimit (email: string, workspaceName: string): void {
  const now = Date.now()
  const lastInvites = invitesSend.get(email)
  if (lastInvites !== undefined) {
    lastInvites.totalSend++
    lastInvites.lastSend = now
    if (lastInvites.totalSend > 5 && now - lastInvites.lastSend < 60 * 1000) {
      // Less 60 seconds between invites
      throw new PlatformError(
        new Status(Severity.ERROR, platform.status.WorkspaceRateLimit, { workspace: workspaceName })
      )
    }
    invitesSend.delete(email)
  } else {
    invitesSend.set(email, {
      lastSend: now,
      totalSend: 1
    })
  }

  // We need to cleanup map
  for (const [k, vv] of invitesSend.entries()) {
    if (vv.lastSend < now - 60 * 1000) {
      invitesSend.delete(k)
    }
  }
}

export async function resendInvite (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    email: string
    role: AccountRole
  }
): Promise<void> {
  const { email, role } = params

  if (email == null || email === '' || role == null || !assignableRoles.includes(role)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account, workspace: workspaceUuid, extra } = decodeTokenVerbose(ctx, token)

  const currentAccount = await db.account.findOne({ uuid: account })
  if (currentAccount == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, { account }))
  }

  const workspace = await db.workspace.findOne({ uuid: workspaceUuid })
  if (workspace == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  checkRateLimit(account, workspaceUuid)

  const callerRole = await db.getWorkspaceRole(account, workspace.uuid)
  verifyAllowedRole(callerRole, role, extra)

  // Refreshing an existing invite skips createInvite, so the seat cap has to be checked here too.
  await assertSeatAvailable(ctx, db, workspace.uuid, role)

  const expHours = 48
  const newExp = Date.now() + expHours * 60 * 60 * 1000

  const invite = await db.invite.findOne({ workspaceUuid, email })
  let inviteId: string
  if (invite != null) {
    inviteId = invite.id
    await db.invite.update({ id: invite.id }, { expiresOn: newExp, remainingUses: 1, role })
  } else {
    inviteId = await createInvite(ctx, db, branding, token, { exp: newExp, email, limit: 1, role })
  }
  const front = getFrontUrl(branding)
  const link = concatLink(front, `/login/join?inviteId=${inviteId}`)

  const inviteEmail = await getInviteEmail(branding, email, link, workspace, expHours, true)
  await sendEmail(inviteEmail, ctx)

  ctx.info('Invite has been resent', {
    to: inviteEmail.to,
    workspaceUuid: workspace.uuid,
    workspaceName: workspace.name
  })
}

/**
 * Given an invite and sign in information, assigns the user to the workspace in a given role.
 * If already a member, updates the role if necessary.
 * Returns the workspace login information.
 */
export async function join (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  _token: string,
  params: {
    email: string
    password: string
    inviteId: string
    workspaceUrl: string
  },
  meta?: Meta
): Promise<WorkspaceLoginInfo | LoginInfo> {
  const { email, password, inviteId, workspaceUrl } = params

  if (password == null || password === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const workspaceJoinInfo = await getWorkspaceJoinInfo(ctx, db, email, inviteId, workspaceUrl)
  ctx.info('Joining a workspace using invite', {
    email,
    normalizedEmail: workspaceJoinInfo.email,
    ...workspaceJoinInfo.invite
  })

  const { token, account } = await login(ctx, db, branding, _token, { email: workspaceJoinInfo.email, password })

  if (token == null) {
    return {
      account
    }
  }

  return await doJoinByInvite(ctx, db, branding, token, account, workspaceJoinInfo.workspace, workspaceJoinInfo.invite)
}

/**
 * Given an invite and a token, checks if the user has already joined the workspace and updates the role if necessary.
 * Returns the workspace login information if the user has already joined. Otherwise, throws an error.
 */
export async function checkJoin (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { inviteId: string }
): Promise<WorkspaceLoginInfo> {
  const { inviteId } = params

  if (inviteId == null || inviteId === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const invite = await getWorkspaceInvite(db, inviteId)
  if (invite == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const { account: accountUuid } = decodeTokenVerbose(ctx, token)
  const emailSocialId = await db.socialId.findOne({
    type: SocialIdType.EMAIL,
    personUuid: accountUuid,
    verifiedOn: { $gt: 0 }
  })
  const email = emailSocialId?.value ?? ''
  const workspaceUuid = await checkInvite(ctx, invite)
  const workspace = await getWorkspaceById(db, workspaceUuid)

  if (workspace === null) {
    ctx.error('Workspace not found in checkJoin', { workspaceUuid, email, inviteId })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  const role = await db.getWorkspaceRole(accountUuid, workspace.uuid)
  if (role == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const wsLoginInfo = await selectWorkspace(ctx, db, branding, token, { workspaceUrl: workspace.url, kind: 'external' })

  if (getRolePower(wsLoginInfo.role) < getRolePower(invite.role)) {
    await db.updateWorkspaceRole(accountUuid, workspaceUuid, invite.role)
    await publishMembersChanged(ctx, workspaceUuid)
  }

  return {
    ...wsLoginInfo,
    role: invite.role
  }
}

/**
 * Given an invite and a token of an already authenticated user, assigns the user to the workspace.
 * Unlike `join` which requires email/password, this method works with an existing session token.
 */
export async function joinByInvite (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { inviteId: string }
): Promise<WorkspaceLoginInfo> {
  const { inviteId } = params

  if (inviteId == null || inviteId === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const invite = await getWorkspaceInvite(db, inviteId)
  if (invite == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const { account: accountUuid } = decodeTokenVerbose(ctx, token)
  const workspaceUuid = await checkInvite(ctx, invite)
  const workspace = await getWorkspaceById(db, workspaceUuid)

  if (workspace === null) {
    ctx.error('Workspace not found in joinByInvite', { workspaceUuid, inviteId })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  return await doJoinByInvite(ctx, db, branding, token, accountUuid, workspace, invite)
}

/** Free seats left on the workspace plan; `available: true` when the plan is unlimited. */
export async function getWorkspaceSeats (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<{ available: boolean, seatsLeft?: number }> {
  const { workspace: workspaceUuid } = decodeTokenVerbose(ctx, token)

  if (workspaceUuid == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const seatsLeft = await getSeatsAvailable(db, workspaceUuid)

  return seatsLeft === undefined ? { available: true } : { available: seatsLeft > 0, seatsLeft }
}

/**
 * Public method to get invite information without authentication.
 * Returns workspace name and invite details for the join page.
 */
export async function getInviteInfo (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { inviteId: string }
): Promise<WorkspaceInviteInfo> {
  const { inviteId } = params

  if (inviteId == null || inviteId === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const invite = await getWorkspaceInvite(db, inviteId)
  if (invite == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const workspaceUuid = await checkInvite(ctx, invite)
  const workspace = await getWorkspaceById(db, workspaceUuid)
  if (workspace == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  const seatsLeft = await getSeatsAvailable(db, workspace.uuid)

  return {
    workspace: workspace.uuid,
    name: workspace.name,
    seatsAvailable: seatsLeft === undefined || seatsLeft > 0
  }
}

export async function checkAutoJoin (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { inviteId: string, firstName?: string, lastName?: string }
): Promise<WorkspaceLoginInfo | WorkspaceInviteInfo> {
  const { inviteId, firstName, lastName } = params

  if (inviteId == null || inviteId === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const invite = await getWorkspaceInvite(db, inviteId)
  if (invite == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  if (invite.autoJoin !== true) {
    ctx.warn('Not an auto-join invite', invite)
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  if (invite.role !== AccountRole.Guest) {
    ctx.warn('Auto-join not for guest role is forbidden', invite)
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const normalizedEmail = invite.email != null ? cleanEmail(invite.email) : ''
  const workspaceUuid = invite.workspaceUuid
  const workspace = await getWorkspaceById(db, workspaceUuid)

  if (workspace === null) {
    ctx.warn('Workspace not found in auto-joining workflow', { workspaceUuid, email: normalizedEmail, inviteId })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  if (normalizedEmail == null || normalizedEmail === '') {
    ctx.error('Malformed auto-join invite', invite)
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const emailSocialId = await db.socialId.findOne({
    type: SocialIdType.EMAIL,
    value: normalizedEmail
  })

  // If it's an existing account we should check for saved token or ask for login to prevent accidental access through shared link
  if (emailSocialId != null) {
    const targetAccount = await getAccount(db, emailSocialId.personUuid as AccountUuid)
    if (targetAccount != null) {
      if (targetAccount.automatic == null || !targetAccount.automatic) {
        if (token == null) {
          // Login required
          const person = await db.person.findOne({ uuid: targetAccount.uuid })

          return {
            workspace: workspace.uuid,
            name: person == null ? '' : getPersonName(person),
            email: normalizedEmail
          }
        }

        const { account: callerAccount } = decodeTokenVerbose(ctx, token)

        if (callerAccount !== targetAccount.uuid) {
          // Login with target email required
          const person = await db.person.findOne({ uuid: targetAccount.uuid })

          return {
            workspace: workspace.uuid,
            name: person == null ? '' : getPersonName(person),
            email: normalizedEmail
          }
        }
      }

      const targetRole = await getWorkspaceRole(db, targetAccount.uuid, workspace.uuid)

      if (targetRole == null) {
        await assertSeatAvailable(ctx, db, workspace.uuid, invite.role)
        await db.assignWorkspace(targetAccount.uuid, workspace.uuid, invite.role)
        await publishMembersChanged(ctx, workspace.uuid)
      } else if (getRolePower(targetRole) < getRolePower(invite.role)) {
        await db.updateWorkspaceRole(targetAccount.uuid, workspace.uuid, invite.role)
        await publishMembersChanged(ctx, workspace.uuid)
      }

      if (token === undefined || token === null) {
        token = generateToken(targetAccount.uuid)
      }
      return await selectWorkspace(ctx, db, branding, token, { workspaceUrl: workspace.url, kind: 'external' })
    }
  }

  // No account yet, create a new one automatically
  if (firstName == null || firstName === '') {
    ctx.error('First name is required for auto-join', { firstName })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account } = await signUpByEmail(
    ctx,
    db,
    branding,
    normalizedEmail,
    null,
    firstName,
    lastName ?? '',
    true,
    true
  )

  return await doJoinByInvite(ctx, db, branding, generateToken(account, workspaceUuid), account, workspace, invite)
}

/**
 * Given an invite and sign up information, creates an account and assigns it to the workspace.
 */
export async function signUpJoin (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    email: string
    password: string
    first: string
    last?: string
    inviteId: string
    workspaceUrl: string
  },
  meta?: Meta
): Promise<WorkspaceLoginInfo> {
  const { email, password, first, last, inviteId, workspaceUrl } = params

  if (password == null || password === '' || first == null || first === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const workspaceJoinInfo = await getWorkspaceJoinInfo(ctx, db, email, inviteId, workspaceUrl)
  ctx.info('Signing up and joining a workspace using invite', {
    email,
    normalizedEmail: workspaceJoinInfo.email,
    first,
    last,
    inviteId
  })

  const { account } = await signUpByEmail(ctx, db, branding, email, password, first, last ?? '', true)
  void setTimezone(ctx, db, account, null, meta)

  return await doJoinByInvite(
    ctx,
    db,
    branding,
    generateToken(account, workspaceJoinInfo.workspace?.uuid),
    account,
    workspaceJoinInfo.workspace,
    workspaceJoinInfo.invite
  )
}

export async function confirm (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<LoginInfo> {
  const { account, extra } = decodeTokenVerbose(ctx, token)

  const email = extra?.confirmEmail
  if (email === undefined) {
    ctx.error('Email not provided for confirmation', { account, extra })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const socialId = await confirmEmail(ctx, db, account, email)

  // Right after confirmEmail: the email is verified now, so the link is dead even if a later step
  // throws. Links from earlier resends stay inert until cleanExpiredOtp sweeps them.
  await db.shortLink.deleteMany({ payload: token })

  // The link also completes a sign up whose OTP code was never entered.
  if ((await db.account.findOne({ uuid: account })) == null) {
    await createAccount(db, account, true)
    ctx.info('Account created via activation link', { account, email })
  }

  await confirmHulyIds(ctx, db, account)

  const person = await db.person.findOne({ uuid: account })
  if (person == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.PersonNotFound, { person: account }))
  }

  const result = {
    account,
    name: getPersonName(person),
    socialId,
    token: generateToken(account)
  }

  ctx.info('Email confirmed', { account, email })

  return result
}

export async function changePassword (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    oldPassword: string
    newPassword: string
  }
): Promise<void> {
  const { oldPassword, newPassword } = params

  if (oldPassword == null || oldPassword === '' || newPassword == null || newPassword === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account: accountUuid } = decodeTokenVerbose(ctx, token)

  ctx.info('Changing password', { accountUuid })

  const account = await getAccount(db, accountUuid)

  if (account == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, { account: accountUuid }))
  }

  if (!verifyPassword(oldPassword, account.hash, account.salt)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  await setPassword(ctx, db, branding, accountUuid, newPassword)

  ctx.info('Password changed', { accountUuid })
}

export async function requestPasswordReset (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  _token: string,
  params: { email: string }
): Promise<void> {
  const { email } = params

  if (email == null || email === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const normalizedEmail = cleanEmail(email)

  ctx.info('Requesting password reset', { email, normalizedEmail })

  const emailSocialId = await getEmailSocialId(db, normalizedEmail)

  if (emailSocialId == null) {
    ctx.error('Email social id not found', { email, normalizedEmail })
    throw new PlatformError(
      new Status(Severity.ERROR, platform.status.SocialIdNotFound, { value: email, type: SocialIdType.EMAIL })
    )
  }

  const account = await getAccount(db, emailSocialId.personUuid as AccountUuid)

  if (account == null) {
    ctx.info('Account not found', { email, normalizedEmail })
    throw new PlatformError(
      new Status(Severity.ERROR, platform.status.AccountNotFound, { account: emailSocialId.personUuid })
    )
  }

  const mailQueue = getMetadata(accountPlugin.metadata.MailQueue)
  const front = getFrontUrl(branding)

  const token = generateToken(account.uuid, undefined, {
    restoreEmail: normalizedEmail
  })

  const link = concatLink(front, `/login/recovery?id=${token}`)
  const lang = branding?.defaultLanguage
  const text = await translate(accountPlugin.string.RecoveryText, { link }, lang)
  const html = await translate(accountPlugin.string.RecoveryHTML, { link }, lang)
  const subject = await translate(accountPlugin.string.RecoverySubject, {}, lang)

  await mailQueue?.send(
    ctx,
    '' as WorkspaceUuid,
    [
      {
        type: 'email',
        data: {
          text,
          html,
          subject,
          to: normalizedEmail
        }
      }
    ],
    normalizedEmail
  )
}

export async function restorePassword (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { password: string }
): Promise<LoginInfo> {
  const { password } = params

  if (password == null || password === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account, extra } = decodeTokenVerbose(ctx, token)
  ctx.info('Restoring password', { account, extra })

  const email = extra?.restoreEmail
  if (email === undefined) {
    ctx.error('Email not provided for restoration', { account, extra })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const emailSocialId = await getEmailSocialId(db, email)

  if (emailSocialId == null) {
    ctx.error('Email social id not found', { email })
    throw new PlatformError(
      new Status(Severity.ERROR, platform.status.SocialIdNotFound, { value: email, type: SocialIdType.EMAIL })
    )
  }

  await setPassword(ctx, db, branding, account, password)

  if (emailSocialId.verifiedOn == null) {
    await db.socialId.update({ key: emailSocialId.key }, { verifiedOn: Date.now() })
  }

  return await login(ctx, db, branding, token, { email, password })
}

export async function leaveWorkspace (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { account: AccountUuid, otpCode?: string }
): Promise<LoginInfo | null> {
  const { account: targetAccount } = params

  if (targetAccount == null || targetAccount === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account, workspace, extra } = decodeTokenVerbose(ctx, token)
  ctx.info('Removing account from workspace', { account, workspace })

  if (account == null || workspace == null) {
    ctx.error('Account or workspace not provided for leaving', { account, workspace })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.InternalServerError, {}))
  }

  const initiatorRole = await db.getWorkspaceRole(account, workspace)
  const targetRole = await db.getWorkspaceRole(targetAccount, workspace)

  if (account === targetAccount) {
    // Leaving on your own is not undoable by yourself: confirm with a code sent to your email.
    // Removing someone else stays role-gated - it is the workspace admin's routine action.
    await verifyAdminOtp(ctx, db, token, params.otpCode ?? '')
  }

  if (account !== targetAccount) {
    if (initiatorRole == null || getRolePower(initiatorRole) < getRolePower(AccountRole.Maintainer)) {
      ctx.error("Need to be at least maintainer to remove someone else's account from workspace", {
        account,
        workspace,
        initiatorRole
      })
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }

    if (targetRole === AccountRole.Owner && initiatorRole === AccountRole.Maintainer) {
      ctx.warn('Maintainer cannot remove owner from workspace', {
        account,
        targetAccount,
        workspace,
        initiatorRole,
        targetRole
      })
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
  }

  if (account === targetAccount && initiatorRole === AccountRole.Owner) {
    const members = await db.getWorkspaceMembers(workspace)
    const owners = members.filter((m) => m.role === AccountRole.Owner)

    if (owners.length === 1) {
      ctx.warn('Owner cannot remove themselves as the last owner of the workspace', {
        account,
        workspace
      })
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
  }

  await db.unassignWorkspace(targetAccount, workspace)
  ctx.info('Account removed from workspace', { targetAccount, workspace })
  await publishMembersChanged(ctx, workspace)

  if (account === targetAccount) {
    const person = await db.person.findOne({ uuid: account })
    if (person == null) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.InternalServerError, {}))
    }

    return {
      account,
      name: getPersonName(person),
      token: generateToken(account, undefined, extra)
    }
  }

  return null
}

export async function changeUsername (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    first: string
    last?: string
  }
): Promise<void> {
  const { first, last } = params

  if (first == null || first === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account } = decodeTokenVerbose(ctx, token)

  await db.person.update({ uuid: account }, { firstName: first, lastName: last ?? '' })

  ctx.info('Person name changed', { account, first, last })
}

export async function updateWorkspaceName (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { name: string }
): Promise<void> {
  const { name } = params

  if (name == null || name === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account, workspace } = decodeTokenVerbose(ctx, token)
  const role = await db.getWorkspaceRole(account, workspace)

  if (role == null || getRolePower(role) < getRolePower(AccountRole.Maintainer)) {
    ctx.error('Need to be at least maintainer to update workspace name', { workspace, account, role })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  await db.workspace.update(
    { uuid: workspace },
    {
      name
    }
  )
}

/**
 * Sends a confirmation code to the caller's verified email. Used before self-service destructive
 * actions (leaving a workspace, deleting one); the admin panel has its own entry point.
 */
export async function requestOperationOtp (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  _params: Record<string, unknown>
): Promise<OtpInfo> {
  return await requestAdminOtp(ctx, db, branding, token)
}

export async function deleteWorkspace (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { otpCode: string }
): Promise<void> {
  const { account, workspace } = decodeTokenVerbose(ctx, token)
  const role = await db.getWorkspaceRole(account, workspace)

  if (role !== AccountRole.Owner) {
    ctx.error('Need to be an owner to delete a workspace', { workspace, account, role })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  // Irreversible for everyone in the workspace: confirm with a code sent to the owner's email.
  await verifyAdminOtp(ctx, db, token, params?.otpCode ?? '')

  await db.workspaceStatus.update(
    { workspaceUuid: workspace },
    {
      isDisabled: true,
      mode: 'pending-deletion',
      // A workspace that had already exhausted its retries would never be picked up again.
      processingAttempts: 0
    }
  )
}

/* =================================== */
/* ==========READ OPERATIONS========== */
/* =================================== */

export async function getRegionInfo (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<RegionInfo[]> {
  return getRegions()
}

// account is the single license-key holder; payment pods ask this at startup instead of verifying a
// key themselves. Values come from metadata set once at account-service startup.
export async function getLicenseInfo (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<LicenseInfo> {
  // Require a valid token (same as sibling methods) — no unauthenticated reads.
  decodeTokenVerbose(ctx, token)
  return {
    edition: (getMetadata(accountPlugin.metadata.LicenseEdition) as LicenseInfo['edition']) ?? 'dev',
    // Fail closed: missing metadata (startup race / misconfig) must not permit payment.
    canRunPayment: getMetadata(accountPlugin.metadata.LicenseCanRunPayment) ?? false,
    maxUsers: getMetadata(accountPlugin.metadata.LicenseMaxUsers) ?? 0
  }
}

export async function getUserWorkspaces (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<WorkspaceInfoWithStatus[]> {
  const { account } = decodeTokenVerbose(ctx, token)

  const edition = getMetadata(accountPlugin.metadata.LicenseEdition)
  return (await db.getAccountWorkspaces(account))
    .filter((ws) => isWorkspaceCreating(ws.status.mode) || !(isDeletingMode(ws.status.mode) || ws.status.isDisabled))
    .map((ws) => ({ ...ws, licenseEdition: edition }))
}

/**
 * @public
 */
export async function getWorkspacesInfo (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { ids: WorkspaceUuid[] }
): Promise<WorkspaceInfoWithStatus[]> {
  const { ids } = params

  if (ids == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account } = decodeTokenVerbose(ctx, token)

  if (account !== systemAccountUuid) {
    ctx.error('getWorkspaceInfos with wrong user', { account, token })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const workspaces: WorkspaceInfoWithStatus[] = await getWorkspacesInfoWithStatusByIds(db, ids)
  workspaces.sort((a, b) => (b.status.lastVisit ?? 0) - (a.status.lastVisit ?? 0))

  return workspaces
}

/**
 * @public
 */
export async function updateLastVisit (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { ids: WorkspaceUuid[] }
): Promise<void> {
  const { ids } = params

  if (ids == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account } = decodeTokenVerbose(ctx, token)

  if (account !== systemAccountUuid) {
    ctx.error('updateLastVisit with wrong user', { account, token })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  await db.workspaceStatus.update({ workspaceUuid: { $in: ids } }, { lastVisit: Date.now() })
}

export async function getWorkspaceInfo (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { updateLastVisit: boolean }
): Promise<WorkspaceInfoWithStatus> {
  const { updateLastVisit = false } = params

  const { account, workspace: workspaceUuid, extra } = decodeTokenVerbose(ctx, token)
  const isGuest = extra?.guest === 'true'
  const isAdmin = extra?.admin === 'true'
  const skipAssignmentCheck = isGuest || account === systemAccountUuid

  if (!skipAssignmentCheck) {
    const role = await db.getWorkspaceRole(account, workspaceUuid)

    if (role == null) {
      ctx.warn('Not a member of the workspace', { workspaceUuid, account })
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
  }

  const workspace = await getWorkspaceInfoWithStatusById(db, workspaceUuid)

  // TODO: what should we return for archived?
  if (workspace == null) {
    ctx.warn('Workspace not found', { workspaceUuid, account })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  if (workspace.status.isDisabled && isActiveMode(workspace.status.mode)) {
    ctx.warn('Workspace is disabled', { workspaceUuid, account })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
  }

  if (!isGuest && updateLastVisit && !isAdmin) {
    await db.workspaceStatus.update({ workspaceUuid }, { lastVisit: Date.now() })
  }

  return workspace
}

/**
 * Validates the token and returns the decoded account information.
 */
export async function getLoginInfoByToken (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params?: LoginInfoRequestData,
  meta?: Meta
): Promise<LoginInfo | WorkspaceLoginInfo | LoginInfoRequest | null> {
  let accountUuid: AccountUuid
  let workspaceUuid: WorkspaceUuid
  let extra: any
  let grant: PermissionsGrant | undefined
  let sub: AccountUuid | undefined
  let account: AccountUuid | undefined
  let nbf: number | undefined
  let exp: number | undefined

  try {
    ;({ account, workspace: workspaceUuid, extra, grant, nbf, exp, sub } = decodeTokenVerbose(ctx, token))
    if (grant != null && sub == null) {
      sub = (await db.generatePersonUuid()) as AccountUuid
    }
    accountUuid = sub ?? account
  } catch (err: any) {
    if (token !== undefined) {
      // do not spam errors as this is expected when we issue request with no token
      Analytics.handleError(err)
      ctx.error('Invalid token', { token, errMsg: err.message })
    }
    switch (err.message) {
      case 'Token not yet active': {
        const { nbf } = decodeToken(token, false)
        throw new PlatformError(new Status(Severity.ERROR, platform.status.TokenNotActive, { notBefore: nbf }))
      }
      case 'Token expired':
        throw new PlatformError(new Status(Severity.ERROR, platform.status.TokenExpired, {}))
      default:
        throw new PlatformError(new Status(Severity.ERROR, platform.status.Unauthorized, {}))
    }
  }

  if (accountUuid == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, { account: accountUuid }))
  }

  const isDocGuest = accountUuid === GUEST_ACCOUNT && extra?.guest === 'true'
  const isSystem = accountUuid === systemAccountUuid
  const isAdmin = extra?.admin === 'true'

  // Check if token has grants and create automatic account if needed
  if (grant != null) {
    if (workspaceUuid != null) {
      ctx.warn('Grants are not allowed in workspace-specific tokens', { workspaceUuid, grant })
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }

    if (isSystem || isAdmin) {
      // No automatic grants for system and admin accounts
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }

    workspaceUuid = grant.workspace

    const grantWorkspace = await getWorkspaceById(db, workspaceUuid)

    if (grantWorkspace == null) {
      ctx.warn('Workspace not found in token grant workflow', { grant })
      throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
    }

    // Check if grant is for the existing account
    const grantAccount = await getAccount(db, accountUuid)

    if (grantAccount == null) {
      const grantPerson = await db.person.findOne({ uuid: accountUuid })
      const firstName = grantPerson?.firstName ?? params?.firstName ?? grant.firstName
      const lastName = grantPerson?.lastName ?? params?.lastName ?? grant.lastName

      if (firstName == null || firstName === '') {
        return {
          request: true,
          firstName,
          lastName
        }
      }

      // Create an automatic account and assign it to the grant workspace
      await signUpByGrant(ctx, db, branding, accountUuid, grant, params)
      await assertSeatAvailable(ctx, db, workspaceUuid, grant.role)
      await db.assignWorkspace(accountUuid, workspaceUuid, grant.role)
      await publishMembersChanged(ctx, workspaceUuid)
    } else {
      if (grantAccount.automatic == null || !grantAccount.automatic) {
        // If grant is for existing non-automatic account we need it to be signed in using the regular approach
        // So return the request for authentication
        return null
      } else {
        // Existing automatic account, check workspace assignment and consider it signed in
        const existingRole = await db.getWorkspaceRole(accountUuid, workspaceUuid)
        if (existingRole == null) {
          await assertSeatAvailable(ctx, db, workspaceUuid, grant.role)
          await db.assignWorkspace(accountUuid, workspaceUuid, grant.role)
          await publishMembersChanged(ctx, workspaceUuid)
        } else if (getRolePower(existingRole) < getRolePower(grant.role)) {
          await db.updateWorkspaceRole(accountUuid, workspaceUuid, grant.role)
          await publishMembersChanged(ctx, workspaceUuid)
        }
      }
    }
  }

  let socialId: SocialId | null = null

  if (!isDocGuest && !isSystem) {
    // Any confirmed social ID will do
    socialId = (await getSocialIds(ctx, db, branding, token, { confirmed: true, includeDeleted: false }))[0]
    if (socialId == null) {
      // Confirmation needed
      return {
        account: accountUuid
      }
    }
  }

  let person: Person | null
  if (isDocGuest) {
    person = {
      uuid: accountUuid,
      firstName: 'Guest',
      lastName: 'User'
    }
  } else if (isSystem) {
    person = {
      uuid: accountUuid,
      firstName: 'System',
      lastName: 'User'
    }
  } else {
    person = await db.person.findOne({ uuid: accountUuid })
  }

  if (person == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.InternalServerError, {}))
  }

  const loginInfo = {
    account: accountUuid,
    name: getPersonName(person),
    socialId: socialId?._id,
    token: generateToken(accountUuid, workspaceUuid, extra, undefined, { grant, nbf, exp, sub })
  }

  if (!isSystem) {
    void setTimezone(ctx, db, accountUuid, null, meta)
  }

  if (workspaceUuid != null && workspaceUuid !== '') {
    const workspace = await getWorkspaceById(db, workspaceUuid)

    if (workspace == null) {
      ctx.warn('Workspace not found', { workspaceUuid, account: accountUuid })
      throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid }))
    }

    const endpointKind = meta?.clientNetworkPosition === 'internal' ? EndpointKind.Internal : EndpointKind.External
    const endpoint = getEndpoint(workspace.uuid, workspace.region, endpointKind)
    const collaboratorEndpoint = getCollaboratorEndpoint(workspace.uuid, workspace.region, endpointKind)

    if (isDocGuest) {
      return {
        ...loginInfo,
        workspace: workspaceUuid,
        workspaceDataId: workspace.dataId,
        workspaceUrl: workspace.url,
        endpoint,
        collaboratorEndpoint,
        role: AccountRole.DocGuest
      } satisfies WorkspaceLoginInfo
    }

    const role = await getWorkspaceRole(db, accountUuid, workspace.uuid)

    if (role == null) {
      // User might have been removed from the workspace
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }

    return {
      ...loginInfo,
      workspace: workspace.uuid,
      workspaceDataId: workspace.dataId,
      workspaceUrl: workspace.url,
      endpoint,
      collaboratorEndpoint,
      role
    } satisfies WorkspaceLoginInfo
  } else {
    return loginInfo
  }
}

/**
 * Validates the token and returns the decoded account information.
 */
export async function getLoginWithWorkspaceInfo (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<LoginInfoWithWorkspaces> {
  let accountUuid: AccountUuid
  let extra: any
  let workspace: WorkspaceUuid | undefined
  try {
    ;({ account: accountUuid, extra, workspace } = decodeTokenVerbose(ctx, token))
  } catch (err: any) {
    Analytics.handleError(err)
    ctx.error('Invalid token', { token })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Unauthorized, {}))
  }

  if (accountUuid == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, { account: accountUuid }))
  }

  const isDocGuest = accountUuid === GUEST_ACCOUNT && extra?.guest === 'true'
  const isSystem = accountUuid === systemAccountUuid
  let socialIds: SocialId[] = []

  if (!isDocGuest && !isSystem) {
    // Any confirmed social ID will do
    socialIds = await db.socialId.find({ personUuid: accountUuid, verifiedOn: { $gt: 0 } })
    if (socialIds.length === 0) {
      return {
        account: accountUuid,
        workspaces: {},
        socialIds: []
      }
    }
  }

  let person: Person | null
  if (isDocGuest) {
    person = {
      uuid: accountUuid,
      firstName: 'Guest',
      lastName: 'User'
    }
  } else if (isSystem) {
    person = {
      uuid: accountUuid,
      firstName: 'System',
      lastName: 'User'
    }
  } else {
    person = await db.person.findOne({ uuid: accountUuid })
  }

  if (person == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.InternalServerError, {}))
  }

  const userWorkspaces = (await db.getAccountWorkspaces(accountUuid)).filter((it) => isActiveMode(it.status.mode))
  const roles: Map<WorkspaceUuid, AccountRole | null> = await getWorkspaceRoles(db, accountUuid)

  const info = getEndpointInfo()
  const loginInfo: LoginInfoWithWorkspaces = {
    account: accountUuid,
    name: getPersonName(person),
    socialId: socialIds[0]?._id,
    token,
    workspaces: Object.fromEntries(
      isSystem || isDocGuest
        ? []
        : userWorkspaces.map((it, idx) => [
          it.uuid,
          {
            url: it.url,
            dataId: it.dataId,
            mode: it.status.mode,
            endpoint: getWorkspaceEndpoint(info, it.uuid, it.region),
            collaboratorEndpoint: getWorkspaceCollaboratorEndpoint(it.uuid, it.region),
            role: roles.get(it.uuid) ?? null,
            version: {
              versionMajor: it.status.versionMajor,
              versionMinor: it.status.versionMinor,
              versionPatch: it.status.versionPatch
            },
            progress: it.status.processingProgress,
            branding: it.branding,
            passwordAgingRule: it.passwordAgingRule
          }
        ])
    ),
    socialIds
  }

  for (const ws of userWorkspaces) {
    if (ws.uuid === workspace) {
      await db.workspaceStatus.update({ workspaceUuid: workspace }, { lastVisit: Date.now() })
      break
    }
  }

  return loginInfo
}

export async function getSocialIds (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { confirmed: boolean, includeDeleted: boolean }
): Promise<SocialId[]> {
  const { confirmed = true, includeDeleted = false } = params
  const { account: accountUuid, sub } = decodeTokenVerbose(ctx, token)
  const account = sub ?? accountUuid

  // do not expose not-confirmed social ids for now
  if (!confirmed) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const socialIds = await db.socialId.find({ personUuid: account, verifiedOn: { $gt: 0 } })

  return includeDeleted ? socialIds : socialIds.filter((si) => si.isDeleted !== true)
}

export async function isReadOnlyGuest (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<boolean> {
  const { account } = decodeTokenVerbose(ctx, token)
  return account === readOnlyGuestAccountUuid
}

export async function getPerson (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<Person> {
  const { account } = decodeTokenVerbose(ctx, token)

  const person = await db.person.findOne({ uuid: account })

  if (person == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.PersonNotFound, { person: account }))
  }

  return person
}

export async function findPersonBySocialId (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { socialId: PersonId, requireAccount?: boolean }
): Promise<PersonUuid | undefined> {
  const { socialId, requireAccount } = params

  if (socialId == null || socialId === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  decodeTokenVerbose(ctx, token)

  const socialIdObj = await db.socialId.findOne({ _id: socialId })

  if (socialIdObj == null) {
    return
  }

  // TODO: combine into one request with join
  if (requireAccount === true) {
    const account = await db.account.findOne({ uuid: socialIdObj.personUuid as AccountUuid })
    if (account == null) {
      return
    }
  }

  return socialIdObj.personUuid
}

export async function findSocialIdBySocialKey (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { socialKey: string, requireAccount?: boolean }
): Promise<PersonId | undefined> {
  const { socialKey, requireAccount } = params
  decodeTokenVerbose(ctx, token)

  if (socialKey == null || socialKey === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const socialIdObj = await db.socialId.findOne({ key: socialKey })

  if (socialIdObj == null) {
    return
  }

  // TODO: combine into one request with join
  if (requireAccount === true) {
    const account = await db.account.findOne({ uuid: socialIdObj.personUuid as AccountUuid })
    if (account == null) {
      return
    }
  }

  return socialIdObj._id
}

export async function getWorkspaceMembers (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<WorkspaceMemberInfo[]> {
  const { account, workspace } = decodeTokenVerbose(ctx, token)

  if (workspace === null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid: workspace }))
  }

  const accRole = await getWorkspaceRole(db, account, workspace)

  if (accRole == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  return await getSeatMembers(db, workspace)
}

export async function getAccountInfo (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { accountId: AccountUuid }
): Promise<AccountInfo> {
  const { accountId } = params
  if (accountId == null || accountId === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account: caller, extra } = decodeTokenVerbose(ctx, token)

  if (accountId !== caller) {
    const isAdmin = extra?.admin === 'true'
    const isAllowedService = verifyAllowedServices(['workspace', 'tool'], extra, false)

    if (!isAdmin && !isAllowedService) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
  }

  const account = await getAccount(db, accountId)
  if (account === undefined || account === null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, {}))
  }
  return { timezone: account?.timezone, locale: account?.locale }
}

export async function ensurePerson (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    socialType: SocialIdType
    socialValue: string
    firstName: string
    lastName: string
  }
): Promise<{ uuid: PersonUuid, socialId: PersonId }> {
  const { account, workspace, extra } = decodeTokenVerbose(ctx, token)
  const allowedService = verifyAllowedServices(
    ['tool', 'workspace', 'schedule', 'mail', 'github', 'hulygram'],
    extra,
    false
  )

  if (!allowedService) {
    const callerRole = await getWorkspaceRole(db, account, workspace)
    verifyAllowedRole(callerRole, AccountRole.User, extra)
  }

  const { socialType, socialValue, firstName, lastName } = params
  const trimmedFirst = firstName == null ? '' : firstName.trim()
  const trimmedLast = lastName == null ? '' : lastName.trim()
  const normalizedValue = normalizeValue(socialValue ?? '')

  if (!Object.values(SocialIdType).includes(socialType) || trimmedFirst.length === 0 || normalizedValue.length === 0) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  return await db.ensurePerson(socialType, normalizedValue, trimmedFirst, trimmedLast)
}

async function getMailboxOptions (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<MailboxOptions> {
  decodeTokenVerbose(ctx, token)

  return {
    availableDomains: process.env.MAILBOX_DOMAINS?.split(',') ?? [],
    minNameLength: parseInt(process.env.MAILBOX_MIN_NAME_LENGTH ?? '6'),
    maxNameLength: parseInt(process.env.MAILBOX_MAX_NAME_LENGTH ?? '30'),
    maxMailboxCount: parseInt(process.env.MAILBOX_MAX_COUNT_PER_ACCOUNT ?? '1')
  }
}

async function createMailbox (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    name: string
    domain: string
  }
): Promise<{ mailbox: string, socialId: PersonId }> {
  const { name, domain } = params

  if (name == null || name === '' || domain == null || domain === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account } = decodeTokenVerbose(ctx, token)
  const normalizedName = cleanEmail(name)
  const normalizedDomain = cleanEmail(domain)
  const mailbox = normalizedName + '@' + normalizedDomain
  const opts = await getMailboxOptions(ctx, db, branding, token)

  if (normalizedName.length === 0 || normalizedDomain.length === 0 || !isEmail(mailbox)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.MailboxError, { reason: 'invalid-name' }))
  }
  if (!opts.availableDomains.includes(normalizedDomain)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.MailboxError, { reason: 'domain-not-found' }))
  }
  if (normalizedName.length < opts.minNameLength || normalizedName.length > opts.maxNameLength) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.MailboxError, { reason: 'name-rules-violated' }))
  }

  if ((await db.mailbox.findOne({ mailbox })) !== null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.MailboxError, { reason: 'mailbox-exists' }))
  }
  const mailboxes = await db.mailbox.find({ accountUuid: account })
  if (mailboxes.length >= opts.maxMailboxCount) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.MailboxError, { reason: 'mailbox-count-limit' }))
  }

  await db.mailbox.insertOne({ accountUuid: account, mailbox })
  await db.mailboxSecret.insertOne({ mailbox, secret: generatePassword() })
  const socialId = await addSocialIdBase(db, account, SocialIdType.EMAIL, mailbox, true)
  ctx.info('Mailbox created', { mailbox, account, socialId })
  return { mailbox, socialId }
}

async function getMailboxes (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<Mailbox[]> {
  const { account } = decodeTokenVerbose(ctx, token)
  return await db.mailbox.find({ accountUuid: account })
}

async function getMailboxSecret (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    mailbox: string
  }
): Promise<MailboxSecret | null> {
  const { extra } = decodeTokenVerbose(ctx, token)
  verifyAllowedServices(['huly-mail'], extra, false)
  return await db.mailboxSecret.findOne({ mailbox: params.mailbox })
}

async function deleteMailbox (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { mailbox: string }
): Promise<void> {
  if (params.mailbox == null || params.mailbox === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const { account } = decodeTokenVerbose(ctx, token)
  const mailbox = cleanEmail(params.mailbox)

  if (!isEmail(mailbox)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.MailboxError, { reason: 'invalid-name' }))
  }

  const mb = await db.mailbox.findOne({ mailbox, accountUuid: account })
  if (mb == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.MailboxError, { reason: 'mailbox-not-found' }))
  }

  await db.mailboxSecret.deleteMany({ mailbox })
  await db.mailbox.deleteMany({ mailbox })
  await doReleaseSocialId(db, account, SocialIdType.EMAIL, mailbox, `deleteMailbox@${account}`)
  ctx.info('Mailbox deleted', { mailbox, account })
}

async function exchangeGuestToken (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<string> {
  const tokenObj = decodeTokenVerbose(ctx, token)
  if (tokenObj.account == null) {
    // Check if it's old guest token
    const oldGuestEmail = '#guest@hc.engineering'
    const { linkId, guest, email, workspace: workspaceDataId } = tokenObj as any

    if (linkId == null || guest == null || email !== oldGuestEmail || workspaceDataId == null) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
    }

    const workspace = await getWorkspaceByDataId(db, workspaceDataId)

    if (workspace == null) {
      throw new PlatformError(
        new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUrl: workspaceDataId })
      )
    }

    return generateToken(GUEST_ACCOUNT, workspace.uuid, { linkId, guest: 'true' })
  }

  return token
}

async function addEmailSocialId (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    email: string
  }
): Promise<OtpInfo> {
  const { email } = params
  const { account } = decodeTokenVerbose(ctx, token)

  if (email == null || email === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  if (account == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.AccountNotFound, { account }))
  }

  const normalizedEmail = normalizeValue(email)
  const existing = await db.socialId.findOne({ type: SocialIdType.EMAIL, value: normalizedEmail })

  // This schema should be applied to all types in general, they should only differ by the verification process.
  // If none exists, create a new one and proceed to verification
  // If exists only for person without account - will be able to merge person to the account, proceed to verification
  // If exists for this account but not verified - proceed to verification right away
  // If exists for this account and verified - throw an error (already exists)
  // If exists for another account and not verified - will move only this id to the current account, proceed to verification
  // If exists for another account and verified - throw an error for now, support merge accounts later, maybe through a different procedure
  let targetSocialId: SocialId
  if (existing != null) {
    if (existing.verifiedOn != null) {
      throw new PlatformError(
        new Status(Severity.ERROR, platform.status.SocialIdAlreadyExists, { value: email, type: SocialIdType.EMAIL })
      )
    }
    targetSocialId = existing
  } else {
    const newSocialId = {
      type: SocialIdType.EMAIL,
      value: normalizedEmail,
      personUuid: account
    }
    const _id = await db.socialId.insertOne(newSocialId)
    targetSocialId = { ...newSocialId, _id, key: buildSocialIdString(newSocialId) }
  }

  return await sendOtp(ctx, db, branding, targetSocialId)
}

async function addHulyAssistantSocialId (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<PersonId> {
  const { account } = decodeTokenVerbose(ctx, token)

  return await addSocialIdBase(db, account, SocialIdType.HULY_ASSISTANT, account, true)
}

export async function refreshHulyAssistantToken (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string
): Promise<void> {
  const { account } = decodeTokenVerbose(ctx, token)

  const assistantSocialId = await db.socialId.findOne({ type: SocialIdType.HULY_ASSISTANT, personUuid: account })
  if (assistantSocialId == null) {
    throw new PlatformError(
      new Status(Severity.ERROR, platform.status.SocialIdNotFound, {
        value: account,
        type: SocialIdType.HULY_ASSISTANT
      })
    )
  }

  const key = 'access_token'
  const integrationSecretKey = {
    socialId: assistantSocialId._id,
    kind: 'ai-assistant' as IntegrationKind,
    workspaceUuid: null,
    key
  }

  const secret = generateToken(account, undefined, { userAiAssistant: 'true' })

  const existingToken = await db.integrationSecret.findOne(integrationSecretKey)

  if (existingToken == null) {
    await db.integrationSecret.insertOne({
      ...integrationSecretKey,
      secret
    })
  } else {
    await db.integrationSecret.update(integrationSecretKey, { secret })
  }
}

export async function releaseSocialId (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { personUuid?: PersonUuid, type: SocialIdType, value: string, deleteIntegrations?: boolean }
): Promise<SocialId> {
  const { account, extra } = decodeTokenVerbose(ctx, token)
  let { personUuid } = params
  const { type, value, deleteIntegrations } = params

  if (!Object.values(SocialIdType).includes(type) || value == null || value === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const allowedService = verifyAllowedServices(['github', 'tool', 'workspace'], extra, false)

  if (!allowedService) {
    if (personUuid != null && personUuid !== account) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    } else {
      personUuid = account
    }
  }

  if (personUuid == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  if (!allowedService) {
    // User should always have at least one Huly and one "login" social id
    // so do not allow releasing last ones
    const socialIds = await db.socialId.find({ personUuid, verifiedOn: { $gt: 0 }, isDeleted: { $ne: true } })
    const afterRemoval = socialIds.filter((it) => it.type !== type || it.value !== value)

    if (afterRemoval.filter((it) => it.type === SocialIdType.HULY).length === 0) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }

    if (afterRemoval.filter((it) => loginSocialTypes.includes(it.type)).length === 0) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
  }

  return await doReleaseSocialId(db, personUuid, type, value, extra?.service ?? account, deleteIntegrations)
}

export async function deleteAccount (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: { uuid?: AccountUuid, otpCode?: string }
): Promise<void> {
  const { account } = decodeTokenVerbose(ctx, token)

  const { uuid } = params

  if (uuid == null || uuid === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  // Irreversible identity purge — human admin, fresh session, emailed OTP confirmation.
  await requireAdminOp(ctx, db, token, 'delete_account', params.otpCode ?? '', uuid)

  if (uuid === account) {
    // Admin must not delete their own account (would also break the OTP-email lookup).
    ctx.warn('Refusing to delete an account: the admin is deleting themselves', { uuid })
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  // Refuse if the target is the sole owner of any workspace — that would orphan it.
  const workspaces = await db.getAccountWorkspaces(uuid)
  for (const ws of workspaces) {
    const members = await db.getWorkspaceMembers(ws.uuid)
    const owners = members.filter((m) => m.role === AccountRole.Owner)
    if (owners.length === 1 && owners[0].person === uuid) {
      ctx.warn('Refusing to delete an account: sole owner of a workspace', { uuid, workspace: ws.uuid, url: ws.url })
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
  }

  const person = await db.person.findOne({ uuid })
  await db.deleteAccount(uuid)
  await db.accountEvent.insertOne({
    accountUuid: uuid,
    eventType: AccountEventType.ACCOUNT_DELETED,
    time: Date.now()
  })
  await logAdminAction(
    ctx,
    db,
    token,
    'delete_account',
    uuid,
    `${person?.firstName ?? ''} ${person?.lastName ?? ''}`.trim()
  )
}

// Social ids that resolve to an account on their own, and therefore hand over the ability to
// authenticate as its owner once they are re-pointed. Password recovery and OTP login look an
// account up by social id value alone (see requestPasswordReset, loginOtp).
const loginCapableSocialTypes = [SocialIdType.EMAIL, SocialIdType.HULY]

/**
 * Merging re-points the secondary person's social ids onto the primary person, so an unrestricted
 * caller could both absorb the identifiers of a person they do not own and inject their own
 * identifiers into somebody else's person. Restrict it to callers with authority over both persons.
 */
async function verifyMergePersonsAuthority (
  db: AccountDB,
  { account, workspace, extra }: Token,
  primaryPerson: PersonUuid,
  secondaryPerson: PersonUuid,
  shouldThrow = true
): Promise<boolean> {
  // The tool/workspace services act on behalf of the whole installation. A global admin does not:
  // merging identities from the admin panel would be an unaudited cross-workspace write.
  // Note this must precede the workspace check below: such tokens carry no workspace.
  if (verifyAllowedServices(['tool', 'workspace'], extra, false)) {
    return true
  }

  const forbidden = (): boolean => {
    if (shouldThrow) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }

    return false
  }

  // Everybody else acts within a single workspace they maintain.
  if (workspace == null) {
    return forbidden()
  }

  if (!verifyAllowedRole(await db.getWorkspaceRole(account, workspace), AccountRole.Maintainer, extra, false)) {
    return forbidden()
  }

  // The platform wide accounts are not anybody's to merge.
  for (const person of [primaryPerson, secondaryPerson]) {
    if (person === systemAccountUuid || person === readOnlyGuestAccountUuid) {
      return forbidden()
    }

    if ((await db.getWorkspaceRole(person as AccountUuid, workspace)) != null) {
      // A member of the caller's workspace.
      continue
    }

    if ((await db.account.findOne({ uuid: person as AccountUuid })) != null) {
      // An account outside of the caller's workspace: no workspace maintainer may take it over.
      return forbidden()
    }
  }

  // Both persons are in reach of the caller by now, but the primary keeps receiving the secondary's
  // social ids. When the primary is somebody else's account, a login capable social id would grant
  // whoever controls it access to that account, so leave those merges to the verification flows.
  // Note doMergePersons only refuses *verified* secondary social ids, which does not cover this.
  if (primaryPerson !== account && (await db.account.findOne({ uuid: primaryPerson as AccountUuid })) != null) {
    const secondarySocialIds = await db.socialId.find({ personUuid: secondaryPerson })

    if (secondarySocialIds.some((si) => loginCapableSocialTypes.includes(si.type))) {
      return forbidden()
    }
  }

  return true
}

export async function canMergeSpecifiedPersons (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    primaryPerson: PersonUuid
    secondaryPerson: PersonUuid
  }
): Promise<boolean> {
  const decodedToken = decodeTokenVerbose(ctx, token)

  const { primaryPerson, secondaryPerson } = params
  if (primaryPerson == null || primaryPerson === '' || secondaryPerson == null || secondaryPerson === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  if (primaryPerson === secondaryPerson) {
    // Nothing to do
    return false
  }

  // This is a predicate the merge dialog polls, so an unauthorized caller is answered
  // rather than thrown at. mergeSpecifiedPersons below enforces the same rules.
  if (!(await verifyMergePersonsAuthority(db, decodedToken, primaryPerson, secondaryPerson, false))) {
    return false
  }

  const primaryPersonObj = await db.person.findOne({ uuid: primaryPerson })
  if (primaryPersonObj == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.PersonNotFound, { person: primaryPerson }))
  }

  const secondaryPersonObj = await db.person.findOne({ uuid: secondaryPerson })
  if (secondaryPersonObj == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.PersonNotFound, { person: secondaryPerson }))
  }

  // TODO: support checking if the source person is merged already

  // Merge social ids. Re-wire the secondary person social ids to the primary person.
  // Keep their ids. This way all PersonIds inside the workspaces will remain the same.
  const verifiedSecondaryIds = await db.socialId.find({ personUuid: secondaryPerson, verifiedOn: { $ne: null } })

  return verifiedSecondaryIds.length === 0
}

export async function mergeSpecifiedPersons (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    primaryPerson: PersonUuid
    secondaryPerson: PersonUuid
  }
): Promise<void> {
  const decodedToken = decodeTokenVerbose(ctx, token)

  const { primaryPerson, secondaryPerson } = params
  if (primaryPerson == null || primaryPerson === '' || secondaryPerson == null || secondaryPerson === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  await verifyMergePersonsAuthority(db, decodedToken, primaryPerson, secondaryPerson)

  await doMergePersons(db, primaryPerson, secondaryPerson)
}

async function setMyProfile (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    profile: Partial<Omit<UserProfile, 'personUuid'>>
  }
): Promise<void> {
  const { account } = decodeTokenVerbose(ctx, token)

  const { profile } = params

  // Validate field lengths
  if (profile.bio !== undefined && profile.bio !== null && profile.bio.length > 150) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, { field: 'bio', limit: 150 }))
  }
  if (profile.city !== undefined && profile.city !== null && profile.city.length > 100) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, { field: 'city', limit: 100 }))
  }
  if (profile.country !== undefined && profile.country !== null && profile.country.length > 50) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, { field: 'country', limit: 50 }))
  }

  // Sanitize profile object - only allow known fields to prevent injection
  const { bio, city, country, website, socialLinks, isPublic } = profile
  const sanitizedProfile: Partial<Omit<UserProfile, 'personUuid'>> = {
    bio,
    city,
    country,
    website,
    socialLinks,
    isPublic: isPublic ?? false
  }

  // Get existing profile or create new
  const existing = await db.userProfile.findOne({ personUuid: account })

  if (existing !== null) {
    // Update existing profile
    await db.userProfile.update({ personUuid: account }, sanitizedProfile)
  } else {
    // Create new profile
    await db.userProfile.insertOne({
      personUuid: account,
      ...sanitizedProfile
    })
  }
}

async function getUserProfile (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string | undefined,
  params: {
    personUuid?: PersonUuid
  }
): Promise<PersonWithProfile | null> {
  const { personUuid } = params

  // Decode token if provided (optional for public profiles)
  let requestingAccount: PersonUuid | undefined
  if (token != null && token !== '') {
    try {
      const tokenData = decodeTokenVerbose(ctx, token)
      requestingAccount = tokenData.account
    } catch {
      // Invalid token, treat as unauthenticated request
      requestingAccount = undefined
    }
  }

  // If no personUuid provided, return requesting user's own profile
  const targetPersonUuid = personUuid ?? requestingAccount

  if (targetPersonUuid == null || targetPersonUuid === '') {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  const person = await db.person.findOne({ uuid: targetPersonUuid })

  if (person == null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.PersonNotFound, { person: targetPersonUuid }))
  }

  const profile = await db.userProfile.findOne({ personUuid: targetPersonUuid })

  if (profile === null) {
    return null
  }

  // Allow access if:
  // 1. Requesting own profile (authenticated user requesting their own)
  // 2. Profile is public
  if (requestingAccount === targetPersonUuid || profile.isPublic) {
    const res: PersonWithProfile = {
      ...person,
      ...profile
    }

    delete (res as any).personUuid

    return res
  }

  // Private profile of another user - not accessible
  throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
}

/**
 * Get subscriptions for a workspace
 * - Regular users: Must be OWNER or MAINTAINER of the workspace (from token)
 * - Services: Can query any workspace by workspaceUuid parameter
 * By default returns only active subscriptions. Set activeOnly=false to include historical subscriptions.
 * @public
 */
export async function getSubscriptions (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    workspaceUuid?: WorkspaceUuid // Optional: used by services only, undefined means all workspaces
    activeOnly?: boolean // Optional: default true - only return active subscriptions
  }
): Promise<Subscription[]> {
  const { account, extra, workspace: tokenWorkspace } = decodeTokenVerbose(ctx, token)
  const { workspaceUuid, activeOnly = true } = params

  let targetWorkspace: WorkspaceUuid | null

  // Service and admin (incl. read-only billing) tokens can query any workspace/all workspaces
  const isService = extra?.service !== undefined || extra?.admin === 'true' || extra?.billingAdmin === 'true'

  if (isService) {
    // Honor an explicit workspaceUuid; otherwise scope to the token's own workspace so an admin
    // browsing their workspace sees only its plan. Only a workspace-less backend service token
    // (no explicit uuid, no bound workspace) falls through to "all workspaces".
    targetWorkspace = workspaceUuid ?? tokenWorkspace ?? null
  } else {
    // Regular users: use workspace from token (ignores workspaceUuid param)
    if (tokenWorkspace === undefined) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
    }
    targetWorkspace = tokenWorkspace

    // Any workspace member may read its subscriptions (to see their plan/usage/limits).
    // Mutating methods (upsert/cancel/adminCreate) keep their own stricter guards.
    const role = await db.getWorkspaceRole(account, targetWorkspace)
    if (role === null) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
  }

  // Fetch subscriptions for workspace (tier + addons + support)
  // By default return only plan-granting subscriptions, unless activeOnly=false.
  // Trialing grants the plan too, so a trial workspace shows its current plan/limits.
  const query: Query<Subscription> = targetWorkspace != null ? { workspaceUuid: targetWorkspace } : {}
  if (activeOnly) {
    query.status = { $in: [SubscriptionStatus.Active, SubscriptionStatus.Trialing] }
  }

  const subscriptions = await db.subscription.find(query)
  for (const sub of subscriptions) fillFreeLimits(sub)
  return subscriptions
}

// Free fallback is provider-agnostic and not persisted: fill it on read so every consumer sees it.
function fillFreeLimits (sub: Subscription): void {
  if (sub.type !== SubscriptionType.Tier) return
  sub.freeLimits = getFreePlanLimits()
}

/**
 * Get a subscription by its internal ID
 * - Services: Can query any subscription
 * - Regular users: Can only query subscriptions from their workspace (from token)
 * @public
 */
export async function getSubscriptionById (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    subscriptionId: string // Internal subscription ID (UUID)
  }
): Promise<Subscription | null> {
  const { account, extra, workspace: tokenWorkspace } = decodeTokenVerbose(ctx, token)
  const { subscriptionId } = params

  // Check if this is a service token
  const isService = extra?.service !== undefined

  // Fetch the subscription first
  const subscription = await db.subscription.findOne({ id: subscriptionId })

  if (subscription === null || subscription === undefined) {
    return null
  }

  if (isService) {
    // Services can query any subscription by internal ID
    fillFreeLimits(subscription)
    return subscription
  }

  // Regular users: can only query subscriptions from their workspace (from token)
  if (tokenWorkspace === undefined) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
  }

  // Verify the subscription belongs to the user's workspace
  if (subscription.workspaceUuid !== tokenWorkspace) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  // Verify user has OWNER or MAINTAINER role in the workspace
  const role = await db.getWorkspaceRole(account, tokenWorkspace)
  if (role === null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  const rolePower = getRolePower(role)
  const maintainerPower = getRolePower(AccountRole.Maintainer)

  if (rolePower < maintainerPower) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  fillFreeLimits(subscription)
  return subscription
}

export async function batchAssignWorkspacePermission (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    accountIds: AccountUuid[]
    permission: string
  }
): Promise<void> {
  const { accountIds, permission } = params
  const { account, workspace } = decodeTokenVerbose(ctx, token)

  if (workspace === null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid: workspace }))
  }

  const accRole = account === systemAccountUuid ? AccountRole.Owner : await db.getWorkspaceRole(account, workspace)
  if (accRole == null || getRolePower(accRole) < getRolePower(AccountRole.Maintainer)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  await db.batchAssignWorkspacePermission(workspace, accountIds, permission)
}

export async function batchRevokeWorkspacePermission (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    accountIds: AccountUuid[]
    permission: string
  }
): Promise<void> {
  const { accountIds, permission } = params
  const { account, workspace } = decodeTokenVerbose(ctx, token)

  if (workspace === null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid: workspace }))
  }

  const accRole = account === systemAccountUuid ? AccountRole.Owner : await db.getWorkspaceRole(account, workspace)
  if (accRole == null || getRolePower(accRole) < getRolePower(AccountRole.Maintainer)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  await db.batchRevokeWorkspacePermission(workspace, accountIds, permission)
}

export async function hasWorkspacePermission (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    accountId: AccountUuid
    permission: string
  }
): Promise<boolean> {
  const { accountId, permission } = params
  const { workspace } = decodeTokenVerbose(ctx, token)

  if (workspace === null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid: workspace }))
  }

  return await db.hasWorkspacePermission(accountId, workspace, permission)
}

export async function getWorkspacePermissions (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    accountId: AccountUuid
    permission: string
  }
): Promise<WorkspaceUuid[]> {
  const { accountId, permission } = params
  const { account } = decodeTokenVerbose(ctx, token)

  // Allow users to query their own permissions or require Maintainer+ role
  if (accountId !== account) {
    // For querying other users' permissions, require at least Maintainer role in any workspace
    // This is a cross-workspace query, so we check if user has Maintainer+ in at least one workspace
    const workspaceRoles = await db.getWorkspaceRoles(account)
    const hasMaintainerAccess = Array.from(workspaceRoles.values()).some(
      (role) => getRolePower(role) >= getRolePower(AccountRole.Maintainer)
    )
    if (!hasMaintainerAccess) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
  }

  return await db.getWorkspacePermissions(accountId, permission)
}

export async function getWorkspaceUsersWithPermission (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  token: string,
  params: {
    permission: string
  }
): Promise<AccountUuid[]> {
  const { permission } = params
  const { account, workspace } = decodeTokenVerbose(ctx, token)

  if (workspace === null) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid: workspace }))
  }

  const accRole = account === systemAccountUuid ? AccountRole.Owner : await db.getWorkspaceRole(account, workspace)
  if (accRole == null || getRolePower(accRole) < getRolePower(AccountRole.Maintainer)) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  return await db.getWorkspaceUsersWithPermission(workspace, permission)
}

export type AccountMethods =
  | AccountServiceMethods
  | 'login'
  | 'loginOtp'
  | 'loginAsGuest'
  | 'signUp'
  | 'signUpOtp'
  | 'validateOtp'
  | 'createWorkspace'
  | 'createInvite'
  | 'createInviteLink'
  | 'createAccessLink'
  | 'sendInvite'
  | 'resendInvite'
  | 'selectWorkspace'
  | 'join'
  | 'joinByInvite'
  | 'checkJoin'
  | 'checkAutoJoin'
  | 'getInviteInfo'
  | 'getWorkspaceSeats'
  | 'signUpJoin'
  | 'confirm'
  | 'changePassword'
  | 'requestPasswordReset'
  | 'restorePassword'
  | 'leaveWorkspace'
  | 'changeUsername'
  | 'updateWorkspaceName'
  | 'deleteWorkspace'
  | 'requestOperationOtp'
  | 'getRegionInfo'
  | 'getLicenseInfo'
  | 'getUserWorkspaces'
  | 'getWorkspaceInfo'
  | 'getWorkspacesInfo'
  | 'updateLastVisit'
  | 'getLoginInfoByToken'
  | 'getLoginWithWorkspaceInfo'
  | 'getSocialIds'
  | 'getPerson'
  | 'getWorkspaceMembers'
  | 'updateWorkspaceRole'
  | 'isAllowReadOnlyGuests'
  | 'updateAllowReadOnlyGuests'
  | 'updateAllowGuestSignUp'
  | 'findPersonBySocialId'
  | 'findSocialIdBySocialKey'
  | 'ensurePerson'
  | 'exchangeGuestToken'
  | 'getMailboxOptions'
  | 'createMailbox'
  | 'getMailboxes'
  | 'getMailboxSecret'
  | 'deleteMailbox'
  | 'getAccountInfo'
  | 'isReadOnlyGuest'
  | 'addEmailSocialId'
  | 'addHulyAssistantSocialId'
  | 'refreshHulyAssistantToken'
  | 'releaseSocialId'
  | 'deleteAccount'
  | 'canMergeSpecifiedPersons'
  | 'mergeSpecifiedPersons'
  | 'setMyProfile'
  | 'getUserProfile'
  | 'getSubscriptions'
  | 'getSubscriptionById'
  | 'updatePasswordAgingRule'
  | 'checkPasswordAging'
  | 'batchAssignWorkspacePermission'
  | 'batchRevokeWorkspacePermission'
  | 'hasWorkspacePermission'
  | 'getWorkspacePermissions'
  | 'getWorkspaceUsersWithPermission'

/**
 * @public
 */
export function getMethods (hasSignUp: boolean = true): Partial<Record<AccountMethods, AccountMethodHandler>> {
  return {
    /* OPERATIONS */
    login: wrap(login),
    loginOtp: wrap(loginOtp),
    loginAsGuest: wrap(loginAsGuest),
    ...(hasSignUp ? { signUp: wrap(signUp) } : {}),
    ...(hasSignUp ? { signUpOtp: wrap(signUpOtp) } : {}),
    validateOtp: wrap(validateOtp),
    createWorkspace: wrap(createWorkspace),
    createInvite: wrap(createInvite),
    createInviteLink: wrap(createInviteLink),
    createAccessLink: wrap(createAccessLink),
    sendInvite: wrap(sendInvite),
    resendInvite: wrap(resendInvite),
    selectWorkspace: wrap(selectWorkspace),
    join: wrap(join),
    joinByInvite: wrap(joinByInvite),
    checkJoin: wrap(checkJoin),
    checkAutoJoin: wrap(checkAutoJoin),
    getInviteInfo: wrap(getInviteInfo),
    getWorkspaceSeats: wrap(getWorkspaceSeats),
    signUpJoin: wrap(signUpJoin),
    confirm: wrap(confirm),
    changePassword: wrap(changePassword),
    requestPasswordReset: wrap(requestPasswordReset),
    restorePassword: wrap(restorePassword),
    leaveWorkspace: wrap(leaveWorkspace),
    changeUsername: wrap(changeUsername),
    updateWorkspaceName: wrap(updateWorkspaceName),
    deleteWorkspace: wrap(deleteWorkspace),
    requestOperationOtp: wrap(requestOperationOtp),
    updateWorkspaceRole: wrap(updateWorkspaceRole),
    isAllowReadOnlyGuests: wrap(isAllowReadOnlyGuests),
    updateAllowReadOnlyGuests: wrap(updateAllowReadOnlyGuests),
    updateAllowGuestSignUp: wrap(updateAllowGuestSignUp),
    updatePasswordAgingRule: wrap(updatePasswordAgingRule),
    checkPasswordAging: wrap(checkPasswordAging),
    createMailbox: wrap(createMailbox),
    getMailboxes: wrap(getMailboxes),
    deleteMailbox: wrap(deleteMailbox),
    ensurePerson: wrap(ensurePerson),
    exchangeGuestToken: wrap(exchangeGuestToken),
    addEmailSocialId: wrap(addEmailSocialId),
    addHulyAssistantSocialId: wrap(addHulyAssistantSocialId),
    refreshHulyAssistantToken: wrap(refreshHulyAssistantToken),
    releaseSocialId: wrap(releaseSocialId),
    deleteAccount: wrap(deleteAccount),
    canMergeSpecifiedPersons: wrap(canMergeSpecifiedPersons),
    mergeSpecifiedPersons: wrap(mergeSpecifiedPersons),
    setMyProfile: wrap(setMyProfile),
    getUserProfile: wrap(getUserProfile),
    getSubscriptions: wrap(getSubscriptions),
    getSubscriptionById: wrap(getSubscriptionById),
    batchAssignWorkspacePermission: wrap(batchAssignWorkspacePermission),
    batchRevokeWorkspacePermission: wrap(batchRevokeWorkspacePermission),
    hasWorkspacePermission: wrap(hasWorkspacePermission),
    getWorkspacePermissions: wrap(getWorkspacePermissions),
    getWorkspaceUsersWithPermission: wrap(getWorkspaceUsersWithPermission),

    /* READ OPERATIONS */
    getRegionInfo: wrap(getRegionInfo),
    getLicenseInfo: wrap(getLicenseInfo),
    getUserWorkspaces: wrap(getUserWorkspaces),
    getWorkspaceInfo: wrap(getWorkspaceInfo),
    getWorkspacesInfo: wrap(getWorkspacesInfo),
    updateLastVisit: wrap(updateLastVisit),
    getLoginInfoByToken: wrap(getLoginInfoByToken),
    getLoginWithWorkspaceInfo: wrap(getLoginWithWorkspaceInfo),
    getSocialIds: wrap(getSocialIds),
    getPerson: wrap(getPerson),
    findPersonBySocialId: wrap(findPersonBySocialId),
    findSocialIdBySocialKey: wrap(findSocialIdBySocialKey),
    getWorkspaceMembers: wrap(getWorkspaceMembers),
    getMailboxOptions: wrap(getMailboxOptions),
    getMailboxSecret: wrap(getMailboxSecret),
    getAccountInfo: wrap(getAccountInfo),
    isReadOnlyGuest: wrap(isReadOnlyGuest),

    /* SERVICE METHODS */
    ...getServiceMethods()
  }
}

export * from './plugin'
export * from './serviceOperations'
export default accountPlugin

//
// Copyright © 2024 Hardcore Engineering Inc.
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
  type AccountInfo,
  type AccountRole,
  type AccountUuid,
  type BackupStatus,
  concatLink,
  Data,
  type Person,
  type PersonId,
  type PersonInfo,
  type PersonUuid,
  type SocialIdType,
  Version,
  type UsageStatus,
  type WorkspaceInfoWithStatus,
  type WorkspaceMemberInfo,
  WorkspaceMode,
  type WorkspaceUserOperation,
  type WorkspaceUuid
} from '@hcengineering/core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import type {
  AccountAggregatedInfo,
  AccountsFilter,
  AdminActionsQuery,
  AdminActionsResult,
  AccountsSortKey,
  TransactorEndpointInfo,
  Integration,
  IntegrationKey,
  IntegrationSecret,
  IntegrationSecretKey,
  LoginInfo,
  LoginInfoByToken,
  LoginInfoRequestData,
  LoginInfoWithWorkspaces,
  MailboxInfo,
  MailboxOptions,
  MailboxSecret,
  OtpInfo,
  PersonWithProfile,
  ProviderInfo,
  RegionInfo,
  LicenseInfo,
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
  SubscriptionInfo,
  UserProfile,
  WorkspaceInviteInfo,
  WorkspaceSeatsInfo,
  WorkspaceLoginInfo,
  WorkspaceOperation,
  AccountWorkspaceBadgeStatus,
  WorkspacesPagedQuery,
  WorkspacesPagedResult,
  WorkspacesSummary,
  RegistrationStats,
  WorkspaceActivityPoint,
  WorkspaceMemberDetails,
  AccountActivityStats
} from './types'
import { getClientTimezone, isNetworkError } from './utils'

/** @public */
export interface AccountClient {
  // Static methods
  getProviders: () => Promise<ProviderInfo[]>

  // RPC
  getUserWorkspaces: () => Promise<WorkspaceInfoWithStatus[]>
  selectWorkspace: (
    workspaceUrl: string,
    kind?: 'external' | 'internal' | 'byregion',
    externalRegions?: string[]
  ) => Promise<WorkspaceLoginInfo>
  validateOtp: (email: string, code: string, password?: string, action?: 'verify') => Promise<LoginInfo>
  loginOtp: (email: string) => Promise<OtpInfo>
  getLoginInfoByToken: (data?: LoginInfoRequestData) => Promise<LoginInfoByToken>
  getLoginWithWorkspaceInfo: () => Promise<LoginInfoWithWorkspaces>
  restorePassword: (password: string) => Promise<LoginInfo>
  confirm: () => Promise<LoginInfo>
  requestPasswordReset: (email: string) => Promise<void>
  sendInvite: (email: string, role: AccountRole) => Promise<void>
  resendInvite: (email: string, role: AccountRole) => Promise<void>
  createInviteLink: (
    email: string,
    role: AccountRole,
    autoJoin: boolean,
    firstName: string,
    lastName: string,
    navigateUrl?: string,
    expHours?: number
  ) => Promise<string>
  leaveWorkspace: (account: AccountUuid, otpCode?: string) => Promise<LoginInfo | null>
  changeUsername: (first: string, last: string) => Promise<void>
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>
  signUpJoin: (
    email: string,
    password: string,
    first: string,
    last: string,
    inviteId: string,
    workspaceUrl: string
  ) => Promise<WorkspaceLoginInfo>
  join: (email: string, password: string, inviteId: string, workspaceUrl: string) => Promise<WorkspaceLoginInfo>
  createInvite: (exp: number, emailMask: string, limit: number, role: AccountRole) => Promise<string>
  /**
   * @param options.personalized
   * If true, will generate a link with a personalized token for one person access
   * If false, will generate a link with an open-ended account in the token. Every token use will generate a new account.
   * When false, notBefore and expiration parameters are mandatory.
   * @param options.notBefore - not valid before; timestamp in seconds
   * @param options.expiration - expires after; timestamp in seconds
   */
  createAccessLink: (
    role: AccountRole,
    options?: {
      firstName?: string
      lastName?: string
      navigateUrl?: string
      extra?: Record<string, any>
      spaces?: string[]
      notBefore?: number
      expiration?: number
      personalized?: boolean
    }
  ) => Promise<string>
  checkJoin: (inviteId: string) => Promise<WorkspaceLoginInfo>
  joinByInvite: (inviteId: string) => Promise<WorkspaceLoginInfo>
  checkAutoJoin: (inviteId: string, firstName?: string, lastName?: string) => Promise<WorkspaceLoginInfo>
  getInviteInfo: (inviteId: string) => Promise<WorkspaceInviteInfo>
  getWorkspaceSeats: () => Promise<WorkspaceSeatsInfo>
  getWorkspaceInfo: (updateLastVisit?: boolean) => Promise<WorkspaceInfoWithStatus>
  getWorkspacesInfo: (workspaces: WorkspaceUuid[]) => Promise<WorkspaceInfoWithStatus[]>
  updateLastVisit: (workspaces: WorkspaceUuid[]) => Promise<void>
  getRegionInfo: () => Promise<RegionInfo[]>
  getLicenseInfo: () => Promise<LicenseInfo>
  createWorkspace: (name: string, region?: string) => Promise<WorkspaceLoginInfo>
  signUpOtp: (email: string, first: string, last: string, phone?: string) => Promise<OtpInfo>
  /**
   * Deprecated. Only to be used for dev setups without mail service.
   */
  signUp: (email: string, password: string, first: string, last: string) => Promise<LoginInfo>
  login: (email: string, password: string) => Promise<LoginInfo>
  loginAsGuest: () => Promise<LoginInfo>
  isReadOnlyGuest: () => Promise<boolean>
  getPerson: () => Promise<Person>
  getPersonInfo: (account: PersonUuid) => Promise<PersonInfo>
  getSocialIds: (includeDeleted?: boolean) => Promise<SocialId[]>
  getWorkspaceMembers: () => Promise<WorkspaceMemberInfo[]>
  updateWorkspaceRole: (account: string, role: AccountRole) => Promise<void>
  isAllowReadOnlyGuests: () => Promise<{ allowed: boolean }>
  updateAllowReadOnlyGuests: (
    readOnlyGuestsAllowed: boolean
  ) => Promise<{ guestPerson: Person, guestSocialIds: SocialId[] } | undefined>
  updateAllowGuestSignUp: (guestSignUpAllowed: boolean) => Promise<void>
  updateWorkspaceName: (name: string) => Promise<void>
  deleteWorkspace: (otpCode: string) => Promise<void>
  /** Sends a confirmation code to the caller's verified email. */
  requestOperationOtp: () => Promise<OtpInfo>
  findPersonBySocialKey: (socialKey: string, requireAccount?: boolean) => Promise<PersonUuid | undefined>
  findPersonBySocialId: (socialId: PersonId, requireAccount?: boolean) => Promise<PersonUuid | undefined>
  findSocialIdBySocialKey: (socialKey: string) => Promise<PersonId | undefined>
  findFullSocialIdBySocialKey: (socialKey: string) => Promise<SocialId | undefined>
  findFullSocialIds: (socialIds: PersonId[]) => Promise<SocialId[]>
  getMailboxOptions: () => Promise<MailboxOptions>
  getMailboxSecret: (mailbox: string) => Promise<MailboxSecret | undefined>
  createMailbox: (name: string, domain: string) => Promise<{ mailbox: string, socialId: PersonId }>
  getMailboxes: () => Promise<MailboxInfo[]>
  deleteMailbox: (mailbox: string) => Promise<void>
  listAccounts: (
    search?: string,
    skip?: number,
    limit?: number,
    sort?: AccountsSortKey,
    filter?: AccountsFilter,
    order?: 'asc' | 'desc'
  ) => Promise<AccountAggregatedInfo[]>
  getTransactorEndpoints: () => Promise<TransactorEndpointInfo[]>
  deleteAccount: (uuid: AccountUuid, otpCode?: string) => Promise<void>

  workerHandshake: (region: string, version: Data<Version>, operation: WorkspaceOperation) => Promise<void>
  getPendingWorkspace: (
    region: string,
    version: Data<Version>,
    operation: WorkspaceOperation
  ) => Promise<WorkspaceInfoWithStatus | null>
  updateWorkspaceInfo: (
    wsUuid: string,
    event: string,
    version: Data<Version>,
    progress: number,
    message?: string
  ) => Promise<void>
  /**
   * Lists workspaces in the specified region and mode.
   * If visited is set, all workspaces visited during visited days will be returned.
   */
  listWorkspaces: (
    region?: string | null,
    mode?: WorkspaceMode | null,
    visited?: number
  ) => Promise<WorkspaceInfoWithStatus[]>
  listWorkspacesPaged: (query: WorkspacesPagedQuery) => Promise<WorkspacesPagedResult>
  getWorkspacesSummary: () => Promise<WorkspacesSummary>
  getRegistrationStats: (from: number, to: number) => Promise<RegistrationStats>
  getWorkspaceActivityStats: (workspace: WorkspaceUuid, from: number) => Promise<WorkspaceActivityPoint[]>
  getWorkspaceMembersInfo: (workspace: WorkspaceUuid) => Promise<WorkspaceMemberDetails[]>
  getAccountActivityStats: (account: AccountUuid, from: number) => Promise<AccountActivityStats>
  requestAdminOperationOtp: () => Promise<OtpInfo>
  /** Consumes the admin second factor and returns a token stamped with `mfaAt`. */
  verifyAdminSession: (otpCode: string) => Promise<{ account: AccountUuid, token: string }>
  /** Global maintenance warning; timeoutMinutes < 0 clears it. */
  adminSetMaintenance: (timeoutMinutes: number, message: string | undefined, otpCode: string) => Promise<void>
  /** Drops every live session of a workspace on whichever transactor holds it. */
  adminForceCloseWorkspace: (workspace: WorkspaceUuid, otpCode: string) => Promise<void>
  /** Records the operator's intent to export a report; the audit entry is the point. */
  adminConfirmExport: (kind: string, filter: Record<string, any> | undefined, otpCode: string) => Promise<void>
  /** Read-only session inside a workspace as one of its members. */
  adminImpersonate: (workspace: WorkspaceUuid, account: AccountUuid, otpCode: string) => Promise<WorkspaceLoginInfo>
  adminUpdateWorkspaceRole: (
    workspace: WorkspaceUuid,
    targetAccount: AccountUuid,
    role: AccountRole,
    otpCode: string
  ) => Promise<void>
  adminAddWorkspaceMember: (
    workspace: WorkspaceUuid,
    email: string,
    role: AccountRole,
    otpCode: string
  ) => Promise<void>
  adminRemoveWorkspaceMember: (workspace: WorkspaceUuid, targetAccount: AccountUuid, otpCode: string) => Promise<void>
  adminReindexWorkspace: (workspace: WorkspaceUuid, otpCode: string) => Promise<void>
  adminReindexAllWorkspaces: (otpCode: string) => Promise<number>
  adminUpdateSubscription: (
    subscriptionId: string,
    otpCode: string,
    seats?: number,
    periodEndMs?: number,
    amount?: number,
    windowMonthLimit?: number
  ) => Promise<void>
  adminCancelSubscription: (subscriptionId: string, otpCode: string) => Promise<void>
  adminUpdateWorkspaceName: (workspace: WorkspaceUuid, name: string, otpCode: string) => Promise<void>
  adminUpdateWorkspaceDisabledFeatures: (workspace: WorkspaceUuid, features: string[], otpCode: string) => Promise<void>
  adminUpdateWorkspaceUrl: (workspace: WorkspaceUuid, url: string, otpCode: string) => Promise<void>
  adminReleaseSocialId: (personUuid: PersonUuid, type: SocialIdType, value: string, otpCode: string) => Promise<void>
  adminDeletePerson: (personUuid: PersonUuid, otpCode: string) => Promise<void>
  listAdminActions: (query: AdminActionsQuery) => Promise<AdminActionsResult>
  performWorkspaceOperation: (
    workspaceId: string | string[],
    event: WorkspaceUserOperation,
    ...params: any
  ) => Promise<boolean>
  performWorkspaceOperationWithOtp: (
    workspaceId: string | string[],
    event: WorkspaceUserOperation,
    otpCode: string,
    ...params: any
  ) => Promise<boolean>
  assignWorkspace: (email: string, workspaceUuid: string, role: AccountRole) => Promise<void>
  updateBackupInfo: (info: BackupStatus) => Promise<void>
  updateUsageInfo: (info: UsageStatus) => Promise<void>
  updateWorkspaceRoleBySocialKey: (socialKey: string, targetRole: AccountRole) => Promise<void>
  ensurePerson: (
    socialType: SocialIdType,
    socialValue: string,
    firstName: string,
    lastName: string
  ) => Promise<{ uuid: PersonUuid, socialId: PersonId }>
  addSocialIdToPerson: (
    person: PersonUuid,
    type: SocialIdType,
    value: string,
    confirmed: boolean,
    displayValue?: string
  ) => Promise<PersonId>
  updateSocialId: (personId: PersonId, displayValue: string) => Promise<PersonId>
  exchangeGuestToken: (token: string) => Promise<string>
  /**
   * Releases the target social id for the target account.
   * If called with user's token it releases the social id for the user's account.
   * @param personUuid Required for services
   * @param type Social id type
   * @param value Social id value
   * @param deleteIntegrations Deletes associated integrations if true. Otherwise, throws an error if any.
   * @returns Deleted social id with updated isDeleted flag and key/value
   */
  releaseSocialId: (
    personUuid: PersonUuid | undefined,
    type: SocialIdType,
    value: string,
    deleteIntegrations?: boolean
  ) => Promise<SocialId>
  createIntegration: (integration: Integration) => Promise<void>
  updateIntegration: (integration: Integration) => Promise<void>
  deleteIntegration: (integrationKey: IntegrationKey) => Promise<void>
  getIntegration: (integrationKey: IntegrationKey) => Promise<Integration | null>
  listIntegrations: (filter: Partial<IntegrationKey>) => Promise<Integration[]>
  addIntegrationSecret: (integrationSecret: IntegrationSecret) => Promise<void>
  updateIntegrationSecret: (integrationSecret: IntegrationSecret) => Promise<void>
  deleteIntegrationSecret: (integrationSecretKey: IntegrationSecretKey) => Promise<void>
  getIntegrationSecret: (integrationSecretKey: IntegrationSecretKey) => Promise<IntegrationSecret | null>
  listIntegrationsSecrets: (filter: Partial<IntegrationSecretKey>) => Promise<IntegrationSecret[]>
  getAccountInfo: (uuid: AccountUuid) => Promise<AccountInfo>
  canMergeSpecifiedPersons: (primaryPerson: PersonUuid, secondaryPerson: PersonUuid) => Promise<boolean>
  mergeSpecifiedPersons: (primaryPerson: PersonUuid, secondaryPerson: PersonUuid) => Promise<void>
  mergeSpecifiedAccounts: (primaryAccount: AccountUuid, secondaryAccount: AccountUuid) => Promise<void>
  addEmailSocialId: (email: string) => Promise<OtpInfo>
  addHulyAssistantSocialId: () => Promise<PersonId>
  refreshHulyAssistantToken: () => Promise<void>
  updatePasswordAgingRule: (days?: number) => Promise<void>
  checkPasswordAging: () => Promise<boolean>

  setMyProfile: (profile: Partial<Omit<UserProfile, 'personUuid'>>) => Promise<void>
  getUserProfile: (personUuid?: PersonUuid) => Promise<PersonWithProfile | null>

  getSubscriptions: (workspaceUuid?: WorkspaceUuid | undefined, activeOnly?: boolean) => Promise<Subscription[]>
  getAllSubscriptions: () => Promise<SubscriptionInfo[]>
  getSubscriptionByProviderId: (provider: string, providerSubscriptionId: string) => Promise<Subscription | null>
  getSubscriptionsByProvider: (
    provider?: string,
    statuses?: string[],
    trialEndBefore?: number
  ) => Promise<Subscription[]>
  claimIntent: (
    claimKey: string,
    provider: string,
    ctx?: { subscriptionId?: string, workspaceUuid?: WorkspaceUuid, amount?: number, orderFingerprint?: string }
  ) => Promise<{ claimed: boolean, intent: PaymentIntent }>
  markChargeIntent: (intentId: string, status: 'charged' | 'failed', paymentId?: string) => Promise<void>
  heartbeatChargeIntent: (intentId: string) => Promise<void>
  reclaimStaleChargeIntent: (intentId: string, leaseMs: number) => Promise<boolean>
  setIntentPayment: (intentId: string, paymentId: string, paymentUrl?: string) => Promise<void>
  deleteCheckoutIntentByPaymentId: (paymentId: string, provider: string) => Promise<void>
  deleteCheckoutIntentById: (intentId: string) => Promise<void>
  logPaymentOperation: (op: PaymentOperation) => Promise<void>
  getPaymentOperationStats: (from: number, to: number) => Promise<PaymentOperationStats>
  getPaymentOperations: (filter: PaymentOperationFilter) => Promise<PaymentOperation[]>
  getPaymentMonthlyStats: (from: number, to: number) => Promise<PaymentMonthlyStats[]>
  createPurchase: (purchase: WorkspacePurchase) => Promise<string>
  updatePurchaseStatus: (id: string, status: WorkspacePurchaseStatus, activatedOn?: number) => Promise<void>
  getPurchases: (workspaceUuid?: WorkspaceUuid) => Promise<WorkspacePurchase[]>
  getSubscriptionById: (subscriptionId: string) => Promise<Subscription | null>
  upsertSubscription: (subscription: SubscriptionUpsert) => Promise<void>
  upsertSubscriptionsBulk: (
    subscriptions: SubscriptionUpsert[]
  ) => Promise<Array<{ id: string, ok: boolean, error?: string }>>
  adminCreateSubscription: (params: {
    workspaceUuid: WorkspaceUuid
    plan: string
    type?: string
    status?: string
    limits?: Subscription['limits']
    periodDays?: number
    trialEnd?: number
    otpCode: string
  }) => Promise<void>

  batchAssignWorkspacePermission: (params: { accountIds: AccountUuid[], permission: string }) => Promise<void>
  batchRevokeWorkspacePermission: (params: { accountIds: AccountUuid[], permission: string }) => Promise<void>
  hasWorkspacePermission: (params: { accountId: AccountUuid, permission: string }) => Promise<boolean>
  getWorkspacePermissions: (params: { accountId: AccountUuid, permission: string }) => Promise<WorkspaceUuid[]>
  getWorkspaceUsersWithPermission: (params: { permission: string }) => Promise<AccountUuid[]>

  setCookie: () => Promise<void>
  deleteCookie: () => Promise<void>
  getAccountWorkspaceBadgeStatuses: (account: AccountUuid) => Promise<AccountWorkspaceBadgeStatus[]>
  setWorkspaceBadgeStatuses: (
    data: Array<{ accountId: AccountUuid, workspaceId: WorkspaceUuid, hasUnread: boolean }>
  ) => Promise<void>
}

/** @public */
export function getClient (
  accountsUrl?: string,
  token?: string,
  retryTimeoutMs?: number,
  origin?: string
): AccountClient {
  if (accountsUrl === undefined) {
    throw new Error('Accounts url not specified')
  }

  return new AccountClientImpl(accountsUrl, token, retryTimeoutMs, origin)
}

interface Request {
  method: string
  params: Record<string, any>
}

class AccountClientImpl implements AccountClient {
  private readonly request: RequestInit
  private readonly rpc: typeof this._rpc

  constructor (
    private readonly url: string,
    private readonly token?: string,
    retryTimeoutMs?: number,
    private readonly origin?: string
  ) {
    if (url === '') {
      throw new Error('Accounts url not specified')
    }

    const isBrowser = typeof window !== 'undefined'

    this.request = {
      keepalive: true,
      headers: {
        ...(this.token === undefined
          ? {}
          : {
              Authorization: 'Bearer ' + this.token
            }),
        ...(origin !== undefined ? { 'X-Origin': origin } : {})
      },
      ...(isBrowser ? { credentials: 'include' } : {})
    }
    this.rpc = withRetryUntilTimeout(this._rpc.bind(this), retryTimeoutMs ?? 5000)
  }

  async getProviders (): Promise<ProviderInfo[]> {
    return await withRetryUntilMaxAttempts(async () => {
      const response = await fetch(concatLink(this.url, '/providers'))

      return await response.json()
    })()
  }

  private async _rpc<T>(request: Request): Promise<T> {
    const timezone = getClientTimezone()
    const meta: Record<string, string> = timezone !== undefined ? { 'x-timezone': timezone } : {}
    const response = await fetch(this.url, {
      ...this.request,
      headers: {
        ...this.request.headers,
        'Content-Type': 'application/json',
        Connection: 'keep-alive',
        ...meta
      },
      method: 'POST',
      body: JSON.stringify(request)
    })

    const result = await response.json()
    if (result.error != null) {
      throw new PlatformError(result.error)
    }

    return result.result
  }

  private flattenStatus (ws: any): WorkspaceInfoWithStatus {
    if (ws === undefined) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.WorkspaceNotFound, {}))
    }

    const status = ws.status
    if (status === undefined) {
      return ws
    }

    const result = { ...ws, ...status, processingAttemps: status.processingAttempts ?? 0 }
    delete result.status

    return result
  }

  async getUserWorkspaces (): Promise<WorkspaceInfoWithStatus[]> {
    const request = {
      method: 'getUserWorkspaces' as const,
      params: {}
    }

    return (await this.rpc<any[]>(request)).map((ws) => this.flattenStatus(ws))
  }

  async selectWorkspace (
    workspaceUrl: string,
    kind: 'external' | 'internal' | 'byregion' = 'external',
    externalRegions: string[] = []
  ): Promise<WorkspaceLoginInfo> {
    const request = {
      method: 'selectWorkspace' as const,
      params: { workspaceUrl, kind, externalRegions }
    }

    return await this.rpc(request)
  }

  async validateOtp (email: string, code: string, password?: string, action?: 'verify'): Promise<LoginInfo> {
    const request = {
      method: 'validateOtp' as const,
      params: { email, code, password, action }
    }

    return await this.rpc(request)
  }

  async loginOtp (email: string): Promise<OtpInfo> {
    const request = {
      method: 'loginOtp' as const,
      params: { email }
    }

    return await this.rpc(request)
  }

  async getLoginInfoByToken (data?: LoginInfoRequestData): Promise<LoginInfoByToken> {
    const request = {
      method: 'getLoginInfoByToken' as const,
      params: data ?? {}
    }

    return await this.rpc(request)
  }

  async getLoginWithWorkspaceInfo (): Promise<LoginInfoWithWorkspaces> {
    const request = {
      method: 'getLoginWithWorkspaceInfo' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async restorePassword (password: string): Promise<LoginInfo> {
    const request = {
      method: 'restorePassword' as const,
      params: { password }
    }

    return await this.rpc(request)
  }

  async confirm (): Promise<LoginInfo> {
    const request = {
      method: 'confirm' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async requestPasswordReset (email: string): Promise<void> {
    const request = {
      method: 'requestPasswordReset' as const,
      params: { email }
    }

    await this.rpc(request)
  }

  async sendInvite (email: string, role: AccountRole): Promise<void> {
    const request = {
      method: 'sendInvite' as const,
      params: { email, role }
    }

    await this.rpc(request)
  }

  async resendInvite (email: string, role: AccountRole): Promise<void> {
    const request = {
      method: 'resendInvite' as const,
      params: { email, role }
    }

    await this.rpc(request)
  }

  async createInviteLink (
    email: string,
    role: AccountRole,
    autoJoin: boolean,
    firstName: string,
    lastName: string,
    navigateUrl?: string,
    expHours?: number
  ): Promise<string> {
    const request = {
      method: 'createInviteLink' as const,
      params: { email, role, autoJoin, firstName, lastName, navigateUrl, expHours }
    }

    return await this.rpc(request)
  }

  async createAccessLink (
    role: AccountRole,
    options?: {
      firstName?: string
      lastName?: string
      navigateUrl?: string
      extra?: Record<string, any>
      spaces?: string[]
      notBefore?: number
      expiration?: number
      personalized?: boolean
    }
  ): Promise<string> {
    const params: any = { ...(options ?? {}), role }
    if (params.extra != null) {
      params.extra = JSON.stringify(params.extra)
    }

    const request = {
      method: 'createAccessLink' as const,
      params
    }

    return await this.rpc(request)
  }

  async leaveWorkspace (account: AccountUuid, otpCode?: string): Promise<LoginInfo | null> {
    const request = {
      method: 'leaveWorkspace' as const,
      params: { account, otpCode }
    }

    return await this.rpc(request)
  }

  async changeUsername (first: string, last: string): Promise<void> {
    const request = {
      method: 'changeUsername' as const,
      params: { first, last }
    }

    await this.rpc(request)
  }

  async changePassword (oldPassword: string, newPassword: string): Promise<void> {
    const request = {
      method: 'changePassword' as const,
      params: { oldPassword, newPassword }
    }

    await this.rpc(request)
  }

  async updatePasswordAgingRule (days?: number): Promise<void> {
    const request = {
      method: 'updatePasswordAgingRule' as const,
      params: { days }
    }

    await this.rpc(request)
  }

  async checkPasswordAging (): Promise<boolean> {
    const request = {
      method: 'checkPasswordAging' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async signUpJoin (
    email: string,
    password: string,
    first: string,
    last: string,
    inviteId: string,
    workspaceUrl: string
  ): Promise<WorkspaceLoginInfo> {
    const request = {
      method: 'signUpJoin' as const,
      params: { email, password, first, last, inviteId, workspaceUrl }
    }

    return await this.rpc(request)
  }

  async join (email: string, password: string, inviteId: string, workspaceUrl: string): Promise<WorkspaceLoginInfo> {
    const request = {
      method: 'join' as const,
      params: { email, password, inviteId, workspaceUrl }
    }

    return await this.rpc(request)
  }

  async createInvite (exp: number, emailMask: string, limit: number, role: AccountRole): Promise<string> {
    const request = {
      method: 'createInvite' as const,
      params: { exp, emailMask, limit, role }
    }

    return await this.rpc(request)
  }

  async checkJoin (inviteId: string): Promise<WorkspaceLoginInfo> {
    const request = {
      method: 'checkJoin' as const,
      params: { inviteId }
    }

    return await this.rpc(request)
  }

  async joinByInvite (inviteId: string): Promise<WorkspaceLoginInfo> {
    const request = {
      method: 'joinByInvite' as const,
      params: { inviteId }
    }

    return await this.rpc(request)
  }

  async checkAutoJoin (inviteId: string, firstName?: string, lastName?: string): Promise<WorkspaceLoginInfo> {
    const request = {
      method: 'checkAutoJoin' as const,
      params: { inviteId, firstName, lastName }
    }

    return await this.rpc(request)
  }

  async getInviteInfo (inviteId: string): Promise<WorkspaceInviteInfo> {
    const request = {
      method: 'getInviteInfo' as const,
      params: { inviteId }
    }

    return await this.rpc(request)
  }

  async getWorkspaceSeats (): Promise<WorkspaceSeatsInfo> {
    const request = {
      method: 'getWorkspaceSeats' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async getWorkspacesInfo (ids: WorkspaceUuid[]): Promise<WorkspaceInfoWithStatus[]> {
    const request = {
      method: 'getWorkspacesInfo' as const,
      params: { ids }
    }
    const infos: any[] = await this.rpc(request)
    return Array.from(infos).map((it) => this.flattenStatus(it))
  }

  async updateLastVisit (ids: WorkspaceUuid[]): Promise<void> {
    const request = {
      method: 'updateLastVisit' as const,
      params: { ids }
    }
    await this.rpc(request)
  }

  async getWorkspaceInfo (updateLastVisit: boolean = false): Promise<WorkspaceInfoWithStatus> {
    const request = {
      method: 'getWorkspaceInfo' as const,
      params: updateLastVisit ? { updateLastVisit: true } : {}
    }

    return this.flattenStatus(await this.rpc(request))
  }

  async getRegionInfo (): Promise<RegionInfo[]> {
    const request = {
      method: 'getRegionInfo' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async getLicenseInfo (): Promise<LicenseInfo> {
    const request = {
      method: 'getLicenseInfo' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async createWorkspace (workspaceName: string, region?: string): Promise<WorkspaceLoginInfo> {
    const request = {
      method: 'createWorkspace' as const,
      params: { workspaceName, region }
    }

    return await this.rpc(request)
  }

  async signUpOtp (email: string, firstName: string, lastName: string, phone?: string): Promise<OtpInfo> {
    const request = {
      method: 'signUpOtp' as const,
      params: { email, firstName, lastName, phone }
    }

    return await this.rpc(request)
  }

  async signUp (email: string, password: string, firstName: string, lastName: string): Promise<LoginInfo> {
    const request = {
      method: 'signUp' as const,
      params: { email, password, firstName, lastName }
    }

    return await this.rpc(request)
  }

  async login (email: string, password: string): Promise<LoginInfo> {
    const request = {
      method: 'login' as const,
      params: { email, password }
    }

    return await this.rpc(request)
  }

  async loginAsGuest (): Promise<LoginInfo> {
    const request = {
      method: 'loginAsGuest' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async isReadOnlyGuest (): Promise<boolean> {
    const request = {
      method: 'isReadOnlyGuest' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async getPerson (): Promise<Person> {
    const request = {
      method: 'getPerson' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async getPersonInfo (account: PersonUuid): Promise<PersonInfo> {
    const request = {
      method: 'getPersonInfo' as const,
      params: { account }
    }

    return await this.rpc(request)
  }

  async getSocialIds (includeDeleted?: boolean): Promise<SocialId[]> {
    const request = {
      method: 'getSocialIds' as const,
      params: { includeDeleted }
    }

    return await this.rpc(request)
  }

  async workerHandshake (region: string, version: Data<Version>, operation: WorkspaceOperation): Promise<void> {
    const request = {
      method: 'workerHandshake' as const,
      params: { region, version, operation }
    }

    await this.rpc(request)
  }

  async getPendingWorkspace (
    region: string,
    version: Data<Version>,
    operation: WorkspaceOperation
  ): Promise<WorkspaceInfoWithStatus | null> {
    const request = {
      method: 'getPendingWorkspace' as const,
      params: { region, version, operation }
    }

    const result = await this.rpc(request)
    if (result == null) {
      return null
    }

    return this.flattenStatus(result)
  }

  async updateWorkspaceInfo (
    workspaceUuid: string,
    event: string,
    version: Data<Version>,
    progress: number,
    message?: string
  ): Promise<void> {
    const request = {
      method: 'updateWorkspaceInfo' as const,
      params: { workspaceUuid, event, version, progress, message }
    }

    await this.rpc(request)
  }

  async isAllowReadOnlyGuests (): Promise<{ allowed: boolean }> {
    const request = {
      method: 'isAllowReadOnlyGuests' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async updateAllowReadOnlyGuests (
    readOnlyGuestsAllowed: boolean
  ): Promise<{ guestPerson: Person, guestSocialIds: SocialId[] } | undefined> {
    const request = {
      method: 'updateAllowReadOnlyGuests' as const,
      params: { readOnlyGuestsAllowed }
    }

    return await this.rpc(request)
  }

  async updateAllowGuestSignUp (guestSignUpAllowed: boolean): Promise<void> {
    const request = {
      method: 'updateAllowGuestSignUp' as const,
      params: { guestSignUpAllowed }
    }

    await this.rpc(request)
  }

  async getWorkspaceMembers (): Promise<WorkspaceMemberInfo[]> {
    const request = {
      method: 'getWorkspaceMembers' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async updateWorkspaceRole (targetAccount: string, targetRole: AccountRole): Promise<void> {
    const request = {
      method: 'updateWorkspaceRole' as const,
      params: { targetAccount, targetRole }
    }

    await this.rpc(request)
  }

  async updateWorkspaceName (name: string): Promise<void> {
    const request = {
      method: 'updateWorkspaceName' as const,
      params: { name }
    }

    await this.rpc(request)
  }

  async deleteWorkspace (otpCode: string): Promise<void> {
    const request = {
      method: 'deleteWorkspace' as const,
      params: { otpCode }
    }

    await this.rpc(request)
  }

  async requestOperationOtp (): Promise<OtpInfo> {
    return await this.rpc({ method: 'requestOperationOtp' as const, params: {} })
  }

  async findPersonBySocialKey (socialString: string, requireAccount?: boolean): Promise<PersonUuid | undefined> {
    const request = {
      method: 'findPersonBySocialKey' as const,
      params: { socialString, requireAccount }
    }

    return await this.rpc(request)
  }

  async findPersonBySocialId (socialId: PersonId, requireAccount?: boolean): Promise<PersonUuid | undefined> {
    const request = {
      method: 'findPersonBySocialId' as const,
      params: { socialId, requireAccount }
    }

    return await this.rpc(request)
  }

  async findSocialIdBySocialKey (socialKey: string): Promise<PersonId | undefined> {
    const request = {
      method: 'findSocialIdBySocialKey' as const,
      params: { socialKey }
    }

    return await this.rpc(request)
  }

  async findFullSocialIdBySocialKey (socialKey: string): Promise<SocialId | undefined> {
    const request = {
      method: 'findFullSocialIdBySocialKey' as const,
      params: { socialKey }
    }
    return await this.rpc(request)
  }

  async findFullSocialIds (socialIds: PersonId[]): Promise<SocialId[]> {
    const request = {
      method: 'findFullSocialIds' as const,
      params: { socialIds }
    }
    return await this.rpc(request)
  }

  async listWorkspaces (
    region?: string | null,
    mode: WorkspaceMode | null = null,
    visited?: number
  ): Promise<WorkspaceInfoWithStatus[]> {
    const request = {
      method: 'listWorkspaces' as const,
      params: { region, mode, visited }
    }

    return ((await this.rpc<any[]>(request)) ?? []).map((ws) => this.flattenStatus(ws))
  }

  async listWorkspacesPaged (query: WorkspacesPagedQuery): Promise<WorkspacesPagedResult> {
    const request = {
      method: 'listWorkspacesPaged' as const,
      params: query
    }
    const res = await this.rpc<{ workspaces: any[], total: number }>(request)
    return {
      workspaces: (res?.workspaces ?? []).map((ws) => this.flattenStatus(ws)),
      total: res?.total ?? 0
    }
  }

  async getWorkspacesSummary (): Promise<WorkspacesSummary> {
    return await this.rpc({ method: 'getWorkspacesSummary' as const, params: {} })
  }

  async getRegistrationStats (from: number, to: number): Promise<RegistrationStats> {
    return await this.rpc({ method: 'getRegistrationStats' as const, params: { from, to } })
  }

  async getWorkspaceActivityStats (workspace: WorkspaceUuid, from: number): Promise<WorkspaceActivityPoint[]> {
    return (await this.rpc({ method: 'getWorkspaceActivityStats' as const, params: { workspace, from } })) ?? []
  }

  async getWorkspaceMembersInfo (workspace: WorkspaceUuid): Promise<WorkspaceMemberDetails[]> {
    return (await this.rpc({ method: 'getWorkspaceMembersInfo' as const, params: { workspace } })) ?? []
  }

  async getAccountActivityStats (account: AccountUuid, from: number): Promise<AccountActivityStats> {
    return await this.rpc({ method: 'getAccountActivityStats' as const, params: { account, from } })
  }

  async requestAdminOperationOtp (): Promise<OtpInfo> {
    return await this.rpc({ method: 'requestAdminOperationOtp' as const, params: {} })
  }

  async verifyAdminSession (otpCode: string): Promise<{ account: AccountUuid, token: string }> {
    return await this.rpc({ method: 'verifyAdminSession' as const, params: { otpCode } })
  }

  async adminSetMaintenance (timeoutMinutes: number, message: string | undefined, otpCode: string): Promise<void> {
    await this.rpc({ method: 'adminSetMaintenance' as const, params: { timeoutMinutes, message, otpCode } })
  }

  async adminForceCloseWorkspace (workspace: WorkspaceUuid, otpCode: string): Promise<void> {
    await this.rpc({ method: 'adminForceCloseWorkspace' as const, params: { workspace, otpCode } })
  }

  async adminConfirmExport (kind: string, filter: Record<string, any> | undefined, otpCode: string): Promise<void> {
    await this.rpc({ method: 'adminConfirmExport' as const, params: { kind, filter, otpCode } })
  }

  async adminImpersonate (workspace: WorkspaceUuid, account: AccountUuid, otpCode: string): Promise<WorkspaceLoginInfo> {
    return await this.rpc({ method: 'adminImpersonate' as const, params: { workspace, account, otpCode } })
  }

  async adminUpdateWorkspaceRole (
    workspace: WorkspaceUuid,
    targetAccount: AccountUuid,
    role: AccountRole,
    otpCode: string
  ): Promise<void> {
    await this.rpc({ method: 'adminUpdateWorkspaceRole' as const, params: { workspace, targetAccount, role, otpCode } })
  }

  async adminAddWorkspaceMember (
    workspace: WorkspaceUuid,
    email: string,
    role: AccountRole,
    otpCode: string
  ): Promise<void> {
    await this.rpc({ method: 'adminAddWorkspaceMember' as const, params: { workspace, email, role, otpCode } })
  }

  async adminRemoveWorkspaceMember (
    workspace: WorkspaceUuid,
    targetAccount: AccountUuid,
    otpCode: string
  ): Promise<void> {
    await this.rpc({ method: 'adminRemoveWorkspaceMember' as const, params: { workspace, targetAccount, otpCode } })
  }

  async adminReindexWorkspace (workspace: WorkspaceUuid, otpCode: string): Promise<void> {
    await this.rpc({ method: 'adminReindexWorkspace' as const, params: { workspace, otpCode } })
  }

  async adminReindexAllWorkspaces (otpCode: string): Promise<number> {
    return await this.rpc({ method: 'adminReindexAllWorkspaces' as const, params: { otpCode } })
  }

  async performWorkspaceOperation (
    workspaceId: string | string[],
    event: WorkspaceUserOperation,
    ...params: any
  ): Promise<boolean> {
    const request = {
      method: 'performWorkspaceOperation' as const,
      params: { workspaceId, event, params }
    }

    return await this.rpc(request)
  }

  async performWorkspaceOperationWithOtp (
    workspaceId: string | string[],
    event: WorkspaceUserOperation,
    otpCode: string,
    ...params: any
  ): Promise<boolean> {
    const request = {
      method: 'performWorkspaceOperation' as const,
      params: { workspaceId, event, params, otpCode }
    }

    return await this.rpc(request)
  }

  async adminUpdateSubscription (
    subscriptionId: string,
    otpCode: string,
    seats?: number,
    periodEndMs?: number,
    amount?: number,
    windowMonthLimit?: number
  ): Promise<void> {
    await this.rpc({
      method: 'adminUpdateSubscription' as const,
      params: { subscriptionId, seats, periodEndMs, amount, windowMonthLimit, otpCode }
    })
  }

  async adminCancelSubscription (subscriptionId: string, otpCode: string): Promise<void> {
    await this.rpc({ method: 'adminCancelSubscription' as const, params: { subscriptionId, otpCode } })
  }

  async adminUpdateWorkspaceName (workspace: WorkspaceUuid, name: string, otpCode: string): Promise<void> {
    await this.rpc({ method: 'adminUpdateWorkspaceName' as const, params: { workspace, name, otpCode } })
  }

  async adminUpdateWorkspaceDisabledFeatures (
    workspace: WorkspaceUuid,
    features: string[],
    otpCode: string
  ): Promise<void> {
    await this.rpc({
      method: 'adminUpdateWorkspaceDisabledFeatures' as const,
      params: { workspace, features, otpCode }
    })
  }

  async adminReleaseSocialId (
    personUuid: PersonUuid,
    type: SocialIdType,
    value: string,
    otpCode: string
  ): Promise<void> {
    await this.rpc({ method: 'adminReleaseSocialId' as const, params: { personUuid, type, value, otpCode } })
  }

  async adminDeletePerson (personUuid: PersonUuid, otpCode: string): Promise<void> {
    await this.rpc({ method: 'adminDeletePerson' as const, params: { personUuid, otpCode } })
  }

  async listAdminActions (query: AdminActionsQuery): Promise<AdminActionsResult> {
    return await this.rpc({ method: 'listAdminActions' as const, params: query })
  }

  async adminUpdateWorkspaceUrl (workspace: WorkspaceUuid, url: string, otpCode: string): Promise<void> {
    await this.rpc({ method: 'adminUpdateWorkspaceUrl' as const, params: { workspace, url, otpCode } })
  }

  async updateBackupInfo (backupInfo: BackupStatus): Promise<void> {
    const request = {
      method: 'updateBackupInfo' as const,
      params: { backupInfo }
    }

    await this.rpc(request)
  }

  async updateUsageInfo (usageInfo: UsageStatus): Promise<void> {
    const request = {
      method: 'updateUsageInfo' as const,
      params: { usageInfo }
    }

    await this.rpc(request)
  }

  async assignWorkspace (email: string, workspaceUuid: string, role: AccountRole): Promise<void> {
    const request = {
      method: 'assignWorkspace' as const,
      params: { email, workspaceUuid, role }
    }

    await this.rpc(request)
  }

  async updateWorkspaceRoleBySocialKey (socialKey: string, targetRole: AccountRole): Promise<void> {
    const request = {
      method: 'updateWorkspaceRoleBySocialKey' as const,
      params: { socialKey, targetRole }
    }

    await this.rpc(request)
  }

  async ensurePerson (
    socialType: SocialIdType,
    socialValue: string,
    firstName: string,
    lastName: string
  ): Promise<{ uuid: PersonUuid, socialId: PersonId }> {
    const request = {
      method: 'ensurePerson' as const,
      params: { socialType, socialValue, firstName, lastName }
    }

    return await this.rpc(request)
  }

  async exchangeGuestToken (token: string): Promise<string> {
    const request = {
      method: 'exchangeGuestToken' as const,
      params: { token }
    }

    return await this.rpc(request)
  }

  async addSocialIdToPerson (
    person: PersonUuid,
    type: SocialIdType,
    value: string,
    confirmed: boolean,
    displayValue?: string
  ): Promise<PersonId> {
    const request = {
      method: 'addSocialIdToPerson' as const,
      params: { person, type, value, confirmed, displayValue }
    }

    return await this.rpc(request)
  }

  async updateSocialId (personId: PersonId, displayValue: string): Promise<PersonId> {
    const request = {
      method: 'updateSocialId' as const,
      params: { personId, displayValue }
    }
    return await this.rpc(request)
  }

  async getMailboxOptions (): Promise<MailboxOptions> {
    const request = {
      method: 'getMailboxOptions' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async getMailboxSecret (mailbox: string): Promise<MailboxSecret | undefined> {
    const request = {
      method: 'getMailboxSecret' as const,
      params: { mailbox }
    }

    return await this.rpc(request)
  }

  async createMailbox (name: string, domain: string): Promise<{ mailbox: string, socialId: PersonId }> {
    const request = {
      method: 'createMailbox' as const,
      params: { name, domain }
    }

    return await this.rpc(request)
  }

  async getMailboxes (): Promise<MailboxInfo[]> {
    const request = {
      method: 'getMailboxes' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async deleteMailbox (mailbox: string): Promise<void> {
    const request = {
      method: 'deleteMailbox' as const,
      params: { mailbox }
    }

    await this.rpc(request)
  }

  async listAccounts (
    search?: string,
    skip?: number,
    limit?: number,
    sort?: AccountsSortKey,
    filter?: AccountsFilter,
    order?: 'asc' | 'desc'
  ): Promise<AccountAggregatedInfo[]> {
    const request = {
      method: 'listAccounts' as const,
      params: { search, skip, limit, sort, filter, order }
    }

    return await this.rpc(request)
  }

  async getTransactorEndpoints (): Promise<TransactorEndpointInfo[]> {
    const request = {
      method: 'getTransactorEndpoints' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async deleteAccount (uuid: AccountUuid, otpCode?: string): Promise<void> {
    const request = {
      method: 'deleteAccount' as const,
      params: { uuid, otpCode }
    }

    await this.rpc(request)
  }

  async releaseSocialId (
    personUuid: PersonUuid | undefined,
    type: SocialIdType,
    value: string,
    deleteIntegrations = false
  ): Promise<SocialId> {
    const request = {
      method: 'releaseSocialId' as const,
      params: { personUuid, type, value, deleteIntegrations }
    }

    return await this.rpc(request)
  }

  async createIntegration (integration: Integration): Promise<void> {
    const request = {
      method: 'createIntegration' as const,
      params: integration
    }

    await this.rpc(request)
  }

  async updateIntegration (integration: Integration): Promise<void> {
    const request = {
      method: 'updateIntegration' as const,
      params: integration
    }

    await this.rpc(request)
  }

  async deleteIntegration (integrationKey: IntegrationKey): Promise<void> {
    const request = {
      method: 'deleteIntegration' as const,
      params: integrationKey
    }

    await this.rpc(request)
  }

  async getIntegration (integrationKey: IntegrationKey): Promise<Integration | null> {
    const request = {
      method: 'getIntegration' as const,
      params: integrationKey
    }

    return await this.rpc(request)
  }

  async listIntegrations (filter: Partial<IntegrationKey>): Promise<Integration[]> {
    const request = {
      method: 'listIntegrations' as const,
      params: filter
    }

    return await this.rpc(request)
  }

  async addIntegrationSecret (integrationSecret: IntegrationSecret): Promise<void> {
    const request = {
      method: 'addIntegrationSecret' as const,
      params: integrationSecret
    }

    await this.rpc(request)
  }

  async updateIntegrationSecret (integrationSecret: IntegrationSecret): Promise<void> {
    const request = {
      method: 'updateIntegrationSecret' as const,
      params: integrationSecret
    }

    await this.rpc(request)
  }

  async deleteIntegrationSecret (integrationSecretKey: IntegrationSecretKey): Promise<void> {
    const request = {
      method: 'deleteIntegrationSecret' as const,
      params: integrationSecretKey
    }

    await this.rpc(request)
  }

  async getIntegrationSecret (integrationSecretKey: IntegrationSecretKey): Promise<IntegrationSecret | null> {
    const request = {
      method: 'getIntegrationSecret' as const,
      params: integrationSecretKey
    }

    return await this.rpc(request)
  }

  async listIntegrationsSecrets (filter: Partial<IntegrationSecretKey>): Promise<IntegrationSecret[]> {
    const request = {
      method: 'listIntegrationsSecrets' as const,
      params: filter
    }

    return await this.rpc(request)
  }

  async getAccountInfo (uuid: AccountUuid): Promise<AccountInfo> {
    const request = {
      method: 'getAccountInfo' as const,
      params: { accountId: uuid }
    }

    return await this.rpc(request)
  }

  async canMergeSpecifiedPersons (primaryPerson: PersonUuid, secondaryPerson: PersonUuid): Promise<boolean> {
    const request = {
      method: 'canMergeSpecifiedPersons' as const,
      params: { primaryPerson, secondaryPerson }
    }

    return await this.rpc(request)
  }

  async mergeSpecifiedPersons (primaryPerson: PersonUuid, secondaryPerson: PersonUuid): Promise<void> {
    const request = {
      method: 'mergeSpecifiedPersons' as const,
      params: { primaryPerson, secondaryPerson }
    }

    await this.rpc(request)
  }

  async mergeSpecifiedAccounts (primaryAccount: AccountUuid, secondaryAccount: AccountUuid): Promise<void> {
    const request = {
      method: 'mergeSpecifiedAccounts' as const,
      params: { primaryAccount, secondaryAccount }
    }

    await this.rpc(request)
  }

  async addEmailSocialId (email: string): Promise<OtpInfo> {
    const request = {
      method: 'addEmailSocialId' as const,
      params: { email }
    }

    return await this.rpc(request)
  }

  async addHulyAssistantSocialId (): Promise<PersonId> {
    const request = {
      method: 'addHulyAssistantSocialId' as const,
      params: {}
    }

    return await this.rpc(request)
  }

  async refreshHulyAssistantToken (): Promise<void> {
    const request = {
      method: 'refreshHulyAssistantToken' as const,
      params: {}
    }

    await this.rpc(request)
  }

  async setCookie (): Promise<void> {
    const url = concatLink(this.url, '/cookie')
    const response = await fetch(url, { ...this.request, method: 'PUT' })

    if (!response.ok) {
      const result = await response.json()
      if (result.error != null) {
        throw new PlatformError(result.error)
      }
    }
  }

  async deleteCookie (): Promise<void> {
    const url = concatLink(this.url, '/cookie')
    const response = await fetch(url, { ...this.request, method: 'DELETE' })

    if (!response.ok) {
      const result = await response.json()
      if (result.error != null) {
        throw new PlatformError(result.error)
      }
    }
  }

  async setMyProfile (profile: Partial<Omit<UserProfile, 'personUuid'>>): Promise<void> {
    const request = {
      method: 'setMyProfile',
      params: {
        profile
      }
    }

    await this._rpc(request)
  }

  async getUserProfile (personUuid?: PersonUuid): Promise<PersonWithProfile | null> {
    return await this._rpc({
      method: 'getUserProfile',
      params: {
        personUuid
      }
    })
  }

  async getSubscriptions (
    workspaceUuid: WorkspaceUuid | undefined = undefined,
    activeOnly: boolean = true
  ): Promise<Subscription[]> {
    return await this._rpc({
      method: 'getSubscriptions',
      params: {
        workspaceUuid,
        activeOnly
      }
    })
  }

  async getAllSubscriptions (): Promise<SubscriptionInfo[]> {
    return await this._rpc({
      method: 'getAllSubscriptions',
      params: {}
    })
  }

  async getSubscriptionByProviderId (provider: string, providerSubscriptionId: string): Promise<Subscription | null> {
    return await this._rpc({
      method: 'getSubscriptionByProviderId',
      params: {
        provider,
        providerSubscriptionId
      }
    })
  }

  async getSubscriptionsByProvider (
    provider?: string,
    statuses?: string[],
    trialEndBefore?: number
  ): Promise<Subscription[]> {
    return await this._rpc({
      method: 'getSubscriptionsByProvider',
      params: {
        provider,
        statuses,
        trialEndBefore
      }
    })
  }

  async claimIntent (
    claimKey: string,
    provider: string,
    ctx?: { subscriptionId?: string, workspaceUuid?: WorkspaceUuid, amount?: number, orderFingerprint?: string }
  ): Promise<{ claimed: boolean, intent: PaymentIntent }> {
    return await this._rpc({
      method: 'claimIntent',
      params: {
        claimKey,
        provider,
        subscriptionId: ctx?.subscriptionId,
        workspaceUuid: ctx?.workspaceUuid,
        amount: ctx?.amount,
        orderFingerprint: ctx?.orderFingerprint
      }
    })
  }

  async markChargeIntent (intentId: string, status: 'charged' | 'failed', paymentId?: string): Promise<void> {
    await this._rpc({
      method: 'markChargeIntent',
      params: {
        intentId,
        status,
        paymentId
      }
    })
  }

  async heartbeatChargeIntent (intentId: string): Promise<void> {
    await this._rpc({
      method: 'heartbeatChargeIntent',
      params: { intentId }
    })
  }

  async reclaimStaleChargeIntent (intentId: string, leaseMs: number): Promise<boolean> {
    return await this._rpc({
      method: 'reclaimStaleChargeIntent',
      params: { intentId, leaseMs }
    })
  }

  async setIntentPayment (intentId: string, paymentId: string, paymentUrl?: string): Promise<void> {
    await this._rpc({
      method: 'setIntentPayment',
      params: { intentId, paymentId, paymentUrl }
    })
  }

  async deleteCheckoutIntentByPaymentId (paymentId: string, provider: string): Promise<void> {
    await this._rpc({
      method: 'deleteCheckoutIntentByPaymentId',
      params: { paymentId, provider }
    })
  }

  async deleteCheckoutIntentById (intentId: string): Promise<void> {
    await this._rpc({
      method: 'deleteCheckoutIntentById',
      params: { intentId }
    })
  }

  async logPaymentOperation (op: PaymentOperation): Promise<void> {
    await this._rpc({
      method: 'logPaymentOperation',
      params: { op }
    })
  }

  async getPaymentOperationStats (from: number, to: number): Promise<PaymentOperationStats> {
    return await this._rpc({
      method: 'getPaymentOperationStats',
      params: { from, to }
    })
  }

  async getPaymentOperations (filter: PaymentOperationFilter): Promise<PaymentOperation[]> {
    return await this._rpc({
      method: 'getPaymentOperations',
      params: filter
    })
  }

  async getPaymentMonthlyStats (from: number, to: number): Promise<PaymentMonthlyStats[]> {
    return await this._rpc({
      method: 'getPaymentMonthlyStats',
      params: { from, to }
    })
  }

  async createPurchase (purchase: WorkspacePurchase): Promise<string> {
    return await this._rpc({
      method: 'createPurchase',
      params: { purchase }
    })
  }

  async updatePurchaseStatus (id: string, status: WorkspacePurchaseStatus, activatedOn?: number): Promise<void> {
    await this._rpc({
      method: 'updatePurchaseStatus',
      params: { id, status, activatedOn }
    })
  }

  async getPurchases (workspaceUuid?: WorkspaceUuid): Promise<WorkspacePurchase[]> {
    return await this._rpc({
      method: 'getPurchases',
      params: { workspaceUuid }
    })
  }

  async getSubscriptionById (subscriptionId: string): Promise<Subscription | null> {
    return await this._rpc({
      method: 'getSubscriptionById',
      params: {
        subscriptionId
      }
    })
  }

  async upsertSubscription (subscription: SubscriptionUpsert): Promise<void> {
    await this._rpc({
      method: 'upsertSubscription',
      params: subscription
    })
  }

  async upsertSubscriptionsBulk (
    subscriptions: SubscriptionUpsert[]
  ): Promise<Array<{ id: string, ok: boolean, error?: string }>> {
    return await this._rpc({
      method: 'upsertSubscriptionsBulk',
      params: { subscriptions }
    })
  }

  async adminCreateSubscription (params: {
    workspaceUuid: WorkspaceUuid
    plan: string
    type?: string
    status?: string
    limits?: Subscription['limits']
    periodDays?: number
    trialEnd?: number
    otpCode: string
  }): Promise<void> {
    await this._rpc({
      method: 'adminCreateSubscription',
      params
    })
  }

  async batchAssignWorkspacePermission (params: { accountIds: AccountUuid[], permission: string }): Promise<void> {
    await this._rpc({
      method: 'batchAssignWorkspacePermission',
      params
    })
  }

  async batchRevokeWorkspacePermission (params: { accountIds: AccountUuid[], permission: string }): Promise<void> {
    await this._rpc({
      method: 'batchRevokeWorkspacePermission',
      params
    })
  }

  async hasWorkspacePermission (params: { accountId: AccountUuid, permission: string }): Promise<boolean> {
    return await this._rpc({
      method: 'hasWorkspacePermission',
      params
    })
  }

  async getWorkspacePermissions (params: { accountId: AccountUuid, permission: string }): Promise<WorkspaceUuid[]> {
    return await this._rpc({
      method: 'getWorkspacePermissions',
      params
    })
  }

  async getWorkspaceUsersWithPermission (params: { permission: string }): Promise<AccountUuid[]> {
    return await this._rpc({
      method: 'getWorkspaceUsersWithPermission',
      params
    })
  }

  async getAccountWorkspaceBadgeStatuses (account: AccountUuid): Promise<AccountWorkspaceBadgeStatus[]> {
    const request = {
      method: 'getAccountWorkspaceBadgeStatuses' as const,
      params: { account }
    }
    return await this.rpc(request)
  }

  async setWorkspaceBadgeStatuses (
    data: Array<{ accountId: AccountUuid, workspaceId: WorkspaceUuid, hasUnread: boolean }>
  ): Promise<void> {
    const request = {
      method: 'setWorkspaceBadgeStatuses' as const,
      params: { data }
    }
    await this.rpc(request)
  }
}

function withRetry<T, F extends (...args: any[]) => Promise<T>> (
  f: F,
  shouldFail: (err: any, attempt: number) => boolean,
  intervalMs: number = 25
): F {
  return async function (...params: any[]): Promise<T> {
    let attempt = 0
    while (true) {
      try {
        return await f(...params)
      } catch (err: any) {
        if (shouldFail(err, attempt)) {
          throw err
        }

        attempt++
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
        if (intervalMs < 1000) {
          intervalMs += 100
        }
      }
    }
  } as F
}

function withRetryUntilTimeout<T, F extends (...args: any[]) => Promise<T>> (f: F, timeoutMs: number = 5000): F {
  // Deadline per call: the wrapper is built once in the constructor, so capturing it
  // here would kill retries for good once timeoutMs elapsed since client creation.
  return async function (...params: Parameters<F>): Promise<T> {
    const timeout = Date.now() + timeoutMs
    const shouldFail = (err: any): boolean => !isNetworkError(err) || timeout < Date.now()
    return await withRetry(f, shouldFail)(...params)
  } as F
}

function withRetryUntilMaxAttempts<T, F extends (...args: any[]) => Promise<T>> (f: F, maxAttempts: number = 5): F {
  const shouldFail = (err: any, attempt: number): boolean => !isNetworkError(err) || attempt === maxAttempts

  return withRetry(f, shouldFail)
}

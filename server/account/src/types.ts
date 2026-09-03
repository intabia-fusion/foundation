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
  type AccountRole,
  type BackupStatus,
  type Branding,
  type Data,
  type MeasureContext,
  type Timestamp,
  type Version,
  type WorkspaceMemberInfo,
  type WorkspaceMode,
  type AccountUuid,
  type Person as BasePerson,
  type PersonId,
  type PersonUuid,
  type SocialId as SocialIdBase,
  type SocialIdType,
  type UsageStatus,
  type WorkspaceDataId,
  type WorkspaceUuid,
  type WorkspaceInfo,
  type WorkspaceUpdateEvent,
  type IntegrationKind
} from '@hcengineering/core'
import type { EndpointInfo } from './utils'

/* ========= D A T A B A S E  E N T I T I E S ========= */
export enum Location {
  KV = 'kv',
  WEUR = 'weur',
  EEUR = 'eeur',
  WNAM = 'wnam',
  ENAM = 'apac'
}

// AccountRole in core

export interface Person extends BasePerson {
  migratedTo?: PersonUuid
}

export interface SocialId extends SocialIdBase {
  personUuid: PersonUuid
  createdOn?: Timestamp
  verifiedOn?: Timestamp
}

export interface Account {
  uuid: AccountUuid
  automatic?: boolean
  timezone?: string
  locale?: string
  hash?: Buffer | null
  salt?: Buffer | null
  maxWorkspaces?: number
  failedLoginAttempts?: number // Number of consecutive failed login attempts
}

// TODO: type data with generic type
export interface AccountEvent {
  accountUuid: AccountUuid
  eventType: AccountEventType
  data?: Record<string, any>
  time: Timestamp
}

export enum AccountEventType {
  ACCOUNT_CREATED = 'account_created',
  SOCIAL_ID_RELEASED = 'social_id_released',
  ACCOUNT_DELETED = 'account_deleted',
  PASSWORD_CHANGED = 'password_changed'
}

export interface Member {
  accountUuid: PersonUuid
  role: AccountRole
}

/**
 * Admin audit trail. Deliberately FK-free: rows must survive deletion of their target.
 * Duplicated in account-client/src/types.ts - change both.
 */
export interface AdminAction {
  id?: string // DB-generated on insert
  actor: string
  actorEmail?: string
  action: string
  target?: string
  targetLabel?: string
  data?: Record<string, any>
  createdOn: Timestamp
}

export interface AdminActionsQuery {
  search?: string // actor email / target uuid / target label
  action?: string
  skip?: number
  limit?: number
}

export interface AdminActionsResult {
  actions: AdminAction[]
  total: number
}

export interface WorkspaceVersion {
  versionMajor: number
  versionMinor: number
  versionPatch: number
}

export interface WorkspaceStatus extends WorkspaceVersion {
  workspaceUuid: WorkspaceUuid
  mode: WorkspaceMode
  processingProgress?: number
  lastProcessingTime?: Timestamp
  lastVisit?: Timestamp
  isDisabled: boolean
  processingAttempts?: number
  processingMessage?: string
  backupInfo?: BackupStatus
  usageInfo?: UsageStatus

  targetRegion?: string
}

export interface Workspace {
  uuid: WorkspaceUuid
  name: string
  url: string
  allowReadOnlyGuest: boolean
  allowGuestSignUp: boolean
  passwordAgingRule?: number | null // Number of days after which password must be changed, null disables it
  disabledFeaturesOverride?: string[] // Features from DISABLED_FEATURES to re-enable for this workspace
  dataId?: WorkspaceDataId // Old workspace identifier. E.g. Database name in Mongo, bucket in R2, etc.
  branding?: string
  location?: Location
  region?: string
  createdBy?: PersonUuid
  billingAccount?: PersonUuid
  createdOn?: Timestamp
}

export interface OTP {
  socialId: PersonId
  code: string
  expiresOn: Timestamp
  createdOn: Timestamp
}

export interface WorkspaceInvite {
  id: string // bigint should be represented as string as it exceeds JS safe integer limit
  migratedFrom?: string // old invite id to be able to find migrated invites
  workspaceUuid: WorkspaceUuid
  expiresOn: Timestamp
  emailPattern?: string
  email?: string
  remainingUses?: number
  role: AccountRole
  autoJoin?: boolean
}

export interface ShortLink {
  id: string
  payload: string
  workspaceId: string
  createdAt: number
}

export interface WorkspacePermission {
  workspaceUuid: WorkspaceUuid
  accountUuid: AccountUuid
  permission: string
  createdOn?: Timestamp
}

export interface WorkspaceJoinInfo {
  email: string
  workspace: Workspace
  invite?: WorkspaceInvite | null
}

export interface Mailbox {
  accountUuid: PersonUuid
  mailbox: string
}

export interface MailboxSecret {
  mailbox: string
  app?: string
  secret: string
}

export interface MailboxInfo {
  mailbox: string
}

export interface Integration {
  socialId: PersonId
  kind: IntegrationKind // Integration kind. E.g. 'github', 'mail', 'telegram-bot', 'telegram' etc.
  workspaceUuid: WorkspaceUuid | null
  data?: Record<string, any>
}

export type IntegrationKey = Omit<Integration, 'data'>

export interface IntegrationSecret {
  socialId: PersonId
  kind: IntegrationKind // Integration kind. E.g. 'github', 'mail', 'telegram-bot', 'telegram' etc.
  workspaceUuid: WorkspaceUuid | null
  key: string // Key for the secret in the integration. Different secrets for the same integration must have different keys. Can be any string. E.g. '', 'user_app_1' etc.
  secret: string
}

export type IntegrationSecretKey = Omit<IntegrationSecret, 'secret'>

/**
 * Known social link keys for user profiles
 * Stored flexibly in JSONB/object but with known common keys
 */
export interface KnownSocialLinks {
  twitter?: string
  linkedin?: string
  github?: string
  telegram?: string
  facebook?: string
  instagram?: string
}

/**
 * User profile with additional information for public sharing
 * Stored in accounts database (global, not workspace-specific)
 */
export interface UserProfile {
  personUuid: PersonUuid
  bio?: string // LinkedIn-style bio (up to ~2000 chars)
  country?: string
  city?: string
  website?: string // Personal website URL
  socialLinks?: Record<string, string> // Flexible storage, keys follow KnownSocialLinks convention
  isPublic: boolean // Public visibility toggle (default: false)
}

export type PersonWithProfile = Person & Omit<UserProfile, 'personUuid'>

/**
 * Workspace subscription status
 * Provider-agnostic abstraction for billing state
 */
export enum SubscriptionStatus {
  Active = 'active', // Subscription is active and in good standing
  Trialing = 'trialing', // In trial period
  PastDue = 'past_due', // Payment failed but still providing service (grace period — full access)
  ReadOnly = 'readonly', // Grace period expired — read-only access, payment still due
  Canceled = 'canceled', // Subscription has been canceled
  Paused = 'paused', // Subscription is paused
  Expired = 'expired' // Subscription or trial has expired
}

/**
 * Subscription type/purpose
 * Allows multiple active subscriptions per workspace for different purposes
 */
export enum SubscriptionType {
  Tier = 'tier', // Main workspace tier (free, starter, pro, enterprise)
  Support = 'support', // Voluntary support/donation subscription
  Package = 'package' // Additional package (storage, etc.)
}

/**
 * Workspace subscription information
 * Provider-agnostic subscription data managed by billing service
 * Multiple subscriptions can be active per workspace (tier + addons + support)
 * Historical subscriptions are preserved with status: canceled/expired
 */
// Plan limits snapshot. Reserved space limits kept for forward compatibility, not enforced yet.
export interface TierLimits {
  storageLimitGB: number
  trafficLimitGB: number
  meetingMinutesLimit: number
  tokenLimit: number
  usersLimit: number
  // AI rolling-window limit (billed tokens/month). Bigger plan = bigger window = more
  // AI before the rate-limit kicks in. 0 = unlimited.
  windowMonthLimit?: number
}

export interface Subscription {
  id: string // Our internal unique subscription ID (UUID)
  workspaceUuid: WorkspaceUuid
  accountUuid: AccountUuid // Account that paid for the subscription

  // Provider details
  provider: string // Payment provider identifier (e.g. 'polar', 'stripe', 'manual')
  providerSubscriptionId: string // External subscription ID from the provider
  providerCheckoutId?: string // External checkout/session ID that created this subscription

  // Subscription classification
  type: SubscriptionType // What this subscription is for (tier, addon, support)
  status: SubscriptionStatus // Current status
  plan: string // Plan/product identifier (e.g. 'free', 'pro', 'storage-100gb', 'supporter')

  // Snapshot of plan limits at time of subscription creation
  // Used instead of plan config to ensure limits are stable over time
  limits?: TierLimits

  // Free fallback limits applied when the paid tier is unpaid: the workspace runs on these
  // instead of full read-only. Not persisted — account fills it from FREE_PLAN_LIMITS env on read.
  freeLimits?: TierLimits

  // Amount paid (in cents, e.g. 9999 = $99.99)
  // Used primarily for pay-what-you-want/donation subscriptions to track actual payment
  amount?: number

  // Billing period (optional - not set for free/manual plans)
  periodStart?: Timestamp
  periodEnd?: Timestamp

  // Trial information (optional)
  trialEnd?: Timestamp

  // Cancellation info (optional)
  canceledAt?: Timestamp
  willCancelAt?: Timestamp // Scheduled cancellation date (cancel at period end)

  // Provider-specific data (stored as JSONB for flexibility)
  // This allows billing service to store additional provider fields if needed
  // e.g. customerExternalId, metadata, etc. Some providers (like Polar.sh) allow using
  // our own customer ID and don't require tracking their external customer ID
  providerData?: Record<string, any>

  createdOn: Timestamp
  updatedOn: Timestamp
}

export type SubscriptionData = Omit<Subscription, 'createdOn' | 'updatedOn'>

/**
 * Upsert payload. `accountUuid` is optional here only: a free/trial tier has no payer.
 */
export type SubscriptionUpsert = Omit<SubscriptionData, 'accountUuid'> & { accountUuid?: AccountUuid }

export type PaymentIntentStatus = 'pending' | 'charged' | 'failed'

// One claim per claimKey. The unique claimKey makes claiming atomic across pods, so concurrent
// renewals/checkouts can't double-charge — a second claim hits the existing row instead.
export interface PaymentIntent {
  id: string
  // dedup key: 'renew:<sub>:<period>' | 'checkout:<ws>:<type>' | 'checkout:<ws>:purchase:<fingerprint>'
  claimKey: string
  provider: string
  status: PaymentIntentStatus
  paymentId?: string // provider charge id, set once the charge is issued; webhook links back here
  paymentUrl?: string // checkout: saved payment URL, reused on repeated checkout
  amount?: number
  heartbeatAt?: Timestamp // lease: refreshed ~1s while a live pod awaits the charge response
  // context columns (nullable; which one is set depends on the claim kind):
  subscriptionId?: string // renew: set; checkout: undefined
  workspaceUuid?: WorkspaceUuid // checkout: set; renew: undefined
  orderFingerprint?: string // checkout: 'plan:seats:period', reuse URL only on an exact order match
  createdOn: Timestamp
  updatedOn: Timestamp
}

/** Append-only payment audit row. Immutable — inserted, never updated/deleted. */
export type PaymentOperationKind = 'init_charge' | 'webhook' | 'charge_recurrent' | 'cancel' | 'refund' | 'update'
/** Who drove this row: the workspace user, our scheduler, the bank callback, or an admin. */
export type PaymentActor = 'user' | 'system' | 'provider' | 'admin'
export interface PaymentOperation {
  id?: string // DB-generated on insert (gen_random_uuid); present on reads
  provider: string
  operation: PaymentOperationKind
  status?: string // provider/webhook status (CONFIRMED|REJECTED|...) or 'success'|'failed'
  paymentId?: string
  orderId?: string
  subscriptionId?: string
  workspaceUuid?: WorkspaceUuid
  accountUuid?: AccountUuid
  actionId?: string // groups every row produced by one intent (purchase, plan change, renewal cycle)
  actor?: PaymentActor
  amount?: number // minor units (kopecks)
  raw?: Record<string, any> // full provider payload for forensics
  createdOn: Timestamp
}

export interface PaymentOperationStats {
  from: Timestamp
  to: Timestamp
  totalCharges: number
  totalAmount: number // kopecks
  totalErrors: number
  workspaces: Array<{ workspaceUuid: string, charges: number, amount: number, errors: number }>
}

/** One-time catalog purchase (mirrors account-client WorkspacePurchase). */
export type WorkspacePurchaseStatus = 'pending' | 'active' | 'consumed' | 'failed'

export interface WorkspacePurchase {
  id?: string // DB-generated on insert
  workspaceUuid: WorkspaceUuid
  accountUuid: AccountUuid
  sku: string
  category?: string
  status: WorkspacePurchaseStatus
  amount?: number // minor units (kopecks)
  paymentId?: string
  provider?: string
  raw?: Record<string, any>
  createdOn?: Timestamp
  activatedOn?: Timestamp
}

export interface PaymentOperationFilter {
  from?: Timestamp
  to?: Timestamp
  workspaceUuid?: WorkspaceUuid
  operation?: PaymentOperationKind
  status?: string
  provider?: string
  limit?: number
  offset?: number
}

/** Ledger aggregation for one calendar month (UTC), month formatted as 'YYYY-MM'. */
export interface PaymentMonthlyStats {
  month: string
  charges: number
  amount: number // kopecks
  errors: number
  cancels: number
  refunds: number
}

export interface AccountWorkspaceBadgeStatus {
  accountUuid: AccountUuid
  workspaceUuid: WorkspaceUuid
  hasUnread: boolean
  updatedOn: Timestamp
}

/* ========= S U P P L E M E N T A R Y ========= */

export interface WorkspaceInfoWithStatus extends Workspace {
  status: WorkspaceStatus
}

export type WorkspacesSortKey = 'name' | 'backupDate' | 'backupSize' | 'lastVisit' | 'createdOn'

export interface WorkspacesPagedQuery {
  search?: string
  modes?: WorkspaceMode[]
  region?: string
  attemptsGte?: number
  billingPlan?: string // current tier plan
  billingStatus?: string // current tier subscription status (e.g. 'trialing')
  billingStatusNot?: string // exclude a status, e.g. paid Business without the trials
  billingExpired?: boolean // has tier subscription, none of them active/trialing
  sort?: WorkspacesSortKey
  order?: 'asc' | 'desc'
  skip?: number
  limit?: number
}

/** Workspace row with the current tier subscription snapshot (mirrors account-client type) */
export type WorkspaceInfoWithBilling = WorkspaceInfoWithStatus & {
  billingPlan?: string
  billingStatus?: string
  billingPeriodEnd?: Timestamp
}

export interface WorkspacesPagedResult {
  workspaces: WorkspaceInfoWithBilling[]
  total: number
}

export interface BillingPlanSummary {
  plan: string
  workspaces: number
  seats: number // SUM(limits.usersLimit) across active/trialing tier subscriptions
}

export interface WorkspacesSummary {
  total: number
  byMode: Record<string, number>
  byRegion: Record<string, number>
  byVersion: Record<string, number> // active workspaces only
  billing: BillingPlanSummary[]
}

export interface RegistrationStatsPoint {
  day: string // YYYY-MM-DD
  count: number
}

export interface RegistrationStats {
  workspaces: RegistrationStatsPoint[]
  accounts: RegistrationStatsPoint[]
}

export interface WorkspaceActivityPoint {
  week: string // YYYY-MM-DD (week start)
  count: number
}

export interface WorkspaceMemberDetails {
  account: AccountUuid
  role: string
  firstName?: string
  lastName?: string
  email?: string
  lastActivity?: Timestamp // MAX(tx.modifiedOn) in this workspace
  txTotal: number
}

export interface AccountWorkspaceActivity {
  workspace: WorkspaceUuid
  name?: string
  url?: string
  count: number
  lastTx: Timestamp
}

export interface AccountActivityStats {
  workspaces: AccountWorkspaceActivity[]
  weekly: WorkspaceActivityPoint[]
}

export type WorkspaceData = Omit<Workspace, 'uuid' | 'status' | 'members'>

export interface WorkspaceWithEndpoint extends Workspace {
  endpoint?: string
}

export type WorkspaceStatusData = Omit<WorkspaceStatus, 'workspaceUuid'>

export type WorkspaceInviteData = Omit<WorkspaceInvite, 'id'>

export type DBFlavor = 'postgres' | 'cockroach' | 'unknown'

/* ========= D A T A B A S E  C O L L E C T I O N S ========= */
export interface AccountDB {
  person: DbCollection<Person>
  account: DbCollection<Account>
  socialId: DbCollection<SocialId>
  workspace: DbCollection<Workspace>
  workspaceStatus: DbCollection<WorkspaceStatus>
  accountEvent: DbCollection<AccountEvent>
  otp: DbCollection<OTP>
  invite: DbCollection<WorkspaceInvite>
  shortLink: DbCollection<ShortLink>
  mailbox: DbCollection<Mailbox>
  mailboxSecret: DbCollection<MailboxSecret>
  integration: DbCollection<Integration>
  integrationSecret: DbCollection<IntegrationSecret>
  userProfile: DbCollection<UserProfile>
  subscription: DbCollection<Subscription>
  paymentIntent: DbCollection<PaymentIntent>
  workspacePermission: DbCollection<WorkspacePermission>
  accountWorkspaceBadgeStatus: DbCollection<AccountWorkspaceBadgeStatus>
  adminAction: DbCollection<AdminAction>

  init: () => Promise<void>
  createWorkspace: (data: WorkspaceData, status: WorkspaceStatusData) => Promise<WorkspaceUuid>
  updateAllowReadOnlyGuests: (workspaceId: WorkspaceUuid, readOnlyGuestsAllowed: boolean) => Promise<void>
  updateAllowGuestSignUp: (workspaceId: WorkspaceUuid, guestSignUpAllowed: boolean) => Promise<void>
  updatePasswordAgingRule: (workspaceId: WorkspaceUuid, days: number | null) => Promise<void>
  assignWorkspace: (accountId: AccountUuid, workspaceId: WorkspaceUuid, role: AccountRole) => Promise<void>
  batchAssignWorkspace: (data: [AccountUuid, WorkspaceUuid, AccountRole][]) => Promise<void>
  updateWorkspaceRole: (accountId: AccountUuid, workspaceId: WorkspaceUuid, role: AccountRole) => Promise<void>
  unassignWorkspace: (accountId: AccountUuid, workspaceId: WorkspaceUuid) => Promise<void>
  getWorkspaceRole: (accountId: AccountUuid, workspaceId: WorkspaceUuid) => Promise<AccountRole | null>
  getWorkspaceRoles: (accountId: AccountUuid) => Promise<Map<WorkspaceUuid, AccountRole>>
  getWorkspaceMembers: (workspaceId: WorkspaceUuid) => Promise<WorkspaceMemberInfo[]>
  getAccountWorkspaces: (accountId: AccountUuid) => Promise<WorkspaceInfoWithStatus[]>
  batchAssignWorkspacePermission: (
    workspaceId: WorkspaceUuid,
    accountIds: AccountUuid[],
    permission: string
  ) => Promise<void>
  batchRevokeWorkspacePermission: (
    workspaceId: WorkspaceUuid,
    accountIds: AccountUuid[],
    permission: string
  ) => Promise<void>
  hasWorkspacePermission: (accountId: AccountUuid, workspaceId: WorkspaceUuid, permission: string) => Promise<boolean>
  getWorkspacePermissions: (accountId: AccountUuid, permission: string) => Promise<WorkspaceUuid[]>
  getWorkspaceUsersWithPermission: (workspaceId: WorkspaceUuid, permission: string) => Promise<AccountUuid[]>
  getPendingWorkspace: (
    region: string,
    version: Data<Version>,
    operation: WorkspaceOperation,
    processingTimeoutMs: number,
    wsLivenessMs?: number
  ) => Promise<WorkspaceInfoWithStatus | undefined>
  setPassword: (accountId: AccountUuid, passwordHash: Buffer, salt: Buffer) => Promise<void>
  resetPassword: (accountId: AccountUuid) => Promise<void>
  deleteAccount: (accountId: AccountUuid) => Promise<void>
  /** Purge an unfinished signup: person + social ids, no account row involved */
  deletePerson: (personUuid: PersonUuid) => Promise<void>
  listAccounts: (
    search?: string,
    skip?: number,
    limit?: number,
    sort?: AccountsSortKey,
    filter?: AccountsFilter,
    order?: 'asc' | 'desc'
  ) => Promise<AccountAggregatedInfo[]>
  listAdminActions: (query: AdminActionsQuery) => Promise<AdminActionsResult>
  listWorkspacesPaged: (query: WorkspacesPagedQuery) => Promise<WorkspacesPagedResult>
  getWorkspacesSummary: () => Promise<WorkspacesSummary>
  getRegistrationStats: (from: Timestamp, to: Timestamp) => Promise<RegistrationStats>
  getWorkspaceActivityStats: (workspace: WorkspaceUuid, from: Timestamp) => Promise<WorkspaceActivityPoint[]>
  getWorkspaceMembersInfo: (workspace: WorkspaceUuid) => Promise<WorkspaceMemberDetails[]>
  getAccountActivityStats: (account: AccountUuid, from: Timestamp) => Promise<AccountActivityStats>
  // Atomically consume an OTP: deletes the (socialId, code) row if it exists and is unexpired,
  // returns true only if THIS call deleted it. Prevents one code confirming two concurrent ops.
  consumeOtp: (socialId: PersonId, code: string) => Promise<boolean>
  generatePersonUuid: () => Promise<PersonUuid>
  ensurePerson: (
    socialType: SocialIdType,
    socialValue: string,
    firstName: string,
    lastName: string
  ) => Promise<{ uuid: PersonUuid, socialId: PersonId }>
  getAccountWorkspaceBadgeStatuses: (accountId: AccountUuid) => Promise<AccountWorkspaceBadgeStatus[]>
  setAccountWorkspaceBadgeStatus: (
    accountId: AccountUuid,
    workspaceId: WorkspaceUuid,
    hasUnread: boolean
  ) => Promise<void>
  batchWorkspaceBadgeStatuses: (
    data: Array<{ accountId: AccountUuid, workspaceId: WorkspaceUuid, hasUnread: boolean }>
  ) => Promise<void>
  // Atomically claim by claimKey. Returns the intent + whether THIS caller created it (claimed).
  // Only the creator may charge; concurrent callers get claimed=false and must not charge.
  claimIntent: (
    claimKey: string,
    provider: string,
    ctx?: { subscriptionId?: string, workspaceUuid?: WorkspaceUuid, amount?: number, orderFingerprint?: string }
  ) => Promise<{ claimed: boolean, intent: PaymentIntent }>
  // Refresh the lease while a charge is in flight (the claimer is still alive).
  heartbeatChargeIntent: (intentId: string) => Promise<void>
  // Take over an orphaned pending intent whose lease expired. Atomic — only one pod wins.
  reclaimStaleChargeIntent: (intentId: string, leaseMs: number) => Promise<boolean>
  // Link a checkout intent to the issued charge (payment_id) and save its URL for reuse.
  setIntentPayment: (intentId: string, paymentId: string, paymentUrl?: string) => Promise<void>
  // Release a checkout claim once the webhook reaches a terminal status
  deleteCheckoutIntentByPaymentId: (paymentId: string, provider: string) => Promise<void>
  deleteCheckoutIntentById: (intentId: string) => Promise<void>
  logPaymentOperation: (op: PaymentOperation) => Promise<void>
  getPaymentOperations: (filter: PaymentOperationFilter) => Promise<PaymentOperation[]>
  getPaymentOperationStats: (from: Timestamp, to: Timestamp) => Promise<PaymentOperationStats>
  getPaymentMonthlyStats: (from: Timestamp, to: Timestamp) => Promise<PaymentMonthlyStats[]>
  // Generic one-time purchases (AI reset, skins, unlocks). createPurchase returns the generated id.
  // account is domain-agnostic — SKU effects are applied by the owning pod, not here.
  createPurchase: (purchase: WorkspacePurchase) => Promise<string>
  updatePurchaseStatus: (id: string, status: WorkspacePurchaseStatus, activatedOn?: Timestamp) => Promise<void>
  getPurchases: (workspace: WorkspaceUuid) => Promise<WorkspacePurchase[]>
}

export interface DbCollection<T> {
  exists: (query: Query<T>) => Promise<boolean>
  find: (query: Query<T>, sort?: Sort<T>, limit?: number) => Promise<T[]>
  findOne: (query: Query<T>) => Promise<T | null>
  insertOne: (data: Partial<T>) => Promise<any>
  insertMany: (data: Partial<T>[]) => Promise<any>
  update: (query: Query<T>, ops: Operations<T>) => Promise<void>
  deleteMany: (query: Query<T>) => Promise<void>
}

export type Sort<T> = {
  [K in keyof T]?: T[K] extends Record<string, any> | undefined ? Sort<T[K]> : 'ascending' | 'descending'
}

export type Query<T> = {
  [P in keyof T]?: T[P] | QueryOperator<T[P]> | null
}

export interface QueryOperator<T> {
  $in?: T[]
  $lt?: T
  $lte?: T
  $gt?: T
  $gte?: T
  $ne?: T | null
}

export type Operations<T> = Partial<T> & {
  $inc?: Partial<Record<keyof T, number>>
  $set?: Partial<T>
}

/* ========= U T I L I T I E S ========= */

export type AccountMethodHandler = (
  ctx: MeasureContext,
  db: AccountDB,
  branding: Branding | null,
  request: any,
  token: string | undefined,
  params?: Record<string, any>,
  meta?: Record<string, any>
) => Promise<any>

// Alias, not a copy: a local duplicate had already drifted and silently dropped the delete events.
export type WorkspaceEvent = WorkspaceUpdateEvent
export type WorkspaceOperation = 'create' | 'upgrade' | 'all' | 'all+backup'
export interface LoginInfo {
  account: AccountUuid
  name?: string
  socialId?: PersonId
  token?: string
}

export interface LoginInfoRequestData {
  firstName?: string
  lastName?: string
}

export type LoginInfoRequest = {
  request: true
} & LoginInfoRequestData

export interface LoginInfoWorkspace {
  url: string
  dataId?: WorkspaceDataId
  mode: WorkspaceMode
  version: WorkspaceVersion
  endpoint: EndpointInfo
  collaboratorEndpoint: EndpointInfo
  role: AccountRole | null

  progress?: number
  branding?: string
  passwordAgingRule?: number | null
}

export interface LoginInfoWithWorkspaces extends LoginInfo {
  // Information necessary to handle user <--> transactor connectivity.
  workspaces: Record<WorkspaceUuid, LoginInfoWorkspace>
  socialIds: SocialId[]
}

export interface WorkspaceLoginInfo extends LoginInfo {
  workspace: WorkspaceUuid
  workspaceUrl: string
  workspaceDataId?: WorkspaceDataId
  endpoint: string
  collaboratorEndpoint?: string
  role: AccountRole
  allowGuestSignUp?: boolean
  disabledFeaturesOverride?: string[]
}

export interface OtpInfo {
  sent: boolean
  retryOn: Timestamp
}

export interface RegionInfo {
  region: string
  name: string
}

// Self-host edition, resolved from the license metadata set at startup. Other pods fetch via getLicenseInfo.
export interface LicenseInfo {
  edition: 'dev' | 'community' | 'licensed'
  canRunPayment: boolean
  maxUsers: number
}

export interface WorkspaceSeatsInfo {
  // True when the plan has a free seat, or the plan is unlimited / free-fallback.
  available: boolean
  seatsLeft?: number
}

export interface WorkspaceInviteInfo {
  workspace: WorkspaceUuid
  email?: string
  name?: string
  // False when the workspace plan has no free seats: the join page must not offer sign up / sign in.
  seatsAvailable?: boolean
}

export interface MailboxOptions {
  availableDomains: string[]
  minNameLength: number
  maxNameLength: number
  maxMailboxCount: number
}

export type ClientNetworkPosition = 'internal' | 'external'

export interface Meta {
  timezone?: string
  clientNetworkPosition?: ClientNetworkPosition
  cookies?: string
}

export interface AccountAggregatedInfo extends Omit<Account, 'hash' | 'salt'>, Person {
  uuid: AccountUuid
  integrations: Omit<Integration, 'data'>[]
  socialIds: SocialId[]
  workspaces: Omit<WorkspaceInfo, 'allowReadOnlyGuest' | 'allowGuestSignUp'>[]
  // Max last_visit across the account's workspaces
  lastVisit?: number
  // Earliest social id creation time - when the person first appeared
  registeredOn?: number
  // False for an unfinished signup: person + social ids exist, but no account row yet
  hasAccount?: boolean
}

export type AccountsSortKey = 'name' | 'lastVisit' | 'registeredOn' | 'workspaces' | 'email'

/** Server-side filters for listAccounts. Duplicated in account-client/src/types.ts - change both */
export interface AccountsFilter {
  noWorkspaces?: boolean
  inactiveDays?: number
  pendingOnly?: boolean
}

/** Transactor endpoint entry for admin manage calls (mirrors account-client type) */
export interface TransactorEndpointInfo {
  region: string
  name?: string
  external: string
}

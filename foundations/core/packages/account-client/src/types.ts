import {
  type AccountUuid,
  PersonId,
  WorkspaceDataId,
  WorkspaceUuid,
  type AccountRole,
  type Timestamp,
  type SocialId as SocialIdBase,
  PersonUuid,
  type WorkspaceMode,
  Person,
  WorkspaceInfo,
  type WorkspaceInfoWithStatus,
  AccountInfo,
  IntegrationKind
} from '@hcengineering/core'

export interface LoginInfo {
  account: AccountUuid
  name?: string
  socialId?: PersonId
  token?: string
}

export interface EndpointInfo {
  internalUrl: string
  externalUrl: string
  region: string
}
export interface WorkspaceVersion {
  versionMajor: number
  versionMinor: number
  versionPatch: number
}

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
  passwordAgingRule?: number | null // in days
}

export interface LoginInfoWithWorkspaces extends LoginInfo {
  // Information necessary to handle user <--> transactor connectivity.
  workspaces: Record<WorkspaceUuid, LoginInfoWorkspace>
  socialIds: SocialId[]
}

export type LoginInfoByToken = LoginInfo | WorkspaceLoginInfo | LoginInfoRequest | null

/**
 * @public
 */
export interface WorkspaceLoginInfo extends LoginInfo {
  workspace: WorkspaceUuid // worspace uuid
  workspaceDataId?: WorkspaceDataId
  workspaceUrl: string
  endpoint: string
  collaboratorEndpoint?: string
  token: string
  role: AccountRole
  allowGuestSignUp?: boolean
  disabledFeaturesOverride?: string[]
}

export interface LoginInfoRequestData {
  firstName?: string
  lastName?: string
}

export type LoginInfoRequest = {
  request: true
} & LoginInfoRequestData

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

export interface OtpInfo {
  sent: boolean
  retryOn: Timestamp
}

export interface RegionInfo {
  region: string
  name: string
}

// Self-host edition, resolved by account (single license-key holder). Other pods fetch this instead
// of verifying a key themselves. maxUsers 0 = unlimited.
export interface LicenseInfo {
  edition: 'dev' | 'community' | 'licensed'
  canRunPayment: boolean
  maxUsers: number
}

export type WorkspaceOperation = 'create' | 'upgrade' | 'all' | 'all+backup'

export interface MailboxOptions {
  availableDomains: string[]
  minNameLength: number
  maxNameLength: number
  maxMailboxCount: number
}

export interface MailboxInfo {
  mailbox: string
  aliases: string[]
  appPasswords: string[]
}

export interface MailboxSecret {
  mailbox: string
  app?: string
  secret: string
}

export interface Integration {
  socialId: PersonId
  kind: IntegrationKind // Integration kind. E.g. 'github', 'mail', 'telegram-bot', 'telegram' etc.
  workspaceUuid: WorkspaceUuid | null
  data?: Record<string, any>
  disabled?: boolean
}

export interface SocialId extends SocialIdBase {
  personUuid: PersonUuid
  isDeleted?: boolean
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

export interface ProviderInfo {
  name: string
  displayName?: string
}

export interface AccountAggregatedInfo extends AccountInfo, Person {
  uuid: AccountUuid
  integrations: Omit<Integration, 'data'>[]
  socialIds: SocialId[]
  workspaces: Omit<WorkspaceInfo, 'allowReadOnlyGuest' | 'allowGuestSignUp'>[]
  // Max last_visit across the account's workspaces (approximation of user's last activity)
  lastVisit?: number
  // Earliest social id creation time - when the person first appeared
  registeredOn?: number
  // False for an unfinished signup: person + social ids exist, but no account row yet
  hasAccount?: boolean
  // Earliest email social id - what the admin list shows and sorts by
  primaryEmail?: string
}

export type AccountsSortKey = 'name' | 'lastVisit' | 'registeredOn' | 'workspaces' | 'email'

/** Admin audit trail entry. Duplicated in server/account/src/types.ts - change both */
export interface AdminAction {
  id?: string
  actor: string
  actorEmail?: string
  action: string
  target?: string
  targetLabel?: string
  data?: Record<string, any>
  createdOn: number
}

export interface AdminActionsQuery {
  search?: string
  action?: string
  skip?: number
  limit?: number
}

export interface AdminActionsResult {
  actions: AdminAction[]
  total: number
}

/** Server-side filters for listAccounts */
export interface AccountsFilter {
  /** Accounts not belonging to any workspace */
  noWorkspaces?: boolean
  /** Accounts with no visit for at least this many days (never visited counts as inactive) */
  inactiveDays?: number
  /** Unfinished signups only: person + social ids without an account row */
  pendingOnly?: boolean
}

/** Transactor endpoint entry for admin manage calls */
export interface TransactorEndpointInfo {
  region: string
  name?: string
  external: string
}

/**
 * User profile with additional information for public sharing
 * Stored in accounts database (global, not workspace-specific)
 */
export interface UserProfile {
  personUuid: PersonUuid
  bio?: string // LinkedIn-style bio (up to ~2000 chars)
  city?: string
  country?: string
  website?: string // Personal website URL
  socialLinks?: Record<string, string> // Flexible storage for social links
  isPublic: boolean // Public visibility toggle (default: false)
}

export type PersonWithProfile = Person & Omit<UserProfile, 'personUuid'>

/**
 * Subscription status enum
 * Reflects the subscription lifecycle from active to canceled/expired
 */
export enum SubscriptionStatus {
  Active = 'active', // Subscription is active and paid
  Trialing = 'trialing', // In trial period (free usage)
  PastDue = 'past_due', // Payment failed but subscription not yet canceled (grace period — full access)
  ReadOnly = 'readonly', // Grace period expired — read-only access, payment still due
  Canceled = 'canceled', // Subscription was canceled by user or admin
  Paused = 'paused', // Subscription is temporarily paused (some providers support this)
  Expired = 'expired' // Subscription or trial has expired
}

/**
 * Subscription type/purpose
 * Allows multiple active subscriptions per workspace for different purposes
 */
export enum SubscriptionType {
  Tier = 'tier', // Main workspace tier (free, starter, pro, enterprise)
  Support = 'support', // Voluntary support/donation subscription
  Package = 'package', // Additional package (storage, etc.)
  Purchase = 'purchase' // One-time catalog purchase (AI usage reset, skins, unlocks) — not a limit-granting subscription
}

/**
 * Workspace subscription information
 * Provider-agnostic subscription data managed by billing service
 * Multiple subscriptions can be active per workspace (tier + addons + support)
 * Historical subscriptions are preserved with status: canceled/expired
 */
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
  limits?: {
    storageLimitGB: number
    trafficLimitGB: number
    meetingMinutesLimit: number
    tokenLimit: number
    usersLimit: number
    // AI rolling-window limit (billed tokens/month) + package multiplier. Bigger plan = bigger window.
    windowMonthLimit?: number
    tokenPackageMultiplier?: number
  }

  // Free fallback limits (from the plan flagged free in config). Applied when the paid tier is unpaid:
  // the workspace runs on these instead of full read-only. Same shape as limits.
  freeLimits?: {
    storageLimitGB: number
    trafficLimitGB: number
    meetingMinutesLimit: number
    tokenLimit: number
    usersLimit: number
    windowMonthLimit?: number
    tokenPackageMultiplier?: number
  }

  // Amount paid (in cents, e.g. 9999 = $99.99)
  // Used primarily for pay-what-you-want/donation subscriptions to track actual payment
  amount?: number

  // Billing period (optional - not set for free/manual plans)
  periodStart?: Timestamp
  periodEnd?: Timestamp

  // Trial information (optional)
  trialEnd?: Timestamp

  // Cancellation tracking (optional)
  canceledAt?: Timestamp
  willCancelAt?: Timestamp // Scheduled cancellation date (cancel at period end)

  // Provider-specific data stored as JSONB (optional)
  providerData?: Record<string, any>

  // Timestamps (managed by database)
  createdOn: Timestamp
  updatedOn: Timestamp
}

/**
 * Subscription data for creating/updating subscriptions (without timestamps)
 * Used by billing service to upsert subscription data
 */
export type SubscriptionData = Omit<Subscription, 'createdOn' | 'updatedOn'>

/**
 * Upsert payload.
 * `accountUuid` is optional here only: a free/trial tier has no payer.
 */
export type SubscriptionUpsert = Omit<SubscriptionData, 'accountUuid'> & { accountUuid?: AccountUuid }

export interface AccountWorkspaceBadgeStatus {
  accountUuid: AccountUuid
  workspaceUuid: WorkspaceUuid
  hasUnread: boolean
  updatedOn: Timestamp
}

export type PaymentIntentStatus = 'pending' | 'charged' | 'failed'

/**
 * One claim per claimKey. The unique claimKey makes claiming atomic across pods/replicas/
 * rolling-updates. claimKey is 'renew:<subscriptionId>:<periodEnd>' (one charge per subscription
 * period) or 'checkout:<workspaceUuid>:<type>' (one pending checkout per workspace + plan type).
 */
export interface PaymentIntent {
  id: string
  claimKey: string
  provider: string
  status: PaymentIntentStatus
  paymentId?: string
  paymentUrl?: string
  amount?: number
  heartbeatAt?: number
  // context columns (nullable; which one is set depends on the claim kind):
  subscriptionId?: string
  workspaceUuid?: WorkspaceUuid
  orderFingerprint?: string // checkout: 'plan:seats:period', reuse URL only on an exact order match
  createdOn: number
  updatedOn: number
}

/** Append-only payment audit row (immutable). */
export type PaymentOperationKind = 'init_charge' | 'webhook' | 'charge_recurrent' | 'cancel' | 'refund' | 'update'
/** Who drove this row: the workspace user, our scheduler, the bank callback, or an admin. */
export type PaymentActor = 'user' | 'system' | 'provider' | 'admin'
export interface PaymentOperation {
  id?: string
  provider: string
  operation: PaymentOperationKind
  status?: string
  paymentId?: string
  orderId?: string
  subscriptionId?: string
  workspaceUuid?: WorkspaceUuid
  accountUuid?: AccountUuid
  actionId?: string // groups every row produced by one intent (purchase, plan change, renewal cycle)
  actor?: PaymentActor
  amount?: number
  raw?: Record<string, any>
  createdOn?: number
}

/** One-time catalog purchase owned by a workspace (AI usage reset now; skins/themes later). */
export type WorkspacePurchaseStatus = 'pending' | 'active' | 'consumed' | 'failed'

export interface WorkspacePurchase {
  id?: string
  workspaceUuid: WorkspaceUuid
  accountUuid: AccountUuid // who bought
  sku: string
  category?: string
  status: WorkspacePurchaseStatus
  amount?: number // minor units (kopecks)
  paymentId?: string
  provider?: string
  raw?: Record<string, any>
  createdOn?: number
  activatedOn?: number
}

export interface PaymentOperationStats {
  from: number
  to: number
  totalCharges: number
  totalAmount: number
  totalErrors: number
  workspaces: Array<{ workspaceUuid: string, charges: number, amount: number, errors: number }>
}

export interface PaymentOperationFilter {
  from?: number
  to?: number
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
  amount: number
  errors: number
  cancels: number
  refunds: number
}

/**
 * Subscription with resolved owner email (used in admin panel)
 */
export interface SubscriptionInfo extends Subscription {
  payerEmail?: string
  payerName?: string
}

export type WorkspacesSortKey = 'name' | 'backupDate' | 'backupSize' | 'lastVisit' | 'createdOn'

export interface WorkspacesPagedQuery {
  search?: string
  modes?: WorkspaceMode[]
  region?: string
  attemptsGte?: number
  billingPlan?: string
  billingStatus?: string
  billingStatusNot?: string
  billingExpired?: boolean
  sort?: WorkspacesSortKey
  order?: 'asc' | 'desc'
  skip?: number
  limit?: number
}

/** Workspace row with the current tier subscription snapshot */
export type WorkspaceInfoWithBilling = WorkspaceInfoWithStatus & {
  billingPlan?: string
  billingStatus?: string
  billingPeriodEnd?: number
}

export interface WorkspacesPagedResult {
  workspaces: WorkspaceInfoWithBilling[]
  total: number
}

export interface BillingPlanSummary {
  plan: string
  workspaces: number
  seats: number
}

export interface WorkspacesSummary {
  total: number
  byMode: Record<string, number>
  byRegion: Record<string, number>
  byVersion: Record<string, number>
  billing: BillingPlanSummary[]
}

export interface RegistrationStatsPoint {
  day: string
  count: number
}

export interface RegistrationStats {
  workspaces: RegistrationStatsPoint[]
  accounts: RegistrationStatsPoint[]
}

export interface WorkspaceActivityPoint {
  week: string
  count: number
}

export interface WorkspaceMemberDetails {
  account: AccountUuid
  role: string
  firstName?: string
  lastName?: string
  email?: string
  lastActivity?: number
  txTotal: number
}

export interface AccountWorkspaceActivity {
  workspace: WorkspaceUuid
  name?: string
  url?: string
  count: number
  lastTx: number
}

export interface AccountActivityStats {
  workspaces: AccountWorkspaceActivity[]
  weekly: WorkspaceActivityPoint[]
}

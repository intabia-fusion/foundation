//
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
import core, {
  AccountRole,
  type AccountUuid,
  type Class,
  type MeasureContext,
  type Ref,
  type SessionData,
  systemAccountUuid,
  type Tx,
  type TxApplyIf,
  type TxCUD,
  type Doc,
  type WorkspaceUuid,
  configUserAccountUuid
} from '@hcengineering/core'
import {
  BaseMiddleware,
  type LimitsProvider,
  type Middleware,
  type PipelineContext,
  type PlanLimits,
  type TxMiddlewareResult
} from '@hcengineering/server-core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import { LIMITS_PROVIDER_VAR, MEMBERS_VERSION_KEY, PLAN_LIMITS_MAP_KEY, PLAN_LIMITS_VAR } from './planLimits'
import { aiBotAccountEmail } from './identity'

const GUEST_ROLES = new Set<AccountRole>([AccountRole.Guest, AccountRole.DocGuest, AccountRole.ReadOnlyGuest])

/** Owners take seats first, then Maintainers, then Users; ties broken by account uuid (deterministic). */
function rolePriority (role: AccountRole | undefined): number {
  if (role === AccountRole.Owner) return 0
  if (role === AccountRole.Maintainer) return 1
  return 2
}

const AI_ACCOUNT_EMAILS = new Set<string>([aiBotAccountEmail])

function isSystemAccount (
  account: { uuid: AccountUuid, role: AccountRole, fullSocialIds: { value: string }[] },
  systemAccounts?: Set<AccountUuid>
): boolean {
  return (
    account.uuid === systemAccountUuid ||
    account.uuid === configUserAccountUuid ||
    account.role === AccountRole.Admin ||
    systemAccounts?.has(account.uuid) === true ||
    account.fullSocialIds.some((it) => AI_ACCOUNT_EMAILS.has(it.value))
  )
}

/**
 * Seat enforcement: members beyond usersLimit become read-only — write tx are rejected here,
 * except the direct/chat-message classes the provider whitelists. The account role is NOT
 * mutated; the user keeps their role so onboarding/identity flows that read role stay consistent.
 * Seats are assigned to workspace members by role priority (Owner, Maintainer, then Users),
 * account-uuid order within a role. The member set is the account ws_members list (a person is
 * there only after real login); membership changes arrive via the host members-version bump.
 */
export class SeatLimitsMiddleware extends BaseMiddleware implements Middleware {
  private usersLimit = 0
  private readonly seatSet = new Set<AccountUuid>()
  private integrationAccounts = new Set<AccountUuid>()
  /** System/AI account uuids (never occupy a seat). Resolved lazily; undefined = not yet resolved. */
  private systemAccounts: Set<AccountUuid> | undefined
  /** Last members-version this instance rebuilt against; a bump by the host consumer forces a rebuild. */
  private membersVersion = -1
  /** Seats init is lazy: PLAN_LIMITS_VAR is published by PlanLimitsMiddleware, which boots after us. */
  private seatsInited = false

  private constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)
  }

  static async create (
    ctx: MeasureContext,
    context: PipelineContext,
    next: Middleware | undefined
  ): Promise<SeatLimitsMiddleware> {
    const mw = new SeatLimitsMiddleware(context, next)
    await mw.init(ctx)
    return mw
  }

  private get provider (): LimitsProvider | undefined {
    return this.context.contextVars[LIMITS_PROVIDER_VAR] as LimitsProvider | undefined
  }

  private async init (_ctx: MeasureContext): Promise<void> {}

  /** Live limits: shared host map (refreshed on plan changes) over the boot snapshot. */
  private planLimits (): PlanLimits | undefined {
    const map = this.context.contextVars[PLAN_LIMITS_MAP_KEY] as Map<WorkspaceUuid, PlanLimits> | undefined
    return (
      map?.get(this.context.workspace.uuid) ?? (this.context.contextVars[PLAN_LIMITS_VAR] as PlanLimits | undefined)
    )
  }

  private async initSeats (ctx: MeasureContext): Promise<void> {
    const limits = this.planLimits()
    if (limits === undefined) return // PlanLimits not booted yet, retry on next tx
    this.seatsInited = true

    this.usersLimit = limits.usersLimit
    if (this.usersLimit === 0) return // seat enforcement disabled

    if (this.provider === undefined) {
      ctx.warn('SeatLimitsMiddleware: LimitsProvider not set, seat enforcement disabled')
      this.usersLimit = 0
      return
    }

    try {
      await this.buildSeatSet()
      ctx.info('SeatLimitsMiddleware: seat init complete', {
        usersLimit: this.usersLimit,
        seated: this.seatSet.size
      })
    } catch (err: any) {
      ctx.error('SeatLimitsMiddleware: failed to init seats, enforcement disabled', { err })
      this.usersLimit = 0 // fail-open
    }
  }

  /** Resolve system/AI account uuids once (excluded from seat counting). */
  private async resolveSystemAccounts (): Promise<Set<AccountUuid>> {
    if (this.systemAccounts !== undefined) return this.systemAccounts
    this.systemAccounts = (await this.provider?.getSystemAccounts(this.context.workspace.uuid)) ?? new Set()
    return this.systemAccounts
  }

  /**
   * API-key integration account uuids. Refreshed with the seat set (both follow the members-version
   * bump the account service publishes when a key is issued or revoked), never cached beyond it.
   */
  private async resolveIntegrationAccounts (): Promise<Set<AccountUuid>> {
    this.integrationAccounts = (await this.provider?.getIntegrationAccounts(this.context.workspace.uuid)) ?? new Set()
    return this.integrationAccounts
  }

  /** Seat-eligible workspace members (uuid), sorted by role priority then uuid for a deterministic set. */
  private async eligibleMembers (): Promise<AccountUuid[]> {
    const provider = this.provider
    if (provider === undefined) return []
    const members = await provider.getWorkspaceMembers(this.context.workspace.uuid)
    const systemAccounts = await this.resolveSystemAccounts()
    const integrationAccounts = await this.resolveIntegrationAccounts()

    const eligible = members.filter((m) => this.seatEligible(m.person, m.role, systemAccounts, integrationAccounts))
    const roleOf = new Map<AccountUuid, AccountRole>()
    for (const m of members) roleOf.set(m.person, m.role)
    return eligible
      .map((m) => m.person)
      .sort((a, b) => {
        const pa = rolePriority(roleOf.get(a))
        const pb = rolePriority(roleOf.get(b))
        if (pa !== pb) return pa - pb
        return a < b ? -1 : a > b ? 1 : 0
      })
  }

  /** Fill seatSet with the first usersLimit eligible members (role priority, then uuid). */
  private async buildSeatSet (): Promise<void> {
    const eligible = await this.eligibleMembers()
    this.seatSet.clear()
    for (const uuid of eligible.slice(0, this.usersLimit)) this.seatSet.add(uuid)
  }

  /** A seat is consumed by any member except system/AI/Admin, API-key integrations and guest-role accounts. */
  private seatEligible (
    uuid: AccountUuid,
    role: AccountRole,
    systemAccounts: Set<AccountUuid>,
    integrationAccounts: Set<AccountUuid>
  ): boolean {
    if (systemAccounts.has(uuid)) return false
    if (integrationAccounts.has(uuid)) return false
    if (role === AccountRole.Admin) return false
    return !GUEST_ROLES.has(role)
  }

  /** Rebuild the seat set if the host bumped the members-version since our last build. */
  private async refreshSeatSetIfStale (ctx: MeasureContext): Promise<void> {
    const versions = this.context.contextVars[MEMBERS_VERSION_KEY] as Map<WorkspaceUuid, number> | undefined
    const current = versions?.get(this.context.workspace.uuid) ?? 0
    if (current === this.membersVersion) return
    this.membersVersion = current
    try {
      await this.buildSeatSet()
    } catch (err: any) {
      ctx.error('SeatLimitsMiddleware: failed to rebuild seat set', { err })
    }
  }

  /** Classes a read-only member may still write (direct/chat messages). Empty if provider omits it. */
  private readOnlyAllowedClasses (): Set<Ref<Class<Doc>>> {
    return this.provider?.getReadOnlyAllowedClasses?.() ?? new Set()
  }

  /** A tx is allowed for read-only members only if its target class is whitelisted (e.g. messages). */
  private isReadOnlyAllowed (tx: Tx, allowed: Set<Ref<Class<Doc>>>): boolean {
    if (tx._class === core.class.TxApplyIf) {
      return (tx as TxApplyIf).txes.every((inner) => this.isReadOnlyAllowed(inner, allowed))
    }
    const cud = tx as TxCUD<Doc>
    // System-generated derived tx (triggers/collections) are not user writes — pass through.
    if (cud.space === core.space.DerivedTx) return true
    const objectClass = cud.objectClass
    if (objectClass == null) return false
    for (const cls of allowed) {
      if (this.context.hierarchy.isDerived(objectClass, cls)) return true
    }
    return false
  }

  /** Read-only mode: reject every write tx whose class is not whitelisted; pass the rest through. */
  private async enforceReadOnly (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<TxMiddlewareResult> {
    const allowed = this.readOnlyAllowedClasses()
    for (const tx of txes) {
      if (!this.isReadOnlyAllowed(tx, allowed)) {
        throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      }
    }
    return await this.provideTx(ctx, txes)
  }

  async tx (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<TxMiddlewareResult> {
    const account = ctx.contextData?.account
    if (account == null) return await this.provideTx(ctx, txes)

    // System identities (system account, Admin operator, AI services) bypass all enforcement.
    const system = isSystemAccount(account, this.systemAccounts)

    if (system) {
      return await this.provideTx(ctx, txes)
    }

    if (!this.seatsInited) {
      await this.initSeats(ctx)
    } else {
      // Plan changed at runtime (shared map refreshed): rebuild seats with the new limit.
      const live = this.planLimits()?.usersLimit
      if (live !== undefined && live !== this.usersLimit) {
        this.seatsInited = false
        await this.initSeats(ctx)
      }
    }
    if (this.usersLimit === 0) {
      return await this.provideTx(ctx, txes)
    }

    // Membership changes (join/leave/role) arrive as a host members-version bump; rebuild if stale.
    // The join-time hard cap lives in the account service now (a join is not a transactor tx).
    await this.refreshSeatSetIfStale(ctx)

    if (GUEST_ROLES.has(account.role)) {
      return await this.provideTx(ctx, txes)
    }

    // An API-key account takes no seat, so it is never in seatSet - and must not be read-only for it.
    // Only seat accounting is lifted: counted limits and the unpaid mode still apply elsewhere.
    if (this.integrationAccounts.has(account.uuid)) {
      return await this.provideTx(ctx, txes)
    }

    if (this.seatSet.has(account.uuid)) {
      return await this.provideTx(ctx, txes)
    }

    // Seatless member (all seats taken): read-only except whitelisted message classes. Role untouched.
    return await this.enforceReadOnly(ctx, txes)
  }
}

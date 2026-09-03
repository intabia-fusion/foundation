//
// Copyright © 2022 Hardcore Engineering Inc.
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
  getClient as getAccountClient,
  type LoginInfoWithWorkspaces,
  type LoginInfoWorkspace
} from '@hcengineering/account-client'
import { Analytics } from '@hcengineering/analytics'
import core, {
  AccountRole,
  type AccountUuid,
  type Branding,
  type BrandingMap,
  cutObjectArray,
  type Data,
  generateId,
  isArchivingMode,
  isMigrationMode,
  isRestoringMode,
  isWorkspaceCreating,
  type MeasureContext,
  type PersonId,
  pickPrimarySocialId,
  platformNow,
  platformNowDiff,
  RateLimiter,
  readOnlyGuestAccountUuid,
  SocialIdType,
  systemAccount,
  systemAccountUuid,
  type Class,
  type Doc,
  type Ref,
  type Tx,
  type TxCUD,
  TxFactory,
  TxProcessor,
  type TxWorkspaceEvent,
  type BulkUpdateEvent,
  type Version,
  versionToString,
  withContext,
  type WorkspaceDataId,
  WorkspaceEvent,
  type WorkspaceIds,
  type WorkspaceInfoWithStatus,
  type WorkspaceUuid
} from '@hcengineering/core'
import platform, { PlatformError, Severity, Status, UNAUTHORIZED, unknownError } from '@hcengineering/platform'
import {
  type HelloRequest,
  type HelloResponse,
  type RateLimitInfo,
  type Request,
  type Response,
  SlidingWindowRateLimitter
} from '@hcengineering/rpc'
import {
  type AddSessionResponse,
  type ClientSessionCtx,
  type ConnectionSocket,
  type ConsumerHandle,
  type GetWorkspaceResponse,
  LOGGING_ENABLED,
  OneSecondCountersImpl,
  pingConst,
  type Pipeline,
  type PipelineFactory,
  type PlatformQueue,
  type PlatformQueueProducer,
  type QueueOnlineUserTx,
  QueueTopic,
  type QueueUserMessage,
  QueueWorkspaceEvent,
  type QueueWorkspaceMessage,
  type QueueWorkspaceMaintenanceMessage,
  type SendMemo,
  type Session,
  SessionDataImpl,
  type SessionHealth,
  type SessionManager,
  userEvents,
  type UserStatistics,
  workspaceEvents,
  type WorkspaceStatistics
} from '@hcengineering/server-core'
import { generateToken, type Token } from '@hcengineering/server-token'
import os from 'os'
import { ClientSession } from './client'
import { sendResponse } from './utils'
import { Workspace } from './workspace'

const ticksPerSecond = 20
const workspaceSoftShutdownTicks = 15 * ticksPerSecond

const guestAccount = 'b6996120-416f-49cd-841e-e4a5d2e49c9b'

const hangRequestTimeoutSeconds = 30
const hangSessionTimeoutSeconds = 60

// Clamp to >=1: RateLimiter(0) deadlocks (its `size >= rate` gate never opens), NaN uncaps it.
const parsedColdBuildConcurrency = parseInt(process.env.COLD_BUILD_CONCURRENCY ?? '8', 10)
const coldBuildConcurrency = Number.isNaN(parsedColdBuildConcurrency) ? 8 : Math.max(1, parsedColdBuildConcurrency)

/**
 * @public
 */
export interface Timeouts {
  // Timeout preferences
  pingTimeout: number // Default 10 second
  reconnectTimeout: number // Default 3 seconds
}

export class TSessionManager implements SessionManager {
  readonly transactorId: string
  // Presence batching: accumulate per-workspace online/offline changes and flush once per
  // second as a single pipeline tx -> one broadcast fan-out (M sends instead of M^2 in a
  // reconnect storm). Last write wins within the window, so connect/disconnect flapping
  // collapses. See docs/stress-test-plan.md.
  private readonly pendingStatus = new Map<WorkspaceUuid, Map<AccountUuid, { session: Session, online: boolean }>>()
  private readonly statusFlushTimers = new Map<WorkspaceUuid, any>()
  private readonly statusFlushing = new Set<WorkspaceUuid>()
  private readonly statusFlushDelay = parseInt(process.env.STATUS_FLUSH_MS ?? '1000')
  readonly workspaces = new Map<WorkspaceUuid, Workspace>()
  checkInterval: any

  sessions = new Map<string, { session: Session, socket: ConnectionSocket, tickHash: number }>()
  reconnectIds = new Set<string>()

  maintenanceTimer: any
  timeMinutes = 0
  maintenanceMessage?: string

  modelVersion = process.env.MODEL_VERSION ?? ''
  serverVersion = process.env.VERSION ?? ''

  workspaceProducer: PlatformQueueProducer<QueueWorkspaceMessage>
  usersProducer: PlatformQueueProducer<QueueUserMessage>
  workspaceConsumer: ConsumerHandle
  onlineUserTxConsumer: ConsumerHandle

  ticksContext: MeasureContext

  hungSessionsWarnPercent = parseInt(process.env.HUNG_SESSIONS_WARN_PERCENT ?? '25')
  hungSessionsFailPercent = parseInt(process.env.HUNG_SESSIONS_FAIL_PERCENT ?? '75')
  hungRequestsFailPercent = parseInt(process.env.HUNG_REQUESTS_PERCENT ?? '50')
  counters = new OneSecondCountersImpl()

  // Cap concurrent cold pipeline builds so a reconnect storm (1000 tenants after a
  // transactor restart) doesn't saturate the event loop at once.
  coldBuildLimiter = new RateLimiter(coldBuildConcurrency)

  constructor (
    readonly ctx: MeasureContext,
    readonly timeouts: Timeouts,
    readonly brandingMap: BrandingMap,
    readonly profiling:
    | {
      start: () => void
      stop: () => Promise<string | undefined>
    }
    | undefined,
    readonly accountsUrl: string,
    readonly enableCompression: boolean,
    readonly doHandleTick: boolean = true,
    readonly queue: PlatformQueue,
    readonly pipelineFactory: PipelineFactory
  ) {
    this.transactorId = process.env.TRANSACTOR_ID ?? os.hostname()
    if (this.doHandleTick) {
      this.checkInterval = setInterval(() => {
        this.handleTick()
      }, 1000 / ticksPerSecond)
    }
    this.workspaceProducer = this.queue.getProducer(ctx.newChild('ws-queue', {}, { span: false }), QueueTopic.Workspace)
    this.usersProducer = this.queue.getProducer(ctx.newChild('user-queue', {}, { span: false }), QueueTopic.Users)

    this.workspaceConsumer = this.queue.createConsumer<QueueWorkspaceMessage>(
      ctx.newChild('ws-queue-consume', {}, { span: false }),
      QueueTopic.Workspace,
      this.transactorId,
      async (ctx, msg) => {
        const m = msg.value
        if (
          m.type === QueueWorkspaceEvent.Upgraded ||
          m.type === QueueWorkspaceEvent.Restored ||
          m.type === QueueWorkspaceEvent.Deleted
        ) {
          // Handle workspace messages
          this.workspaceInfoCache.delete(msg.workspace)
        } else if (m.type === QueueWorkspaceEvent.LimitsChanged) {
          // Notify connected clients so they re-read usage/limits without waiting for the poll.
          // Skip when no session is active for this workspace — broadcast would log "cannot find sessions".
          if (this.workspaces.has(msg.workspace)) {
            const tx: TxWorkspaceEvent = {
              _id: generateId(),
              _class: core.class.TxWorkspaceEvent,
              event: WorkspaceEvent.LimitsChanged,
              modifiedBy: core.account.System,
              modifiedOn: Date.now(),
              objectSpace: core.space.DerivedTx,
              space: core.space.DerivedTx,
              createdBy: core.account.System,
              params: null
            }
            this.broadcast(ctx, null, msg.workspace, [tx], undefined)
          }
        } else if (m.type === QueueWorkspaceEvent.ForceClose) {
          // Operator dropped every session of this workspace; whichever transactor holds it acts.
          await this.forceClose(msg.workspace)
        } else if (m.type === QueueWorkspaceEvent.Maintenance) {
          // Global maintenance warning from the account service; workspace key is not meaningful here
          const mm = m as QueueWorkspaceMaintenanceMessage
          this.scheduleMaintenance(mm.timeoutMinutes, mm.message)
        }
      }
    )

    this.onlineUserTxConsumer = this.queue.createConsumer<QueueOnlineUserTx>(
      ctx.newChild('transactor-online-user-tx-consumer', {}, { span: false }),
      QueueTopic.OnlineUserTx,
      this.transactorId,
      async (ctx, msg) => {
        const { tx, account } = msg.value
        // The message names an account, so sessions are the index - a workspace without one
        // had nothing to apply anyway.
        const targets = new Set<WorkspaceUuid>()
        for (const { session } of this.sessions.values()) {
          if (session.getUser() === account) {
            targets.add(session.workspace.uuid)
          }
        }

        for (const workspaceUuid of targets) {
          const workspace = this.workspaces.get(workspaceUuid)
          if (workspace == null) continue

          await workspace.with(async (pipeline) => {
            ctx.contextData = new SessionDataImpl(
              systemAccount,
              'online-user-tx',
              true,
              { txes: [], targets: {}, queue: [], sessions: {} },
              workspace.wsId,
              true,
              undefined,
              undefined,
              pipeline.context.modelDb,
              new Map(),
              'transactor'
            )
            await pipeline.tx(ctx, [tx])
            await pipeline.handleBroadcast(ctx)
          })
        }
      }
    )

    this.ticksContext = ctx.newChild('ticks', {}, { span: false })
  }

  scheduleMaintenance (timeMinutes: number, message?: string): void {
    this.timeMinutes = timeMinutes
    this.maintenanceMessage = message

    this.sendMaintenanceWarning()

    const nextTime = (): number => (this.timeMinutes > 1 ? 60 * 1000 : this.timeMinutes * 60 * 1000)

    const showMaintenance = (): void => {
      if (this.timeMinutes > 1) {
        this.timeMinutes -= 1
        clearTimeout(this.maintenanceTimer)
        this.maintenanceTimer = setTimeout(showMaintenance, nextTime())
      } else {
        this.timeMinutes = 0
      }

      this.sendMaintenanceWarning()
    }

    clearTimeout(this.maintenanceTimer)
    this.maintenanceTimer = setTimeout(showMaintenance, nextTime())
  }

  private sendMaintenanceWarning (): void {
    if (this.timeMinutes === 0) {
      return
    }
    const event: TxWorkspaceEvent = this.createMaintenanceWarning()
    for (const ws of this.workspaces.values()) {
      this.doBroadcast(this.ctx, ws, [event])
    }
  }

  private createMaintenanceWarning (): TxWorkspaceEvent {
    return {
      _id: generateId(),
      _class: core.class.TxWorkspaceEvent,
      event: WorkspaceEvent.MaintenanceNotification,
      modifiedBy: core.account.System,
      modifiedOn: Date.now(),
      objectSpace: core.space.DerivedTx,
      space: core.space.DerivedTx,
      createdBy: core.account.System,
      params: {
        timeMinutes: this.timeMinutes,
        message: this.maintenanceMessage
      }
    }
  }

  ticks = 0

  handleTick (): void {
    const now = Date.now()
    this.handleWorkspaceTick()

    this.handleSessionTick(now)
    this.ticks++
  }

  calcWorkspaceStats (sessions: { session: Session }[]): { sys: number, user: number, anonymous: number } {
    let user: number = 0
    let sys: number = 0
    let anonymous: number = 0
    for (const s of sessions) {
      if (s.session.getUser() === systemAccountUuid) {
        sys++
      } else {
        user++
        if (s.session.getUser() === guestAccount || s.session.getUser() === readOnlyGuestAccountUuid) {
          anonymous++
        }
      }
    }
    return { sys, user, anonymous }
  }

  private handleWorkspaceTick (): void {
    if (this.ticks % ticksPerSecond === 0) {
      // A gauge does not need the full 20Hz tick rate.
      this.ctx.measure('sessions', this.sessions.size, { kind: 'total' }, true)

      // Let's update workspace statistics every 10 seconds
      this.sendUserWorkspaceStats()

      // Send extra counters and clear them to collect again
      for (const [, entry] of this.counters.entriesFull()) {
        if (entry.labels !== undefined) {
          this.ctx.measure(entry.counter, entry.value, entry.labels, true)
        } else {
          this.ctx.measure(entry.counter, entry.value, true)
        }
      }
      this.counters.check()
    }

    if (this.ticks % (60 * ticksPerSecond) === 0) {
      const workspacesToUpdate: WorkspaceUuid[] = []

      for (const [wsId, workspace] of this.workspaces.entries()) {
        // update account lastVisit every minute per every workspace.
        for (const val of workspace.sessions.values()) {
          // Services may hold a person account (aibot), so the system account alone is not enough
          // to tell a real visit from a service connection.
          if (val.session.getUser() !== systemAccountUuid && val.session.token?.extra?.service === undefined) {
            workspacesToUpdate.push(wsId)
            break
          }
        }
      }
      if (workspacesToUpdate.length > 0) {
        void this.updateLastVisit(this.ctx, workspacesToUpdate).catch(() => {
          // Ignore
        })
      }
    }
    for (const [wsId, workspace] of this.workspaces.entries()) {
      // Map allows delete during iteration in JS; no need to spread to a temp array.
      for (const [k, v] of workspace.tickHandlers) {
        v.ticks--
        if (v.ticks === 0) {
          workspace.tickHandlers.delete(k)
          try {
            v.operation()
          } catch (err: any) {
            Analytics.handleError(err)
          }
        }
      }

      // Hoisted out of the session loop: true once every five minutes, yet it made the tick walk
      // every session of every workspace 20 times a second.
      if (this.ticks % (5 * 60 * ticksPerSecond) === workspace.tickHash) {
        for (const s of workspace.sessions.values()) {
          s.session.mins5.find = s.session.current.find
          s.session.mins5.tx = s.session.current.tx

          s.session.current = { find: 0, tx: 0 }
        }
      }

      // Wait some time for new client to appear before closing workspace.
      if (
        !workspace.maintenance &&
        workspace.sessions.size === 0 &&
        workspace.closing === undefined &&
        workspace.workspaceInitCompleted
      ) {
        workspace.softShutdown--
        if (workspace.softShutdown <= 0) {
          this.ctx.warn('closing workspace, no users', {
            workspace: workspace.wsId.url,
            wsId,
            upgrade: workspace.maintenance
          })
          workspace.closing = this.performWorkspaceCloseCheck(workspace)
        }
      } else {
        workspace.softShutdown = workspaceSoftShutdownTicks
      }
    }
  }

  private sendUserWorkspaceStats (): void {
    const { sys, user, anonymous } = this.calcWorkspaceStats(Array.from(this.sessions.values()))

    let userWorkspaces: number = 0
    let sysOnlyWorkspaces: number = 0

    for (const ws of this.workspaces.values()) {
      const { sys, user } = this.calcWorkspaceStats(Array.from(ws.sessions.values()))
      if (user > 0) {
        userWorkspaces++
      } else {
        if (sys > 0) {
          sysOnlyWorkspaces++
        }
      }
    }

    this.ctx.measure('sessions', user, { kind: 'user' }, true)
    this.ctx.measure('sessions', sys, { kind: 'system' }, true)
    this.ctx.measure('sessions', anonymous, { kind: 'anonymous' }, true)

    this.ctx.measure('workspaces', this.workspaces.size, { kind: 'all' }, true)
    this.ctx.measure('workspaces', userWorkspaces, { kind: 'user' }, true)
    this.ctx.measure('workspaces', sysOnlyWorkspaces, { kind: 'systemonly' }, true)
  }

  private handleSessionTick (now: number): void {
    for (const s of this.sessions.values()) {
      const isCurrentUserTick = this.ticks % ticksPerSecond === s.tickHash

      if (isCurrentUserTick) {
        const wsId = s.session.workspace.uuid
        const lastRequestDiff = now - s.session.lastRequest

        let timeout = hangSessionTimeoutSeconds * 1000
        if (s.session.getUser() === systemAccountUuid) {
          timeout = timeout * 10
        }
        if (lastRequestDiff > timeout) {
          this.ctx.warn('session hang, closing...', {
            wsId,
            user: s.session.getUser()
          })

          // Force close workspace if only one client and it hang.
          void this.close(this.ticksContext, s.socket, wsId).catch((err) => {
            this.ctx.error('failed to close', err)
          })
          continue
        }
        if (
          lastRequestDiff + (1 / 10) * lastRequestDiff > this.timeouts.pingTimeout &&
          now - s.session.lastPing > this.timeouts.pingTimeout
        ) {
          // We need to check state and close socket if it broken
          // And ping other wize
          s.session.lastPing = now
          if (s.socket.checkState()) {
            void s.socket.send(this.ticksContext, { result: pingConst }, s.session.binaryMode, s.session.useCompression)
          }
        }
        for (const r of s.session.requests.values()) {
          const sec = Math.round((now - r.start) / 1000)
          if (sec > 0 && sec % hangRequestTimeoutSeconds === 0) {
            this.ctx.warn('request hang found', {
              sec,
              wsId,
              total: s.session.requests.size,
              user: s.session.getUser(),
              params: cutObjectArray(r.params)
            })
          }
        }
      }
    }
  }

  createSession (token: Token, workspace: WorkspaceIds, info: LoginInfoWithWorkspaces): Session {
    let primarySocialId: PersonId
    let role: AccountRole = info.workspaces[workspace.uuid]?.role ?? AccountRole.User
    switch (info.account) {
      case systemAccountUuid:
        primarySocialId = core.account.System
        role = AccountRole.Owner
        break
      case guestAccount:
        primarySocialId = '' as PersonId
        role = AccountRole.DocGuest
        break
      default:
        primarySocialId = pickPrimarySocialId(info.socialIds)._id
    }

    return new ClientSession(
      token,
      workspace,
      {
        uuid: info.account,
        socialIds: info.socialIds.map((it) => it._id),
        primarySocialId,
        fullSocialIds: info.socialIds,
        role
      },
      info,
      token.extra?.mode === 'backup',
      this.counters
    )
  }

  @withContext('🧭 get-workspace-info')
  async getWorkspaceInfo (
    ctx: MeasureContext,
    token: string,
    updateLastVisit = true
  ): Promise<WorkspaceInfoWithStatus | undefined> {
    try {
      return await getAccountClient(this.accountsUrl, token).getWorkspaceInfo(updateLastVisit)
    } catch (err: any) {
      if (err?.cause?.code === 'ECONNRESET' || err?.cause?.code === 'ECONNREFUSED') {
        return undefined
      }
      throw err
    }
  }

  @withContext('🧭 update-last-visit')
  async updateLastVisit (ctx: MeasureContext, workspaces: WorkspaceUuid[]): Promise<void> {
    try {
      const sysToken = generateToken(systemAccountUuid, undefined, { service: 'transactor' })
      await getAccountClient(this.accountsUrl, sysToken).updateLastVisit(workspaces)
    } catch (err: any) {
      if (err?.cause?.code === 'ECONNRESET' || err?.cause?.code === 'ECONNREFUSED') {
        return undefined
      }
      throw err
    }
  }

  @withContext('🧭 get-login-with-workspace-info')
  async getLoginWithWorkspaceInfo (ctx: MeasureContext, token: string): Promise<LoginInfoWithWorkspaces | undefined> {
    try {
      const accountClient = getAccountClient(this.accountsUrl, token)
      return await accountClient.getLoginWithWorkspaceInfo()
    } catch (err: any) {
      if (err?.cause?.code === 'ECONNRESET' || err?.cause?.code === 'ECONNREFUSED') {
        return undefined
      }
      throw err
    }
  }

  @withContext('🧭 check-password-aging')
  async checkPasswordAging (ctx: MeasureContext, token: string): Promise<boolean> {
    const accountClient = getAccountClient(this.accountsUrl, token)
    return await accountClient.checkPasswordAging()
  }

  countUserSessions (workspace: Workspace, accountUuid: AccountUuid): number {
    return Array.from(workspace.sessions.values())
      .filter((it) => it.session.getUser() === accountUuid)
      .reduce<number>((acc) => acc + 1, 0)
  }

  getUserSession (workspaceUuid: WorkspaceUuid, accountUuid: AccountUuid): Session | undefined {
    const workspace = this.workspaces.get(workspaceUuid)
    if (workspace == null) return undefined
    return Array.from(workspace.sessions.values()).find((it) => it.session.getUser() === accountUuid)?.session
  }

  checkHealth (): SessionHealth {
    const now = Date.now()

    let totalSessions = 0
    let hungSessions = 0

    for (const [, { session }] of this.sessions) {
      let totalRequests = 0
      let hungRequests = 0

      // Ignore system account sessions
      if (session.getUser() === systemAccountUuid) {
        continue
      }

      totalSessions += 1

      // Check if the session is hung
      const lastRequestDiff = now - session.lastRequest
      if (lastRequestDiff > hangSessionTimeoutSeconds * 1000) {
        hungSessions += 1
        continue
      }

      // Check if requests are hung
      for (const r of session.requests.values()) {
        const sec = Math.round((now - r.start) / 1000)
        if (sec > hangRequestTimeoutSeconds) {
          hungRequests += 1
        }
        totalRequests += 1
      }

      const hungRequestsPercent = totalRequests > 0 ? (100 * hungRequests) / totalRequests : 0
      if (hungRequestsPercent > this.hungRequestsFailPercent) {
        hungSessions += 1
      }
    }

    this.ctx.measure('sessions', hungSessions, { kind: 'hung' }, true)

    const hungSessionsPercent = totalSessions > 0 ? (100 * hungSessions) / totalSessions : 0

    if (hungSessionsPercent > this.hungSessionsFailPercent) {
      this.ctx.warn('high hung sessions', { hungSessionsPercent })
      return 'unhealthy'
    }

    if (hungSessionsPercent > this.hungSessionsWarnPercent) {
      this.ctx.warn('high degraded sessions', { hungSessionsPercent })
      return 'degraded'
    }

    return 'healthy'
  }

  tickCounter = 0

  @withContext('🧭 get-workspace')
  async getWorkspace (
    ctx: MeasureContext,
    workspaceUuid: WorkspaceUuid,
    workspaceInfo: LoginInfoWorkspace | undefined,
    token: Token,
    ws: ConnectionSocket
  ): Promise<{ workspace?: Workspace, resp?: GetWorkspaceResponse }> {
    if (workspaceInfo === undefined) {
      return { resp: { error: new Error('Workspace not found or not available'), terminate: true } }
    }

    if (isArchivingMode(workspaceInfo.mode)) {
      // No access to disabled workspaces for regular users
      return {
        resp: {
          error: new Status(Severity.ERROR, platform.status.WorkspaceArchived, { workspaceUuid }),
          terminate: true,
          specialError: 'archived'
        }
      }
    }
    if (isMigrationMode(workspaceInfo.mode)) {
      // No access to disabled workspaces for regular users
      return {
        resp: {
          error: new Status(Severity.ERROR, platform.status.WorkspaceMigration, { workspaceUuid }),
          terminate: true,
          specialError: 'migration'
        }
      }
    }
    if (isRestoringMode(workspaceInfo.mode)) {
      // No access to disabled workspaces for regular users
      return {
        resp: {
          error: new Status(Severity.ERROR, platform.status.WorkspaceMigration, { workspaceUuid }),
          terminate: true,
          specialError: 'migration'
        }
      }
    }

    if (isWorkspaceCreating(workspaceInfo.mode)) {
      // No access to workspace for token.
      return { resp: { error: new Error(`Workspace during creation phase...${workspaceUuid}`) } }
    }

    const wsVersion: Data<Version> = {
      major: workspaceInfo.version.versionMajor,
      minor: workspaceInfo.version.versionMinor,
      patch: workspaceInfo.version.versionPatch
    }

    if (
      this.modelVersion !== '' &&
      this.modelVersion !== versionToString(wsVersion) &&
      token.extra?.model !== 'upgrade' &&
      token.extra?.mode !== 'backup'
    ) {
      ctx.warn('Model version mismatch', {
        source: token.extra?.service ?? 'user',
        version: this.modelVersion,
        workspaceVersion: versionToString(wsVersion),
        workspace: workspaceUuid
      })
      // Version mismatch, return upgrading.
      return {
        resp: { upgrade: true, progress: workspaceInfo.mode === 'upgrading' ? (workspaceInfo.progress ?? 0) : 0 }
      }
    }

    let workspace = this.workspaces.get(workspaceUuid)
    if (workspace?.closing !== undefined) {
      await workspace?.closing
    }

    workspace = this.workspaces.get(workspaceUuid)

    const branding =
      (workspaceInfo.branding !== undefined
        ? Object.values(this.brandingMap).find((b) => b.key === workspaceInfo?.branding)
        : null) ?? null

    if (workspace === undefined) {
      ctx.warn('open workspace', {
        account: token.account,
        workspace: workspaceUuid,
        ...token.extra
      })

      workspace = this.createWorkspace(ctx.parent ?? ctx, ctx, token, workspaceInfo.url, workspaceInfo.dataId, branding)
      await this.workspaceProducer.send(ctx, workspaceUuid, [workspaceEvents.open()])
    }

    if (token.extra?.model === 'upgrade') {
      if (workspace.maintenance) {
        ctx.warn('reconnect workspace in upgrade', {
          account: token.account,
          workspace: workspaceUuid,
          wsUrl: workspaceInfo.url
        })
      } else {
        ctx.warn('reconnect workspace in upgrade switch', {
          email: token.account,
          workspace: workspaceUuid,
          wsUrl: workspaceInfo.url
        })

        // We need to wait in case previous upgrade connection is already closing.
        await this.switchToUpgradeSession(token, ctx.parent ?? ctx, workspace, ws)
      }
    } else {
      if (workspace.maintenance || this.maintenanceWorkspaces.has(workspace.wsId.uuid)) {
        ctx.warn('connect during upgrade', {
          account: token.account,
          workspace: workspace.wsId.url,
          sessionUsers: Array.from(workspace.sessions.values()).map((it) => it.session.getUser()),
          sessionData: Array.from(workspace.sessions.values()).map((it) => it.socket.data())
        })

        return { resp: { upgrade: true } }
      }
    }
    return { workspace }
  }

  sysAccount = {
    account: systemAccountUuid,
    name: 'System',
    workspaces: {},
    socialIds: []
  }

  maintenanceWorkspaces = new Set<WorkspaceUuid>()

  workspaceInfoCache = new Map<WorkspaceUuid, WorkspaceInfoWithStatus>()

  async addSession (
    ctx: MeasureContext,
    ws: ConnectionSocket,
    token: Token,
    rawToken: string,
    sessionId: string | undefined
  ): Promise<AddSessionResponse> {
    return await this.counters.withCounter('addSession', 1, () =>
      ctx.with('📲 add-session', { source: token.extra?.service ?? '🤦‍♂️user' }, async (ctx) => {
        let account: LoginInfoWithWorkspaces | undefined

        try {
          if (token.account === undefined) {
            return { error: UNAUTHORIZED, terminate: true }
          }
          account =
            token.account === systemAccountUuid ? this.sysAccount : await this.getLoginWithWorkspaceInfo(ctx, rawToken)
        } catch (err: any) {
          return { error: err }
        }

        if (account === undefined) {
          return { error: new Error('Account not found or not available'), terminate: true }
        }

        let wsInfo = account.workspaces[token.workspace]

        if (wsInfo === undefined) {
          // In case of guest or system account
          // We need to get workspace info for system account.
          const workspaceInfo =
            this.workspaceInfoCache.get(token.workspace) ?? (await this.getWorkspaceInfo(ctx, rawToken, false))
          if (workspaceInfo === undefined) {
            return { error: new Error('Workspace not found or not available'), terminate: true }
          }
          this.workspaceInfoCache.set(token.workspace, workspaceInfo)

          wsInfo = {
            url: workspaceInfo.url,
            mode: workspaceInfo.mode,
            dataId: workspaceInfo.dataId,
            version: {
              versionMajor: workspaceInfo.versionMajor,
              versionMinor: workspaceInfo.versionMinor,
              versionPatch: workspaceInfo.versionPatch
            },
            // Placeholder only: createSession takes the role from account.workspaces, never from here.
            role: AccountRole.ReadOnlyGuest,
            endpoint: { externalUrl: '', internalUrl: '', region: workspaceInfo.region ?? '' },
            collaboratorEndpoint: { externalUrl: '', internalUrl: '', region: workspaceInfo.region ?? '' },
            progress: workspaceInfo.processingProgress,
            branding: workspaceInfo.branding
          }
        } else {
          this.workspaceInfoCache.delete(token.workspace)
        }

        if (wsInfo.passwordAgingRule != null && wsInfo.passwordAgingRule > 0) {
          const isPasswordAgingOk = await this.checkPasswordAging(ctx, rawToken)
          if (!isPasswordAgingOk) {
            return { error: new Status(Severity.ERROR, platform.status.PasswordExpired, {}), terminate: true }
          }
        }

        const { workspace, resp } = await this.getWorkspace(ctx.parent ?? ctx, token.workspace, wsInfo, token, ws)
        if (resp !== undefined) {
          return resp
        }

        if (workspace === undefined || account === undefined) {
          // Should not happen
          return { error: new Error('Workspace not found or not available'), terminate: true }
        }

        const oldSession = sessionId !== undefined ? workspace.sessions?.get(sessionId) : undefined
        if (oldSession !== undefined) {
          // Just close old socket for old session id.
          await this.close(ctx, oldSession.socket, workspace.wsId.uuid)
        }

        const session = this.createSession(token, workspace.wsId, account)

        session.sessionId = sessionId !== undefined && (sessionId ?? '').trim().length > 0 ? sessionId : generateId()
        session.sessionInstanceId = generateId()
        const tickHash = this.tickCounter % ticksPerSecond

        this.sessions.set(ws.id, { session, socket: ws, tickHash })
        // We need to delete previous session with Id if found.
        this.tickCounter++
        workspace.sessions.set(session.sessionId, { session, socket: ws, tickHash })

        const accountUuid = account.account
        if (accountUuid !== systemAccountUuid && accountUuid !== guestAccount) {
          await this.usersProducer.send(ctx, workspace.wsId.uuid, [
            userEvents.login({
              user: accountUuid,
              sessions: this.countUserSessions(workspace, accountUuid),
              socialIds: account.socialIds.map((it) => it._id),
              timestamp: Date.now()
            })
          ])
        }

        // Mark workspace as init completed and we had at least one client.
        if (!workspace.workspaceInitCompleted) {
          workspace.workspaceInitCompleted = true
        }

        // AI bot uses REST, not hello-time status; mark it online on first request.
        if (token.extra?.service === 'aibot') {
          this.queueStatus(workspace.wsId.uuid, session, true)
        }

        if (this.timeMinutes > 0) {
          void ws
            .send(ctx, { result: this.createMaintenanceWarning() }, session.binaryMode, session.useCompression)
            .catch((err) => {
              ctx.error('failed to send maintenance warning', err)
            })
        }
        return { session, context: workspace.context, workspaceId: workspace.wsId.uuid }
      })
    )
  }

  private async switchToUpgradeSession (
    token: Token,
    ctx: MeasureContext,
    workspace: Workspace,
    ws: ConnectionSocket
  ): Promise<void> {
    if (LOGGING_ENABLED) {
      ctx.info('reloading workspace', { url: workspace.wsId.url, token: JSON.stringify(token) })
    }

    // Mark as upgrade, to prevent any new clients to connect during close
    workspace.maintenance = true
    // If upgrade client is used.
    // Drop all existing clients
    await this.doCloseAll(workspace, 0, 'upgrade', ws)
  }

  broadcastAll (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    tx: Tx[],
    target?: AccountUuid | AccountUuid[],
    exclude?: AccountUuid[]
  ): void {
    const ws = this.workspaces.get(workspace)
    if (ws === undefined) {
      return
    }
    this.doBroadcast(ctx, ws, tx, target, exclude)
  }

  doBroadcast (
    ctx: MeasureContext,
    ws: Workspace,
    tx: Tx[],
    target?: AccountUuid | AccountUuid[],
    exclude?: AccountUuid[]
  ): void {
    if (ws.maintenance) {
      return
    }
    if (target !== undefined && !Array.isArray(target)) {
      target = [target]
    }
    ctx = ctx.newChild('📬 broadcast-all', {})
    const sessions = [...ws.sessions.values()].filter((it) => {
      if (it === undefined) {
        return false
      }
      const tt = it.session.getUser()
      return (target === undefined && !(exclude ?? []).includes(tt)) || (target?.includes(tt) ?? false)
    })
    // Compute the set of classes that this broadcast touches. We include both
    // objectClass and attachedToClass so collaborator-driven live queries on the
    // parent doc also get refreshed after a drop.
    const computeClasses = (txes: Tx[]): Ref<Class<Doc>>[] => {
      const set = new Set<Ref<Class<Doc>>>()
      for (const t of txes) {
        if (TxProcessor.isExtendsCUD(t._class)) {
          const cud = t as TxCUD<Doc>
          if (cud.objectClass != null) set.add(cud.objectClass)
          if (cud.attachedToClass != null) set.add(cud.attachedToClass)
        }
      }
      return Array.from(set)
    }
    let cachedClasses: Ref<Class<Doc>>[] | null = null
    const droppedClasses = (): Ref<Class<Doc>>[] => {
      if (cachedClasses === null) cachedClasses = computeClasses(tx)
      return cachedClasses
    }
    const buildRefreshTx = (classes: Ref<Class<Doc>>[]): TxWorkspaceEvent => ({
      _id: generateId(),
      _class: core.class.TxWorkspaceEvent,
      event: WorkspaceEvent.BulkUpdate,
      modifiedBy: core.account.System,
      modifiedOn: Date.now(),
      objectSpace: core.space.DerivedTx,
      space: core.space.DerivedTx,
      createdBy: core.account.System,
      params: { _class: classes } satisfies BulkUpdateEvent
    })
    function send (): void {
      const promises: Promise<void>[] = []
      // Identical bytes go to every socket that is not owed a refresh - pack and compress once.
      const memo: SendMemo = new Map()
      for (const session of sessions) {
        try {
          const sock = session.socket
          // Slow client - drop tx for this socket and accumulate classes for a later refresh.
          if (sock.isOverloaded?.() === true) {
            sock.addDroppedClasses?.(droppedClasses())
            ctx.measure('broadcast-dropped', tx.length)
            continue
          }
          // Buffer drained enough - emit a single BulkUpdate event covering all dropped classes
          // before delivering the current broadcast so client query cache invalidates.
          const pending = sock.takePendingRefresh?.() ?? null
          let outTx = tx
          let sendMemo: SendMemo | undefined = memo
          if (pending !== null && pending.length > 0) {
            outTx = [buildRefreshTx(pending), ...tx]
            sendMemo = undefined // this socket gets a different payload
            ctx.measure('broadcast-flushed-refresh', pending.length)
          }
          promises.push(
            sendResponse(ctx, session.session, sock, { result: outTx }, sendMemo).catch((err) => {
              ctx.error('failed to send', err)
            })
          )
        } catch (err: any) {
          Analytics.handleError(err)
          ctx.error('error during send', { error: err })
        }
      }
      void Promise.all(promises).finally(() => {
        ctx.end()
      })
    }
    if (sessions.length > 0) {
      // We need to send broadcast after our client response so put it after all IO
      send()
    } else {
      ctx.end()
    }
  }

  broadcastSessions (measure: MeasureContext, sessionIds: Record<string, Tx[]>): void {
    const ctx = measure.newChild('📬 broadcast sessions', {})
    const allSessions = Array.from(this.sessions.values())
    const sessions = Object.entries(sessionIds).map(([sessionId, txes]) => ({
      session: allSessions.find((it) => it.session.sessionId === sessionId),
      txes
    }))

    function send (): void {
      for (const session of sessions) {
        if (session.session === undefined) {
          continue
        }
        try {
          void sendResponse(ctx, session.session.session, session.session.socket, { result: session.txes })
        } catch (err: any) {
          Analytics.handleError(err)
          ctx.error('error during send', { error: err })
        }
      }
      ctx.end()
    }
    if (sessions.length > 0) {
      // We need to send broadcast after our client response so put it after all IO
      send()
    } else {
      ctx.end()
    }
  }

  broadcast (
    ctx: MeasureContext,
    from: Session | null,
    workspaceId: WorkspaceUuid,
    resp: Tx[],
    target: AccountUuid | undefined,
    exclude?: AccountUuid[]
  ): void {
    const workspace = this.workspaces.get(workspaceId)
    if (workspace === undefined) {
      this.ctx.error('internal: cannot find sessions', {
        workspaceId,
        target,
        userId: from?.getUser() ?? '$unknown'
      })
      return
    }
    if (workspace?.maintenance ?? false) {
      return
    }

    const sessions = [...workspace.sessions.values()]
    ctx = ctx.newChild('📭 broadcast', {})
    const send = (): void => {
      const memo: SendMemo = new Map()
      for (const sessionRef of sessions) {
        const tt = sessionRef.session.getUser()
        if ((target === undefined && !(exclude ?? []).includes(tt)) || (target?.includes(tt) ?? false)) {
          sessionRef.session.broadcast(ctx, sessionRef.socket, resp, memo)
        }
      }
      ctx.end()
    }
    if (sessions.length > 0) {
      // We need to send broadcast after our client response so put it after all IO
      send()
    } else {
      ctx.end()
    }
  }

  private createWorkspace (
    ctx: MeasureContext,
    pipelineCtx: MeasureContext,
    token: Token,
    workspaceUrl: string,
    workspaceDataId: WorkspaceDataId | undefined,
    branding: Branding | null
  ): Workspace {
    const upgrade = token.extra?.model === 'upgrade'
    const context = ctx.newChild('🧲 session', {}, { span: false })
    const workspaceIds: WorkspaceIds = {
      uuid: token.workspace,
      dataId: workspaceDataId,
      url: workspaceUrl
    }

    const factory = async (): Promise<Pipeline> => {
      // Only the cold build is gated (see coldBuildLimiter); pipeline ops run unthrottled.
      const pipeline = await this.coldBuildLimiter.exec(() =>
        this.counters.withCounter('startWorkspace', 1, () =>
          this.pipelineFactory(
            pipelineCtx,
            workspaceIds,
            {
              broadcast: (ctx, tx, targets, exclude) => {
                this.broadcastAll(ctx, workspaceIds.uuid, tx, targets, exclude)
              },
              broadcastSessions: (ctx, sessions) => {
                this.broadcastSessions(ctx, sessions)
              }
            },
            branding
          )
        )
      )
      return pipeline
    }
    const workspace: Workspace = new Workspace(
      context,
      generateToken(systemAccountUuid, token.workspace, { service: 'transactor' }),
      factory,
      this.tickCounter % ticksPerSecond,
      workspaceSoftShutdownTicks,
      workspaceIds,
      branding
    )
    workspace.maintenance = upgrade
    this.workspaces.set(token.workspace, workspace)

    return workspace
  }

  private queueStatus (workspaceId: WorkspaceUuid, session: Session, online: boolean): void {
    const user = session.getUser()
    if (user === undefined || session.getRawAccount().role === AccountRole.ReadOnlyGuest) return
    let pending = this.pendingStatus.get(workspaceId)
    if (pending === undefined) {
      pending = new Map()
      this.pendingStatus.set(workspaceId, pending)
    }
    pending.set(user, { session, online })
    this.queueStatusFlush(workspaceId)
  }

  private queueStatusFlush (workspaceId: WorkspaceUuid): void {
    if (this.statusFlushTimers.has(workspaceId)) return
    this.statusFlushTimers.set(
      workspaceId,
      setTimeout(() => {
        this.statusFlushTimers.delete(workspaceId)
        void this.flushStatus(workspaceId)
      }, this.statusFlushDelay)
    )
  }

  private async flushStatus (workspaceId: WorkspaceUuid): Promise<void> {
    // Serialize flushes per workspace: an overlapping flush could findAll before the prior
    // create commits and duplicate a transient UserStatus. Re-arm and bail if one is running.
    if (this.statusFlushing.has(workspaceId)) {
      this.queueStatusFlush(workspaceId)
      return
    }
    const pending = this.pendingStatus.get(workspaceId)
    if (pending === undefined || pending.size === 0) return
    this.pendingStatus.delete(workspaceId)
    const workspace = this.workspaces.get(workspaceId)
    if (workspace === undefined || workspace.maintenance) return
    this.statusFlushing.add(workspaceId)
    const entries = [...pending.entries()]
    try {
      await workspace.context.with('🧨 status-batch', {}, (ctx) =>
        workspace.with(async (pipeline) => {
          ctx.contextData = new SessionDataImpl(
            systemAccount,
            'status-batch',
            true,
            { txes: [], targets: {}, queue: [], sessions: {} },
            workspace.wsId,
            true,
            undefined,
            undefined,
            pipeline.context.modelDb,
            new Map(),
            'transactor'
          )
          const users = entries.map(([user]) => user)
          const existing = await pipeline.findAll(ctx, core.class.UserStatus, { user: { $in: users } })
          const byUser = new Map(existing.map((s) => [s.user, s]))
          const txes: Tx[] = []
          for (const [user, { session, online }] of entries) {
            const txFactory = new TxFactory(session.getRawAccount().primarySocialId, true)
            const cur = byUser.get(user)
            if (cur === undefined) {
              if (online) {
                txes.push(txFactory.createTxCreateDoc(core.class.UserStatus, core.space.Space, { online, user }))
              }
            } else if (cur.online !== online) {
              txes.push(txFactory.createTxUpdateDoc(cur._class, cur.space, cur._id, { online }))
            }
          }
          if (txes.length === 0) return
          await pipeline.tx(ctx, txes)
          await pipeline.handleBroadcast(ctx)
        })
      )
    } catch (err: any) {
      this.ctx.error('failed to flush status batch', { err, workspaceId })
      Analytics.handleError(err)
    } finally {
      this.statusFlushing.delete(workspaceId)
      // New changes may have arrived during the flush.
      if ((this.pendingStatus.get(workspaceId)?.size ?? 0) > 0) this.queueStatusFlush(workspaceId)
    }
  }

  async close (ctx: MeasureContext, ws: ConnectionSocket, workspaceUuid: WorkspaceUuid): Promise<void> {
    const workspace = this.workspaces.get(workspaceUuid)

    const sessionRef = this.sessions.get(ws.id)
    if (sessionRef !== undefined) {
      // We need to close all requests from counters
      ctx.info('bye happen', {
        workspaceId: workspace?.wsId.uuid,
        userId: sessionRef.session.getUser(),
        user: sessionRef.session.getSocialIds().find((it) => it.type !== SocialIdType.HULY)?.value,
        binary: sessionRef.session.binaryMode,
        compression: sessionRef.session.useCompression,
        totalTime: Date.now() - sessionRef.session.createTime,
        workspaceUsers: workspace?.sessions?.size,
        totalUsers: this.sessions.size
      })
      this.sessions.delete(ws.id)

      if (workspace !== undefined) {
        workspace.sessions.delete(sessionRef.session.sessionId)

        const userUuid = sessionRef.session.getUser()
        await this.usersProducer.send(ctx, workspaceUuid, [
          userEvents.logout({
            user: userUuid,
            sessions: this.countUserSessions(workspace, userUuid),
            socialIds: sessionRef.session.getUserSocialIds(),
            timestamp: Date.now()
          })
        ])

        if (this.doHandleTick) {
          workspace.tickHandlers.set(sessionRef.session.sessionId, {
            ticks: this.timeouts.reconnectTimeout * ticksPerSecond,
            operation: () => {
              this.reconnectIds.delete(sessionRef.session.sessionId)
              const user = sessionRef.session.getUser()
              if (workspace !== undefined) {
                const another = Array.from(workspace.sessions.values()).findIndex((p) => p.session.getUser() === user)
                if (another === -1 && !workspace.maintenance) {
                  void workspace.with(async (pipeline) => {
                    await pipeline.closeSession(ctx, sessionRef.session.sessionId)
                  })
                  // Keep the AI bot online while the workspace is up: its REST sessions come and
                  // go per request, so flipping it offline on session close would blink it out.
                  const isAiBot = sessionRef.session.token.extra?.service === 'aibot'
                  if (user !== guestAccount && user !== systemAccountUuid && !isAiBot) {
                    this.queueStatus(workspaceUuid, sessionRef.session, false)
                  }
                }
              }
            }
          })
        }
        this.reconnectIds.add(sessionRef.session.sessionId)
      }
      try {
        sessionRef.socket.close()
      } catch (err) {
        // Ignore if closed
      }
    }
  }

  async forceMaintenance (ctx: MeasureContext, workspaceId: WorkspaceUuid): Promise<void> {
    const workspace = this.workspaces.get(workspaceId)
    this.maintenanceWorkspaces.add(workspaceId)
    if (workspace !== undefined) {
      workspace.maintenance = true
      ctx.info('force-maintenance', { workspaceId })
      await this.doCloseAll(workspace, 99, 'force-close')
    }
  }

  async forceClose (wsId: WorkspaceUuid, ignoreSocket?: ConnectionSocket): Promise<void> {
    const ws = this.workspaces.get(wsId)
    this.maintenanceWorkspaces.delete(wsId)
    this.workspaceInfoCache.delete(wsId)
    if (ws !== undefined) {
      this.ctx.warn('force-close', { name: ws.wsId.url })
      ws.maintenance = true // We need to similare upgrade to refresh all clients.
      ws.closing = this.doCloseAll(ws, 99, 'force-close', ignoreSocket)
      this.workspaces.delete(wsId)
      await ws.closing
      ws.closing = undefined
    } else {
      this.ctx.warn('force-close-unknown', { wsId })
    }
  }

  async doCloseAll (
    workspace: Workspace,
    code: number,
    reason: 'upgrade' | 'shutdown' | 'force-close',
    ignoreSocket?: ConnectionSocket
  ): Promise<void> {
    if (LOGGING_ENABLED) {
      this.ctx.info('closing workspace', {
        url: workspace.wsId.url,
        uuid: workspace.wsId.uuid,
        code,
        reason
      })
    }

    const sessions = Array.from(workspace.sessions)
    workspace.sessions.clear()

    const closeS = (s: Session, webSocket: ConnectionSocket): void => {
      s.workspaceClosed = true
      if (reason === 'upgrade' || reason === 'force-close') {
        // Override message handler, to wait for upgrading response from clients.
        this.sendUpgrade(workspace.context, webSocket, s.binaryMode, s.useCompression)
      }
      webSocket.close()
      this.reconnectIds.delete(s.sessionId)
    }

    if (LOGGING_ENABLED) {
      this.ctx.warn('Clients disconnected. Closing Workspace...', {
        url: workspace.wsId.url,
        uuid: workspace.wsId.uuid
      })
    }

    sessions
      .filter((it) => it[1].socket.id !== ignoreSocket?.id)
      .forEach((s) => {
        closeS(s[1].session, s[1].socket)
      })

    if (reason !== 'upgrade') {
      await workspace.close(this.ctx)
      if (LOGGING_ENABLED) {
        this.ctx.warn('Workspace closed...', { uuid: workspace.wsId.uuid, url: workspace.wsId.url })
      }
    }
  }

  private sendUpgrade (ctx: MeasureContext, webSocket: ConnectionSocket, binary: boolean, compression: boolean): void {
    void webSocket.send(
      ctx,
      {
        result: {
          _class: core.class.TxModelUpgrade
        }
      },
      binary,
      compression
    )
  }

  async closeWorkspaces (ctx: MeasureContext): Promise<void> {
    clearInterval(this.checkInterval)

    for (const w of this.workspaces) {
      await this.doCloseAll(w[1], 1, 'shutdown')
    }
    await this.workspaceProducer.close()
    await this.usersProducer.close()
  }

  private async performWorkspaceCloseCheck (workspace: Workspace): Promise<void> {
    const uuid = workspace.wsId.uuid
    const logParams = { uuid, url: workspace.wsId.url }
    if (workspace.sessions.size === 0) {
      if (LOGGING_ENABLED) {
        this.ctx.warn('no sessions for workspace', logParams)
      }
      try {
        if (workspace.sessions.size === 0) {
          await workspace.close(this.ctx)

          this.workspaces.delete(uuid)
          workspace.context.end()
          if (LOGGING_ENABLED) {
            this.ctx.warn('Closed workspace', logParams)
          }

          await this.workspaceProducer.send(this.ctx, workspace.wsId.uuid, [workspaceEvents.down()])
        }
      } catch (err: any) {
        Analytics.handleError(err)
        this.workspaces.delete(uuid)
        if (LOGGING_ENABLED) {
          this.ctx.error('failed', { ...logParams, error: err })
        }
      }
    } else {
      if (LOGGING_ENABLED) {
        this.ctx.info('few sessions for workspace, close skipped', {
          ...logParams,
          sessions: workspace.sessions.size
        })
      }
    }
  }

  createOpContext (
    ctx: MeasureContext,
    sendCtx: MeasureContext,
    pipeline: Pipeline,
    requestId: Request<any>['id'],
    service: Session,
    ws: ConnectionSocket,
    rateLimit: RateLimitInfo | undefined
  ): ClientSessionCtx {
    const st = platformNow()
    return {
      ctx,
      pipeline,
      requestId,
      sendResponse: (reqId, msg) =>
        sendResponse(sendCtx, service, ws, {
          id: reqId,
          result: msg,
          time: platformNowDiff(st),
          queue: service.requests.size,
          rateLimit
        }),
      sendPong: () => {
        ws.sendPong()
      },
      socialStringsToUsers: this.getActiveSocialStringsToUsersMap(service.workspace.uuid),
      sendError: (reqId, msg, error: Status) =>
        sendResponse(sendCtx, service, ws, {
          id: reqId,
          result: msg,
          error,
          time: platformNowDiff(st),
          rateLimit,
          queue: service.requests.size
        })
    }
  }

  // TODO: cache this map and update when sessions created/closed
  getActiveSocialStringsToUsersMap (
    workspace: WorkspaceUuid,
    ...extra: Session[]
  ): Map<
    PersonId,
    {
      accountUuid: AccountUuid
      role: AccountRole
    }
    > {
    const ws = this.workspaces.get(workspace)
    if (ws === undefined) {
      return new Map()
    }
    const res = new Map<
    PersonId,
    {
      accountUuid: AccountUuid
      role: AccountRole
    }
    >()
    const populate = (s: Session): void => {
      const sessionAccount = s.getUser()
      if (sessionAccount === systemAccountUuid) {
        return
      }
      const role = s.getRawAccount().role
      const userSocialIds = s.getUserSocialIds()
      for (let i = 0; i < userSocialIds.length; i++) {
        res.set(userSocialIds[i], { accountUuid: sessionAccount, role })
      }
    }
    // Iterate Map directly - no intermediate Array.from / map / spread alloc.
    for (const entry of ws.sessions.values()) {
      populate(entry.session)
    }
    for (let i = 0; i < extra.length; i++) {
      populate(extra[i])
    }
    return res
  }

  limitter = new SlidingWindowRateLimitter(
    parseInt(process.env.RATE_LIMIT_MAX ?? '1500'),
    parseInt(process.env.RATE_LIMIT_WINDOW ?? '30000'),
    () => Date.now()
  )

  sysLimitter = new SlidingWindowRateLimitter(
    parseInt(process.env.RATE_LIMIT_MAX ?? '5000'),
    parseInt(process.env.RATE_LIMIT_WINDOW ?? '30000'),
    () => Date.now()
  )

  checkRate (service: Session): RateLimitInfo {
    if (service.getUser() === systemAccountUuid) {
      return this.sysLimitter.checkRateLimit('#sys#' + (service.token.extra?.service ?? '') + service.workspace.uuid)
    }
    return this.limitter.checkRateLimit(service.getUser() + (service.token.extra?.service ?? ''))
  }

  private reportRequestError (ctx: MeasureContext, err: any, opts: { method?: string, request?: unknown }): void {
    if (err instanceof PlatformError && err.status.code !== platform.status.UnknownError) {
      // Forbidden/Unauthorized etc are business outcomes, not faults: count them, don't log a stack.
      ctx.measure('request-rejected', 1, { code: err.status.code, method: opts.method })
      return
    }
    Analytics.handleError(err)
    if (LOGGING_ENABLED) {
      this.ctx.error('error handle request', { error: err, request: opts.request })
    }
  }

  async handleRequest<S extends Session>(
    requestCtx: MeasureContext,
    service: S,
    ws: ConnectionSocket,
    request: Request<any>,
    workspaceId: WorkspaceUuid
  ): Promise<void> {
    // Calculate total number of clients
    const reqId = generateId()
    const source = service.token.extra?.service ?? '🤦‍♂️user'

    const st = Date.now()
    try {
      if (request.time != null) {
        const delta = Date.now() - request.time
        requestCtx.measure('msg-receive-delta', delta)
      }
      const workspace = this.workspaces.get(workspaceId)
      if (workspace === undefined || workspace.closing !== undefined) {
        await ws.send(
          requestCtx,
          {
            id: request.id,
            error: unknownError('Workspace is closing')
          },
          service.binaryMode,
          service.useCompression
        )
        return
      }
      if (request.id === -1 && request.method === 'hello') {
        await requestCtx.with('🧨 handleHello', { source }, (ctx) =>
          this.handleHello<S>(request, service, ctx, workspace, ws, requestCtx)
        )
        return
      }
      if (request.id === -2 && request.method === 'forceClose') {
        // TODO: we chould allow this only for admin or system accounts
        let done = false
        const wsRef = this.workspaces.get(workspaceId)
        if (wsRef?.maintenance ?? false) {
          done = true
          this.ctx.warn('FORCE CLOSE', { workspace: workspaceId })
          // In case of upgrade, we need to force close workspace not in interval handler
          await this.forceClose(workspaceId, ws)
        }
        const forceCloseResponse: Response<any> = {
          id: request.id,
          result: done
        }
        await ws.send(requestCtx, forceCloseResponse, service.binaryMode, service.useCompression)
        return
      }
      let rateLimit: RateLimitInfo | undefined
      if (request.method !== 'ping') {
        rateLimit = this.checkRate(service)
        // If remaining is 0, rate limit is exceeded
        if (rateLimit?.remaining === 0) {
          service.updateLast()
          void ws.send(
            requestCtx,
            {
              id: request.id,
              rateLimit,
              error: unknownError('Rate limit')
            },
            service.binaryMode,
            service.useCompression
          )
          return
        }
      }

      if (request.id === -1 && request.method === '#upgrade') {
        ws.close()
        return
      }
      service.requests.set(reqId, {
        id: reqId,
        params: request,
        start: st
      })

      const f = (service as any)[request.method]
      try {
        const params = [...request.params]

        if (ws.isBackpressure()) {
          await ws.backpressure(requestCtx)
        }

        if (request.method === 'ping') {
          service.lastRequest = Date.now()
          ws.sendPong()
          return
        }
        await this.counters.withCounter('request', 1, () =>
          workspace.with(async (pipeline) => {
            await requestCtx.with(
              '🧨 ' + request.method,
              { source, mode: 'websocket' },
              (callTx) =>
                f.apply(service, [
                  this.createOpContext(callTx, requestCtx, pipeline, request.id, service, ws, rateLimit),
                  ...params
                ]),
              {
                user: service.getUser(),
                socialId: service.getRawAccount().primarySocialId,
                workspace: workspace.wsId.uuid
              },
              { meta: request.meta }
            )
          })
        )
      } catch (err: any) {
        this.reportRequestError(requestCtx, err, { method: request.method, request })
        await ws.send(
          requestCtx,
          {
            id: request.id,
            error: unknownError(err)
          },
          service.binaryMode,
          service.useCompression
        )
      }
    } finally {
      service.requests.delete(reqId)
    }
  }

  async handleRPC<S extends Session>(
    requestCtx: MeasureContext,
    service: S,
    method: string,
    ws: ConnectionSocket,
    operation: (ctx: ClientSessionCtx, rateLimit: RateLimitInfo | undefined) => Promise<void>
  ): Promise<RateLimitInfo | undefined> {
    const rateLimitStatus = this.checkRate(service)
    // If remaining is 0, rate limit is exceeded
    if (rateLimitStatus?.remaining === 0) {
      return await Promise.resolve(rateLimitStatus)
    }

    const source = service.token.extra?.service ?? '🤦‍♂️user'

    // Calculate total number of clients
    const reqId = generateId()

    const st = Date.now()
    try {
      const workspace = this.workspaces.get(service.workspace.uuid)
      if (workspace === undefined || workspace.closing !== undefined) {
        throw new Error('Workspace is closing')
      }

      service.requests.set(reqId, {
        id: reqId,
        params: {},
        start: st
      })

      try {
        await this.counters.withCounter('request', 1, () =>
          workspace.with(async (pipeline) => {
            await requestCtx.with(
              '🧨 ' + method,
              { source, mode: 'rpc' },
              (callTx) =>
                operation(
                  this.createOpContext(callTx, requestCtx, pipeline, reqId, service, ws, rateLimitStatus),
                  rateLimitStatus
                ),
              {
                user: service.getUser(),
                socialId: service.getRawAccount().primarySocialId,
                workspace: workspace.wsId.uuid
              }
            )
          })
        )
      } catch (err: any) {
        this.reportRequestError(requestCtx, err, { method })
        await ws.send(
          requestCtx,
          {
            id: reqId,
            error: unknownError(err)
          },
          service.binaryMode,
          service.useCompression
        )
        throw err
      }
      return undefined
    } finally {
      service.requests.delete(reqId)
    }
  }

  entryToUserStats = (session: Session, socket: ConnectionSocket): UserStatistics => {
    return {
      current: session.current,
      mins5: session.mins5,
      userId: session.getUser(),
      sessionId: socket.id,
      total: session.total,
      // data is an accessor - assigning the function itself loses it on serialization to stats
      data: socket.data()
    }
  }

  workspaceToWorkspaceStats = (ws: Workspace): WorkspaceStatistics => {
    return {
      clientsTotal: new Set(Array.from(ws.sessions.values()).map((it) => it.session.getUser())).size,
      sessionsTotal: ws.sessions.size,
      workspaceName: ws.wsId.url,
      wsId: ws.wsId.uuid,
      sessions: Array.from(ws.sessions.values()).map((it) => this.entryToUserStats(it.session, it.socket))
    }
  }

  getStatistics (): WorkspaceStatistics[] {
    return Array.from(this.workspaces.values()).map((it) => this.workspaceToWorkspaceStats(it))
  }

  private async handleHello<S extends Session>(
    request: Request<any>,
    service: S,
    ctx: MeasureContext<any>,
    workspace: Workspace,
    ws: ConnectionSocket,
    requestCtx: MeasureContext<any>
  ): Promise<void> {
    try {
      const hello = request as HelloRequest
      service.binaryMode = hello.binary ?? false
      service.useCompression = this.enableCompression ? (hello.compression ?? false) : false

      if (LOGGING_ENABLED) {
        ctx.info('hello happen', {
          workspace: workspace.wsId.url,
          workspaceId: workspace.wsId.uuid,
          userId: service.getUser(),
          user: service.getSocialIds().find((it) => it.type !== SocialIdType.HULY)?.value,
          binary: service.binaryMode,
          compression: service.useCompression,
          timeToHello: Date.now() - service.createTime,
          workspaceUsers: workspace.sessions.size,
          totalUsers: this.sessions.size
        })
      }
      const reconnect = this.reconnectIds.has(service.sessionId)
      if (reconnect) {
        this.reconnectIds.delete(service.sessionId)
      }

      const account = service.getRawAccount()
      await workspace.with(async (pipeline) => {
        const helloResponse: HelloResponse = {
          id: -1,
          result: 'hello',
          binary: service.binaryMode,
          reconnect,
          serverVersion: this.serverVersion,
          lastTx: pipeline.context.lastTx,
          lastHash: pipeline.context.lastHash,
          account,
          useCompression: service.useCompression
        }
        await ws.send(ctx, helloResponse, false, false)
      })
      if (account.uuid !== guestAccount && account.uuid !== systemAccountUuid) {
        // Batched + broadcast once per second (see queueStatus).
        this.queueStatus(service.workspace.uuid, service, true)
      }
    } catch (err: any) {
      ctx.error('error', { err })
    }
  }
}

export function createSessionManager (
  ctx: MeasureContext,
  brandingMap: BrandingMap,
  timeouts: Timeouts,
  profiling:
  | {
    start: () => void
    stop: () => Promise<string | undefined>
  }
  | undefined,
  accountsUrl: string,
  enableCompression: boolean,
  doHandleTick: boolean = true,
  queue: PlatformQueue,
  pipelineFactory: PipelineFactory
): SessionManager {
  return new TSessionManager(
    ctx,
    timeouts,
    brandingMap ?? null,
    profiling,
    accountsUrl,
    enableCompression,
    doHandleTick,
    queue,
    pipelineFactory
  )
}

export interface SessionManagerOptions extends Partial<Timeouts> {
  pipelineFactory: PipelineFactory
  brandingMap: BrandingMap
  enableCompression?: boolean
  accountsUrl: string
  profiling?: {
    start: () => void
    stop: () => Promise<string | undefined>
  }
  queue: PlatformQueue
}

/**
 * @public
 */
export function startSessionManager (ctx: MeasureContext, opt: SessionManagerOptions): SessionManager {
  const sessions = createSessionManager(
    ctx,
    opt.brandingMap,
    {
      pingTimeout: opt.pingTimeout ?? 10000,
      reconnectTimeout: 30 // seconds to reconnect
    },
    opt.profiling,
    opt.accountsUrl,
    opt.enableCompression ?? false,
    true,
    opt.queue,
    opt.pipelineFactory
  )
  return sessions
}

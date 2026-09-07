/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

import { MeasureContext, Ref, WorkspaceUuid } from '@hcengineering/core'
import { Person } from '@hcengineering/contact'
import { MeetingMinutes, parseRoomName } from '@hcengineering/love'
import { PlatformQueueProducer } from '@hcengineering/server-core'
import {
  EgressClient,
  type EgressInfo,
  RoomServiceClient,
  ParticipantInfo as LiveKitParticipant,
  Room
} from 'livekit-server-sdk'
import { WorkspaceClient } from './workspaceClient'
import { parseMetadata, parseParticipantMetadata, updateMetadata } from './utils'
import { type BillingMessage } from './queue'

/**
 * Configuration for the polling service
 */
export interface PollingConfig {
  /** Polling interval in milliseconds */
  intervalMs: number
  /** LiveKit project key used in room metadata */
  projectKey: string
  /** How long an office may stay open after its owner disappeared, so a refresh does not end the meeting. */
  ownerRejoinGraceMs: number
}

/** Per-participant meeting-minutes billing progress, tracked to send only the un-sent delta each poll. */
interface ParticipantBillingProgress {
  joinedAtMs: number
  sentSeconds: number
}

/**
 * Tracks the state of a LiveKit room for reconciliation
 */
interface RoomState {
  roomName: string
  workspace: WorkspaceUuid
  meetingId: Ref<MeetingMinutes>
  participants: Map<string, LiveKitParticipant>
  lastUpdated: number
  sentByParticipant: Map<string, ParticipantBillingProgress>
  /** Office owner of the room; `null` when it is not an office, `undefined` until resolved. */
  officeOwner?: Ref<Person> | null
}

/** Periodically polls LiveKit to reconcile room/participant state with the platform database. */
export class LiveKitPollingService {
  private readonly ctx: MeasureContext
  private readonly roomClient: RoomServiceClient
  private readonly config: PollingConfig
  private intervalHandle: NodeJS.Timeout | null = null
  /** Consecutive polls that found no rooms of ours. */
  private idleCycles = 0
  /** Earliest moment an owner grace expires; the next poll is pulled forward to meet it. */
  private nextGraceDeadline = Number.POSITIVE_INFINITY
  /** A cycle is in flight - `wakeUp` must not start a second one over the same rooms. */
  private polling = false
  private static readonly IDLE_CYCLES_BEFORE_BACKOFF = 3
  private static readonly IDLE_INTERVAL_MS = 60000
  private isRunning = false
  private readonly roomStates = new Map<string, RoomState>()

  private readonly workspacesToCheck = new Set<WorkspaceUuid>()
  // Unlike workspacesToCheck (cleared each cycle), this persists — outage drain needs the full history.
  private readonly knownWorkspaces = new Set<WorkspaceUuid>()
  private readonly lastCleanupTime = new Map<WorkspaceUuid, number>()
  private static readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
  /** An egress younger than this may simply be between the egress call and the row update. */
  private static readonly ORPHAN_EGRESS_GRACE_MS = 60_000

  // Draining finishes every meeting of every workspace, so the bar is high: a LiveKit
  // restart or a network blip must not clear the whole installation.
  private static readonly LIVEKIT_OUTAGE_MS = 5 * 60 * 1000
  private static readonly LIVEKIT_OUTAGE_FAILURES = 5
  private livekitFailureSince: number | null = null
  private livekitFailures = 0
  private livekitDrainedAt: number | null = null

  constructor (
    ctx: MeasureContext,
    roomClient: RoomServiceClient,
    config: PollingConfig,
    private readonly billingProducer?: PlatformQueueProducer<BillingMessage>,
    private readonly egressClient?: EgressClient
  ) {
    this.ctx = ctx
    this.roomClient = roomClient
    this.config = config
  }

  addWorkspaceToCheck (workspace: WorkspaceUuid): void {
    this.workspacesToCheck.add(workspace)
    this.knownWorkspaces.add(workspace)
  }

  /**
   * Check if cleanup should be run for a workspace (at most once per hour)
   */
  private shouldRunCleanup (workspace: WorkspaceUuid): boolean {
    const lastCleanup = this.lastCleanupTime.get(workspace)
    const now = Date.now()
    if (lastCleanup === undefined || now - lastCleanup >= LiveKitPollingService.CLEANUP_INTERVAL_MS) {
      this.lastCleanupTime.set(workspace, now)
      return true
    }
    return false
  }

  /**
   * Start the polling service
   */
  start (): void {
    if (this.isRunning) {
      this.ctx.warn('[PollingService] Already running, ignoring start()')
      return
    }

    this.isRunning = true
    this.ctx.info('[PollingService] Starting polling service', {
      intervalMs: this.config.intervalMs,
      projectKey: this.config.projectKey
    })

    // Run immediately on start
    void this.runCycle()
  }

  /** Poll, then schedule the next cycle - the delay depends on whether anything is live. */
  private async runCycle (): Promise<void> {
    if (!this.isRunning || this.polling) return
    this.polling = true
    try {
      await this.poll()
    } finally {
      this.polling = false
      this.scheduleNext()
    }
  }

  private scheduleNext (): void {
    if (!this.isRunning) return
    if (this.intervalHandle !== null) {
      clearTimeout(this.intervalHandle)
    }
    const delay =
      this.idleCycles >= LiveKitPollingService.IDLE_CYCLES_BEFORE_BACKOFF
        ? Math.max(this.config.intervalMs, LiveKitPollingService.IDLE_INTERVAL_MS)
        : this.config.intervalMs
    // A grace running out between two polls would leave the room open for another whole interval.
    const wake = Math.max(1000, Math.min(delay, this.nextGraceDeadline - Date.now()))
    this.nextGraceDeadline = Number.POSITIVE_INFINITY
    this.intervalHandle = setTimeout(() => {
      void this.runCycle()
    }, wake)
  }

  /** A webhook means the stand is not idle: drop the back-off and poll right away. */
  wakeUp (): void {
    if (!this.isRunning) return
    if (this.idleCycles === 0) return
    this.idleCycles = 0
    this.ctx.info('[PollingService] Activity detected, resuming the base interval')
    // scheduleNext() clears the pending timer; a stray one is absorbed by `polling`.
    void this.runCycle()
  }

  /**
   * Stop the polling service
   */
  stop (): void {
    if (!this.isRunning) {
      return
    }

    this.isRunning = false
    if (this.intervalHandle !== null) {
      clearTimeout(this.intervalHandle)
      this.intervalHandle = null
    }
    this.ctx.info('[PollingService] Stopped polling service')
  }

  private async getOurRooms (): Promise<Room[]> {
    // Get all active rooms from LiveKit
    const rooms = await this.roomClient.listRooms()

    // Filter rooms that belong to our project
    return rooms.filter((room) => {
      try {
        const metadata = room.metadata !== undefined && room.metadata !== '' ? JSON.parse(room.metadata) : {}
        return metadata.projectKey === this.config.projectKey
      } catch {
        return false
      }
    })
  }

  /** Force-finish all Active/Pending meetings across known workspaces during a LiveKit outage. */
  private async drainAllActiveMeetings (): Promise<void> {
    const targets = Array.from(this.knownWorkspaces)
    if (targets.length === 0) return
    this.ctx.warn('[PollingService] LiveKit outage: finishing all active meetings', {
      workspaces: targets.length
    })
    for (const workspace of targets) {
      try {
        const wsClient = await WorkspaceClient.create(workspace, this.ctx)
        // Empty exclusion list -> every Active/Pending meeting is finished.
        await wsClient.checkUnfinishedMeetings([])
      } catch (err: any) {
        this.ctx.error('[PollingService] Failed to drain meetings during outage', {
          workspace,
          error: err?.message ?? String(err)
        })
      }
    }
  }

  /**
   * Main polling loop - fetches all rooms and reconciles state
   */
  private async poll (): Promise<void> {
    if (!this.isRunning) return

    try {
      this.ctx.info('[PollingService] Starting poll cycle')

      let ourRooms: Room[]
      try {
        ourRooms = await this.getOurRooms()
        // Healthy fetch -> reset outage tracker.
        if (this.livekitFailureSince !== null) {
          this.ctx.info('[PollingService] LiveKit reachable again')
          this.livekitFailureSince = null
          this.livekitFailures = 0
          this.livekitDrainedAt = null
        }
      } catch (err: any) {
        const now = Date.now()
        if (this.livekitFailureSince === null) {
          this.livekitFailureSince = now
        }
        this.livekitFailures++
        const outageMs = now - this.livekitFailureSince
        this.ctx.error('[PollingService] LiveKit listRooms failed', {
          error: err?.message ?? String(err),
          outageMs,
          failures: this.livekitFailures
        })
        // Both bars must be cleared: elapsed time alone would fire on two failures spaced
        // far apart, a failure count alone would fire on a burst inside one second.
        const outageConfirmed =
          outageMs >= LiveKitPollingService.LIVEKIT_OUTAGE_MS &&
          this.livekitFailures >= LiveKitPollingService.LIVEKIT_OUTAGE_FAILURES
        // Drain once per outage so the cleanup is idempotent and doesn't
        // hammer the database every 30s while LiveKit stays down.
        if (outageConfirmed && this.livekitDrainedAt === null) {
          this.livekitDrainedAt = now
          await this.drainAllActiveMeetings()
        }
        return
      }

      // An empty stand does not need to be polled every few seconds; back off until a
      // webhook or a room shows up again.
      this.idleCycles = ourRooms.length === 0 ? this.idleCycles + 1 : 0

      // Track every workspace seen, since processRoom() only covers workspaces with a current LiveKit room.
      for (const room of ourRooms) {
        const parsed = parseRoomName(room.name ?? '')
        if (parsed !== undefined) this.knownWorkspaces.add(parsed.workspace)
      }

      // Process each room
      for (const room of ourRooms) {
        try {
          await this.processRoom(room)
        } catch (err: any) {
          this.ctx.error('[PollingService] Error processing room', {
            roomName: room.name,
            error: err?.message ?? String(err)
          })
        }
      }

      await this.stopOrphanEgresses()

      // We need to check workspaces added to check for un finished meetings.
      const wtc = Array.from(this.workspacesToCheck)
      this.workspacesToCheck.clear()
      for (const workspace of wtc) {
        try {
          const wsClient = await WorkspaceClient.create(workspace, this.ctx)
          await wsClient.checkUnfinishedMeetings(
            ourRooms
              .map((it) => parseRoomName(it.name))
              .filter((it) => it?.workspace === workspace)
              .map((it) => it?.meetingId)
              .filter((it) => it != null)
          )
          // Also clean up orphaned ParticipantInfo entries for finished meetings (at most once per hour)
          if (this.shouldRunCleanup(workspace)) {
            await wsClient.cleanupOrphanedParticipantInfos()
            // Clean up orphaned PendingRecording entries for finished meetings
            await wsClient.cleanupOrphanedPendingRecordings()
          }
        } catch (err: any) {
          this.ctx.error('[PollingService] Error checking unfinished meetings', {
            workspace,
            error: err?.message ?? String(err)
          })
        }
      }

      // Clean up state for rooms that no longer exist
      await this.cleanupStaleRoomStates(ourRooms)
    } catch (err: any) {
      this.ctx.error('[PollingService] Error during poll', {
        error: err?.message ?? String(err)
      })
    }
  }

  /**
   * Process a single room - reconcile participants and pending joins
   */
  private async processRoom (room: Room): Promise<void> {
    const roomName = room.name
    if (roomName === undefined || roomName === '') return

    // Parse room name to extract workspace and meeting ID
    const parsed = parseRoomName(roomName)
    if (parsed === undefined) {
      this.ctx.warn('[PollingService] Could not parse room name', { roomName })
      return
    }

    const { workspace, meetingId } = parsed

    // Get participants from LiveKit
    const participants = await this.roomClient.listParticipants(roomName)

    // Get previous state (if any)
    const previousState = this.roomStates.get(roomName)
    const previousParticipants = previousState?.participants ?? new Map()

    // Build current participant map (exclude agents) for join/leave detection
    const currentParticipants = new Map<string, LiveKitParticipant>()
    // Build all participants map (including agents) for database reconciliation
    const allParticipants = new Map<string, LiveKitParticipant>()
    for (const p of participants) {
      if (p.identity !== undefined && p.identity !== '') {
        allParticipants.set(p.identity, p)
        // Skip agent participants (AI bots) for join/leave detection only
        if (p.permission?.agent !== true && p.kind !== 4) {
          currentParticipants.set(p.identity, p)
        }
      }
    }

    const sentByParticipant = previousState?.sentByParticipant ?? new Map<string, ParticipantBillingProgress>()

    // Update state
    const state: RoomState = {
      roomName,
      workspace,
      meetingId,
      participants: currentParticipants,
      lastUpdated: Date.now(),
      sentByParticipant,
      officeOwner: previousState?.officeOwner
    }
    this.roomStates.set(roomName, state)

    await this.closeRoomIfOwnerGone(room, state, currentParticipants)
    await this.closeRoomIfAgentsOnly(room, state, currentParticipants, allParticipants)

    // Bill the un-sent meeting-minutes delta for every real (non-agent) participant still in the room.
    await this.trackMeetingMinutesBilling(workspace, roomName, currentParticipants, sentByParticipant)

    // Reconcile with database (compare DB state with LiveKit state, not just in-memory cache)
    // Use allParticipants (including agents) to avoid removing AI bot ParticipantInfo entries
    await this.reconcileParticipantsWithDatabase(workspace, meetingId, allParticipants)

    // Also reconcile in-memory cache for detecting joins (backwards compatibility)
    await this.reconcileParticipants(workspace, meetingId, previousParticipants, currentParticipants)
  }

  // The webhook only stamps `ownerLeftAt`: a refresh arrives as a normal leave, and a delay kept in
  // one replica's memory would die with it. The stamp lives in LiveKit, so every replica agrees.
  private async closeRoomIfOwnerGone (
    room: Room,
    state: RoomState,
    present: Map<string, LiveKitParticipant>
  ): Promise<void> {
    const ownerLeftAt = parseMetadata(room.metadata).ownerLeftAt
    if (ownerLeftAt === undefined) return

    if (state.officeOwner === undefined) {
      state.officeOwner = await this.resolveOfficeOwner(state.workspace, state.meetingId)
    }
    // `undefined` - lookup failed, retry next poll; `null` - not an office, the stamp is not ours.
    const owner = state.officeOwner
    if (owner == null) return

    // Back in the room - the leave was a refresh after all.
    if (present.has(owner)) {
      await updateMetadata(this.ctx, this.roomClient, state.roomName, { ownerLeftAt: undefined })
      return
    }
    // Nobody left to evict; LiveKit drops an empty room on its own.
    if (present.size === 0) return

    const missingMs = Date.now() - ownerLeftAt
    if (missingMs < this.config.ownerRejoinGraceMs) {
      const deadline = ownerLeftAt + this.config.ownerRejoinGraceMs
      this.nextGraceDeadline = Math.min(this.nextGraceDeadline, deadline)
      return
    }

    try {
      await this.roomClient.deleteRoom(state.roomName)
      this.ctx.info('[PollingService] Office owner gone past the grace, closed the room', {
        meetingId: state.meetingId,
        owner,
        missingMs
      })
      this.roomStates.delete(state.roomName)
    } catch (err: any) {
      this.ctx.warn('[PollingService] Failed to close the room after the owner left', {
        roomName: state.roomName,
        error: err?.message ?? String(err)
      })
    }
  }

  // Safety net, not the primary path: LiveKit 1.13.6 closes an agent-only room on its own
  // `departureTimeout`, but if a deployment ever keeps such a room alive, `room_finished` never
  // arrives and the meeting stays Active. Same stamp-in-metadata scheme as `ownerLeftAt`, so
  // replicas share the clock. See docs/memory/love_one_person_two_meetings.md.
  private async closeRoomIfAgentsOnly (
    room: Room,
    state: RoomState,
    humans: Map<string, LiveKitParticipant>,
    all: Map<string, LiveKitParticipant>
  ): Promise<void> {
    // Nobody at all - LiveKit drops an empty room on its own.
    if (all.size === 0) return

    const humansLeftAt = parseMetadata(room.metadata).humansLeftAt

    if (humans.size > 0) {
      if (humansLeftAt !== undefined) {
        await updateMetadata(this.ctx, this.roomClient, state.roomName, { humansLeftAt: undefined })
      }
      return
    }

    // A room is created by `/getToken`, and the agent is dispatched into it before the joiner's
    // WebSocket is up (that connect allows 20s). Stamping right away would race the very first
    // join, so leave a fresh room alone for one grace period.
    const createdMs = Number(room.creationTime ?? 0) * 1000
    if (createdMs > 0 && Date.now() - createdMs < this.config.ownerRejoinGraceMs) {
      this.nextGraceDeadline = Math.min(this.nextGraceDeadline, createdMs + this.config.ownerRejoinGraceMs)
      return
    }

    if (humansLeftAt === undefined) {
      await updateMetadata(this.ctx, this.roomClient, state.roomName, { humansLeftAt: Date.now() })
      this.nextGraceDeadline = Math.min(this.nextGraceDeadline, Date.now() + this.config.ownerRejoinGraceMs)
      return
    }

    const missingMs = Date.now() - humansLeftAt
    if (missingMs < this.config.ownerRejoinGraceMs) {
      this.nextGraceDeadline = Math.min(this.nextGraceDeadline, humansLeftAt + this.config.ownerRejoinGraceMs)
      return
    }

    try {
      await this.roomClient.deleteRoom(state.roomName)
      this.ctx.info('[PollingService] Only agents left past the grace, closed the room', {
        meetingId: state.meetingId,
        missingMs
      })
      this.roomStates.delete(state.roomName)
    } catch (err: any) {
      this.ctx.warn('[PollingService] Failed to close the agent-only room', {
        roomName: state.roomName,
        error: err?.message ?? String(err)
      })
    }
  }

  /**
   * An egress nobody tracks keeps burning CPU and writing to storage: it happens when the start
   * call times out after LiveKit already accepted it, so the reservation is dropped on our side.
   */
  private async stopOrphanEgresses (): Promise<void> {
    if (this.egressClient === undefined) return
    let active: EgressInfo[]
    try {
      active = await this.egressClient.listEgress({ active: true })
    } catch (err: any) {
      this.ctx.warn('[PollingService] Failed to list active egresses', { error: err?.message ?? String(err) })
      return
    }

    const grace = LiveKitPollingService.ORPHAN_EGRESS_GRACE_MS
    for (const info of active) {
      const parsed = parseRoomName(info.roomName ?? '')
      if (parsed === undefined) continue
      const startedAtMs = Number(info.startedAt) / 1_000_000
      if (startedAtMs <= 0 || Date.now() - startedAtMs < grace) continue

      // One unreachable workspace must not stop the sweep, and a failed lookup must not read as
      // "nothing tracks this egress" - that would kill a live recording.
      try {
        const wsClient = await WorkspaceClient.create(parsed.workspace, this.ctx)
        const tracked = await wsClient.findPendingRecordingsByMeeting(parsed.meetingId)
        // A row still waiting for its egressId belongs to a start that is under way.
        const claimed = tracked.some(
          (it) => it.egressId === info.egressId || (it.egressId === undefined && Date.now() - it.startedAt < grace)
        )
        if (claimed) continue

        this.ctx.warn('[PollingService] Stopping an egress no PendingRecording tracks', {
          egressId: info.egressId,
          roomName: info.roomName,
          meetingId: parsed.meetingId
        })
        await this.egressClient.stopEgress(info.egressId)
      } catch (err: any) {
        this.ctx.warn('[PollingService] Failed to reconcile an active egress', {
          egressId: info.egressId,
          roomName: info.roomName,
          error: err?.message ?? String(err)
        })
      }
    }
  }

  /** `null` when the room is not an office; `undefined` on a lookup failure, so the next poll retries. */
  private async resolveOfficeOwner (
    workspace: WorkspaceUuid,
    meetingId: Ref<MeetingMinutes>
  ): Promise<Ref<Person> | null | undefined> {
    try {
      const wsClient = await WorkspaceClient.create(workspace, this.ctx)
      const meeting = await wsClient.findMeetingById(meetingId)
      if (meeting?.roomId == null) return null
      return (await wsClient.findOfficeOwner(meeting.roomId)) ?? null
    } catch (err: any) {
      this.ctx.warn('[PollingService] Failed to resolve the office owner', {
        meetingId,
        error: err?.message ?? String(err)
      })
      return undefined
    }
  }

  /** Sends the un-sent meeting-minutes delta (in seconds) for each currently-joined participant. */
  private async trackMeetingMinutesBilling (
    workspace: WorkspaceUuid,
    roomName: string,
    currentParticipants: Map<string, LiveKitParticipant>,
    sentByParticipant: Map<string, ParticipantBillingProgress>
  ): Promise<void> {
    if (this.billingProducer === undefined) return

    for (const participant of currentParticipants.values()) {
      const sid = participant.sid
      if (sid === undefined || sid === '') continue

      const joinedAtRaw = Number(participant.joinedAt ?? participant.joinedAtMs ?? 0)
      if (joinedAtRaw <= 0) continue
      const joinedAtMs = joinedAtRaw > 1e12 ? joinedAtRaw : joinedAtRaw * 1000

      const progress = sentByParticipant.get(sid) ?? { joinedAtMs, sentSeconds: 0 }
      const elapsedSec = Math.floor((Date.now() - joinedAtMs) / 1000)
      const newSec = elapsedSec - progress.sentSeconds
      if (newSec <= 0) {
        sentByParticipant.set(sid, progress)
        continue
      }

      const newSentTotal = progress.sentSeconds + newSec
      try {
        await this.billingProducer.send(this.ctx, workspace, [
          {
            kind: 'usage',
            workspace,
            metric: 'meetingMinutes',
            amount: newSec,
            ref: `meetingMinutes-${roomName}-${sid}-${newSentTotal}`
          }
        ])
        sentByParticipant.set(sid, { joinedAtMs, sentSeconds: newSentTotal })
      } catch (err: any) {
        this.ctx.error('[PollingService] Failed to send meeting-minutes usage delta', {
          workspace,
          roomName,
          sid,
          error: err?.message ?? String(err)
        })
      }
    }

    // Drop those who left: their time is already billed up to the last poll, and keeping them
    // would make the final flush bill Date.now() - joinedAt, i.e. time after they disconnected.
    const presentSids = new Set<string>()
    for (const participant of currentParticipants.values()) {
      if (participant.sid !== undefined && participant.sid !== '') presentSids.add(participant.sid)
    }
    for (const sid of sentByParticipant.keys()) {
      if (!presentSids.has(sid)) sentByParticipant.delete(sid)
    }
  }

  /** Removes ParticipantInfo entries not present in LiveKit; allParticipants must include agents/bots to avoid removing them. */
  private async reconcileParticipantsWithDatabase (
    workspace: WorkspaceUuid,
    meetingId: Ref<MeetingMinutes>,
    allParticipants: Map<string, LiveKitParticipant>
  ): Promise<void> {
    try {
      const wsClient = await WorkspaceClient.create(workspace, this.ctx)

      // Get all ParticipantInfo from database for this meeting
      const dbParticipants = await wsClient.findParticipantInfosByMeeting(meetingId)

      // Build set of identities currently in LiveKit (including agents)
      const liveKitIdentities = new Set(allParticipants.keys())
      const liveKitSids = new Set([...allParticipants.values()].map((it) => it.sid))

      // Find ParticipantInfo entries not present in LiveKit and remove them
      for (const dbParticipant of dbParticipants) {
        // Check if this participant's person is in LiveKit
        const personId = dbParticipant.person
        if (personId !== undefined && personId !== null) {
          const identityStr = personId as string
          const liveKitParticipant = allParticipants.get(identityStr)

          // Skip agents (AI bots) - they are managed by ai-bot service and may reconnect
          if (liveKitParticipant?.kind === 4 || liveKitParticipant?.permission?.agent === true) {
            continue
          }

          // A row keyed to a dead sid is a ghost seat: participant_left was lost while
          // the same person rejoined under a new sid. Agent rows carry sessionId === null.
          const sid = dbParticipant.sessionId
          if (sid != null && sid !== '' && !liveKitSids.has(sid)) {
            this.ctx.info('[PollingService] Removing ParticipantInfo with stale sessionId', {
              workspace,
              meetingId,
              participantInfoId: dbParticipant._id,
              person: personId,
              sessionId: sid
            })
            await wsClient.removeParticipantInfoById(dbParticipant._id)
            continue
          }

          if (!liveKitIdentities.has(identityStr)) {
            this.ctx.info('[PollingService] Removing stale ParticipantInfo (not in LiveKit)', {
              workspace,
              meetingId,
              participantInfoId: dbParticipant._id,
              person: personId,
              name: dbParticipant.name
            })
            await wsClient.removeParticipantInfoById(dbParticipant._id)
          }
        }
      }
    } catch (err: any) {
      this.ctx.error('[PollingService] Error reconciling participants with database', {
        workspace,
        meetingId,
        error: err?.message ?? String(err)
      })
    }
  }

  /**
   * Reconcile in-memory cache state with LiveKit state (for detecting new joins)
   */
  private async reconcileParticipants (
    workspace: WorkspaceUuid,
    meetingId: Ref<MeetingMinutes>,
    previousParticipants: Map<string, LiveKitParticipant>,
    currentParticipants: Map<string, LiveKitParticipant>
  ): Promise<void> {
    try {
      const wsClient = await WorkspaceClient.create(workspace, this.ctx)

      // Preload existing ParticipantInfo (by person id and name) to catch a stale in-memory cache.
      const existingParticipantInfos = await wsClient.findParticipantInfosByMeeting(meetingId)
      const existingPersonIds = new Set(existingParticipantInfos.map((it) => String(it.person)))

      // Driven by the database, not the cache: a workspace-session restart wipes the rows while the
      // cache still lists everyone, so a cache-based check would never notice the seats are gone.
      for (const [identity, participant] of currentParticipants) {
        if (participant?.kind !== 0) {
          continue // Skip agents
        }
        if (existingPersonIds.has(identity)) continue

        this.ctx.info('[PollingService] Detected missed participant_joined', {
          workspace,
          meetingId,
          identity,
          name: participant.name
        })

        // Try to resolve person from identity (may be undefined for guest identities)
        const personRef = await wsClient.findPersonRefById(identity as Ref<Person>)

        // A guest joins under an identity that is not their person ref, so the row can exist anyway.
        if (personRef != null && existingPersonIds.has(String(personRef))) continue

        if (personRef !== undefined) {
          // Upsert ParticipantInfo
          await wsClient.upsertParticipantFromLiveKit(
            personRef,
            participant.name ?? participant.identity ?? 'Unknown',
            null,
            meetingId,
            participant.sid,
            parseParticipantMetadata(participant.metadata)
          )
        }
      }

      // Find participants who left (in previous but not in current)
      for (const [identity, participant] of previousParticipants) {
        if (participant?.kind !== 0) {
          continue // Skip agents
        }
        if (!currentParticipants.has(identity)) {
          this.ctx.info('[PollingService] Detected missed participant_left', {
            workspace,
            meetingId,
            identity,
            name: participant.name
          })

          // Try to resolve person from identity
          const personRef = await wsClient.findPersonRefById(identity as Ref<Person>)

          // Remove ParticipantInfo
          if (personRef !== undefined) {
            await wsClient.removeParticipantFromLiveKit(meetingId, personRef, participant.sid)
          }
        }
      }
    } catch (err: any) {
      this.ctx.error('[PollingService] Error reconciling participants', {
        workspace,
        meetingId,
        error: err?.message ?? String(err)
      })
    }
  }

  /**
   * Clean up state for rooms that no longer exist in LiveKit
   */
  private async cleanupStaleRoomStates (activeRooms: Room[]): Promise<void> {
    const activeRoomNames = new Set(activeRooms.map((r) => r.name).filter(Boolean))

    for (const [roomName, state] of this.roomStates) {
      if (!activeRoomNames.has(roomName)) {
        this.ctx.info('[PollingService] Room no longer exists, cleaning up state', {
          roomName,
          workspace: state.workspace,
          meetingId: state.meetingId
        })

        // Flush the final un-sent meeting-minutes remainder for participants still tracked at cleanup time.
        await this.flushFinalMeetingMinutesBilling(state)

        // Room ended - ensure meeting is marked as finished and pending joins are cleaned up
        try {
          const wsClient = await WorkspaceClient.create(state.workspace, this.ctx)
          await wsClient.finishMeeting(state.meetingId, Date.now())
        } catch (err: any) {
          this.ctx.error('[PollingService] Error finishing meeting for closed room', {
            roomName,
            error: err?.message ?? String(err)
          })
        }

        this.roomStates.delete(roomName)
      }
    }
  }

  /** Sends the final remainder for participants still present at cleanup time; those who left are already dropped. */
  private async flushFinalMeetingMinutesBilling (state: RoomState): Promise<void> {
    if (this.billingProducer === undefined) return

    for (const [sid, progress] of state.sentByParticipant) {
      const finalSec = Math.floor((Date.now() - progress.joinedAtMs) / 1000) - progress.sentSeconds
      if (finalSec <= 0) continue

      const newSentTotal = progress.sentSeconds + finalSec
      try {
        await this.billingProducer.send(this.ctx, state.workspace, [
          {
            kind: 'usage',
            workspace: state.workspace,
            metric: 'meetingMinutes',
            amount: finalSec,
            ref: `meetingMinutes-${state.roomName}-${sid}-${newSentTotal}`
          }
        ])
      } catch (err: any) {
        this.ctx.error('[PollingService] Failed to send final meeting-minutes usage delta', {
          workspace: state.workspace,
          roomName: state.roomName,
          sid,
          error: err?.message ?? String(err)
        })
      }
    }
  }
}

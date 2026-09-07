import { AccountRole, generateId, getCurrentAccount, type Ref, type Space, type AccountUuid } from '@hcengineering/core'
import love, {
  MeetingStatus,
  TranscriptionState,
  RecordingState,
  type Room,
  RoomType,
  isOffice,
  isScheduledJoinable,
  type MeetingMinutes
} from '@hcengineering/love'
import presentation, { getClient, onClient } from '@hcengineering/presentation'
import {
  getLiveKitEndpoint,
  getRoomName,
  liveKitClient,
  loveClient,
  navigateToMeetingMinutes,
  navigateToOfficeDoc
} from './utils'
import { get, writable } from 'svelte/store'
import { LoveServiceError } from './loveClient'
import {
  infos,
  rooms,
  myConnectingSessionId,
  meetings,
  currentMeetingMinutes,
  waitForOfficeLoaded,
  withConnectingToMeeting
} from './stores'
import { getCurrentEmployee, type Person } from '@hcengineering/contact'
import { getPersonByPersonRef } from '@hcengineering/contact-resources'
import { getMetadata } from '@hcengineering/platform'
import { sendInvites } from './invites'
import { lkIsConnecting, lkSessionConnected, lkSessionEnded } from './liveKitClient'
import { findOtherLiveSession } from './otherSession'

export let currentMeetingRoom: Ref<Room> | undefined
export let currentMeeting: Ref<MeetingMinutes> | undefined

// True while the auto-reconnect routine (post page-refresh) is trying to
// take the LiveKit seat back. UI can show a banner / spinner.
export const reconnectingToMeeting = writable<boolean>(false)

// Survives a refresh: a reload can outrun the LK departureTimeout, so the server-side
// ParticipantInfo may already be gone by the time we come back.
const ACTIVE_MEETING_STORAGE_KEY = 'love.activeMeeting'
function rememberActiveMeeting (id: Ref<MeetingMinutes>): void {
  try {
    sessionStorage.setItem(ACTIVE_MEETING_STORAGE_KEY, id)
  } catch {}
}
function forgetActiveMeeting (): void {
  try {
    sessionStorage.removeItem(ACTIVE_MEETING_STORAGE_KEY)
  } catch {}
}
export function recallActiveMeeting (): Ref<MeetingMinutes> | undefined {
  try {
    return (sessionStorage.getItem(ACTIVE_MEETING_STORAGE_KEY) as Ref<MeetingMinutes>) ?? undefined
  } catch {
    return undefined
  }
}

// Every branch reports why: a bare `undefined` left the caller unable to tell "nothing to do"
// from "you need to knock", so Connect silently did nothing.
export type CreateMeetingOutcome = { meeting: MeetingMinutes } | { refused: 'invite-sent' | 'room-occupied' }

export async function createMeeting (room: Room, meeting?: MeetingMinutes): Promise<CreateMeetingOutcome> {
  return await withConnectingToMeeting(async () => {
    const me = getCurrentEmployee()
    const currentPerson = await getPersonByPersonRef(me)

    if (isOffice(room) && room.person != null && room.person !== currentPerson?._id) {
      await sendInvites([room.person])
      return { refused: 'invite-sent' }
    }

    // Explicit meeting (e.g. invite flow) -> join it directly.
    if (meeting !== undefined) {
      await joinMeeting(meeting)
      return { meeting }
    }

    // Participants but no meeting we can see: a private meeting is running, knock instead.
    const roomParticipants = get(infos).filter((p) => p.room === room._id)
    if (roomParticipants.length > 0) {
      return { refused: 'room-occupied' }
    }

    // Atomic server-side get-or-create: notMatch runs against fresh server data, so a stale
    // local cache showing a just-finished meeting as Active can't make us re-join a dead one.
    const { meeting: mm, created } = await createMeetingDocument(room)
    if (created) {
      await connectToMeeting(mm, room)
    } else {
      await joinMeeting(mm)
    }
    return { meeting: mm }
  })
}

// Blocks the reconnect watcher between `disconnect()` and the server removing our
// ParticipantInfo - otherwise the stale row races us back into the room.
let leavingMeeting = false

export async function leaveMeeting (): Promise<void> {
  // If we're still in the process of connecting, don't disconnect
  if (get(lkIsConnecting)) {
    return
  }

  // Guard first: the disconnect handler wakes the reconnect watcher, which would
  // re-enter `connectToMeeting` on the still-live ParticipantInfo.
  leavingMeeting = true
  forgetActiveMeeting()
  try {
    // The `participant_left` webhook removes our ParticipantInfo server-side;
    // clients must NOT delete those documents directly.
    await liveKitClient.disconnect()
    currentMeeting = undefined
    currentMeetingRoom = undefined
  } finally {
    leavingMeeting = false
  }
}

export async function joinMeeting (meeting: MeetingMinutes): Promise<void> {
  await withConnectingToMeeting(async () => {
    if (meeting.roomId == null) return
    const room = getRoomById(meeting.roomId)
    const me = getCurrentAccount()
    const isWorkspaceOwner = me.role === AccountRole.Owner

    if (meeting.private && !meeting.members.includes(me.uuid)) {
      // SpaceSecurityMiddleware already grants the workspace owner every space, so they
      // self-add and walk in; everyone else bails out to the knock flow.
      if (!isWorkspaceOwner) return
      try {
        const client = getClient()
        await client.update(meeting, { $push: { members: me.uuid } })
        meeting = { ...meeting, members: [...meeting.members, me.uuid] }
      } catch (err) {
        console.warn('Failed to self-add workspace owner to private meeting members', err)
        return
      }
    }

    const isGuest = me.role === AccountRole.Guest

    // Check if this is the user's own office - allow direct connection without knock
    const isOwnOffice = room !== undefined && isOffice(room) && room.person === getCurrentEmployee()

    const officePerson = room != null ? (isOffice(room) ? room.person : undefined) : undefined
    if (isGuest && officePerson != null && !isOwnOffice) {
      await sendInvites([officePerson], meeting._id)
      return
    }

    await connectToMeeting(meeting)
  })
}

export async function joinOrCreateMeetingByInvite (meetingId: Ref<MeetingMinutes>): Promise<boolean> {
  return await withConnectingToMeeting(async () => {
    const client = getClient()

    // Retry finding meeting - it may take time to propagate
    let meeting: MeetingMinutes | undefined = get(meetings).find((it) => it._id === meetingId)
    let attempts = 0
    const maxAttempts = 20
    const delay = 100 // ms

    while (attempts < maxAttempts) {
      if (meeting === undefined) {
        meeting = await client.findOne(love.class.MeetingMinutes, { _id: meetingId })
      }

      if (meeting !== undefined) {
        break
      }

      attempts++
      if (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    if (meeting === undefined) {
      console.error('[joinOrCreateMeetingByInvite] MeetingMinutes not found after all retries', { meetingId })
      return false
    }

    // The membership write behind an accepted knock is not synchronous with the `accepted`
    // status the client sees, so `/getToken` can still answer 403. Retry before giving up.
    let lastErr: LoveServiceError | undefined
    // Membership usually lands within a few milliseconds; a flat 250ms tick made every knock
    // wait that long. Back off from 25ms instead, capped so a slow server still gets retries.
    let backoff = 25
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await connectToMeeting(meeting)
        return true
      } catch (err) {
        // 409 - the meeting is Finished; the link is dead, retrying cannot help.
        if (err instanceof LoveServiceError && err.status === 409) return false
        if (!(err instanceof LoveServiceError) || err.status !== 403) throw err
        lastErr = err
        await new Promise((resolve) => setTimeout(resolve, backoff))
        backoff = Math.min(backoff * 2, 400)
        // Re-fetch in case members propagated since the snapshot we have.
        const refreshed = await client.findOne(love.class.MeetingMinutes, { _id: meetingId })
        if (refreshed === undefined || refreshed.status === MeetingStatus.Finished) {
          // Meeting is gone — stop hammering.
          return false
        }
        meeting = refreshed
      }
    }
    console.warn(`joinOrCreateMeetingByInvite: connect failed after retries: ${lastErr?.message ?? 'unknown'}`)
    return false
  })
}

export async function kick (person: Ref<Person>): Promise<void> {
  // TODO: Need to rework a logic to kick a person from a personal meeting.
  const client = getClient()
  const allRooms = get(rooms)
  const participantsInfo = get(infos)
  const participantInfo = participantsInfo.find((p) => p.person === person)
  if (participantInfo === undefined) return
  const participantOffice = allRooms.find((r) => isOffice(r) && r.person === person)
  await client.update(participantInfo, { room: participantOffice?._id ?? love.ids.Reception, x: 0, y: 0 })
}

async function connectToMeeting (mm: MeetingMinutes, room?: Room, silent = false): Promise<void> {
  if (getCurrentAccount().role === AccountRole.ReadOnlyGuest) {
    return
  }
  // `currentMeeting` outlives the LiveKit session (a workspace switch disconnects without
  // `leaveMeeting()`), and a stale ref would silently reject every rejoin of the same meeting.
  if (currentMeeting === mm._id && get(lkSessionConnected)) {
    return
  }

  // A seat of mine elsewhere is another tab or device, not this one - joining here evicts it
  // server-side, so let the user keep the meeting they are actually talking in. An automatic
  // reconnect asks nothing: nobody clicked, so a modal would just appear on its own.
  const otherSession = findOtherLiveSession(mm._id, currentMeeting)
  if (!silent && otherSession !== undefined) {
    // The row alone is not proof: it outlives a closed tab, and prompting about a meeting nobody
    // is in is worse than not prompting at all. Ask the server what LiveKit actually holds.
    const live = await loveClient.liveSessions([otherSession.meeting])
    if (live.includes(otherSession.meeting)) {
      // Loaded on demand: this module must not pull `@hcengineering/ui` at import time.
      const { confirmLeaveOtherMeeting } = await import('./loveGuards')
      if (!(await confirmLeaveOtherMeeting(otherSession))) return
    }
  }

  if (currentMeeting !== undefined) {
    await leaveMeeting()
  }

  currentMeeting = mm._id

  if (mm.roomId !== undefined) {
    room = room ?? (await getClient().findOne<Room>(love.class.Room, { _id: mm.roomId }))
    currentMeetingRoom = room?._id
  }

  await navigateToOfficeDoc(mm) // TODO: Select room?

  // Without this a failed attempt leaves `currentMeeting` set, and every retry early-returns.
  let token: string
  try {
    token = await loveClient.getRoomToken(mm)
  } catch (err) {
    currentMeeting = undefined
    currentMeetingRoom = undefined
    throw err
  }
  const wsURL = getLiveKitEndpoint()

  // Mark local session as connecting (prevents accidental disconnects while connecting)
  const sessionId = getMetadata(presentation.metadata.SessionId) ?? null
  myConnectingSessionId.set(sessionId)

  try {
    await liveKitClient.connect(wsURL, token, room?.type === RoomType.Video)
    await navigateToMeetingMinutes(mm)
  } catch (err: any) {
    console.error('[connectToMeeting] Error connecting:', err)
    // Ensure local connecting flag is cleared on error
    myConnectingSessionId.set(null)
    throw err
  }

  // Connection completed successfully: clear connecting flag and remember
  // the meeting so a page refresh can reconnect directly via /getToken.
  myConnectingSessionId.set(null)
  rememberActiveMeeting(mm._id)
  // Now that this session is live, let the server drop my sessions in other meetings. Not awaited:
  // housekeeping must not hold up the caller, which has already navigated.
  void loveClient.claimSession(mm)
}

const LIVE_MEETING_STATUSES = [MeetingStatus.Active, MeetingStatus.Pending]

// A Scheduled meeting already owns its room, so creating a second one would split people
// arriving by the calendar link from people clicking the room - but only inside its window.
async function findJoinableScheduled (room: Room): Promise<MeetingMinutes | undefined> {
  const scheduled = await getClient().findAll(love.class.MeetingMinutes, {
    roomId: room._id,
    status: MeetingStatus.Scheduled
  })
  return scheduled.find((it) => isScheduledJoinable(it))
}

async function createMeetingDocument (room: Room): Promise<{ meeting: MeetingMinutes, created: boolean }> {
  const client = getClient()

  const joinableScheduled = await findJoinableScheduled(room)
  if (joinableScheduled !== undefined) return { meeting: joinableScheduled, created: false }

  while (true) {
    const me = getCurrentEmployee()
    const currentPerson = await getPersonByPersonRef(me)
    const myAccount = currentPerson?.personUuid

    // Use apply() to atomically create MeetingMinutes with Pending status
    const ops = client.apply(`create_meeting_${room._id}`)
    // Ensure no MeetingMinutes for this room exists at the time of commit
    ops.notMatch(love.class.MeetingMinutes, { roomId: room._id, status: { $in: LIVE_MEETING_STATUSES } })
    const title = await getNewMeetingTitle(room)
    const newMeetingId = generateId<MeetingMinutes>()
    await ops.createDoc(
      love.class.MeetingMinutes,
      newMeetingId as unknown as Ref<Space>,
      {
        name: title,
        description: '',
        private: room.startPrivate ?? false,
        archived: false,
        members: myAccount !== undefined ? [myAccount as unknown as AccountUuid] : [],
        owners: myAccount !== undefined ? [myAccount as unknown as AccountUuid] : [],
        descriptionRef: null,
        summary: null,
        roomId: room._id,
        status: MeetingStatus.Pending,
        transcriptionState: TranscriptionState.NotStarted,
        recordingState: RecordingState.NotStarted,
        language: room.language,
        startWithRecording: room.startWithRecording ?? false,
        startWithTranscription: room.startWithTranscription ?? false
      },
      newMeetingId
    )
    try {
      const { result } = await ops.commit()
      if (result) {
        const meeting = await client.findOne(love.class.MeetingMinutes, { _id: newMeetingId })
        if (meeting !== undefined) {
          return { meeting, created: true }
        }
      } else {
        // notMatch failed on fresh server data — a live meeting already exists
        // for this room. Reuse it instead of creating a duplicate.
        const existing = await client.findOne(love.class.MeetingMinutes, {
          roomId: room._id,
          status: { $in: LIVE_MEETING_STATUSES }
        })
        if (existing !== undefined) return { meeting: existing, created: false }
      }
    } catch (err: any) {
      // Concurrent creation happened — pick the existing one (if available)
      const existing = await client.findOne(love.class.MeetingMinutes, {
        roomId: room._id,
        status: { $in: LIVE_MEETING_STATUSES }
      })
      if (existing !== undefined) return { meeting: existing, created: false }
      throw err
    }
    // Retry with a delay
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function getNewMeetingTitle (room: Room): Promise<string> {
  const date = new Date()
    .toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })
    .replace(',', ' at')
  return `${await getRoomName(room)} ${date}`
}

function getRoomById (roomId: Ref<Room>): Room | undefined {
  const allRooms = get(rooms)
  return allRooms.find((p) => p._id === roomId)
}

let reconnecting = false

/**
 * Auto-reconnect after a refresh from the sessionStorage anchor, falling back to a surviving
 * ParticipantInfo. Both hand off to `connectToMeeting`, which drops the anchor if the meeting is gone.
 */
export async function reconnectToCurrentMeeting (): Promise<void> {
  if (reconnecting) return
  if (leavingMeeting) return
  if (get(lkSessionConnected) || get(lkIsConnecting)) return
  if (currentMeeting !== undefined) return
  if (getCurrentAccount().role === AccountRole.ReadOnlyGuest) return

  // The anchor is the only signal that the user *wants* to be in a meeting: after an
  // explicit leave the ParticipantInfo lingers, and the watcher would yank them back.
  const remembered = recallActiveMeeting()
  if (remembered === undefined) return

  let mm: MeetingMinutes | undefined = get(currentMeetingMinutes)
  if (mm !== undefined && mm._id !== remembered) {
    // PI points at a different meeting than the one we remembered —
    // trust the anchor.
    mm = undefined
  }
  if (mm === undefined) {
    const allMeetings = get(meetings)
    // Still loading: wait for the next store tick instead of dropping the anchor,
    // which would cost a 30s round-trip on the second-chance reconnect.
    if (allMeetings.length === 0) return
    mm = allMeetings.find((m) => m._id === remembered)
    if (mm === undefined) {
      // MeetingMinutes is finished or otherwise filtered out of the store
      // (`status !== Finished` clause). Anchor is stale — drop it.
      forgetActiveMeeting()
      return
    }
  }

  if (mm.status !== MeetingStatus.Active && mm.status !== MeetingStatus.Pending) {
    forgetActiveMeeting()
    return
  }

  reconnecting = true
  reconnectingToMeeting.set(true)
  try {
    const room = mm.roomId !== undefined ? getRoomById(mm.roomId) : undefined
    await connectToMeeting(mm, room, true)
  } catch (err) {
    console.warn('[reconnectToCurrentMeeting] failed', err)
    forgetActiveMeeting()
  } finally {
    reconnecting = false
    reconnectingToMeeting.set(false)
  }
}

/**
 * Cancels the reconnect attempt. An in-flight connect surfaces as a normal
 * LiveKit timeout, which the watcher's catch branch swallows.
 */
export function cancelReconnect (): void {
  forgetActiveMeeting()
  reconnectingToMeeting.set(false)
}

onClient(() => {
  // Inside onClient: at module scope this runs while `liveKitClient` is still evaluating - the two
  // modules import each other - and reading the store then throws before the office ever renders.
  //
  // A server-side end is final: the room is gone. Keeping the anchor sends the client back into a
  // meeting that no longer exists on the next store tick, and `connectToMeeting` navigates it to
  // that meeting's minutes page on the way - out of the office, with nothing to connect to.
  let lastSessionEnd: number | undefined
  lkSessionEnded.subscribe((value) => {
    if (lastSessionEnd === undefined || value === lastSessionEnd) {
      lastSessionEnd = value
      return
    }
    lastSessionEnd = value
    currentMeeting = undefined
    currentMeetingRoom = undefined
    forgetActiveMeeting()
  })

  void waitForOfficeLoaded().then(() => {
    void reconnectToCurrentMeeting()
    // Either store may populate after `officeLoaded` resolves; the loop is guarded
    // by `reconnecting`/`currentMeeting`.
    currentMeetingMinutes.subscribe(() => {
      void reconnectToCurrentMeeting()
    })
    meetings.subscribe(() => {
      if (recallActiveMeeting() !== undefined) {
        void reconnectToCurrentMeeting()
      }
    })
  })
})

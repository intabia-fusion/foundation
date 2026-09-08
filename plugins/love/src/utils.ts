import { AccessLevel, Event, ReccuringEvent, ReccuringInstance, generateRecurringValues } from '@hcengineering/calendar'
import { Employee, Person } from '@hcengineering/contact'
import { Data, DocumentQuery, Timestamp, generateId, Ref, WorkspaceUuid } from '@hcengineering/core'

import love from './plugin'
import {
  Floor,
  MeetingEventLink,
  MeetingMinutes,
  MeetingStatus,
  Office,
  ParticipantInfo,
  Room,
  RoomType,
  defaultMeetingAccess
} from './types'

/**
 * Parsed LiveKit room name components
 */
export interface ParsedRoomName {
  workspace: WorkspaceUuid
  meetingId: Ref<MeetingMinutes>
}

/**
 * Splits `${workspaceUuid}_${meetingMinutesId}` from `getRoomName`. Neither id ever contains
 * `_`, so the first one is always the separator.
 */
export function parseRoomName (roomName: string): ParsedRoomName | undefined {
  const sepIdx = roomName.indexOf('_')
  if (sepIdx <= 0 || sepIdx === roomName.length - 1) return undefined

  return {
    workspace: roomName.slice(0, sepIdx) as WorkspaceUuid,
    meetingId: roomName.slice(sepIdx + 1) as Ref<MeetingMinutes>
  }
}

/**
 * The service floor and its single room are created by fixed id and belong to the workspace,
 * not to a user: they cannot be renamed, deleted, or given another room.
 */
export function isServiceFloor (floor: Ref<Floor> | undefined): boolean {
  return floor === love.ids.ScheduledFloor
}

export function isServiceRoom (room: Pick<Room, '_id'> | undefined): boolean {
  return room?._id === love.ids.ScheduledRoom
}

/**
 * Query resolving the master event a meeting's identity lives on. An override of one occurrence
 * owns a different `eventId`, and resolving by it would give that occurrence its own link.
 */
export function meetingMasterQuery (event: Pick<Event, 'eventId'>): DocumentQuery<Event> {
  const recurringEventId = (event as ReccuringInstance).recurringEventId
  return { eventId: recurringEventId ?? event.eventId, access: AccessLevel.Owner }
}

export const GRID_WIDTH = 15

interface Slot {
  _id?: Ref<Room>
  width: number
  height: number
  x: number
  y: number
}

export function isOffice (room: Data<Room>): room is Office {
  return (room as Office).person !== undefined
}

export function createDefaultRooms (
  employees: Ref<Employee>[],
  defaultTranscription: boolean = false,
  defaultRecording: boolean = false,
  defaultPrivate: boolean = false
): (Data<Room | Office> & { _id: Ref<Room> })[] {
  const res: (Data<Room | Office> & { _id: Ref<Room> })[] = []
  // create 12 offices
  for (let index = 0; index < 12; index++) {
    const _id = generateId<Office>()
    const office: Data<Office> & { _id: Ref<Office> } = {
      _id,
      name: '',
      type: RoomType.Video,
      floor: love.ids.MainFloor,
      width: 2,
      height: 1,
      x: (index % 2) * 3,
      y: index - (index % 2),
      person: employees[index] ?? null,
      language: 'en',
      startWithTranscription: false,
      startWithRecording: false,
      startPrivate: true,
      description: null
    }
    res.push(office)
  }
  const allHands = generateId<Room>()

  res.push({
    _id: allHands,
    name: 'All hands',
    type: RoomType.Video,
    floor: love.ids.MainFloor,
    width: 9,
    height: 3,
    x: 6,
    y: 0,
    language: 'en',
    startWithTranscription: defaultTranscription,
    startWithRecording: defaultRecording,
    startPrivate: defaultPrivate,
    description: null
  })

  const meetingRoom1 = generateId<Room>()
  res.push({
    _id: meetingRoom1,
    name: 'Meeting Room 1',
    type: RoomType.Video,
    floor: love.ids.MainFloor,
    width: 4,
    height: 3,
    x: 6,
    y: 4,
    language: 'en',
    startWithTranscription: defaultTranscription,
    startWithRecording: defaultRecording,
    startPrivate: defaultPrivate,
    description: null
  })
  const meetingRoom2 = generateId<Room>()
  res.push({
    _id: meetingRoom2,
    name: 'Meeting Room 2',
    type: RoomType.Video,
    floor: love.ids.MainFloor,
    width: 4,
    height: 3,
    x: 11,
    y: 4,
    language: 'en',
    startWithTranscription: defaultTranscription,
    startWithRecording: defaultRecording,
    startPrivate: defaultPrivate,
    description: null
  })
  const voiceRoom1 = generateId<Room>()
  res.push({
    _id: voiceRoom1,
    name: 'Voice Room 1',
    type: RoomType.Audio,
    floor: love.ids.MainFloor,
    width: 4,
    height: 3,
    x: 6,
    y: 8,
    language: 'en',
    startWithTranscription: false,
    startWithRecording: false,
    startPrivate: false,
    description: null
  })
  const voiceRoom2 = generateId<Room>()
  res.push({
    _id: voiceRoom2,
    name: 'Voice Room 2',
    type: RoomType.Audio,
    floor: love.ids.MainFloor,
    width: 4,
    height: 3,
    x: 11,
    y: 8,
    language: 'en',
    startWithTranscription: false,
    startWithRecording: false,
    startPrivate: false,
    description: null
  })
  return res
}

const cropMaxWidth = (width: number): number => {
  return width > GRID_WIDTH ? GRID_WIDTH : width
}

export function getFreeSpace (rooms: Slot[], exclude?: Slot, completeExclusion?: boolean): boolean[][] {
  const sorted = [...rooms].sort((a, b) => a.y - b.y)
  const map: boolean[][] = [new Array(GRID_WIDTH).fill(true)]

  for (const room of sorted) {
    const excluded: boolean = exclude?._id === room._id
    for (
      let y = room.y === 0 ? 0 : excluded ? room.y : room.y - 1;
      y < room.y + room.height + (excluded ? 0 : 1);
      y++
    ) {
      map[y] ??= new Array(GRID_WIDTH).fill(true)
      for (
        let x = room.x === 0 ? 0 : excluded ? room.x : room.x - 1;
        x <
        (room.x + room.width - 1 < GRID_WIDTH
          ? excluded
            ? cropMaxWidth(room.x + room.width)
            : cropMaxWidth(room.x + room.width + 1)
          : GRID_WIDTH - 1);
        x++
      ) {
        map[y][x] = completeExclusion === true && excluded
      }
    }
  }
  map.push(new Array(GRID_WIDTH).fill(true))

  return map
}

export function getFreePosition (
  rooms: Slot[],
  width: number,
  height: number
): {
    x: number
    y: number
  } {
  const map: boolean[][] = getFreeSpace(rooms)

  for (let y = 0; y <= map.length; y++) {
    map[y] ??= new Array(GRID_WIDTH).fill(true)
    for (let x = 0; x < map[y].length; x++) {
      if (map[y][x]) {
        let matched = true
        for (let yIndex = 0; yIndex < height; yIndex++) {
          if (map[y + yIndex] === undefined) {
            map[y + yIndex] = new Array(GRID_WIDTH).fill(true)
          }
          for (let xIndex = 0; xIndex < width; xIndex++) {
            if (!map[y + yIndex][x + xIndex]) {
              matched = false
              break
            }
          }
        }
        if (matched) {
          return {
            x,
            y
          }
        }
      }
    }
  }

  return {
    x: 0,
    y: 0
  }
}

export function checkIntersection (rooms: Slot[], width: number, height: number, x: number, y: number): boolean {
  for (const room of rooms) {
    if (x <= room.x + room.width && x + width >= room.x && y <= room.y + room.height && y + height >= room.y) {
      return true
    }
  }
  return false
}

export interface ScreenSource {
  id: string
  name: string
  thumbnailURL: string
  appIconURL: string
}

// A session that is either running or waiting for its first participant. At most one of these
// may exist per meeting at a time - both the client and the love service rely on that.
export const LIVE_MEETING_STATUSES = [MeetingStatus.Active, MeetingStatus.Pending]

// An occurrence may be joined from 15 minutes before its start until 4 hours after it: an empty
// room in the middle of a meeting is a dropout, not the end.
export const SCHEDULED_MEETING_WINDOW_MS = 4 * 60 * 60 * 1000
export const SCHEDULED_JOIN_LEAD_MS = 15 * 60 * 1000

export function getFreeRoomPlace (
  room: Room,
  info: ParticipantInfo[],
  person: Ref<Person>,
  pref?: { x: number, y: number }
): { x: number, y: number } {
  const taken = (x: number, y: number): boolean => info.some((p) => p.x === x && p.y === y)

  if (pref !== undefined) {
    if (isOffice(room) && room.person === person) {
      return { x: 0, y: 0 }
    }
    // Only honour a preference that the floor grid can actually render.
    const inGrid = pref.x >= 0 && pref.y >= 0 && pref.x < room.width && pref.y < room.height
    // (0,0) of an office belongs to its owner, who already returned above.
    const ownerSeat = isOffice(room) && pref.x === 0 && pref.y === 0
    if (inGrid && !ownerSeat && !taken(pref.x, pref.y)) {
      return pref
    }
  }
  for (let y = 0; y < room.height; y++) {
    for (let x = 0; x < room.width; x++) {
      if (taken(x, y)) continue
      // (0,0) of an office belongs to its owner.
      if (x === 0 && y === 0 && isOffice(room)) {
        if (room.person === person) return { x: 0, y: 0 }
        continue
      }
      return { x, y }
    }
  }
  // Room full: overflow along x - RoomPreview adds extra columns, never rows.
  for (let x = room.width; ; x++) {
    if (!taken(x, 0)) return { x, y: 0 }
  }
}

/**
 * Occurrence starts of a meeting inside `[from, to)`, sorted. Overrides are not subtracted:
 * an override is a session of its own, resolved through its `originalStartTime` (F1 §5).
 */
export function meetingOccurrences (master: Event, from: Timestamp, to: Timestamp): Timestamp[] {
  const rec = master as ReccuringEvent
  if (rec.rules === undefined && rec.rdate === undefined) {
    return master.date >= from && master.date < to ? [master.date] : []
  }

  const values = new Set<Timestamp>()
  for (const rule of rec.rules ?? []) {
    // generateRecurringValues treats `to` as inclusive; the half-open range keeps `resolveOccurrence`
    // from reporting an occurrence that starts exactly at the far edge of the lookahead.
    for (const value of generateRecurringValues(rule, master.date, from, to)) {
      if (value < to) values.add(value)
    }
  }
  for (const date of rec.rdate ?? []) {
    if (date >= from && date < to) values.add(date)
  }
  for (const date of rec.exdate ?? []) {
    values.delete(date)
  }
  return Array.from(values).sort((a, b) => a - b)
}

/**
 * Which occurrence a session may be opened for right now: `current` is the one whose join window
 * is open, `next` is what a caller outside the window is told to wait for.
 */
export function resolveOccurrence (
  master: Event,
  now: number = Date.now(),
  lookahead: number = 90 * 24 * 60 * 60 * 1000
): { current?: Timestamp, next?: Timestamp } {
  const starts = meetingOccurrences(master, now - SCHEDULED_MEETING_WINDOW_MS, now + lookahead)
  const current = starts.find((it) => now >= it - SCHEDULED_JOIN_LEAD_MS && now < it + SCHEDULED_MEETING_WINDOW_MS)
  const next = starts.find((it) => it - SCHEDULED_JOIN_LEAD_MS > now)
  return { current, next }
}

/** Why a meeting link no longer works, or `undefined` when it still does. */
export type LinkRejection = 'revoked' | 'expired'

/**
 * Whether a link still opens its meeting. Revoking bumps `linkVersion`, so the old short id keeps
 * resolving but carries a stale version; `afterTtl` counts only once the series has no future
 * occurrence - otherwise a weekly meeting's link would die every week.
 */
export function checkMeetingLink (
  link: Pick<MeetingEventLink, 'linkVersion' | 'meetingAccess'>,
  claimed: { linkVersion?: number },
  series: { nextOccurrence?: Timestamp, lastMeetingEnd?: Timestamp, permanent?: boolean },
  now: number = Date.now()
): LinkRejection | undefined {
  if ((claimed.linkVersion ?? 1) !== (link.linkVersion ?? 1)) return 'revoked'
  // A permanent meeting has no series to outlive: nothing but a revoke ends its link.
  if (series.permanent === true) return undefined
  if (series.nextOccurrence !== undefined) return undefined

  const afterTtl = link.meetingAccess?.afterTtl ?? defaultMeetingAccess.afterTtl
  // Nothing has run and nothing is coming - the link had a series once, and it is over.
  const since = series.lastMeetingEnd
  if (since === undefined) return undefined
  return now < since + afterTtl ? undefined : 'expired'
}

/**
 * What a meeting link points at - a pointer, not a credential: nothing changeable is baked in,
 * and permissions are issued by the love service against the policy as it stands then.
 */
export interface MeetingLinkPayload {
  /** Master event's `eventId`, or the `_id` of a PermanentMeeting when `kind` is `meeting`. */
  eventId: string
  workspace: string
  linkVersion: number
  /** Absent in links minted before F4; those all point at events. */
  kind?: MeetingLinkKind
}

export type MeetingLinkKind = 'event' | 'meeting'

export function buildMeetingLinkPayload (payload: MeetingLinkPayload): string {
  // Key order is fixed: the account service deduplicates short links by the exact payload string,
  // and a reordered object would mint a second id for the same meeting. `kind` goes last and is
  // omitted for events, so every link issued before F4 keeps its short id.
  return JSON.stringify(
    payload.kind === 'meeting'
      ? {
          eventId: payload.eventId,
          workspace: payload.workspace,
          linkVersion: payload.linkVersion,
          kind: payload.kind
        }
      : {
          eventId: payload.eventId,
          workspace: payload.workspace,
          linkVersion: payload.linkVersion
        }
  )
}

/** Reads a link payload, or `undefined` for the old JWT form (F1 §11). */
export function parseMeetingLinkPayload (raw: string): MeetingLinkPayload | undefined {
  if (!raw.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(raw)
    const { eventId, workspace, linkVersion, kind } = parsed ?? {}
    if (typeof eventId !== 'string' || eventId === '') return undefined
    if (typeof workspace !== 'string' || workspace === '') return undefined
    return {
      eventId,
      workspace,
      linkVersion: typeof linkVersion === 'number' ? linkVersion : 1,
      kind: kind === 'meeting' ? 'meeting' : 'event'
    }
  } catch {
    return undefined
  }
}

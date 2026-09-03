import { Employee, Person } from '@hcengineering/contact'
import { Data, generateId, Ref, WorkspaceUuid } from '@hcengineering/core'

import love from './plugin'
import { MeetingMinutes, MeetingStatus, Office, ParticipantInfo, Room, RoomType } from './types'

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
      if (map[y] === undefined) {
        map[y] = new Array(GRID_WIDTH).fill(true)
      }
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
    if (map[y] === undefined) {
      map[y] = new Array(GRID_WIDTH).fill(true)
    }
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

// A scheduled meeting keeps its identity for a plausible session length: an empty room in the
// middle of it is a dropout, not the end. Joining opens 15 minutes before the start.
export const SCHEDULED_MEETING_WINDOW_MS = 4 * 60 * 60 * 1000
export const SCHEDULED_JOIN_LEAD_MS = 15 * 60 * 1000

// A Scheduled meeting owns its room only inside that window; next week's one must not swallow
// an ad-hoc Connect. Without a date there is no window, so it owns nothing.
export function isScheduledJoinable (
  mm: Pick<MeetingMinutes, 'status' | 'meetingScheduledDate'>,
  now: number = Date.now()
): boolean {
  if (mm.status !== MeetingStatus.Scheduled) return false
  const date = mm.meetingScheduledDate
  if (date == null) return false
  return now >= date - SCHEDULED_JOIN_LEAD_MS && now < date + SCHEDULED_MEETING_WINDOW_MS
}

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

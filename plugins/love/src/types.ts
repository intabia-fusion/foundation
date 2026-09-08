import { Event, Schedule } from '@hcengineering/calendar'
import { Person } from '@hcengineering/contact'
import { AccountUuid, AttachedDoc, Doc, MarkupBlobRef, Ref, Space, Timestamp, WorkspaceUuid } from '@hcengineering/core'
import { Preference } from '@hcengineering/preference'

export enum RoomType {
  Video,
  Audio,
  Reception,
  // The one service room every scheduled meeting runs in - it holds no place on a floor grid,
  // sessions are told apart by MeetingMinutes, not by the room.
  Scheduled
}

export interface Floor extends Doc {
  name: string
}

/**
 * Transcription state for MeetingMinutes - stored in DB as activity status
 */
export enum TranscriptionState {
  NotStarted = 0,
  Transcribing = 1,
  Finished = 2
}

/**
 * Recording state for MeetingMinutes - stored in DB as activity status
 */
export enum RecordingState {
  NotStarted = 0,
  Recording = 1,
  Finished = 2
}

export type RoomLanguage =
  | 'bg'
  | 'ca'
  | 'zh'
  | 'zh-TW'
  | 'zh-HK'
  | 'cs'
  | 'da'
  | 'nl'
  | 'en'
  | 'en-US'
  | 'en-AU'
  | 'en-GB'
  | 'en-NZ'
  | 'en-IN'
  | 'et'
  | 'fi'
  | 'nl-BE'
  | 'fr'
  | 'fr-CA'
  | 'de'
  | 'de-CH'
  | 'el'
  | 'hi'
  | 'hu'
  | 'id'
  | 'it'
  | 'ja'
  | 'ko'
  | 'lv'
  | 'lt'
  | 'ms'
  | 'no'
  | 'pl'
  | 'pt'
  | 'pt-br'
  | 'pt-PT'
  | 'ro'
  | 'ru'
  | 'sk'
  | 'es'
  | 'es-419'
  | 'sv'
  | 'th'
  | 'tr'
  | 'uk'
  | 'vi'

export interface RoomMetadata {
  projectKey?: string
  workspaceId?: WorkspaceUuid
  meetingId?: Ref<MeetingMinutes>
  language?: RoomLanguage

  // Status for operations
  transcription?: boolean
  recording?: boolean

  /** When the office owner left. Set by the love webhook, cleared once they are back. */
  ownerLeftAt?: number

  /** When the last human left an agent-only room. Set by the love polling, cleared once anyone is back. */
  humansLeftAt?: number
}

export interface ParticipantMetadata {
  isGuest?: boolean
  x?: number
  y?: number
}

export interface Room extends Doc {
  name: string
  type: RoomType
  floor: Ref<Floor>
  width: number
  height: number
  x: number
  y: number
  language: RoomLanguage
  startWithTranscription: boolean
  startWithRecording: boolean
  startPrivate: boolean
  description: MarkupBlobRef | null
  attachments?: number
  messages?: number
}

export interface Office extends Room {
  person: Ref<Person> | null
}

// transient data for status
export interface ParticipantInfo extends Doc {
  kind: 'user' | 'agent'
  // isActive: boolean (disabled until server connection to check it for all active meetings)
  person: Ref<Person>
  name: string
  meeting: Ref<MeetingMinutes>
  room?: Ref<Room>
  x: number
  y: number
  sessionId: string | null
  account: AccountUuid | null
}

export interface RoomInfo extends Doc {
  persons: Ref<Person>[]
  room: Ref<Room>
  isOffice: boolean
}

export interface MeetingAccess {
  /** Who may open a new session outside an occurrence window. */
  start: 'members' | 'link'
  /** How long the link outlives the series, ms. Counted from the last session's end, and only
   *  while the series has no future occurrence - otherwise a weekly meeting would die weekly. */
  afterTtl: number
  /** What the link gives access to once the series is over. */
  past: 'none' | 'last'
  /** pbkdf2-sha256 hash+salt, base64. Absent - no password. Written only by the love service. */
  guestPassword?: { hash: string, salt: string }
}

export const defaultMeetingAccess: MeetingAccess = {
  start: 'members',
  afterTtl: 7 * 24 * 60 * 60 * 1000,
  past: 'last'
}

/**
 * Meeting identity, mixed into calendar.class.Event. Lives on the series master only: a persisted
 * ReccuringInstance would carry its own `linkId`. Time and participants stay on the Event.
 */
export interface MeetingEventLink extends Event {
  /** Media mode of the session. Used to be taken from Room.type. */
  type?: RoomType.Video | RoomType.Audio

  /** shortId of the permanent link. Absent until the link is first issued. */
  linkId?: string
  /** Bumping it revokes the previous link: new payload, new shortId. */
  linkVersion?: number

  /** Named `meetingAccess`, not `access`: `Event.access` is already the calendar's AccessLevel. */
  meetingAccess?: MeetingAccess

  /** Privacy of future sessions. Drives the Busy badge on the service floor. */
  private?: boolean
  language?: RoomLanguage
  startWithRecording?: boolean
  startWithTranscription?: boolean

  // Superseded by the fields above, still written by the old scheduling path (F1 §7).
  room?: Ref<Room>
  meetingId?: Ref<MeetingMinutes> // A reference to scheduled meeting minutes
}

export interface MeetingSchedule extends Schedule {
  room: Ref<Room>
}

export interface DevicesPreference extends Preference {
  micEnabled: boolean
  noiseCancellation: boolean
  blurRadius: number
  camEnabled: boolean
  // Alert when the user talks while muted. Undefined = enabled (opt-out).
  speakingWhileMutedAlert?: boolean
}

export enum MeetingStatus {
  Active = 0,
  Finished = 1,
  Pending = 2
}

export const transcriptionStateLabel = {
  [TranscriptionState.NotStarted]: 'NotStarted',
  [TranscriptionState.Transcribing]: 'Transcribing',
  [TranscriptionState.Finished]: 'Finished'
}

export const recordingStateLabel = {
  [RecordingState.NotStarted]: 'NotStarted',
  [RecordingState.Recording]: 'Recording',
  [RecordingState.Finished]: 'Finished'
}

// Meeting minutes - now extends Space for access control
export interface MeetingMinutes extends Space {
  // Rich description (MarkupBlobRef) - should sync with Space description
  descriptionRef: MarkupBlobRef | null

  summary: MarkupBlobRef | null

  status: MeetingStatus
  transcriptionState: TranscriptionState
  recordingState: RecordingState
  meetingEnd?: Timestamp

  transcription?: number
  messages?: number
  attachments?: number
  /** Number of active recordings (PendingRecording collection) */
  recordings?: number

  /** Reference to the room where meeting takes place (optional, for navigation) */
  roomId?: Ref<Room>

  /** eventId of the master event this session belongs to. Undefined for an ad-hoc meeting. */
  eventId?: string
  /** The permanent meeting this session belongs to - the counterpart of `eventId` for F4. */
  meeting?: Ref<PermanentMeeting>
  /** Start of the occurrence the session is pinned to - `originalStartTime`, not the actual
   *  start: a moved occurrence keeps the series history stitched to its original point. */
  occurrence?: Timestamp

  language: RoomLanguage

  // If defined, should start with recording
  startWithRecording?: boolean
  // If defined, should start with transcription
  startWithTranscription?: boolean
}

/**
 * A meeting with a name and no time: it is started whenever someone needs it, and every start
 * opens its own `MeetingMinutes` session. Documents and chat live here, on the parent, so they
 * outlive the sessions - a session is terminal, this is not (F4).
 */
export interface PermanentMeeting extends Space {
  /** The meeting's own document. Sessions keep their own minutes. */
  descriptionRef: MarkupBlobRef | null

  /** Media mode of every session opened from here. */
  type: RoomType.Video | RoomType.Audio
  language: RoomLanguage
  startWithRecording?: boolean
  startWithTranscription?: boolean

  /** shortId of the permanent link. Absent until the link is first issued. */
  linkId?: string
  /** Bumping it revokes the previous link: new payload, new shortId. */
  linkVersion?: number
  /** Only `start` applies here: with no series there is nothing for `afterTtl`/`past` to follow. */
  meetingAccess?: MeetingAccess

  messages?: number
  attachments?: number
}

/**
 * Recording format type for PendingRecording
 */
export type RecordingFormat = 'video' | 'audio'

/**
 * Recording status for PendingRecording
 */
export type RecordingStatus = 'active' | 'cancelled' | 'completed'

/**
 * Pending recording document created when recording starts.
 * Used to track in-progress recordings until they complete (egress_ended).
 * Attached to MeetingMinutes as a collection to show recording progress in UI.
 */
export interface PendingRecording extends AttachedDoc {
  /** LiveKit egress ID for this recording (set when egress_started webhook arrives) */
  egressId?: string
  /** Recording format: video (room composite) or audio (track) */
  format: RecordingFormat
  /** When the recording started (Unix timestamp in milliseconds) */
  startedAt: Timestamp
  /** Room name from LiveKit (contains workspace and meetingId) */
  roomName: string
  /** Display name for the recording file (e.g., "Room_2024-01-15_12-30-00.mp4") */
  name: string
  /** Current size in bytes (updated via egress_updated webhooks) */
  size?: number
  /** Recording status: active, cancelled (stopping), or completed */
  status: RecordingStatus
}

/**
 * User meeting invite - stored in user's personal space.
 * Lives in DOMAIN_TRANSIENT with TransientTTL=30s; sender refreshes the
 * TTL via a 15s heartbeat (no-op update) while still calling.
 *
 * kind: 'invite-request' - created in sender's space, tracks outgoing invites.
 * kind: 'invite-response' - created in recipient's space (or each owner's
 *   space for a knock) by the server trigger.
 */
export interface UserMeetingInvite extends Doc {
  kind: 'invite-request' | 'invite-response'
  from: Ref<Person>
  to: Ref<Person>
  /** Existing meeting ref (A1, or set on Б by trigger after accept). */
  meeting?: Ref<MeetingMinutes>
  /**
   * Room ref — set ONLY for Б (knock) flow. Sender knows the room but not
   * the meeting; trigger uses it to fan-out to all owners of the active
   * private meeting in that room.
   */
  room?: Ref<Room>
  status: 'pending' | 'accepted' | 'declined'
  /**
   * Recipient's browser session ID set on accept. Multi-tab guard: only
   * the tab whose `presentation.metadata.SessionId` matches this value
   * auto-joins the meeting.
   */
  acceptedSessionId?: string
  /**
   * Sender's browser session ID set when the request is created. Multi-tab
   * guard for the sender: only the tab that started the call reacts to the
   * accept (joins, or creates the A2 meeting).
   */
  senderSessionId?: string
}

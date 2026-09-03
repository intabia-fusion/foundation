import { Event, Schedule } from '@hcengineering/calendar'
import { Person } from '@hcengineering/contact'
import { AccountUuid, AttachedDoc, Doc, MarkupBlobRef, Ref, Space, Timestamp, WorkspaceUuid } from '@hcengineering/core'
import { Preference } from '@hcengineering/preference'

export enum RoomType {
  Video,
  Audio,
  Reception
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

export interface MeetingEventLink extends Event {
  room: Ref<Room>
  meetingId: Ref<MeetingMinutes> // A reference to scheduled meeting minutes
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
  Pending = 2,
  Scheduled = 7 // In case meeting is scheduled, it could be started by any ws participant, only once at -15mins - due interval
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

  meetingScheduledDate?: Timestamp

  transcription?: number
  messages?: number
  attachments?: number
  /** Number of active recordings (PendingRecording collection) */
  recordings?: number

  /** Reference to the room where meeting takes place (optional, for navigation) */
  roomId?: Ref<Room>

  language: RoomLanguage

  // If defined, should start with recording
  startWithRecording?: boolean
  // If defined, should start with transcription
  startWithTranscription?: boolean
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
}

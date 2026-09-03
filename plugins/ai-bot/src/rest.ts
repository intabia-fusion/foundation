//
// Copyright © 2024-2025 Hardcore Engineering Inc.
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

import { Class, Doc, Markup, PersonId, Ref, Space, Timestamp } from '@hcengineering/core'
import { MeetingMinutes, RoomLanguage } from '@hcengineering/love'
import { Contact, Person } from '@hcengineering/contact'
import { ChatMessage } from '@hcengineering/chunter'

/** Assistant quality level id: data-driven string, not a fixed enum; new levels need no code change. */
export type AILevel = string

/** What an AI conversation was started for (mirrors AIContextMessage.purpose). */
export type AIConversationPurpose = 'issue-draft'

export interface AIEventRequest {
  message: string
  messageClass: Ref<Class<ChatMessage>>
  messageId: Ref<ChatMessage>
  objectClass: Ref<Class<Doc>>
  objectId: Ref<Doc>
  objectIdIsSpace: boolean
  objectSpace: Ref<Space>
  user: PersonId
  collection: string
  createdOn: Timestamp
  // Effective AI level, already clamped to the space ceiling by the server trigger.
  // The pod routes by this directly (no level resolution on the pod side).
  level?: AILevel
  // Which feature this request serves. The pod narrows the registry to levels allowing it,
  // so a level denied for the feature falls back to a capable one. Unset -> no narrowing.
  feature?: AIFeature
  // Space language for the bot's non-personal replies (set by the server trigger
  // from AISpaceSettings); the pod falls back to AI_DEFAULT_LANGUAGE when unset.
  language?: string
  // What the conversation is for, taken from its root. Narrows the toolset: drafting an issue
  // that does not exist yet has no use for sub-task or document tools.
  purpose?: AIConversationPurpose
}

/** Queue task for a chat voice-note transcription (kind='chat-voice'), handled by the stt-worker. */
export interface ChatVoiceTranscriptionTask {
  kind: 'chat-voice'
  // AudioTranscribe doc to write the result back onto.
  transcribeId: Ref<Doc>
  space: Ref<Space>
  attachedTo: Ref<Doc>
  attachedToClass: Ref<Class<Doc>>
  // Workspace storage blob id (attachment.file) of the audio.
  blobId: string
  audioFormat: 'ogg' | 'webm' | 'wav' | 'mp4'
  durationSec: number
  // Effective ASR/LLM level (space ceiling), forwarded by the trigger.
  level?: AILevel
  language?: string
}

export interface TranslateRequest {
  text: Markup
  lang: string
}

export interface PersonMessage {
  personRef: Ref<Contact>
  personName: string

  time: Timestamp
  text: string
}

export interface SummarizeMessagesRequest {
  lang: string

  target: Ref<Doc>
  targetClass: Ref<Class<Doc>>
}

export interface SummarizeMessagesResponse {
  text: Markup
  lang: string
}

export interface TranslateResponse {
  text: Markup
  lang: string
}

export interface ConnectMeetingRequest {
  meetingId: Ref<MeetingMinutes>
  language: RoomLanguage
  transcription: boolean
}

export interface DisconnectMeetingRequest {
  meetingId: Ref<MeetingMinutes>
}

export interface PostTranscriptRequest {
  transcript: string
  participant: Ref<Person>
  roomName: string
}

export interface IdentityResponse {
  identity: Ref<Person>
  name: string
}

/** Which AI features a level may serve; unset flag = allowed (default true). */
export interface AIFeatureFlags {
  talk?: boolean // "Discuss with the assistant" (live conversation)
  chat?: boolean // chat replies
  summary?: boolean // conversation summary
  tasks?: boolean // create tasks from chat
}

export type AIFeature = keyof AIFeatureFlags

/** A level the ai-bot offers, served by its API (GET levels); same catalog for everyone, not per-workspace. */
export interface AILevelInfo {
  level: AILevel
  order: number // sort key (lower = weaker/cheaper)
  label: string
  tokenMultiplier: number
  displayMultiplier?: number // UI-facing "xN" relative to the base level
  features?: AIFeatureFlags
}

/** ASR (transcription) quality level id. Data-driven string, mirrors AILevel. */
export type AsrLevel = string

/** A transcription level the ai-bot offers (GET /asr-levels). Mirrors AILevelInfo. */
export interface AsrLevelInfo {
  level: AsrLevel
  order: number
  label: string
  tokenMultiplier: number // billed per SECOND of audio
  displayMultiplier?: number
}

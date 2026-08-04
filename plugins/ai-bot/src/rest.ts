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

/**
 * ЮляИИ quality level id. Data-driven (free-form string, e.g. 'low', 'pro',
 * 'fast'), not a fixed enum. Level definitions live as AIModelInfo docs in the
 * workspace (projected from the pod registry); the UI lists them and renders
 * label/description. New levels need no code change.
 */
export type AILevel = string

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
  // Space language for the bot's non-personal replies (set by the server trigger
  // from AISpaceSettings); the pod falls back to AI_DEFAULT_LANGUAGE when unset.
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

/**
 * A level the ai-bot offers, served by its API (GET levels). The catalog is the
 * same for everyone, so it lives in the pod, not in per-workspace docs. The UI
 * lists these for the level picker; the choice is stored in AISpaceSettings.
 */
export interface AILevelInfo {
  level: AILevel
  order: number // sort key (lower = weaker/cheaper)
  label: string
  description?: string
  tokenMultiplier: number
  displayMultiplier?: number // UI-facing "xN" relative to the base level
}

/** ASR (transcription) quality level id. Data-driven string, mirrors AILevel. */
export type AsrLevel = string

/** A transcription level the ai-bot offers (GET /asr-levels). Mirrors AILevelInfo. */
export interface AsrLevelInfo {
  level: AsrLevel
  order: number
  label: string
  description?: string
  tokenMultiplier: number // billed per SECOND of audio
  displayMultiplier?: number
}

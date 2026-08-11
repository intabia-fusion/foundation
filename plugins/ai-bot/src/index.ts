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

import {
  type AccountUuid,
  type Blob,
  buildSocialIdString,
  type Class,
  type Doc,
  type Markup,
  type Ref,
  type Space,
  type Timestamp,
  SocialIdType
} from '@hcengineering/core'
import type { ChatMessage, ThreadMessage } from '@hcengineering/chunter'
import type { Attachment } from '@hcengineering/attachment'
import type { IntlString, Metadata, Plugin } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'
import type { Preference } from '@hcengineering/preference'
import type { AnyComponent } from '@hcengineering/ui/src/types'
import type { AILevel, AsrLevel } from './rest'

export * from './rest'

export const aiBotId = 'ai-bot' as Plugin

export const aiBotAccountEmail = 'huly.ai.bot@hc.engineering'
export const aiBotEmailSocialKey = buildSocialIdString({
  type: SocialIdType.EMAIL,
  value: aiBotAccountEmail
})

/**
 * Per-user AI assistant memory, stored as a Preference owned by the user.
 * The ai-bot writes it on the user's behalf; the user sees and edits it in settings.
 */
export interface AIPersonalData extends Preference {
  attachedTo: AccountUuid
  personalContext: string
  // Preferred language for the bot's replies in the user's DIRECT chat. Overrides the
  // space/workspace language there only; group chats keep the space language.
  language?: string
}

/** Lifecycle of a queued AI request, surfaced to the user for status/ETA. */
export type AIRequestStatus = 'queued' | 'processing' | 'done' | 'failed'

/**
 * Status document for one AI request. Lives in the user's PersonSpace so both the
 * user and the system can see it. The pod creates it on enqueue and updates it as
 * the request moves through the pipeline; the UI shows progress and ETA from it.
 */
export interface AIRequest extends Doc {
  status: AIRequestStatus
  level: AILevel
  modelId: string
  kind: string // 'chat' | 'text-op' | ... (request category)
  promptTokens: number
  completionTokens: number
  billedTokens: number // (prompt+completion) * model.tokenMultiplier
  estimatedFinishAt?: Timestamp
  error?: string
}

/**
 * Per-space (or workspace-wide when attachedTo is unset) AI settings.
 * - `level`: the AI level ceiling; a request carries its own requested level and the
 *   server trigger clamps it to this ceiling. NOT a Space mixin.
 * - `language`: language for the bot's non-personal replies (summary, translate,
 *   limit notices). Falls back to the pod's AI_DEFAULT_LANGUAGE env when unset.
 */
export interface AISpaceSettings extends Doc {
  attachedTo?: Ref<Space>
  level: AILevel
  // Transcription (ASR) level for meetings in this space/workspace. Unset -> pod default.
  asrLevel?: AsrLevel
  language?: string
  sharedPrompt?: string
}

/**
 * Root message that starts an object-linked conversation with the bot. A distinct class (not a
 * mixin) so the create tx alone identifies it — the trigger skips it without a DB read or a
 * mixin-timing race. Marks the reusable "discuss with Yulia" thread for `objectId`, so the
 * button reopens it. Heavy data (context snapshot) lives in a datalake blob, not the DB.
 */
export interface AIContextMessage extends ChatMessage {
  objectId: Ref<Doc>
  objectClass: Ref<Class<Doc>>
  // Direct space holding this conversation (for reopening in the sidebar).
  direct: Ref<Space>
  // Datalake blob with the frozen context snapshot, when compacted (T18). Absent until then.
  snapshotBlob?: Ref<Blob>
  // Set when the user starts a fresh context: the "discuss" button and the pod both skip archived
  // roots, so the current (non-archived) root marks where the live context begins.
  archived?: boolean
  // Per-thread AI level chosen by the user in the thread header. The server trigger forwards it
  // on every reply in this thread (overrides the space/workspace level); unset -> space default.
  level?: AILevel
}

/**
 * Bot's proposed edit to a document/issue, posted into the chat as a distinct message.
 * The user reviews it and applies it client-side (into their own undo stack) via a button in
 * the presenter. Holds the whole proposed markup; the diff against the live doc is computed on
 * apply, so a drift between generation and apply time just re-diffs against the current text.
 */
export interface AIEditProposalMessage extends ThreadMessage {
  // Target object whose collaborative attribute the edit applies to. Named target* to avoid
  // colliding with ThreadMessage.objectId/objectClass (which point at the thread's parent).
  targetId: Ref<Doc>
  targetClass: Ref<Class<Doc>>
  // Collaborative attribute being rewritten (e.g. 'description' for an issue, 'content' for a doc).
  targetAttr: string
  // Whole proposed new content as Markup (JSON string).
  proposedMarkup: Markup
  // Set once the user applied it, to disable the button and mark the message.
  applied?: boolean
}

/** Lifecycle of a voice-note transcription. */
export type AudioTranscribeState = 'pending' | 'done' | 'failed'

/**
 * A voice-note recorded in a chat: the audio blob plus its transcription.
 * The client creates it (state=pending) into the Direct space; a server trigger enqueues an STT
 * task; the stt-worker fills `text` (ASR + LLM error-correction) and flips `state` to done. The
 * chat input watches for done and injects the text.
 */
export interface AudioTranscribe extends Attachment {
  state: AudioTranscribeState
  // Corrected transcription text (markdown), set by the worker when state=done.
  text?: string
  // Recording length in seconds, for billing and UI.
  durationSec?: number
  lang?: string
  // True once the user edited the transcript inplace. The bot always reads `text`; the flag only
  // records that a human touched it.
  edited?: boolean
}

const aiBot = plugin(aiBotId, {
  metadata: {
    EndpointURL: '' as Metadata<string>
  },
  class: {
    AIPersonalData: '' as Ref<Class<AIPersonalData>>,
    AIRequest: '' as Ref<Class<AIRequest>>,
    AISpaceSettings: '' as Ref<Class<AISpaceSettings>>,
    AIContextMessage: '' as Ref<Class<AIContextMessage>>,
    AIEditProposalMessage: '' as Ref<Class<AIEditProposalMessage>>,
    AudioTranscribe: '' as Ref<Class<AudioTranscribe>>
  },
  component: {
    AIPersonalDataSettings: '' as AnyComponent,
    AISpaceSettingsEditor: '' as AnyComponent,
    AISettings: '' as AnyComponent,
    DiscussWithAI: '' as AnyComponent,
    EditProposalPresenter: '' as AnyComponent,
    ThreadContextActions: '' as AnyComponent
  },
  string: {
    AISettings: '' as IntlString,
    TokenLimitReachedMonth: '' as IntlString,
    AIServiceUnavailable: '' as IntlString,
    AIEmptyResponse: '' as IntlString,
    AILevel: '' as IntlString,
    AILevelHint: '' as IntlString,
    AsrLevel: '' as IntlString,
    AsrLevelHint: '' as IntlString,
    Language: '' as IntlString,
    LanguageHint: '' as IntlString,
    LanguageAuto: '' as IntlString,
    BasicTab: '' as IntlString,
    PersonalTab: '' as IntlString,
    SharedPrompt: '' as IntlString,
    SharedPromptHint: '' as IntlString,
    PersonalContext: '' as IntlString,
    PersonalContextHint: '' as IntlString,
    DiscussWithAI: '' as IntlString,
    DiscussFirstMessage: '' as IntlString,
    ProposedEdit: '' as IntlString,
    ApplyEdit: '' as IntlString,
    EditApplied: '' as IntlString,
    OpenDocument: '' as IntlString,
    PreviewDiff: '' as IntlString,
    HideDiff: '' as IntlString,
    NewContext: '' as IntlString,
    NewContextHint: '' as IntlString,
    NewContextConfirm: '' as IntlString
  }
})

export default aiBot

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
  SocialIdType
} from '@hcengineering/core'
import type { ChatMessage, ThreadMessage } from '@hcengineering/chunter'
import type { Attachment } from '@hcengineering/attachment'
import type { IntlString, Metadata, Plugin } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'
import type { Preference } from '@hcengineering/preference'
import type { AnyComponent } from '@hcengineering/ui/src/types'
import type { AIConversationPurpose, AILevel, AsrLevel } from './rest'

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
export type AIRequestStatus = 'queued' | 'processing' | 'done' | 'failed' | 'cancelled'

/** Status of one AI request, stored in the chat's space; the pod updates it as the request progresses. */
export interface AIRequest extends Doc {
  status: AIRequestStatus
  level: AILevel
  modelId: string
  kind: string // 'chat' | 'text-op' | ... (request category)
  promptTokens: number
  completionTokens: number
  billedTokens: number // (prompt+completion) * model.tokenMultiplier
  error?: string
  // Chat/thread the request answers: lets the UI show progress and a cancel button in that chat.
  objectId?: Ref<Doc>
  // Model<->tool round trips done so far, surfaced as progress while the request runs.
  iteration?: number
  // How full the conversation context is, so the user can see compaction coming instead of being
  // surprised by it: tokens the assembled context took, and the level at which the older part gets
  // folded into a summary.
  contextTokens?: number
  contextCompactAt?: number
  // This request folded the older part of the conversation into a summary.
  compacted?: boolean
}

/** Per-space (or workspace-wide when attachedTo is unset) AI settings: level ceiling and reply language. */
export interface AISpaceSettings extends Doc {
  attachedTo?: Ref<Space>
  level: AILevel
  // Transcription (ASR) level for meetings in this space/workspace. Unset -> pod default.
  asrLevel?: AsrLevel
  language?: string
  sharedPrompt?: string
  // Summarize a meeting when it ends. Unset counts as enabled.
  meetingSummary?: boolean
}

/** Root message of an object-linked "discuss with the assistant" thread for `objectId`; reused when the button reopens it. */
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
  // What this conversation is for. Unset = a plain "discuss this object" thread; 'issue-draft'
  // marks a thread started by the create-issue dialog's assistant, so history views can tell
  // assistant sessions apart from ordinary discussions.
  purpose?: AIConversationPurpose
  // The issue that was finally created from this conversation (set by the dialog on save).
  resultId?: Ref<Doc>
  // Working state the conversation is about (the create-issue dialog keeps the draft here).
  // Never rendered in chat: it is context for the model, not a message for people to read.
  workingContext?: string
}

/** Bot's proposed edit to a document/issue, posted as a chat message the user reviews and applies via a button. */
export interface AIEditProposalMessage extends ThreadMessage {
  // Target object whose collaborative attribute the edit applies to. Named target* to avoid
  // colliding with ThreadMessage.objectId/objectClass (which point at the thread's parent).
  targetId: Ref<Doc>
  targetClass: Ref<Class<Doc>>
  // Collaborative attribute being rewritten (e.g. 'description' for an issue, 'content' for a doc).
  targetAttr: string
  // Whole proposed new content as Markup (JSON string). Absent when only the title is proposed.
  proposedMarkup?: Markup
  // Proposed new title. Renaming is a proposal like any other: the bot never writes it itself.
  proposedTitle?: string
  // Set once the user applied it, to disable the button and mark the message.
  applied?: boolean
}

/** One proposed sub-task inside an AITaskProposalMessage. Bodies stay markdown until created. */
export interface AITaskProposal {
  title: string
  description?: string
  // Issue created from this row. Set on success so a retry after a partial failure skips it.
  createdId?: Ref<Doc>
  // tracker IssuePriority (0 none, 1 urgent, 2 high, 3 medium, 4 low). Ref-free to keep ai-bot
  // independent of tracker; the card maps it onto the real enum.
  priority?: number
  // Estimate in hours, as the tracker estimation editor shows it.
  estimation?: number
}

/** Bot's proposed task (with optional sub-tasks), posted as an editable card; nothing is created until confirmed. */
export interface AITaskProposalMessage extends ThreadMessage {
  title: string
  // Markdown, converted to collaborative markup when the issue is created.
  description?: string
  subtasks?: AITaskProposal[]
  // Project the issue goes to. Ref<Space> and not Ref<Project>: ai-bot must not depend on tracker.
  project?: Ref<Space>
  // Parent issue when the proposal splits an existing task into sub-tasks.
  parent?: Ref<Doc>
  // Created issues, set once the user confirmed; presence disables the button.
  createdIds?: Ref<Doc>[]
  // The parent issue this proposal created (absent for a split, which reuses `parent`).
  createdRootId?: Ref<Doc>
  // tracker IssuePriority (0 none, 1 urgent, 2 high, 3 medium, 4 low), kept ref-free.
  priority?: number
  // Estimate in hours, as the tracker estimation editor shows it.
  estimation?: number
  // Due date, ISO-8601 (YYYY-MM-DD): the model has no notion of the workspace timezone.
  dueDate?: string
  // Label names. Only labels that already exist in the workspace are applied.
  labels?: string[]
  // Draft sessions: the user pushed this proposal into the create dialog. Nothing is created,
  // so this is the only way to tell an applied proposal from a pending one.
  applied?: boolean
}

/** Lifecycle of a voice-note transcription. */
export type AudioTranscribeState = 'pending' | 'done' | 'failed'

/** A voice-note recorded in a chat: the audio blob plus its transcription, filled in by the stt-worker. */
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
    AITaskProposalMessage: '' as Ref<Class<AITaskProposalMessage>>,
    AudioTranscribe: '' as Ref<Class<AudioTranscribe>>
  },
  component: {
    AIPersonalDataSettings: '' as AnyComponent,
    AISpaceSettingsEditor: '' as AnyComponent,
    AISettings: '' as AnyComponent,
    DiscussWithAI: '' as AnyComponent,
    EditProposalPresenter: '' as AnyComponent,
    TaskProposalPresenter: '' as AnyComponent,
    ThreadContextActions: '' as AnyComponent,
    IssueAssistPanel: '' as AnyComponent,
    IssueAssistToggle: '' as AnyComponent
  },
  string: {
    AISettings: '' as IntlString,
    TokenLimitReachedMonth: '' as IntlString,
    AIServiceUnavailable: '' as IntlString,
    AIEmptyResponse: '' as IntlString,
    AILevel: '' as IntlString,
    AILevelHint: '' as IntlString,
    AILevelCapabilities: '' as IntlString,
    AILevelCapabilitiesHint: '' as IntlString,
    AILevelChat: '' as IntlString,
    AILevelTalk: '' as IntlString,
    AILevelSummary: '' as IntlString,
    AILevelTasks: '' as IntlString,
    AsrLevel: '' as IntlString,
    AsrLevelHint: '' as IntlString,
    Language: '' as IntlString,
    LanguageHint: '' as IntlString,
    LanguageAuto: '' as IntlString,
    BasicTab: '' as IntlString,
    PersonalTab: '' as IntlString,
    SharedPrompt: '' as IntlString,
    SharedPromptHint: '' as IntlString,
    MeetingSummary: '' as IntlString,
    MeetingSummaryHint: '' as IntlString,
    PersonalContext: '' as IntlString,
    PersonalContextHint: '' as IntlString,
    DiscussWithAI: '' as IntlString,
    AssistIssue: '' as IntlString,
    AssistIssueThreadStart: '' as IntlString,
    AssistIssueApply: '' as IntlString,
    AssistIssueApplyAgain: '' as IntlString,
    AssistIssueAppliedMark: '' as IntlString,
    AssistIssueNewContext: '' as IntlString,

    DiscussFirstMessage: '' as IntlString,
    ProposedEdit: '' as IntlString,
    ProposedTask: '' as IntlString,
    TaskTitle: '' as IntlString,
    CreateTask: '' as IntlString,
    TaskCreated: '' as IntlString,
    CreateTaskFailed: '' as IntlString,
    SelectProject: '' as IntlString,
    ProposedEstimation: '' as IntlString,
    ApplyEdit: '' as IntlString,
    EditApplied: '' as IntlString,
    OpenDocument: '' as IntlString,
    PreviewDiff: '' as IntlString,
    HideDiff: '' as IntlString,
    NewContext: '' as IntlString,
    NewContextHint: '' as IntlString,
    NewContextConfirm: '' as IntlString,
    ExportChat: '' as IntlString,
    ExportChatHint: '' as IntlString
  }
})

export default aiBot

//
// Copyright © 2024 Hardcore Engineering Inc.
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
  AccountRole,
  type AccountUuid,
  type Blob,
  type Class,
  type Doc,
  type Domain,
  type Markup,
  type Ref,
  type Space
} from '@hcengineering/core'
import {
  type AIContextMessage,
  type AIConversationPurpose,
  type AIEditProposalMessage,
  type AILevel,
  type AsrLevel,
  type AISpaceSettings,
  type AITaskProposal,
  type AITaskProposalMessage,
  type AIPersonalData,
  type AIRequest,
  type AIRequestStatus,
  type AudioTranscribe,
  type AudioTranscribeState
} from '@hcengineering/ai-bot'
import attachment, { TAttachment } from '@hcengineering/model-attachment'
import {
  type Builder,
  Model,
  Prop,
  TypeBoolean,
  TypeMarkup,
  TypeNumber,
  TypeRef,
  TypeAny,
  TypeString
} from '@hcengineering/model'
import core, { TDoc } from '@hcengineering/model-core'
import chunter, { TChatMessage, TThreadMessage } from '@hcengineering/model-chunter'
import preference, { TPreference } from '@hcengineering/model-preference'
import tracker from '@hcengineering/tracker'
import presentation from '@hcengineering/model-presentation'
import setting from '@hcengineering/setting'
import view from '@hcengineering/model-view'

import aiBot from './plugin'

/** Domain for AI request status documents. */
export const DOMAIN_AI = 'ai' as Domain

export { aiBotId } from '@hcengineering/ai-bot'
export { aiBotOperation } from './migration'
export default aiBot

@Model(aiBot.class.AIPersonalData, preference.class.Preference)
export class TAIPersonalData extends TPreference implements AIPersonalData {
  declare attachedTo: AccountUuid

  @Prop(TypeString(), core.string.String)
    personalContext!: string

  @Prop(TypeString(), core.string.String)
    language?: string
}

@Model(aiBot.class.AIRequest, core.class.Doc, DOMAIN_AI)
export class TAIRequest extends TDoc implements AIRequest {
  @Prop(TypeString(), core.string.String)
    status!: AIRequestStatus

  @Prop(TypeString(), core.string.String)
    level!: AILevel

  @Prop(TypeString(), core.string.String)
    modelId!: string

  @Prop(TypeString(), core.string.String)
    kind!: string

  @Prop(TypeNumber(), core.string.Number)
    promptTokens!: number

  @Prop(TypeNumber(), core.string.Number)
    completionTokens!: number

  @Prop(TypeNumber(), core.string.Number)
    billedTokens!: number

  @Prop(TypeString(), core.string.String)
    error?: string

  @Prop(TypeRef(core.class.Doc), core.string.Object)
    objectId?: Ref<Doc>

  @Prop(TypeNumber(), core.string.Number)
    iteration?: number

  @Prop(TypeNumber(), core.string.Number)
    contextTokens?: number

  @Prop(TypeNumber(), core.string.Number)
    contextCompactAt?: number

  @Prop(TypeBoolean(), core.string.Boolean)
    compacted?: boolean
}

@Model(aiBot.class.AISpaceSettings, core.class.Doc, DOMAIN_AI)
export class TAISpaceSettings extends TDoc implements AISpaceSettings {
  @Prop(TypeRef(core.class.Space), core.string.Space)
    attachedTo?: Ref<Space>

  @Prop(TypeString(), core.string.String)
    level!: AILevel

  @Prop(TypeString(), core.string.String)
    asrLevel?: AsrLevel

  @Prop(TypeString(), core.string.String)
    language?: string

  @Prop(TypeString(), core.string.String)
    sharedPrompt?: string

  @Prop(TypeBoolean(), core.string.Boolean)
    meetingSummary?: boolean
}

@Model(aiBot.class.AIContextMessage, chunter.class.ChatMessage)
export class TAIContextMessage extends TChatMessage implements AIContextMessage {
  @Prop(TypeRef(core.class.Doc), core.string.Object)
    objectId!: Ref<Doc>

  @Prop(TypeRef(core.class.Class), core.string.Class)
    objectClass!: Ref<Class<Doc>>

  @Prop(TypeRef(core.class.Space), core.string.Space)
    direct!: Ref<Space>

  @Prop(TypeRef(core.class.Blob), core.string.Object)
    snapshotBlob?: Ref<Blob>

  @Prop(TypeBoolean(), core.string.Boolean)
    archived?: boolean

  @Prop(TypeString(), core.string.String)
    level?: AILevel

  @Prop(TypeString(), core.string.String)
    purpose?: AIConversationPurpose

  @Prop(TypeRef(core.class.Doc), core.string.Object)
    resultId?: Ref<Doc>

  @Prop(TypeString(), core.string.String)
    workingContext?: string
}

@Model(aiBot.class.AIEditProposalMessage, chunter.class.ThreadMessage)
export class TAIEditProposalMessage extends TThreadMessage implements AIEditProposalMessage {
  @Prop(TypeRef(core.class.Doc), core.string.Object)
    targetId!: Ref<Doc>

  @Prop(TypeRef(core.class.Class), core.string.Class)
    targetClass!: Ref<Class<Doc>>

  @Prop(TypeString(), core.string.String)
    targetAttr!: string

  @Prop(TypeMarkup(), core.string.String)
    proposedMarkup?: Markup

  @Prop(TypeString(), core.string.String)
    proposedTitle?: string

  @Prop(TypeBoolean(), core.string.Boolean)
    applied?: boolean
}

@Model(aiBot.class.AITaskProposalMessage, chunter.class.ThreadMessage)
export class TAITaskProposalMessage extends TThreadMessage implements AITaskProposalMessage {
  @Prop(TypeString(), core.string.String)
    title!: string

  @Prop(TypeString(), core.string.String)
    description?: string

  // Plain array of {title, description} - not a collection: the card edits them inline and they
  // become real issues only on confirm.
  @Prop(TypeAny(view.component.ObjectPresenter, core.string.Object), core.string.Object)
    subtasks?: AITaskProposal[]

  @Prop(TypeRef(core.class.Space), core.string.Space)
    project?: Ref<Space>

  @Prop(TypeRef(core.class.Doc), core.string.Object)
    parent?: Ref<Doc>

  @Prop(TypeAny(view.component.ObjectPresenter, core.string.Object), core.string.Object)
    createdIds?: Ref<Doc>[]
}

@Model(aiBot.class.AudioTranscribe, attachment.class.Attachment)
export class TAudioTranscribe extends TAttachment implements AudioTranscribe {
  @Prop(TypeString(), core.string.String)
    state!: AudioTranscribeState

  @Prop(TypeString(), core.string.String)
    text?: string

  @Prop(TypeNumber(), core.string.Number)
    durationSec?: number

  @Prop(TypeString(), core.string.String)
    lang?: string

  @Prop(TypeBoolean(), core.string.Boolean)
    edited?: boolean
}

export function createModel (builder: Builder): void {
  builder.createModel(
    TAIPersonalData,
    TAIRequest,
    TAISpaceSettings,
    TAIContextMessage,
    TAIEditProposalMessage,
    TAITaskProposalMessage,
    TAudioTranscribe
  )

  // Render the proposal message with its own presenter (diff + apply button) instead of the
  // plain chat-message body. The activity feed resolves ObjectPresenter by _class.
  builder.mixin(aiBot.class.AIEditProposalMessage, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: aiBot.component.EditProposalPresenter
  })

  // The task proposal renders as an editable card with a "create" button.
  builder.mixin(aiBot.class.AITaskProposalMessage, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: aiBot.component.TaskProposalPresenter
  })

  // Voice-note attachment renders as a player + transcript (component lives in attachment-resources).
  builder.mixin(aiBot.class.AudioTranscribe, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: attachment.component.VoiceAttachmentPresenter
  })

  builder.mixin(aiBot.class.AISpaceSettings, core.class.Class, core.mixin.TxAccessLevel, {
    createAccessLevel: AccountRole.Owner,
    updateAccessLevel: AccountRole.Owner,
    removeAccessLevel: AccountRole.Owner
  })

  builder.createDoc(setting.class.SettingsCategory, core.space.Model, {
    name: 'ai-settings',
    label: aiBot.string.AISettings,
    icon: view.icon.AiStar,
    component: aiBot.component.AISettings,
    group: 'settings-account',
    role: AccountRole.Guest,
    order: 1700
  })

  // Assistant in the create-issue dialog: toggle in the header, panel beside the dialog.
  builder.createDoc(presentation.class.ComponentPointExtension, core.space.Model, {
    extension: tracker.extensions.CreateIssueHeaderActions,
    component: aiBot.component.IssueAssistToggle
  })
  builder.createDoc(presentation.class.ComponentPointExtension, core.space.Model, {
    extension: tracker.extensions.CreateIssueAssist,
    component: aiBot.component.IssueAssistPanel
  })

  // "Discuss with the assistant" button in the object header (issues, documents, etc.).
  builder.createDoc(presentation.class.ComponentPointExtension, core.space.Model, {
    extension: view.extensions.EditDocTitleExtension,
    component: aiBot.component.DiscussWithAI
  })

  // "New context" button in the thread header; renders only for AI context roots.
  builder.createDoc(presentation.class.ComponentPointExtension, core.space.Model, {
    extension: chunter.extensions.ThreadHeaderExtension,
    component: aiBot.component.ThreadContextActions
  })
}

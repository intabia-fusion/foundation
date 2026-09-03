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

import core, {
  AccountUuid,
  Doc,
  PersonId,
  Ref,
  SortingOrder,
  Space,
  Tx,
  TxCreateDoc,
  TxProcessor
} from '@hcengineering/core'
import { PlatformQueueProducer, QueueTopic, TriggerControl } from '@hcengineering/server-core'
import aiBot, {
  type AIContextMessage,
  aiBotEmailSocialKey,
  AIEventRequest,
  type AudioTranscribe,
  type ChatVoiceTranscriptionTask
} from '@hcengineering/ai-bot'
import chunter, { ChatMessage, DirectMessage, ThreadMessage } from '@hcengineering/chunter'
import contact, { Employee, SocialIdentity } from '@hcengineering/contact'

import { MarkupNodeType, markupToJSON, traverseNode } from '@hcengineering/text'

interface WorkspaceCacheEntry {
  primary: SocialIdentity[]
  all: PersonId[]
  employee: Employee
}

const cacheKey = 'ai-info'

async function getAIWorkspaceID (control: TriggerControl): Promise<WorkspaceCacheEntry | undefined> {
  let wsEntry: WorkspaceCacheEntry | number | undefined = control.cache.get(cacheKey) as
    | WorkspaceCacheEntry
    | number
    | undefined
  if (typeof wsEntry === 'number') {
    if (Date.now() - wsEntry < 5000) {
      control.ctx.info('[AIBot.getAIWorkspaceID] Cache cooldown, skipping')
      return undefined
    }
    wsEntry = undefined
  }
  if (wsEntry === undefined) {
    const primaryIdentities = await control.findAll(
      control.ctx,
      contact.class.SocialIdentity,
      { key: aiBotEmailSocialKey },
      {}
    )

    if (primaryIdentities.length === 0) return undefined

    const attachedTo = primaryIdentities.map((it) => it.attachedTo as Ref<Employee>)
    const allAiSocialIds: PersonId[] = (
      await control.findAll(control.ctx, contact.class.SocialIdentity, {
        attachedTo: { $in: attachedTo }
      })
    ).map((it) => it._id)

    const employee = (
      await control.findAll(
        control.ctx,
        contact.mixin.Employee,
        { _id: { $in: attachedTo } },
        { limit: 1, sort: { modifiedOn: SortingOrder.Descending } }
      )
    ).shift()
    if (employee === undefined) {
      return undefined
    }
    wsEntry = {
      all: allAiSocialIds,
      primary: primaryIdentities,
      employee
    }
    control.cache.set(cacheKey, wsEntry)
  }
  return wsEntry
}

async function OnMessageSend (originTxs: TxCreateDoc<ChatMessage>[], control: TriggerControl): Promise<Tx[]> {
  const wsID = await getAIWorkspaceID(control)
  if (wsID === undefined) {
    control.ctx.info('[AIBot.OnMessageSend] No AI workspace ID, skipping')
    return []
  }

  const { hierarchy } = control

  const producer = control.queue?.getProducer<AIEventRequest>(control.ctx, QueueTopic.AIQueue)
  if (producer === undefined) {
    control.ctx.info('[AIBot.OnMessageSend] No queue producer, skipping')
    return []
  }

  // IGNORE AI operations
  const txes = originTxs.filter((it) => !wsID.all.includes(it.modifiedBy))

  if (txes.length === 0) {
    return []
  }

  for (const tx of txes) {
    const message = TxProcessor.createDoc2Doc(tx)

    const isThread = hierarchy.isDerived(tx.objectClass, chunter.class.ThreadMessage)
    const docClass = isThread ? (message as ThreadMessage).objectClass : message.attachedToClass
    // Find out it message contains a mention of AIBot
    try {
      const jsonMarkup = markupToJSON(message.message)
      let mentioned = false
      traverseNode(jsonMarkup, (node) => {
        if (node.type === MarkupNodeType.reference && node.attrs != null) {
          const objectId = node.attrs.id as Ref<Doc>
          if (wsID.primary.some((it) => objectId === it.attachedTo)) {
            // AI bot has mentioned
            mentioned = true
            return false
          }
        }
        return !mentioned
      })

      // Context-starter opens a thread; bot must not answer it top-level in the Direct.
      const isContextStarter = hierarchy.isDerived(message._class, aiBot.class.AIContextMessage)

      if (docClass === chunter.class.DirectMessage && !isContextStarter) {
        await onBotDirectMessageSend(control, message, 'direct', wsID, producer)
      } else if (mentioned) {
        await onBotDirectMessageSend(control, message, 'mentioned', wsID, producer)
      }
    } catch (err: any) {
      control.ctx.error('Failed to prepare a ai bot message', { err })
    }
    // }
  }

  return []
}

function getMessageData (doc: Doc, message: ChatMessage): AIEventRequest {
  return {
    createdOn: message.createdOn ?? message.modifiedOn,
    objectId: message.attachedTo,
    objectClass: message.attachedToClass,
    objectSpace: doc.space,
    collection: message.collection,
    messageClass: message._class,
    messageId: message._id,
    message: message.message,
    user: message.createdBy ?? message.modifiedBy,
    objectIdIsSpace: false
  }
}

// A top-level message in the Direct channel with the bot starts a new conversation.
function getThreadMessageData (message: ThreadMessage): AIEventRequest {
  return {
    createdOn: message.createdOn ?? message.modifiedOn,
    objectId: message.attachedTo,
    objectClass: message.attachedToClass,
    objectSpace: message.space,
    collection: message.collection,
    messageClass: message._class,
    message: message.message,
    messageId: message._id,
    user: message.createdBy ?? message.modifiedBy,
    objectIdIsSpace: false
  }
}

async function getMessageDoc (message: ChatMessage, control: TriggerControl): Promise<Doc | undefined> {
  if (control.hierarchy.isDerived(message._class, chunter.class.ThreadMessage)) {
    const thread = message as ThreadMessage
    const _id = thread.objectId
    const _class = thread.objectClass

    return (await control.queryFind(control.ctx, _class, { _id }))[0]
  } else {
    const _id = message.attachedTo
    const _class = message.attachedToClass

    return (await control.queryFind(control.ctx, _class, { _id }))[0]
  }
}

function isDirectAvailable (direct: DirectMessage, control: TriggerControl, wsID: WorkspaceCacheEntry): boolean {
  const { members } = direct

  if (!members.includes(wsID.employee.personUuid as AccountUuid)) {
    return false
  }

  return members.length === 2
}

/** Sets effective AI level + language on the event from AISpaceSettings (space -> workspace-wide). */
async function applySpaceSettings (control: TriggerControl, event: AIEventRequest): Promise<void> {
  // Set before the lookups: a failed settings read must not leave the feature unset.
  event.feature = 'chat'
  const { level, language } = await resolveSpaceLevel(control, event.objectSpace)
  event.level = level
  event.language = language
}

/** Per-thread level (from the AIContextMessage root) overrides the space/workspace level. */
async function applyThreadLevel (control: TriggerControl, message: ChatMessage, event: AIEventRequest): Promise<void> {
  // The root of an assistant conversation carries the purpose itself; a reply carries it on its root.
  if (control.hierarchy.isDerived(message._class, aiBot.class.AIContextMessage)) {
    applyConversationPurpose(message as AIContextMessage, event)
    return
  }
  if (!control.hierarchy.isDerived(message._class, chunter.class.ThreadMessage)) return
  try {
    const rootId = (message as ThreadMessage).attachedTo as unknown as Ref<AIContextMessage>
    const root = (await control.findAll(control.ctx, aiBot.class.AIContextMessage, { _id: rootId }))[0]
    if (root === undefined) return
    // An AIContextMessage thread is the "discuss with Julia" feature; the level stays the space
    // one unless this thread carries an explicit pick.
    event.feature = 'talk'
    applyConversationPurpose(root, event)
    if (root.level != null && root.level !== '') {
      event.level = root.level
    }
  } catch (err: any) {
    control.ctx.warn('failed to apply thread AI level', { error: err?.message })
  }
}

/**
 * A conversation started by the create-issue assistant is task work, not a chat: routing must pick
 * a level that is allowed to propose tasks, otherwise a chat-only level would answer with prose.
 */
function applyConversationPurpose (root: AIContextMessage, event: AIEventRequest): void {
  if (root.purpose === 'issue-draft') {
    event.feature = 'tasks'
    event.purpose = root.purpose
  }
}

async function onBotDirectMessageSend (
  control: TriggerControl,
  message: ChatMessage,
  kind: 'direct' | 'mentioned',
  wsID: WorkspaceCacheEntry,
  producer: PlatformQueueProducer<AIEventRequest>
): Promise<void> {
  if (kind === 'direct') {
    const direct = (await getMessageDoc(message, control)) as DirectMessage
    if (direct === undefined) {
      return
    }
    const isAvailable = isDirectAvailable(direct, control, wsID)
    if (!isAvailable) {
      return
    }
    let messageEvent: AIEventRequest
    if (control.hierarchy.isDerived(message._class, chunter.class.ThreadMessage)) {
      // Reply within a thread = continue that conversation (full thread context).
      messageEvent = getThreadMessageData(message as ThreadMessage)
    } else {
      // Top-level message in the Direct = the bot replies inline in the Direct;
      // context is the recent Direct messages (current day, see pod-side).
      messageEvent = getMessageData(direct, message)
    }
    messageEvent.objectIdIsSpace = control.hierarchy.isDerived(messageEvent.objectClass, core.class.Space)
    await applySpaceSettings(control, messageEvent)
    await applyThreadLevel(control, message, messageEvent)
    await producer.send(control.ctx, control.workspace.uuid, [messageEvent])
  } else if (kind === 'mentioned') {
    let messageEvent: AIEventRequest
    if (control.hierarchy.isDerived(message._class, chunter.class.ThreadMessage)) {
      messageEvent = getThreadMessageData(message as ThreadMessage)
    } else {
      messageEvent = getMessageData(message, message)
    }
    messageEvent.objectIdIsSpace = control.hierarchy.isDerived(messageEvent.objectClass, core.class.Space)
    await applySpaceSettings(control, messageEvent)
    await applyThreadLevel(control, message, messageEvent)
    await producer.send(control.ctx, control.workspace.uuid, [messageEvent])
  }
}

// Effective ASR/LLM level+language for a space. Per field, not per document: a space that sets
// only a language still inherits the workspace-wide level.
async function resolveSpaceLevel (
  control: TriggerControl,
  space: Ref<Space>
): Promise<{ level?: string, language?: string }> {
  try {
    const all = await control.findAll(control.ctx, aiBot.class.AISpaceSettings, {})
    const spaceSetting = all.find((s) => s.attachedTo === space)
    const wsSetting = all.find((s) => s.attachedTo == null)
    return { level: spaceSetting?.level ?? wsSetting?.level, language: spaceSetting?.language ?? wsSetting?.language }
  } catch (err: any) {
    control.ctx.warn('failed to resolve space AI level', { error: err?.message })
    return {}
  }
}

// A voice-note (AudioTranscribe) created in a chat -> enqueue an STT task; the stt-worker
// transcribes + LLM-corrects and writes the text back onto the doc.
async function OnAudioTranscribe (originTxs: TxCreateDoc<AudioTranscribe>[], control: TriggerControl): Promise<Tx[]> {
  const wsID = await getAIWorkspaceID(control)
  if (wsID === undefined) return []

  const producer = control.queue?.getProducer<ChatVoiceTranscriptionTask>(control.ctx, QueueTopic.TranscriptionQueue)
  if (producer === undefined) return []

  // Ignore the bot's own writes (it fills text via updateDoc, not create).
  const txes = originTxs.filter((it) => !wsID.all.includes(it.modifiedBy))

  for (const tx of txes) {
    const doc = TxProcessor.createDoc2Doc(tx)
    if (doc.state !== 'pending') continue
    const type = doc.type ?? ''
    const fmt = (['ogg', 'mp4', 'wav'] as const).find((f) => type.includes(f)) ?? 'webm'
    const { level, language } = await resolveSpaceLevel(control, doc.space)
    const task: ChatVoiceTranscriptionTask = {
      kind: 'chat-voice',
      transcribeId: doc._id,
      space: doc.space,
      attachedTo: doc.attachedTo,
      attachedToClass: doc.attachedToClass,
      blobId: doc.file,
      audioFormat: fmt,
      durationSec: doc.durationSec ?? 0,
      level,
      language
    }
    await producer.send(control.ctx, control.workspace.uuid, [task], doc.space)
  }

  return []
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    OnMessageSend,
    OnAudioTranscribe
  }
})

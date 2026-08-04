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

import core, { AccountUuid, Doc, PersonId, Ref, SortingOrder, Tx, TxCreateDoc, TxProcessor } from '@hcengineering/core'
import { PlatformQueueProducer, QueueTopic, TriggerControl } from '@hcengineering/server-core'
import aiBot, { type AIContextMessage, aiBotEmailSocialKey, AIEventRequest } from '@hcengineering/ai-bot'
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

      // A context-starter message (its own class) opens the "Discuss with Yulia" thread; the
      // bot must not answer it top-level in the Direct. Its class is on the create tx, so no
      // DB read and no mixin race.
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

/**
 * Set the effective AI level + language on the event from the active AISpaceSettings
 * (space-specific -> workspace-wide). The model catalog lives in the pod (served via
 * its API), so the trigger only forwards the chosen level/language; the pod validates
 * the level against its registry and falls back to AI_DEFAULT_LANGUAGE for language.
 */
async function applySpaceSettings (control: TriggerControl, event: AIEventRequest): Promise<void> {
  try {
    const spaceSetting = (
      await control.findAll(control.ctx, aiBot.class.AISpaceSettings, { attachedTo: event.objectSpace })
    )[0]
    const wsSetting =
      spaceSetting ??
      (await control.findAll(control.ctx, aiBot.class.AISpaceSettings, {})).find((s) => s.attachedTo == null)
    event.level = spaceSetting?.level ?? wsSetting?.level
    event.language = spaceSetting?.language ?? wsSetting?.language
  } catch (err: any) {
    control.ctx.warn('failed to apply AI space settings', { error: err?.message })
  }
}

/**
 * A thread reply belongs to an AIContextMessage root. If the user picked a per-thread level in the
 * thread header (root.level), it wins over the space/workspace level. Only applies to thread
 * messages; top-level Direct replies keep the space default.
 */
async function applyThreadLevel (control: TriggerControl, message: ChatMessage, event: AIEventRequest): Promise<void> {
  if (!control.hierarchy.isDerived(message._class, chunter.class.ThreadMessage)) return
  try {
    const rootId = (message as ThreadMessage).attachedTo as unknown as Ref<AIContextMessage>
    const root = (await control.findAll(control.ctx, aiBot.class.AIContextMessage, { _id: rootId }))[0]
    if (root?.level != null && root.level !== '') {
      event.level = root.level
    }
  } catch (err: any) {
    control.ctx.warn('failed to apply thread AI level', { error: err?.message })
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

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    OnMessageSend
  }
})

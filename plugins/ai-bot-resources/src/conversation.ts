//
// Copyright © 2026 Intabia Fusion.
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

import { type AccountUuid, type Class, type Doc, getCurrentAccount, type Markup, type Ref } from '@hcengineering/core'
import chunter, { type ChatMessage, createAndGetDirect, type DirectMessage } from '@hcengineering/chunter'
import aiBot, { type AIContextMessage } from '@hcengineering/ai-bot'
import contact from '@hcengineering/contact'
import { getClient } from '@hcengineering/presentation'
import { jsonToMarkup } from '@hcengineering/text'
import { markdownToMarkup } from '@hcengineering/text-markdown'
import { get } from 'svelte/store'

import { aiBotSocialIdentityStore } from './utils'

/** Optional link back to the object that started the conversation. */
export interface ConversationOrigin {
  objectId: Ref<Doc>
  objectClass: Ref<Class<Doc>>
  label: string
}

export interface StartedConversation {
  direct: DirectMessage
  messageId: Ref<ChatMessage>
}

/** Resolve the AI bot's account uuid from its cached social identity. */
async function getBotAccount (): Promise<AccountUuid | undefined> {
  const identity = get(aiBotSocialIdentityStore)
  if (identity === undefined) return undefined
  const client = getClient()
  const person = await client.findOne(contact.class.Person, { _id: identity.attachedTo })
  return person?.personUuid as AccountUuid | undefined
}

/** Build a clickable reference-mention markdown to the origin object. */
function originMention (origin: ConversationOrigin): string {
  const cls = encodeURIComponent(origin.objectClass)
  const id = encodeURIComponent(origin.objectId)
  const label = encodeURIComponent(origin.label)
  return `[](ref://?_class=${cls}&_id=${id}&label=${label})`
}

/**
 * Start a new conversation with the AI bot in the user's Direct channel.
 *
 * Posts a top-level ChatMessage (= a new conversation); the server trigger makes
 * the bot reply in a thread under it. Returns the Direct and the new message id so
 * the caller can open the thread (see openThreadInSidebar in chunter-resources).
 *
 * Reusable across features (e.g. "discuss this task with Yulia"): pass the first
 * message and an optional origin link so the user can navigate back.
 */
export async function startAIConversation (
  message: Markup,
  origin?: ConversationOrigin
): Promise<StartedConversation | undefined> {
  const me = getCurrentAccount().uuid
  const botAccount = await getBotAccount()
  if (botAccount === undefined) return undefined

  const client = getClient()
  const direct = await createAndGetDirect(client, [me, botAccount])
  if (direct === undefined) return undefined

  // chunter stores Markup (JSON), not markdown. Convert with refUrl='ref://' so the origin
  // link parses into a reference node the server can read (else it stays as literal text and
  // the object context is lost).
  const md = origin !== undefined ? `${originMention(origin)}\n\n${message}` : message
  const body: Markup = jsonToMarkup(markdownToMarkup(md, { refUrl: 'ref://', imageUrl: '' }))

  // With an origin: a distinct AIContextMessage carrying the link in one tx, so the trigger
  // recognizes the thread starter by class and does not answer it top-level. Without: a plain
  // message (ordinary chat with the bot).
  const messageId =
    origin !== undefined
      ? await client.addCollection<DirectMessage, AIContextMessage>(
        aiBot.class.AIContextMessage,
        direct._id,
        direct._id,
        chunter.class.DirectMessage,
        'messages',
        { message: body, objectId: origin.objectId, objectClass: origin.objectClass, direct: direct._id }
      )
      : await client.addCollection<DirectMessage, ChatMessage>(
        chunter.class.ChatMessage,
        direct._id,
        direct._id,
        chunter.class.DirectMessage,
        'messages',
        { message: body }
      )

  return { direct, messageId }
}

/** The current user's existing object-linked conversation for an object, if any. */
export async function findObjectConversation (objectId: Ref<Doc>): Promise<AIContextMessage | undefined> {
  const client = getClient()
  const me = getCurrentAccount().uuid
  const botAccount = await getBotAccount()
  if (botAccount === undefined) return undefined
  // Resolve the user's Direct with the bot first and query within it: a plain findAll by
  // objectId can miss messages whose space is not in the active liveQuery subscription.
  const direct = await createAndGetDirect(client, [me, botAccount])
  if (direct === undefined) return undefined
  // Only the live (non-archived) context: the button always lands in the current one, never a
  // context the user explicitly reset away from.
  const contexts = await client.findAll(aiBot.class.AIContextMessage, {
    space: direct._id,
    objectId,
    archived: { $ne: true }
  })
  return contexts[0]
}

/**
 * Reset the context for an object: archive the current root and start a fresh one (same origin).
 * The archived thread stays in the chat, but the "discuss" button and the pod both work off the
 * new root. Returns the new conversation so the caller can reopen it.
 */
export async function resetObjectConversation (
  root: AIContextMessage,
  firstMessage: Markup
): Promise<StartedConversation | undefined> {
  const client = getClient()
  await client.updateDoc<AIContextMessage>(root._class, root.space, root._id, { archived: true })
  return await startAIConversation(firstMessage, {
    objectId: root.objectId,
    objectClass: root.objectClass,
    label: ''
  })
}

/**
 * Open the object-linked conversation with the bot, reusing the existing one when present.
 * Returns the root message + its Direct so the caller can open the thread in the sidebar.
 */
export async function openOrStartObjectConversation (
  origin: ConversationOrigin,
  firstMessage: Markup
): Promise<StartedConversation | undefined> {
  const existing = await findObjectConversation(origin.objectId)
  if (existing !== undefined) {
    const client = getClient()
    const direct = await client.findOne(chunter.class.DirectMessage, { _id: existing.direct as Ref<DirectMessage> })
    if (direct !== undefined) {
      return { direct, messageId: existing._id }
    }
  }
  return await startAIConversation(firstMessage, origin)
}

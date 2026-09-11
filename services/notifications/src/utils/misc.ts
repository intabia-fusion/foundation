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

import { AccountUuid, BlobType, Doc, type Hierarchy, Space } from '@hcengineering/core'
import contact, { Employee } from '@hcengineering/contact'
import { ActivityMessage } from '@hcengineering/activity'
import { NotificationMessage } from '@hcengineering/notification'
import { TypeMatchClient } from '@hcengineering/server-notification'
import chunter, { ChatMessage } from '@hcengineering/chunter'
import attachment, { Attachment } from '@hcengineering/attachment'

import { Client } from '../types'
import Cache from '../cache'

// ---- Collaborators ----

/**
 * Collects unique collaborator accounts for a document, filtering by space membership
 * for private spaces and excluding already-notified accounts.
 */
export async function getCollaboratorAccounts (
  client: Client,
  cache: Cache,
  doc: Doc,
  space: Space,
  notified: AccountUuid[] = []
): Promise<AccountUuid[]> {
  const collaborators = await cache.getCollaborators(doc._id, doc._class)

  const filtered = space.private ? collaborators.filter((it) => space.members.includes(it.collaborator)) : collaborators

  const accounts = new Set(filtered.map((it) => it.collaborator))

  // Employees are always collaborators on their own documents
  if (client.hierarchy.isDerived(doc._class, contact.mixin.Employee)) {
    const employeeAccount = (doc as Employee).personUuid
    if (employeeAccount != null) {
      accounts.add(employeeAccount)
    }
  }

  return Array.from(accounts).filter((it) => !notified.includes(it))
}

// ---- Client adapters ----

/**
 * Creates a TypeMatchClient adapter from the notification service Client.
 */
export function getTypeMatchClient (client: Client): TypeMatchClient {
  return {
    hierarchy: client.hierarchy,
    modelDb: client.model,
    txFactory: client.txFactory,
    ctx: client.ctx,
    branding: client.branding ?? null,
    findAll: (_ctx, _class, query, ops) => client.findAll(_class, query, ops)
  }
}

// ---- Message helpers ----

/**
 * Strips volatile activity-only fields from an ActivityMessage,
 * producing a stable NotificationMessage snapshot.
 */
export function toNotificationMessage (message: ActivityMessage): NotificationMessage {
  const { editedOn, replies, repliedPersons, reactions, isPinned, lastReply, ...notificationMessage } = message

  return notificationMessage
}

export function isChatMessage (message: ActivityMessage, hierarchy: Hierarchy): message is ChatMessage {
  return hierarchy.isDerived(message._class, chunter.class.ChatMessage)
}

/**
 * Fetches blob metadata for all file attachments of a chat message.
 */
export async function getAttachments (message: ActivityMessage, client: Client): Promise<BlobType[]> {
  if (!isChatMessage(message, client.hierarchy) || (message.attachments ?? 0) === 0) {
    return []
  }

  const attachments: Attachment[] = await client.findAll(attachment.class.Attachment, { attachedTo: message._id })
  return attachments.map((it) => ({
    file: it.file,
    type: it.type,
    name: it.name,
    size: it.size,
    metadata: it.metadata
  }))
}

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

import core, { AccountUuid, DocumentUpdate, Timestamp, TxCUD, TxUpdateDoc } from '@hcengineering/core'
import {
  DocNotifyContext,
  ReadState,
  ReadPosition,
  isUnreadMessageId,
  UnreadMessageId,
  isUnreadMessageChunk,
  UnreadMessageChunk
} from '@hcengineering/notification'

import { Client, Result } from '../types'
import Cache from '../cache'

const skipKeys = [
  '_id',
  '_class',
  'space',
  'createdOn',
  'modifiedOn',
  'createdBy',
  'modifiedBy',
  'latestMessageId',
  'latestMessageTimestamp',
  'attachedTo',
  'attachedToClass',
  'collection'
]

export async function handleReadState (
  client: Client,
  cache: Cache,
  result: Result,
  tx: TxCUD<ReadState>
): Promise<void> {
  if (tx._class !== core.class.TxUpdateDoc) return

  const updateTx = tx as TxUpdateDoc<ReadState>
  const updateKeys = Object.keys(updateTx.operations).filter((key) => !skipKeys.includes(key))

  if (updateKeys.length === 0) return

  const readState = await cache.getReadState(updateTx.objectId)
  if (readState == null) {
    client.ctx.warn('ReadState not found for read state update', { readStateId: updateTx.objectId })
    return
  }

  const contexts = await cache.getContexts(readState.attachedTo)

  for (const [key, value] of Object.entries(updateTx.operations)) {
    if (skipKeys.includes(key)) continue

    const account = key as AccountUuid
    const position = value as ReadPosition | null | undefined

    const ts = position?.timestamp ?? 0
    if (ts === 0) continue

    const context = contexts.find((it) => it.user === account)
    if (context == null) continue
    await readContext(client, result, context, ts)
  }
}

async function readContext (client: Client, result: Result, context: DocNotifyContext, ts: Timestamp): Promise<void> {
  const unreadMessagesToRead: UnreadMessageId[] = []
  const unreadChunksToRead: UnreadMessageChunk[] = []

  for (const unread of context.unreadMessages ?? []) {
    if (isUnreadMessageId(unread)) {
      if (unread.createdOn <= ts) {
        unreadMessagesToRead.push(unread)
      }
    } else if (isUnreadMessageChunk(unread)) {
      if (unread.to <= ts) {
        unreadChunksToRead.push(unread)
      }
    }
  }

  if (unreadMessagesToRead.length > 0) {
    const decrease = unreadMessagesToRead.filter((it) => it.notified === true).length
    const updateOps: DocumentUpdate<DocNotifyContext> = {
      $pull: {
        unreadMessages: { id: { $in: unreadMessagesToRead.map((it) => it.id) } }
      },
      ...(decrease > 0 ? { $inc: { unreadCount: -decrease } } : {})
    }

    result.updateContextTx.push(
      client.txFactory.createTxUpdateDoc(context._class, context.space, context._id, updateOps)
    )
  }

  if (unreadChunksToRead.length > 0) {
    const decrease = unreadChunksToRead.reduce((acc, it) => acc + (it.notifiedCount ?? 0), 0)

    const updateOps: DocumentUpdate<DocNotifyContext> = {
      $pull: {
        unreadMessages: { to: { $in: unreadChunksToRead.map((it) => it.to) } }
      },
      ...(decrease > 0 ? { $inc: { unreadCount: -decrease } } : {})
    }
    result.updateContextTx.push(
      client.txFactory.createTxUpdateDoc(context._class, context.space, context._id, updateOps)
    )
  }
}

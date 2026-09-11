//
// Copyright © 2024 Hardcore Engineering Inc.
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
import { sortActivityMessages } from '@hcengineering/activity-resources'
import { type ActivityMessage } from '@hcengineering/activity'
import notification, { type DocNotifyContext, type ReadState, isUnreadMessageId } from '@hcengineering/notification'
import { type Doc, getCurrentAccount, type Ref } from '@hcengineering/core'
import { get, writable } from 'svelte/store'
import { getClient } from '@hcengineering/presentation'

export function messageInView (msgElement: Element, containerRect: DOMRect): boolean {
  const rect = msgElement.getBoundingClientRect()
  return rect.bottom > containerRect.top && rect.top < containerRect.bottom
}

type MessagePick = Pick<ActivityMessage, '_id' | 'createdOn' | 'modifiedOn'>
const accumulatorsByChannel = new Map<string, Map<Ref<Doc>, MessagePick>>()
const timersByChannel = new Map<string, any>()

// NOTE: Store timestamp updates to avoid unnecessary updates if the server takes a long time to respond
const lastViewTimestampStore = writable<Map<Ref<Doc>, number>>(new Map())
// NOTE: Sometimes user can read message before notification is created and we should mark it as viewed when notification is received
export const chatReadMessagesStore = writable<Set<Ref<ActivityMessage>>>(new Set())

const toRead = new Set<Ref<ActivityMessage>>()
let toReadTimer: any

export function readViewportMessages (
  chatId: Ref<Doc>,
  messages: ActivityMessage[],
  scrollDiv?: HTMLElement | null,
  contentDiv?: HTMLElement | null,
  context?: DocNotifyContext,
  readState?: ReadState
): void {
  if (scrollDiv == null || contentDiv == null || messages.length === 0) return

  const scrollRect = scrollDiv.getBoundingClientRect()
  const messagesElements = contentDiv?.getElementsByClassName('activityMessage')

  for (const message of messages) {
    const msgElement = messagesElements?.[message._id as any]
    if (msgElement == null) continue

    if (messageInView(msgElement, scrollRect)) {
      let accumulator = accumulatorsByChannel.get(chatId)
      if (accumulator == null) {
        accumulator = new Map<Ref<Doc>, MessagePick>()
        accumulatorsByChannel.set(chatId, accumulator)
      }
      accumulator.set(message._id, {
        _id: message._id,
        createdOn: message.createdOn,
        modifiedOn: message.modifiedOn
      })
    }
  }

  const timer = timersByChannel.get(chatId)
  if (timer !== undefined) {
    clearTimeout(timer)
  }

  const newTimer = setTimeout(() => {
    timersByChannel.delete(chatId)
    const accumulator = accumulatorsByChannel.get(chatId)
    if (accumulator == null) return
    accumulatorsByChannel.delete(chatId)

    const messagesToRead = Array.from(accumulator.values())
    if (messagesToRead.length === 0) return
    void readMessages(sortActivityMessages(messagesToRead), context, readState)
  }, 500)

  timersByChannel.set(chatId, newTimer)
}

export function recheckNotifications (context: DocNotifyContext): void {
  const messages = get(chatReadMessagesStore)

  if (messages.size === 0) return

  for (const unread of context.unreadMessages ?? []) {
    if (isUnreadMessageId(unread)) {
      if (messages.has(unread.id)) {
        toRead.add(unread.id)
      }
    }
  }

  if (toRead.size === 0) return

  clearTimeout(toReadTimer)
  toReadTimer = setTimeout(() => {
    const toReadData = Array.from(toRead)
    toRead.clear()
    void (async () => {
      const client = getClient()
      const me = getCurrentAccount()
      await client.createDoc(notification.class.ReadNotificationAction, context.space, {
        attachedTo: context.objectId,
        attachedToClass: context.objectClass,
        account: me.uuid,
        messageIds: toReadData
      })
    })()
  }, 500)
}

export async function readMessages (
  messages: Array<Pick<ActivityMessage, '_id' | 'createdOn' | 'modifiedOn'>>,
  context?: DocNotifyContext,
  readState?: ReadState
): Promise<void> {
  if (messages.length === 0) return
  if (context == null && readState == null) return

  const messageIds = messages.map((m) => m._id)
  chatReadMessagesStore.update((store) => {
    for (const id of messageIds) {
      store.add(id)
    }
    return store
  })

  const client = getClient()
  const op = client.apply()
  const me = getCurrentAccount()
  const lastMessage = messages[messages.length - 1]
  const newTimestamp = lastMessage.createdOn ?? lastMessage.modifiedOn ?? 0

  if (readState != null && newTimestamp > 0) {
    const storedTimestampUpdates = get(lastViewTimestampStore).get(readState.attachedTo)
    const position = readState[me.uuid]
    const prevTimestamp = Math.max(storedTimestampUpdates ?? 0, position?.timestamp ?? 0)

    if (prevTimestamp < newTimestamp) {
      lastViewTimestampStore.update((store) => {
        store.set(readState.attachedTo, newTimestamp)
        return store
      })

      await op.update(readState, {
        [me.uuid]: {
          messageId: lastMessage._id,
          timestamp: newTimestamp
        }
      })
    }
  }

  if (context != null && context.unreadReactions.length > 0) {
    const messageIds = messages.map((m) => m._id)
    const reactionsToClear = context.unreadReactions.filter((r) => messageIds.includes(r.attachedTo))
    if (reactionsToClear.length > 0) {
      const reactionIds = reactionsToClear.map((r) => r.id)
      await op.createDoc(notification.class.ReadNotificationAction, context.space, {
        attachedTo: context.objectId,
        attachedToClass: context.objectClass,
        account: me.uuid,
        reactionIds
      })
    }
  }

  await op.commit()
}

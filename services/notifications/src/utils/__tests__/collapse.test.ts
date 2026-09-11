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

import { Ref } from '@hcengineering/core'
import { ActivityMessage } from '@hcengineering/activity'
import {
  isUnreadMessageChunk,
  isUnreadMessageId,
  UnreadMessage,
  UnreadMessageChunk,
  UnreadMessageId
} from '@hcengineering/notification'

import { collapseUnreadMessages, appendAndCollapseUnreadMessages, getChunkSize } from '../collapse'

describe('Unread Message Chunking Logic', () => {
  it('correctly calculates progressive chunk size', () => {
    // getChunkSize = candidateCount / 80, mapped to [10, 20, 30, 50, 100]
    expect(getChunkSize(0)).toBe(10)
    expect(getChunkSize(800)).toBe(10)
    expect(getChunkSize(801)).toBe(20)
    expect(getChunkSize(1600)).toBe(20)
    expect(getChunkSize(1601)).toBe(30)
    expect(getChunkSize(2400)).toBe(30)
    expect(getChunkSize(2401)).toBe(50)
    expect(getChunkSize(4000)).toBe(50)
    expect(getChunkSize(4001)).toBe(100)
    expect(getChunkSize(10000)).toBe(100)
  })

  it('does not collapse when total count <= 100', () => {
    const unreads: UnreadMessage[] = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${i}` as Ref<ActivityMessage>,
      createdOn: 1000 + i,
      notified: true
    }))

    const result = collapseUnreadMessages(unreads)
    expect(result).toHaveLength(100)
    expect(result[0]).toEqual({ id: 'msg-0' as Ref<ActivityMessage>, createdOn: 1000, notified: true })
  })

  it('collapses older messages but keeps the last 20 messages uncollapsed', () => {
    // 101 messages total (81 candidate messages, 20 tail messages)
    const unreads: UnreadMessage[] = Array.from({ length: 101 }, (_, i) => ({
      id: `msg-${i}` as Ref<ActivityMessage>,
      createdOn: 1000 + i,
      notified: i % 2 === 0 // alternating notified
    }))

    const result = collapseUnreadMessages(unreads)

    // Last 20 messages should be intact as UnreadMessageId
    const tail = result.slice(-20)
    expect(tail.every(isUnreadMessageId)).toBe(true)
    expect((tail[0] as UnreadMessageId).id).toBe('msg-81' as Ref<ActivityMessage>)

    // Candidates (msg-0 to msg-80, count = 81) should be collapsed
    // candidateCount = 81. requiredS = 81/80 = 1.0125 -> chunkSize = 10.
    // 81 candidates split into chunks of max size 10:
    // 8 chunks of size 10, 1 chunk of size 1 (remains msg-80 as UnreadMessageId)
    const candidates = result.slice(0, result.length - 20)
    expect(candidates).toHaveLength(9)

    // Check first chunk
    const firstChunk = candidates[0] as UnreadMessageChunk
    expect(isUnreadMessageChunk(firstChunk)).toBe(true)
    expect(firstChunk.count).toBe(10)
    expect(firstChunk.from).toBe(1000)
    expect(firstChunk.to).toBe(1009)
    // 5 notified messages in the first 10 (even indices: 0, 2, 4, 6, 8)
    expect(firstChunk.notifiedCount).toBe(5)

    // Check last element in candidates (the remainder of size 1, should not be converted to chunk)
    const remainder = candidates[8] as UnreadMessageId
    expect(isUnreadMessageId(remainder)).toBe(true)
    expect(remainder.id).toBe('msg-80' as Ref<ActivityMessage>)
  })

  it('never collapses messages with mentioned: true', () => {
    // 105 messages total:
    // msg-0 to msg-84 (candidates, count = 85)
    // msg-85 to msg-104 (tail, count = 20)
    // Let's make msg-10 and msg-50 mentions
    const unreads: UnreadMessage[] = Array.from({ length: 105 }, (_, i) => ({
      id: `msg-${i}` as Ref<ActivityMessage>,
      createdOn: 1000 + i,
      notified: true,
      mentioned: i === 10 || i === 50 ? true : undefined
    }))

    const result = collapseUnreadMessages(unreads)

    // Check that mentions are preserved in their original order
    const msg10 = result.find(
      (it) => isUnreadMessageId(it) && it.id === ('msg-10' as Ref<ActivityMessage>)
    ) as UnreadMessageId
    const msg50 = result.find(
      (it) => isUnreadMessageId(it) && it.id === ('msg-50' as Ref<ActivityMessage>)
    ) as UnreadMessageId

    expect(msg10).toBeDefined()
    expect(msg10.mentioned).toBe(true)
    expect(msg50).toBeDefined()
    expect(msg50.mentioned).toBe(true)

    // The result should contain the correct timeline sequence:
    // [Chunk (0-9), Mention(10), Chunk (11-49), Mention(50), Chunk (51-84), Tail(85-104)]
    // Let's verify the counts.
    // Candidate count: 85. chunkSize = 10 (85/80 = 1.06 -> 10)
    // Run 1: 0 to 9 (10 messages) -> 1 chunk of size 10
    // Mention 10
    // Run 2: 11 to 49 (39 messages) -> 3 chunks of size 10, 1 chunk of size 9
    // Mention 50
    // Run 3: 51 to 84 (34 messages) -> 3 chunks of size 10, 1 chunk of size 4
    // Tail: 85 to 104 (20 messages)

    // Total elements in result should be: 1 + 1 + 4 + 1 + 4 + 20 = 31 elements
    expect(result).toHaveLength(31)

    const c1 = result[0] as UnreadMessageChunk
    expect(c1.count).toBe(10)
    expect(c1.from).toBe(1000)
    expect(c1.to).toBe(1009)

    expect(result[1]).toEqual(unreads[10])

    const c2 = result[2] as UnreadMessageChunk
    expect(c2.count).toBe(10)
    expect(c2.from).toBe(1011)
    expect(c2.to).toBe(1020)

    const c3 = result[3] as UnreadMessageChunk
    expect(c3.count).toBe(10)
    expect(c3.from).toBe(1021)
    expect(c3.to).toBe(1030)

    expect(result[6]).toEqual(unreads[50])
  })

  it('appendAndCollapseUnreadMessages appends and collapses if threshold is exceeded', () => {
    const unreads: UnreadMessage[] = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${i}` as Ref<ActivityMessage>,
      createdOn: 1000 + i,
      notified: true
    }))

    const newMessage: UnreadMessage = {
      id: 'msg-100' as Ref<ActivityMessage>,
      createdOn: 1100,
      notified: true
    }

    const { collapsed, didCollapse } = appendAndCollapseUnreadMessages(unreads, newMessage)

    expect(didCollapse).toBe(true)
    // Candidates: 81 messages (msg-0 to msg-80). Chunk size 10.
    // 8 chunks of size 10 + 1 message (msg-80) + 20 tail = 29 elements total.
    expect(collapsed).toHaveLength(29)
  })
})

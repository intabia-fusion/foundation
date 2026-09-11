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

import { isUnreadMessageChunk, isUnreadMessageId, UnreadMessage } from '@hcengineering/notification'

export function getChunkSize (candidateCount: number): number {
  const S_OPTIONS = [10, 20, 30, 50, 100]
  const requiredS = candidateCount / 80
  for (const s of S_OPTIONS) {
    if (s >= requiredS) {
      return s
    }
  }
  return 100
}

function mergeGroup (group: UnreadMessage[]): UnreadMessage[] {
  if (group.length === 1) {
    return group
  }

  let from = Infinity
  let to = -Infinity
  let count = 0
  let notifiedCount = 0

  for (const item of group) {
    if (isUnreadMessageId(item)) {
      from = Math.min(from, item.createdOn)
      to = Math.max(to, item.createdOn)
      count += 1
      if (item.notified === true) {
        notifiedCount += 1
      }
    } else if (isUnreadMessageChunk(item)) {
      from = Math.min(from, item.from)
      to = Math.max(to, item.to)
      count += item.count
      if (item.notifiedCount !== undefined) {
        notifiedCount += item.notifiedCount
      }
    }
  }

  return [
    {
      from,
      to,
      count,
      notifiedCount: notifiedCount > 0 ? notifiedCount : undefined
    }
  ]
}

function splitAndMergeRun (run: UnreadMessage[], maxChunkSize: number): UnreadMessage[] {
  const merged: UnreadMessage[] = []
  let currentGroup: UnreadMessage[] = []
  let currentGroupCount = 0

  for (const item of run) {
    const itemCount = isUnreadMessageChunk(item) ? item.count : 1

    if (currentGroup.length > 0 && currentGroupCount + itemCount > maxChunkSize) {
      merged.push(...mergeGroup(currentGroup))
      currentGroup = []
      currentGroupCount = 0
    }

    currentGroup.push(item)
    currentGroupCount += itemCount
  }

  if (currentGroup.length > 0) {
    merged.push(...mergeGroup(currentGroup))
  }

  return merged
}

export function collapseUnreadMessages (unreadMessages: UnreadMessage[]): UnreadMessage[] {
  const totalCount = unreadMessages.reduce((acc, it) => acc + (isUnreadMessageChunk(it) ? it.count : 1), 0)

  if (totalCount <= 100) {
    return unreadMessages
  }

  const keepCount = 20
  let tailStartIndex = unreadMessages.length
  let tailCount = 0

  for (let i = unreadMessages.length - 1; i >= 0; i--) {
    const item = unreadMessages[i]
    const itemCount = isUnreadMessageChunk(item) ? item.count : 1
    if (tailCount + itemCount <= keepCount) {
      tailCount += itemCount
      tailStartIndex = i
    } else {
      break
    }
  }

  const candidates = unreadMessages.slice(0, tailStartIndex)
  const tail = unreadMessages.slice(tailStartIndex)

  const candidateCount = candidates.reduce((acc, it) => acc + (isUnreadMessageChunk(it) ? it.count : 1), 0)
  const maxChunkSize = getChunkSize(candidateCount)

  const collapsedCandidates: UnreadMessage[] = []
  let currentRun: UnreadMessage[] = []

  for (const item of candidates) {
    const isMention = isUnreadMessageId(item) && item.mentioned === true

    if (isMention) {
      if (currentRun.length > 0) {
        collapsedCandidates.push(...splitAndMergeRun(currentRun, maxChunkSize))
        currentRun = []
      }
      collapsedCandidates.push(item)
    } else {
      currentRun.push(item)
    }
  }

  if (currentRun.length > 0) {
    collapsedCandidates.push(...splitAndMergeRun(currentRun, maxChunkSize))
  }

  return [...collapsedCandidates, ...tail]
}

export function appendAndCollapseUnreadMessages (
  unreadMessages: UnreadMessage[],
  newMessage: UnreadMessage
): { collapsed: UnreadMessage[], didCollapse: boolean } {
  const currentUnreads = [...unreadMessages, newMessage]
  const collapsed = collapseUnreadMessages(currentUnreads)
  return {
    collapsed,
    didCollapse: collapsed.length < currentUnreads.length
  }
}

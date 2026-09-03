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

/**
 * Deciding what to compact. Pure: reading the file, calling the model and writing the summary back
 * happen in WorkspaceClient; here we only pick the cut.
 *
 * Without this the oldest turns were dropped silently by `buildThreadContext` - an agreement made
 * at the start of a conversation disappeared with no trace in the file, in the prompt or in the log.
 */

import type { SnapshotTurn } from './conversationSnapshot'

/** Same defaults pi runs with; both overridable through `limits:` in the pod config. */
export const DEFAULT_RESERVE_TOKENS = 16384
export const DEFAULT_KEEP_RECENT_TOKENS = 20000

export interface CompactionInput {
  /** Every turn in the file, oldest first, tool turns included. */
  turns: SnapshotTurn[]
  /** Where the previous compaction left the live tail; undefined when never compacted. */
  firstKept?: string
  countTokens: (text: string) => number
  /** Context budget of the serving level. */
  budgetTokens: number
  reserveTokens?: number
  keepRecentTokens?: number
  /** Compact even though the history nominally fits: the provider just refused it as too long. */
  force?: boolean
}

export interface CompactionPlan {
  needed: boolean
  /** Turns to fold into a summary. Empty when there is nothing older than the tail. */
  toSummarize: SnapshotTurn[]
  /** Turns that stay verbatim. */
  kept: SnapshotTurn[]
  /** `messageId` of the first kept turn - written to the file so the next run starts here. */
  firstKeptId?: string
}

/** Turns the model actually sees; tool turns are kept in the file for people, not for the model. */
function visible (turns: SnapshotTurn[]): SnapshotTurn[] {
  return turns.filter((t) => t.role !== 'tool')
}

function tokensOf (turns: SnapshotTurn[], countTokens: (text: string) => number): number {
  return visible(turns).reduce((sum, t) => sum + countTokens(t.content), 0)
}

/**
 * Where the live tail starts. Walking back from the newest turn we gather `keepRecentTokens`, then
 * step back to the nearest `user` turn: cutting between a question and its answer leaves the model
 * with an answer to something it cannot see.
 */
function findCutIndex (turns: SnapshotTurn[], countTokens: (text: string) => number, keepRecent: number): number {
  let total = 0
  let index = turns.length
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn.role !== 'tool') {
      const next = total + countTokens(turn.content)
      if (next > keepRecent && index < turns.length) break
      total = next
    }
    index = i
  }
  // Land on a user turn: it opens a turn, everything after it belongs to that turn.
  while (index < turns.length && turns[index].role !== 'user') index++
  return index
}

export function planCompaction (input: CompactionInput): CompactionPlan {
  const { turns, countTokens } = input
  const reserve = input.reserveTokens ?? DEFAULT_RESERVE_TOKENS
  const keepRecent = input.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS

  const fits = tokensOf(turns, countTokens) <= Math.max(0, input.budgetTokens - reserve)
  if (fits && input.force !== true) {
    return { needed: false, toSummarize: [], kept: turns }
  }

  const cut = findCutIndex(turns, countTokens, keepRecent)
  // The whole history is one enormous tail: nothing older to fold, the window trim handles it.
  if (cut <= 0) {
    return { needed: false, toSummarize: [], kept: turns }
  }

  // A repeat compaction folds from where the previous one left off, not from its summary: turns
  // that survived last time have to take part again, otherwise they vanish between the two.
  const from = input.firstKept !== undefined ? turns.findIndex((t) => t.messageId === input.firstKept) : 0
  const start = from >= 0 ? from : 0
  const toSummarize = turns.slice(start, cut)
  if (toSummarize.length === 0) {
    return { needed: false, toSummarize: [], kept: turns }
  }

  const kept = turns.slice(cut)
  return {
    needed: true,
    toSummarize,
    kept,
    firstKeptId: kept.find((t) => t.messageId !== undefined)?.messageId
  }
}

/**
 * The provider refused the request because the context is too long. Token counts are estimates
 * (tiktoken against a GigaChat model is a guess), so this happens even inside a budget we thought
 * we respected - hence a compact-and-retry rather than a straight failure.
 */
export function isContextOverflow (err: unknown): boolean {
  const raw = (err as { message?: unknown })?.message
  const message = (typeof raw === 'string' ? raw : String(err ?? '')).toLowerCase()
  const source = err as { code?: unknown, status?: unknown } | undefined
  const code = String(source?.code ?? source?.status ?? '')
  return (
    message.includes('context_length_exceeded') ||
    message.includes('context length') ||
    message.includes('maximum context') ||
    message.includes('too many tokens') ||
    message.includes('prompt is too long') ||
    code === '413'
  )
}

/** The turns as plain text for the summarizer: roles and bodies, tool traffic left out. */
export function renderForSummary (turns: SnapshotTurn[]): string {
  return visible(turns)
    .map((t) => `[${t.role === 'user' ? t.author : 'assistant'}]: ${t.content}`)
    .join('\n\n')
}

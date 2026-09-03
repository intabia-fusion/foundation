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
 * Ceilings on what tools put into the context.
 *
 * A tool that answers with the whole channel, or with a task carrying a hundred sub-tasks, can
 * overflow the model window on its own: the provider then answers 422 and the request is lost.
 * The cut is by characters, not tokens - the tokenizer is not wired into the tools, and this is a
 * guard rail, not accounting. What matters more is that the text says it was cut and how to read
 * the rest, so the model asks for the next slice instead of assuming it saw everything.
 */

/** Roughly 4 characters per token across the languages we serve (same figure as prompts.ts). */
export const CHARS_PER_TOKEN = 4

export interface TruncateResult {
  text: string
  truncated: boolean
  keptChars: number
  totalChars: number
}

/**
 * Keep the head of `text` within `maxChars`, cutting on a line boundary. `hint` is appended as the
 * instruction on how to get the rest; it is never itself truncated.
 */
export function truncateForModel (text: string, maxChars: number, hint?: string): TruncateResult {
  const total = text.length
  if (maxChars <= 0 || total <= maxChars) {
    return { text, truncated: false, keptChars: total, totalChars: total }
  }

  const head = text.slice(0, maxChars)
  const lastBreak = head.lastIndexOf('\n')
  // A single line longer than the budget has no boundary to cut on: take it as is rather than
  // returning nothing.
  const kept = lastBreak > 0 ? head.slice(0, lastBreak) : head
  const note = `\n\n[...truncated: showing ${kept.length} of ${total} characters${
    hint !== undefined && hint !== '' ? `. ${hint}` : ''
  }]`
  return { text: kept + note, truncated: true, keptChars: kept.length, totalChars: total }
}

/** Budget shared by every tool result of one run; see ReqCtx.budget. */
export interface ToolBudget {
  maxChars: number
  spentChars: number
}

/** Ceiling for one tool result and for all of them together, derived from the level's window. */
export function toolBudgets (contextBudgetTokens: number): { perCall: number, perRun: number } {
  const chars = Math.max(0, contextBudgetTokens) * CHARS_PER_TOKEN
  return { perCall: Math.floor(chars * 0.15), perRun: Math.floor(chars * 0.4) }
}

/**
 * Apply both ceilings to one tool result. Returns what the model should see; `budget.spentChars`
 * grows by what was kept. Once the run budget is gone every further result is replaced outright -
 * a model that keeps fetching must be told to answer with what it has.
 */
export function applyToolBudget (content: string, perCall: number, budget?: ToolBudget): string {
  if (budget !== undefined && budget.spentChars >= budget.maxChars) {
    return (
      'Too much data has been gathered in this conversation. Answer with what you already have ' +
      'and do not call any more tools.'
    )
  }
  const left = budget !== undefined ? budget.maxChars - budget.spentChars : Number.MAX_SAFE_INTEGER
  const limit = Math.min(perCall, left)
  const result = truncateForModel(content, limit, 'Request the rest in a separate call if you need it.')
  if (budget !== undefined) {
    budget.spentChars += result.keptChars
  }
  return result.text
}

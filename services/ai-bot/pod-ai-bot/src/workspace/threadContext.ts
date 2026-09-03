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

/** A single conversation turn from a chunter thread, prepared for the LLM. */
export interface ContextMessage {
  role: 'user' | 'assistant'
  content: string
  tokens: number
}

export interface ContextLine {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/**
 * Truncate thread messages to fit the model context window, keeping the most recent ones.
 *
 * The hard cap of 20 turns that used to sit here is gone: it hid whatever a large window could
 * have held, and what no longer fits is now folded into a summary by compaction rather than
 * dropped (see workspace/compaction.ts).
 */
export function buildThreadContext (
  messages: ContextMessage[],
  promptTokens: number,
  maxContentTokens: number
): ContextLine[] {
  const result: ContextLine[] = []
  let total = promptTokens

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (total + m.tokens > maxContentTokens) break
    result.unshift({ role: m.role, content: m.content })
    total += m.tokens
  }

  return result
}

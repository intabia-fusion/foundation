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
 * Truncate thread messages to fit the model context window.
 *
 * Messages come in chronological order (oldest first). We keep the most recent
 * ones that fit within `maxContentTokens` together with the incoming prompt,
 * preserving order. Pure: no I/O, fully unit-testable.
 */
export function buildThreadContext (
  messages: ContextMessage[],
  promptTokens: number,
  maxContentTokens: number,
  maxRecentMessages = 20
): ContextLine[] {
  const recent = messages.slice(-maxRecentMessages)
  const result: ContextLine[] = []
  let total = promptTokens

  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]
    if (total + m.tokens > maxContentTokens) break
    result.unshift({ role: m.role, content: m.content })
    total += m.tokens
  }

  return result
}

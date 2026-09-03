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

import type { ToolCall } from './types'

export interface InlineParseResult {
  toolCalls: ToolCall[]
  content: string // remaining human-facing text (function-call markup stripped)
}

// Local OpenAI-compatible servers without a tool-call parser (gpt-oss/GigaChat harmony) leak
// calls as `<|function_call|>{...}` text in the assistant reply; match the marker + JSON object.
const MARKER = /<\|function_call\|>\s*/g

/** Extract a balanced JSON object starting at `start` (which must point at '{'). */
function readJsonObject (s: string, start: number): { json: string, end: number } | undefined {
  if (s[start] !== '{') return undefined
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { json: s.slice(start, i + 1), end: i + 1 }
    }
  }
  return undefined
}

/** Parse inline `<|function_call|>{...}` markers into ToolCalls plus the leftover human-facing text. */
export function parseInlineToolCalls (text: string): InlineParseResult {
  if (text === '' || !text.includes('<|function_call|>')) {
    return { toolCalls: [], content: text }
  }

  const toolCalls: ToolCall[] = []
  let content = ''
  let lastIndex = 0
  let idx = 0
  MARKER.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MARKER.exec(text)) !== null) {
    const jsonStart = m.index + m[0].length
    const obj = readJsonObject(text, jsonStart)
    if (obj === undefined) {
      // Malformed; keep scanning after the marker.
      content += text.slice(lastIndex, m.index)
      lastIndex = jsonStart
      continue
    }
    content += text.slice(lastIndex, m.index)
    lastIndex = obj.end
    MARKER.lastIndex = obj.end
    try {
      const parsed = JSON.parse(obj.json)
      const name = typeof parsed?.name === 'string' ? parsed.name : ''
      if (name !== '') {
        const rawArgs = parsed?.arguments
        const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {})
        toolCalls.push({ id: `inline_${idx++}`, name, arguments: args })
      }
    } catch {
      // Not valid JSON after the marker - drop it from content, ignore as a call.
    }
  }
  content += text.slice(lastIndex)
  return { toolCalls, content: content.trim() }
}

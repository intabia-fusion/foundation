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

import { parseInlineToolCalls } from '../llms/inlineToolCalls'

describe('parseInlineToolCalls', () => {
  it('returns plain text unchanged when no marker', () => {
    const r = parseInlineToolCalls('Привет! Чем помочь?')
    expect(r.toolCalls).toHaveLength(0)
    expect(r.content).toBe('Привет! Чем помочь?')
  })

  it('parses a single inline function call (object arguments)', () => {
    const r = parseInlineToolCalls('<|function_call|>{"name": "get_shared_context", "arguments": {}}')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].name).toBe('get_shared_context')
    expect(r.toolCalls[0].arguments).toBe('{}')
    expect(r.content).toBe('')
  })

  it('parses nested object arguments and serializes them to a JSON string', () => {
    const r = parseInlineToolCalls(
      '<|function_call|>{"name": "update_assistant_memory", "arguments": {"memory": "Привет {x}"}}'
    )
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].name).toBe('update_assistant_memory')
    expect(JSON.parse(r.toolCalls[0].arguments)).toEqual({ memory: 'Привет {x}' })
  })

  it('keeps a string arguments value as-is', () => {
    const r = parseInlineToolCalls('<|function_call|>{"name": "f", "arguments": "{\\"a\\":1}"}')
    expect(r.toolCalls[0].arguments).toBe('{"a":1}')
  })

  it('strips the marker and keeps surrounding text', () => {
    const r = parseInlineToolCalls('before <|function_call|>{"name":"f","arguments":{}} after')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.content).toBe('before  after'.trim())
  })

  it('handles braces inside string arguments without breaking JSON balance', () => {
    const r = parseInlineToolCalls('<|function_call|>{"name":"f","arguments":{"t":"a {b} c }"}}')
    expect(r.toolCalls).toHaveLength(1)
    expect(JSON.parse(r.toolCalls[0].arguments)).toEqual({ t: 'a {b} c }' })
  })

  it('parses multiple inline calls', () => {
    const r = parseInlineToolCalls(
      '<|function_call|>{"name":"a","arguments":{}}<|function_call|>{"name":"b","arguments":{"x":1}}'
    )
    expect(r.toolCalls.map((c) => c.name)).toEqual(['a', 'b'])
  })

  it('ignores malformed JSON after the marker', () => {
    const r = parseInlineToolCalls('<|function_call|>not-json here')
    expect(r.toolCalls).toHaveLength(0)
  })
})

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

import { buildThreadContext, type ContextMessage } from '../workspace/threadContext'

function msg (role: 'user' | 'assistant', content: string, tokens: number): ContextMessage {
  return { role, content, tokens }
}

describe('buildThreadContext', () => {
  it('keeps all messages when they fit and preserves order', () => {
    const messages = [msg('user', 'a', 10), msg('assistant', 'b', 10), msg('user', 'c', 10)]
    const out = buildThreadContext(messages, 5, 1000)
    expect(out).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }
    ])
  })

  it('drops oldest messages to fit the token budget', () => {
    const messages = [msg('user', 'old', 50), msg('assistant', 'mid', 30), msg('user', 'new', 20)]
    // budget 100, prompt 10 -> remaining 90: 'new'(20)+'mid'(30)=50 fit, +'old'(50)=100 > 90 -> drop 'old'
    const out = buildThreadContext(messages, 10, 100)
    expect(out).toEqual([
      { role: 'assistant', content: 'mid' },
      { role: 'user', content: 'new' }
    ])
  })

  it('returns empty when even the newest message does not fit', () => {
    const messages = [msg('user', 'huge', 1000)]
    expect(buildThreadContext(messages, 0, 100)).toEqual([])
  })

  // The old hard cap of 20 turns hid what a large window could hold; the budget is the only limit
  // now, and what does not fit is folded into a summary by compaction, not dropped.
  it('keeps every message that fits the budget, however many', () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg('user', `m${i}`, 1))
    const out = buildThreadContext(messages, 0, 10000)
    expect(out).toHaveLength(30)
    expect(out[0].content).toBe('m0')
    expect(out[29].content).toBe('m29')
  })

  it('still drops the oldest when the budget runs out', () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg('user', `m${i}`, 1))
    const out = buildThreadContext(messages, 0, 5)
    expect(out).toHaveLength(5)
    expect(out[0].content).toBe('m25')
  })

  it('accounts for the incoming prompt tokens', () => {
    const messages = [msg('user', 'a', 40), msg('assistant', 'b', 40)]
    // budget 100, prompt 70 -> remaining 30: neither 40-token message fits
    expect(buildThreadContext(messages, 70, 100)).toEqual([])
  })

  it('handles an empty thread', () => {
    expect(buildThreadContext([], 5, 100)).toEqual([])
  })
})

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

import { isContextOverflow, planCompaction, renderForSummary } from '../workspace/compaction'
import type { SnapshotTurn } from '../workspace/conversationSnapshot'

// One "word" is one token here, so the arithmetic in the tests is readable.
const countTokens = (text: string): number => text.split(/\s+/).filter((w) => w !== '').length

const turn = (role: SnapshotTurn['role'], content: string, messageId?: string): SnapshotTurn => ({
  role,
  author: role === 'user' ? 'Андрей' : 'Юля',
  at: 0,
  messageId,
  content
})

/** n exchanges of `size` tokens each: user question, tool call, assistant answer. */
const conversation = (n: number, size = 10): SnapshotTurn[] => {
  const out: SnapshotTurn[] = []
  for (let i = 0; i < n; i++) {
    out.push(turn('user', `вопрос ${i} ${'слово '.repeat(size)}`, `u${i}`))
    out.push(turn('tool', `{"tool":"propose_task"} ${'x '.repeat(size)}`))
    out.push(turn('assistant', `ответ ${i} ${'слово '.repeat(size)}`, `a${i}`))
  }
  return out
}

describe('planCompaction', () => {
  it('does nothing while the conversation fits', () => {
    const plan = planCompaction({
      turns: conversation(3),
      countTokens,
      budgetTokens: 10000,
      reserveTokens: 100,
      keepRecentTokens: 100
    })
    expect(plan.needed).toBe(false)
    expect(plan.toSummarize).toHaveLength(0)
  })

  it('folds the old part and keeps the recent tail', () => {
    const turns = conversation(10)
    const plan = planCompaction({
      turns,
      countTokens,
      budgetTokens: 120,
      reserveTokens: 20,
      keepRecentTokens: 60
    })
    expect(plan.needed).toBe(true)
    expect(plan.toSummarize.length).toBeGreaterThan(0)
    expect(plan.kept.length).toBeGreaterThan(0)
    expect(plan.toSummarize.length + plan.kept.length).toBe(turns.length)
  })

  // An answer whose question was folded away reads as an answer to nothing.
  it('cuts on a user turn, never between a question and its answer', () => {
    const plan = planCompaction({
      turns: conversation(10),
      countTokens,
      budgetTokens: 120,
      reserveTokens: 20,
      keepRecentTokens: 60
    })
    expect(plan.kept[0].role).toBe('user')
  })

  it('never cuts on a tool turn', () => {
    const plan = planCompaction({
      turns: conversation(8),
      countTokens,
      budgetTokens: 100,
      reserveTokens: 10,
      keepRecentTokens: 40
    })
    expect(plan.kept[0].role).not.toBe('tool')
  })

  it('reports where the live tail begins', () => {
    const plan = planCompaction({
      turns: conversation(10),
      countTokens,
      budgetTokens: 120,
      reserveTokens: 20,
      keepRecentTokens: 60
    })
    expect(plan.firstKeptId).toBe(plan.kept[0].messageId)
  })

  // Turns that survived the previous compaction must take part in the next one, otherwise they
  // fall between the two summaries and are lost for good.
  it('a repeat compaction folds from the previous boundary, not from the summary', () => {
    const turns = conversation(12)
    const plan = planCompaction({
      turns,
      firstKept: 'u4',
      countTokens,
      budgetTokens: 120,
      reserveTokens: 20,
      keepRecentTokens: 60
    })
    expect(plan.toSummarize[0].messageId).toBe('u4')
  })

  it('leaves a single huge turn alone - there is nothing older to fold', () => {
    const turns = [turn('user', 'слово '.repeat(500), 'u0')]
    const plan = planCompaction({ turns, countTokens, budgetTokens: 100, reserveTokens: 10, keepRecentTokens: 10 })
    expect(plan.needed).toBe(false)
  })

  it('ignores tool turns when measuring: the model never sees them', () => {
    const withTools = [
      turn('user', 'слово '.repeat(5), 'u0'),
      turn('tool', 'слово '.repeat(500)),
      turn('assistant', 'слово '.repeat(5), 'a0')
    ]
    const plan = planCompaction({
      turns: withTools,
      countTokens,
      budgetTokens: 100,
      reserveTokens: 10,
      keepRecentTokens: 50
    })
    expect(plan.needed).toBe(false)
  })
})

describe('renderForSummary', () => {
  it('names the speakers and drops tool traffic', () => {
    const text = renderForSummary(conversation(1, 1))
    expect(text).toContain('[Андрей]: вопрос 0')
    expect(text).toContain('[assistant]: ответ 0')
    expect(text).not.toContain('propose_task')
  })
})

describe('isContextOverflow', () => {
  const cases = [
    "This model's maximum context length is 8192 tokens",
    'Error code: 400 - context_length_exceeded',
    'prompt is too long: 210000 tokens',
    'Too many tokens in request'
  ]

  it.each(cases)('recognizes %s', (message) => {
    expect(isContextOverflow(new Error(message))).toBe(true)
  })

  it('recognizes a 413 by code', () => {
    expect(isContextOverflow({ status: 413 })).toBe(true)
  })

  // Every other failure must stay a plain failure: retrying a network error by compacting the
  // conversation would throw away history for nothing.
  it('leaves unrelated failures alone', () => {
    expect(isContextOverflow(new Error('socket hang up'))).toBe(false)
    expect(isContextOverflow(undefined)).toBe(false)
  })
})

describe('forced compaction', () => {
  it('folds even when the history nominally fits', () => {
    const plan = planCompaction({
      turns: conversation(6),
      countTokens,
      budgetTokens: 100000,
      reserveTokens: 100,
      keepRecentTokens: 30,
      force: true
    })
    expect(plan.needed).toBe(true)
    expect(plan.toSummarize.length).toBeGreaterThan(0)
  })
})

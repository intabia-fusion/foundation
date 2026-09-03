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

import {
  appendTurns,
  parseSnapshot,
  renderSnapshot,
  snapshotBlobId,
  snapshotMessageIds,
  type SnapshotTurn
} from '../workspace/conversationSnapshot'

const turn = (over: Partial<SnapshotTurn> = {}): SnapshotTurn => ({
  role: 'user',
  author: 'Sobolev Andrey',
  at: Date.parse('2026-08-21T17:46:06.000Z'),
  messageId: 'msg1',
  content: 'Заведи задачу',
  ...over
})

describe('conversation snapshot', () => {
  it('round-trips a conversation', () => {
    const snapshot = {
      conversation: 'root1',
      object: 'tracker:class:Issue:TSK-38',
      cursor: 100,
      turns: [
        turn(),
        turn({ role: 'tool', author: 'propose_task', messageId: undefined, content: '{"title":"Бага"}' }),
        turn({ role: 'assistant', author: 'Юля', messageId: 'msg2', content: 'Задача создана.' })
      ]
    }
    const parsed = parseSnapshot(renderSnapshot(snapshot))
    expect(parsed).toEqual(snapshot)
  })

  it('keeps a --- line inside a body from splitting the file', () => {
    const body = 'before\n---\nafter'
    const parsed = parseSnapshot(renderSnapshot({ conversation: 'c', cursor: 0, turns: [turn({ content: body })] }))
    expect(parsed?.turns).toHaveLength(1)
    expect(parsed?.turns[0].content).toBe(body)
  })

  it('survives an apostrophe in the object name', () => {
    const parsed = parseSnapshot(
      renderSnapshot({ conversation: "it's", object: "o'brien", cursor: 1, turns: [turn()] })
    )
    expect(parsed?.conversation).toBe("it's")
    expect(parsed?.object).toBe("o'brien")
  })

  it('returns undefined for anything not written by us', () => {
    expect(parseSnapshot('just some markdown')).toBeUndefined()
    expect(parseSnapshot('')).toBeUndefined()
  })

  it('appends new turns and anchors the cursor on the newest incoming message', () => {
    const first = appendTurns(undefined, 'c', 'obj', [turn()], 100)
    const later = Date.parse('2026-08-21T17:47:00.000Z')
    const second = appendTurns(first, 'c', 'obj', [turn({ messageId: 'msg2', at: later, role: 'user' })], 100)
    expect(second.turns).toHaveLength(2)
    expect(second.cursor).toBe(later)
  })

  // Anchoring on the answer would skip whatever other people posted while the model was thinking.
  it('leaves the cursor on the request, not on the answer that followed it', () => {
    const asked = Date.parse('2026-08-21T17:46:00.000Z')
    const answered = Date.parse('2026-08-21T17:46:40.000Z')
    const snapshot = appendTurns(
      undefined,
      'c',
      undefined,
      [
        turn({ messageId: 'ask', at: asked }),
        turn({ role: 'assistant', author: 'Юля', messageId: 'answer', at: answered, content: 'ok' })
      ],
      100
    )
    expect(snapshot.cursor).toBe(asked)
    expect(snapshotMessageIds(snapshot)).toEqual(new Set(['ask', 'answer']))
  })

  it('drops a redelivered turn instead of duplicating it', () => {
    const first = appendTurns(undefined, 'c', undefined, [turn()], 100)
    const again = appendTurns(first, 'c', undefined, [turn()], 100)
    expect(again.turns).toHaveLength(1)
  })

  it('keeps tool turns even though they repeat', () => {
    const tool = turn({ role: 'tool', author: 'propose_task', messageId: undefined })
    const first = appendTurns(undefined, 'c', undefined, [tool], 100)
    const again = appendTurns(first, 'c', undefined, [tool], 100)
    expect(again.turns).toHaveLength(2)
  })

  it('caps the file at the newest turns', () => {
    let snapshot = appendTurns(undefined, 'c', undefined, [turn({ messageId: 'a', at: 1 })], 2)
    snapshot = appendTurns(snapshot, 'c', undefined, [turn({ messageId: 'b', at: 2 })], 2)
    snapshot = appendTurns(snapshot, 'c', undefined, [turn({ messageId: 'd', at: 3 })], 2)
    expect(snapshot.turns.map((t) => t.messageId)).toEqual(['b', 'd'])
  })

  it('names one file per conversation', () => {
    expect(snapshotBlobId('root1')).toBe('ai-snapshot-root1.mdx')
  })
})

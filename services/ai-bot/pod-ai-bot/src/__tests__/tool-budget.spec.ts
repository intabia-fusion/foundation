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

import { applyToolBudget, toolBudgets, truncateForModel, type ToolBudget } from '../utils/budget'

const lines = (n: number, width = 20): string =>
  Array.from({ length: n }, (_, i) => `${i}`.padEnd(width, 'x')).join('\n')

describe('truncateForModel', () => {
  it('leaves text that fits untouched', () => {
    const r = truncateForModel('короткий ответ', 100)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('короткий ответ')
  })

  it('cuts on a line boundary, never mid-line', () => {
    const r = truncateForModel(lines(50), 100)
    expect(r.truncated).toBe(true)
    const body = r.text.split('\n\n[...truncated')[0]
    expect(body.split('\n').every((l) => l.length === 20)).toBe(true)
  })

  // A cut the model cannot see is a cut it will assume did not happen.
  it('says how much was cut and how to read the rest', () => {
    const r = truncateForModel(lines(50), 100, 'Call again with beforeIso.')
    expect(r.text).toContain('truncated')
    expect(r.text).toContain(`of ${lines(50).length} characters`)
    expect(r.text).toContain('Call again with beforeIso.')
  })

  it('keeps a single over-long line rather than returning nothing', () => {
    const r = truncateForModel('x'.repeat(500), 100)
    expect(r.truncated).toBe(true)
    expect(r.keptChars).toBe(100)
  })

  it('treats a zero budget as no limit', () => {
    expect(truncateForModel('abc', 0).truncated).toBe(false)
  })
})

describe('applyToolBudget', () => {
  const budget = (): ToolBudget => ({ maxChars: 300, spentChars: 0 })

  it('charges the run budget for what was kept', () => {
    const b = budget()
    applyToolBudget(lines(10), 1000, b)
    expect(b.spentChars).toBeGreaterThan(0)
    expect(b.spentChars).toBeLessThanOrEqual(300)
  })

  it('caps one result at the per-call ceiling', () => {
    const b = budget()
    const out = applyToolBudget(lines(100), 100, b)
    expect(out).toContain('truncated')
  })

  // Otherwise a model that keeps fetching walks the whole run into the window.
  it('replaces further results once the run budget is gone', () => {
    const b: ToolBudget = { maxChars: 50, spentChars: 50 }
    const out = applyToolBudget('что-то ещё', 1000, b)
    expect(out).toContain('Answer with what you already have')
    expect(out).not.toContain('что-то ещё')
  })

  it('works without a run budget at all', () => {
    expect(applyToolBudget('короткий', 1000)).toBe('короткий')
  })
})

describe('toolBudgets', () => {
  it('scales both ceilings with the level window', () => {
    const b = toolBudgets(100000)
    expect(b.perCall).toBe(Math.floor(100000 * 4 * 0.15))
    expect(b.perRun).toBe(Math.floor(100000 * 4 * 0.4))
    expect(b.perCall).toBeLessThan(b.perRun)
  })
})

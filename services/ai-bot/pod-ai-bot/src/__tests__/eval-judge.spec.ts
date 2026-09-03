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

import { FIXTURES } from './eval/fixtures'
import { serializeTrace, summarizeVerdicts } from './eval/judge'

describe('trace serialization for the judge', () => {
  const trace = FIXTURES[0].trace

  it('carries the requirements, the calls and both states', () => {
    const text = serializeTrace(trace)
    expect(text).toContain('R1: частота выпуска изменена')
    expect(text).toContain('tool propose_new_document(')
    expect(text).toContain('WORKSPACE BEFORE:')
    expect(text).toContain('WORKSPACE AFTER:')
    expect(text).toContain('Релиз-менеджер отвечает за выпуск')
  })

  // Without the "before" state a requirement like "left unchanged" cannot be judged at all -
  // the judge marked it unmet on a run that was in fact correct.
  it('shows what the document looked like before the run', () => {
    const text = serializeTrace(trace)
    const before = text.slice(text.indexOf('WORKSPACE BEFORE:'), text.indexOf('TRACE:'))
    expect(before).toContain('Выпуск раз в неделю')
  })

  it('marks an untouched workspace as empty on both sides', () => {
    const text = serializeTrace(FIXTURES[3].trace)
    expect(text.match(/\(empty\)/g)?.length).toBe(2)
  })
})

describe('proposals that were prepared but not applied', () => {
  // An issue draft never lands in the workspace on purpose. Without this line the judge sees an
  // empty workspace and concludes nothing was done.
  it('are shown to the judge as the result of the turn', () => {
    const trace = {
      ...FIXTURES[2].trace,
      turns: [
        {
          ...FIXTURES[2].trace.turns[0],
          applied: [],
          staged: { kind: 'task', title: 'Не приходят письма о смене пароля', subtasks: 0 }
        }
      ]
    }
    const text = serializeTrace(trace)
    expect(text).toContain('prepared but not applied: task draft "Не приходят письма о смене пароля"')
  })
})

describe('summarizeVerdicts', () => {
  it('counts what was confirmed and names what was not', () => {
    expect(
      summarizeVerdicts([
        { id: 'R1', met: true, evidence: '' },
        { id: 'R2', met: false, evidence: '' }
      ])
    ).toBe('1/2 (нет: R2)')
  })

  it('shows a clean result without a tail', () => {
    expect(summarizeVerdicts([{ id: 'R1', met: true, evidence: '' }])).toBe('1/1')
  })

  // A judge that failed to answer must not read as a verdict about the run.
  it('distinguishes a silent judge from an empty requirement list', () => {
    expect(summarizeVerdicts(undefined)).toBe('судья не ответил')
    expect(summarizeVerdicts([])).toBe('-')
  })
})

describe('conversation history and compaction in the trace', () => {
  const trace = {
    ...FIXTURES[0].trace,
    historyBefore: [{ role: 'user', content: 'Отвечай только списком коротких пунктов.' }],
    summaries: ['## Договорённости\n- отвечать списком коротких пунктов']
  }

  // "Was the agreement from the start honoured" is unanswerable without the start.
  it('shows what was said before the run', () => {
    expect(serializeTrace(trace)).toContain('Отвечай только списком коротких пунктов')
  })

  it('shows what survived the compaction', () => {
    const text = serializeTrace(trace)
    expect(text).toContain('COMPACTED INTO THIS SUMMARY')
    expect(text).toContain('- отвечать списком коротких пунктов')
  })
})

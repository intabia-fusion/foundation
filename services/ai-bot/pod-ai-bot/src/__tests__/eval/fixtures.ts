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
 * Reference traces for calibrating the judge: two runs that clearly did the job and two that
 * clearly did not. A judge that cannot tell them apart is measuring noise, and its verdicts on
 * real runs mean nothing - so it is checked before it is trusted.
 */

import type { Trace } from './runner'

export interface Fixture {
  name: string
  trace: Trace
  /** What a correct judge must answer for each requirement. */
  expected: Record<string, boolean>
}

const base = (over: Partial<Trace>): Trace => ({
  scenario: 'fixture',
  model: 'fixture',
  compactions: 0,
  historyBefore: [],
  summaries: [],
  initialWorld: { issues: [], history: [] },
  requirements: [],
  turns: [],
  world: { issues: [], history: [] },
  asserts: [],
  usage: { promptTokens: 0, completionTokens: 0 },
  ms: 0,
  ok: true,
  ...over
})

export const FIXTURES: Fixture[] = [
  {
    name: 'good: правка внесена, остальное цело',
    expected: { R1: true, R2: true },
    trace: base({
      initialWorld: {
        document: {
          id: 'd',
          title: 'Регламент выпуска',
          body: '# Регламент\nВыпуск раз в неделю.\n## Роли\nРелиз-менеджер отвечает за выпуск.'
        },
        issues: [],
        history: []
      },
      requirements: [
        { id: 'R1', text: 'частота выпуска изменена на раз в две недели' },
        { id: 'R2', text: 'раздел про роли сохранён без изменений' }
      ],
      turns: [
        {
          n: 1,
          ask: 'Замени "раз в неделю" на "раз в две недели"',
          toolCalls: [
            {
              name: 'propose_new_document',
              args: '{"markdown":"# Регламент\\nВыпуск раз в две недели.\\n## Роли\\nРелиз-менеджер отвечает за выпуск."}'
            }
          ],
          applied: ['document:Регламент выпуска'],
          answer: 'Готово, заменил частоту.',
          rounds: 2
        }
      ],
      world: {
        document: {
          id: 'd',
          title: 'Регламент выпуска',
          body: '# Регламент\nВыпуск раз в две недели.\n## Роли\nРелиз-менеджер отвечает за выпуск.'
        },
        issues: [],
        history: []
      }
    })
  },
  {
    name: 'bad: документ переписан целиком, раздел потерян',
    expected: { R1: true, R2: false },
    trace: base({
      initialWorld: {
        document: {
          id: 'd',
          title: 'Регламент выпуска',
          body: '# Регламент\nВыпуск раз в неделю.\n## Роли\nРелиз-менеджер отвечает за выпуск.'
        },
        issues: [],
        history: []
      },
      requirements: [
        { id: 'R1', text: 'частота выпуска изменена на раз в две недели' },
        { id: 'R2', text: 'раздел про роли сохранён без изменений' }
      ],
      turns: [
        {
          n: 1,
          ask: 'Замени "раз в неделю" на "раз в две недели"',
          toolCalls: [
            {
              name: 'propose_new_document',
              args: '{"markdown":"# Регламент\\nВыпуск раз в две недели.\\nПроцесс переработан заново."}'
            }
          ],
          applied: ['document:Регламент выпуска'],
          answer: 'Переписал регламент.',
          rounds: 2
        }
      ],
      world: {
        document: {
          id: 'd',
          title: 'Регламент выпуска',
          body: '# Регламент\nВыпуск раз в две недели.\nПроцесс переработан заново.'
        },
        issues: [],
        history: []
      }
    })
  },
  {
    name: 'good: задача создана одна',
    expected: { R1: true, R2: true },
    trace: base({
      requirements: [
        { id: 'R1', text: 'создана ровно одна задача про падающий импорт CSV' },
        { id: 'R2', text: 'содержимое задачи не продублировано в тексте ответа' }
      ],
      turns: [
        {
          n: 1,
          ask: 'Заведи задачу по этому обсуждению',
          toolCalls: [
            {
              name: 'propose_task',
              args: '{"title":"Исправить падающий импорт CSV","description":"Файлы больше 10 МБ обрываются по таймауту."}'
            }
          ],
          applied: ['issue:Исправить падающий импорт CSV'],
          answer: 'Подготовил карточку задачи.',
          rounds: 2
        }
      ],
      world: { issues: [{ id: '1', identifier: 'EVAL-1', title: 'Исправить падающий импорт CSV' }], history: [] }
    })
  },
  {
    name: 'bad: ничего не создано, только рассуждение',
    expected: { R1: false },
    trace: base({
      requirements: [{ id: 'R1', text: 'создана задача про падающий импорт CSV' }],
      turns: [
        {
          n: 1,
          ask: 'Заведи задачу по этому обсуждению',
          toolCalls: [],
          applied: [],
          answer: 'Задачу стоит завести: импорт падает на больших файлах, нужно проверить таймаут парсера.',
          rounds: 1
        }
      ],
      world: { issues: [], history: [] }
    })
  }
]

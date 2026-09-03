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

import { buildDocPromptText, documentOutline } from '../workspace/docPrompt'

const BODY = `# Регламент

Вводная часть.

## Роли
Релиз-менеджер отвечает за выпуск.

### Дежурный
Следит за алертами.

## Откат
Возврат на предыдущую версию.`

describe('documentOutline', () => {
  it('keeps headings in order and nothing else', () => {
    expect(documentOutline(BODY)).toEqual(['# Регламент', '## Роли', '### Дежурный', '## Откат'])
  })

  it('ignores hashes that are not headings', () => {
    expect(documentOutline('текст #hashtag\n#нет пробела\n## Да')).toEqual(['## Да'])
  })
})

describe('document that fits', () => {
  const text = buildDocPromptText({ kind: 'document', title: 'Регламент', body: BODY })

  it('gives the body verbatim and offers the edit tool', () => {
    expect(text).toContain(BODY)
    expect(text).toContain('propose_new_document')
  })
})

describe('document that does not fit', () => {
  const text = buildDocPromptText({
    kind: 'document',
    title: 'Регламент',
    body: BODY,
    oversized: true,
    previewChars: 40
  })

  // Truncating the body silently is worse than refusing: a rewrite from half a document
  // deletes the other half, and nobody notices until it is applied.
  it('replaces the body with an outline plus the opening', () => {
    expect(text).toContain('too large')
    expect(text).toContain('OUTLINE')
    expect(text).toContain('## Откат')
    expect(text).not.toContain('Возврат на предыдущую версию')
  })

  it('states outright that editing is unavailable and why', () => {
    expect(text).toContain('cannot rewrite this document')
    expect(text).toContain('in parts is still in development')
  })

  it('does not advertise the rewrite tool', () => {
    expect(text).not.toContain('call the propose_new_document tool')
  })

  it('still allows answering about what is shown', () => {
    expect(text).toContain('Questions about its structure')
  })
})

describe('issue body', () => {
  it('carries the identifier and the existing sub-tasks', () => {
    const text = buildDocPromptText({
      kind: 'issue',
      title: 'Импорт CSV',
      identifier: 'EVAL-1',
      body: 'Падает на больших файлах.',
      subtasksListing: 'Existing sub-tasks (1):\n- EVAL-2 Починить парсер'
    })
    expect(text).toContain('task EVAL-1')
    expect(text).toContain('EVAL-2 Починить парсер')
  })
})

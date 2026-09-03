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

import { sanitizeDocumentMarkdown } from '../utils/documentMarkdown'

// Cases taken from real GigaChat rewrite_document output (FUSIO-866 logs).
describe('sanitizeDocumentMarkdown', () => {
  it('strips a single ```markdown fence with a trailing space', () => {
    expect(sanitizeDocumentMarkdown('```markdown\nраз, два\nпро пса\n``` ')).toBe('раз, два\nпро пса')
  })

  it('peels nested/accumulated fences', () => {
    expect(sanitizeDocumentMarkdown('```markdown\n```markdown\nсчиталка\n``` markdown\n```\n```')).toBe('считалка')
  })

  it('drops a dangling malformed closer "``` markdown"', () => {
    expect(sanitizeDocumentMarkdown('# Считалка\n\nтекст\n``` markdown')).toBe('# Считалка\n\nтекст')
  })

  it('leaves clean markdown untouched', () => {
    const clean = '# Считалка о Псе\n\n## Сюжет\nтекст'
    expect(sanitizeDocumentMarkdown(clean)).toBe(clean)
  })

  it('preserves an internal code block', () => {
    const doc = 'Вот код:\n```js\nconst x = 1\n```\nконец'
    expect(sanitizeDocumentMarkdown(doc)).toBe(doc)
  })

  it('unescapes literal \\n and then strips the fence', () => {
    expect(sanitizeDocumentMarkdown('```markdown\\n# H\\nтекст\\n```')).toBe('# H\nтекст')
  })

  it('strips legacy <<<DOCUMENT>>> markers', () => {
    expect(sanitizeDocumentMarkdown('<<<DOCUMENT\n# H\nтекст\nDOCUMENT>>>')).toBe('# H\nтекст')
  })

  it('returns empty string for a body that is only fences', () => {
    expect(sanitizeDocumentMarkdown('```markdown\n```')).toBe('')
  })

  it('drops html comments (they become `comment` nodes the doc schema rejects)', () => {
    const md = '# Title\n\n<!-- Разбиваем каждую фазу -->\n\nBody text\n\n<!-- note -->'
    const out = sanitizeDocumentMarkdown(md)
    expect(out).not.toContain('<!--')
    expect(out).toContain('# Title')
    expect(out).toContain('Body text')
  })
})

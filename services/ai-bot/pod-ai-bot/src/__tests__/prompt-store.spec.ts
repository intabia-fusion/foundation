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

import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadPromptTemplates, renderPrompt, PROMPT_KEYS } from '../llms/promptStore'

const REPO_PROMPTS = path.resolve(__dirname, '../../prompts.yaml')

function tmpYaml (content: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-')), 'prompts.yaml')
  fs.writeFileSync(file, content)
  return file
}

describe('renderPrompt', () => {
  it('substitutes plain placeholders', () => {
    expect(renderPrompt('Hello {{name}}, lang={{lang}}', { name: 'Bob', lang: 'en' })).toBe('Hello Bob, lang=en')
  })

  it('replaces absent placeholders with empty string', () => {
    expect(renderPrompt('a={{a}};b={{b}}', { a: 'x' })).toBe('a=x;b=')
  })

  it('keeps a conditional block when the variable is non-empty', () => {
    const out = renderPrompt('start{{#mem}} persona: {{mem}}{{/mem}} end', { mem: 'Boss' })
    expect(out).toBe('start persona: Boss end')
  })

  it('drops a conditional block when the variable is empty or absent', () => {
    expect(renderPrompt('start{{#mem}} persona: {{mem}}{{/mem}} end', { mem: '' })).toBe('start end')
    expect(renderPrompt('start{{#mem}} persona: {{mem}}{{/mem}} end', {})).toBe('start end')
  })

  it('handles multiple independent conditional blocks', () => {
    const tpl = '{{#a}}A={{a}}{{/a}}|{{#b}}B={{b}}{{/b}}'
    expect(renderPrompt(tpl, { a: '1', b: '' })).toBe('A=1|')
    expect(renderPrompt(tpl, { a: '', b: '2' })).toBe('|B=2')
  })
})

describe('loadPromptTemplates', () => {
  it('loads the repo prompts.yaml with all required keys', () => {
    const t = loadPromptTemplates(REPO_PROMPTS)
    for (const key of PROMPT_KEYS) {
      expect(typeof t[key]).toBe('string')
      expect(t[key].length).toBeGreaterThan(0)
    }
  })

  it('throws when the file is missing (no silent fallback)', () => {
    expect(() => loadPromptTemplates('/nonexistent/prompts.yaml')).toThrow(/not found/i)
  })

  it('throws when a required key is missing', () => {
    const file = tmpYaml('translateHtml: hi\n')
    expect(() => loadPromptTemplates(file)).toThrow(/missing required keys/i)
  })

  it('throws on empty/invalid yaml', () => {
    const file = tmpYaml('')
    expect(() => loadPromptTemplates(file)).toThrow(/empty or invalid/i)
  })

  it('uses overridden templates verbatim', () => {
    const full: Record<string, string> = {}
    for (const key of PROMPT_KEYS) full[key] = `tpl-${key}`
    full.translateHtml = 'translate to {{lang}}'
    const file = tmpYaml(
      Object.entries(full)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join('\n') + '\n'
    )
    const t = loadPromptTemplates(file)
    expect(renderPrompt(t.translateHtml, { lang: 'German' })).toBe('translate to German')
    expect(t.threadChatWithTools).toBe('tpl-threadChatWithTools')
  })
})

describe('PROMPTS via prompts.yaml', () => {
  beforeEach(() => {
    jest.resetModules()
    delete process.env.PROMPTS_PATH
  })

  it('renders direct chat with and without memory blocks', async () => {
    const { PROMPTS } = await import('../llms/prompts')
    const empty = PROMPTS.DIRECT_CHAT_WITH_TOOLS({ sharedPrompt: '', personalContext: '' })
    expect(empty).not.toContain('About this user')

    const withMem = PROMPTS.DIRECT_CHAT_WITH_TOOLS({
      sharedPrompt: '',
      personalContext: 'Call me Boss'
    })
    expect(withMem).toContain('About this user')
    expect(withMem).toContain('Call me Boss')
  })

  it('renders summarize with and without description', async () => {
    const { PROMPTS } = await import('../llms/prompts')
    const withDesc = PROMPTS.SUMMARIZE_MESSAGES('English', 'Sprint planning')
    expect(withDesc).toContain('English')
    expect(withDesc).toContain('Sprint planning')

    const noDesc = PROMPTS.SUMMARIZE_MESSAGES('English')
    expect(noDesc).not.toContain('Meeting description')
  })
})

describe('output limit in the chat prompts', () => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { describeOutputLimit } = require('../llms/prompts') as typeof import('../llms/prompts')
  /* eslint-enable @typescript-eslint/no-var-requires */

  it('states the cap and how to handle longer content', () => {
    const text = describeOutputLimit(8192)
    expect(text).toContain('8192 tokens')
    // The rule is useless unless it says what to do instead of overrunning.
    expect(text).toMatch(/several tool calls/i)
  })

  it('says nothing when the model has no configured cap', () => {
    expect(describeOutputLimit(undefined)).toBe('')
    expect(describeOutputLimit(0)).toBe('')
  })

  it('renders into both chat templates, and drops out when empty', () => {
    const templates = loadPromptTemplates(REPO_PROMPTS)
    for (const key of ['directChatWithTools', 'threadChatWithTools'] as const) {
      const withLimit = renderPrompt(templates[key], { outputLimit: 'CAP RULE', sharedPrompt: '', lang: 'en' })
      expect(withLimit).toContain('CAP RULE')
      const without = renderPrompt(templates[key], { outputLimit: '', sharedPrompt: '', lang: 'en' })
      expect(without).not.toContain('Reply length limit')
    }
  })
})

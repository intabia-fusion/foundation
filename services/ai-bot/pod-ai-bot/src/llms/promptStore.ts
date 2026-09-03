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
import path from 'path'
import yaml from 'js-yaml'

/** Keys of prompt templates. All must be present in prompts.yaml. */
export const PROMPT_KEYS = [
  'translateHtml',
  'summarizeMessages',
  'correctTranscript',
  'directChatWithTools',
  'threadChatWithTools',
  'compactConversation'
] as const

export type PromptKey = (typeof PROMPT_KEYS)[number]
export type PromptTemplates = Record<PromptKey, string>

/** Reply-language rule per language code, written in that language. See prompts.yaml. */
export type LanguageReminders = Record<string, string>

/**
 * Render a prompt template: `{{#name}}...{{/name}}` blocks are kept only when `vars.name` is
 * non-empty (resolved first), then plain `{{name}}` placeholders are substituted.
 */
export function renderPrompt (template: string, vars: Record<string, string | undefined>): string {
  // Conditional sections: {{#key}} ... {{/key}}
  let out = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key: string, body: string) => {
    const value = vars[key]
    if (value === undefined || value === '') return ''
    // Function form: a `$&`/`$1` inside a user-authored value must stay literal.
    return body.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value)
  })
  // Plain placeholders.
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? '')
  return out
}

/**
 * The `replyLanguageReminder` map from the same file. Optional: a prompts.yaml without it simply
 * yields no reminder, and the prompts render without that block.
 */
export function loadLanguageReminders (filePath?: string): LanguageReminders {
  const resolved = filePath ?? defaultPromptsPath()
  if (!fs.existsSync(resolved)) return {}
  const raw = yaml.load(fs.readFileSync(resolved, 'utf8'))
  const map = (raw as Record<string, unknown> | null)?.replyLanguageReminder
  if (map === null || typeof map !== 'object') return {}
  const out: LanguageReminders = {}
  for (const [lang, text] of Object.entries(map as Record<string, unknown>)) {
    if (typeof text === 'string' && text.trim() !== '') out[lang] = text
  }
  return out
}

/**
 * Load prompt templates from YAML - the single source of truth, no built-in fallbacks.
 * Throws on a missing file/key so a misconfigured pod fails fast.
 */
export function loadPromptTemplates (filePath?: string): PromptTemplates {
  const resolved = filePath ?? defaultPromptsPath()
  if (!fs.existsSync(resolved)) {
    throw new Error(`Prompts file not found: ${resolved}. Set PROMPTS_PATH or provide prompts.yaml.`)
  }
  const raw = yaml.load(fs.readFileSync(resolved, 'utf8'))
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Prompts file is empty or invalid: ${resolved}`)
  }
  const data = raw as Record<string, unknown>
  const result: Partial<PromptTemplates> = {}
  const missing: string[] = []
  for (const key of PROMPT_KEYS) {
    const v = data[key]
    if (typeof v === 'string' && v.trim() !== '') {
      result[key] = v
    } else {
      missing.push(key)
    }
  }
  if (missing.length > 0) {
    throw new Error(`Prompts file ${resolved} is missing required keys: ${missing.join(', ')}`)
  }
  return result as PromptTemplates
}

/**
 * Prompts file location: PROMPTS_PATH env > prompts.yaml next to the process (docker) >
 * package-root prompts.yaml (dev). Returns the first existing, else the package-root path.
 */
function defaultPromptsPath (): string {
  const fromEnv = process.env.PROMPTS_PATH
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const candidates = [path.resolve(process.cwd(), 'prompts.yaml'), path.resolve(__dirname, '../../prompts.yaml')]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[candidates.length - 1]
}

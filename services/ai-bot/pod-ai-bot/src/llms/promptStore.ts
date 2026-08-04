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
export const PROMPT_KEYS = ['translateHtml', 'summarizeMessages', 'directChatWithTools', 'threadChatWithTools'] as const

export type PromptKey = (typeof PROMPT_KEYS)[number]
export type PromptTemplates = Record<PromptKey, string>

/**
 * Render a prompt template.
 *
 * Substitutions:
 * - `{{#name}}...{{/name}}` keeps the block only when `vars.name` is a non-empty
 *   string; inner `{{name}}` is replaced with the value. Empty/absent -> block removed.
 * - `{{name}}` is replaced with `vars.name` (empty string when absent).
 *
 * Conditional blocks are resolved first so a removed block takes its placeholders with it.
 */
export function renderPrompt (template: string, vars: Record<string, string | undefined>): string {
  // Conditional sections: {{#key}} ... {{/key}}
  let out = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key: string, body: string) => {
    const value = vars[key]
    if (value === undefined || value === '') return ''
    return body.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
  })
  // Plain placeholders.
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? '')
  return out
}

/**
 * Load prompt templates from a YAML file. The file is the single source of truth -
 * there are NO built-in fallbacks. A missing file, unparseable YAML, or any missing
 * prompt key throws, so a misconfigured pod fails fast instead of running with
 * silent defaults.
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
 * Prompts file location, in priority order:
 *  1. PROMPTS_PATH env (explicit override).
 *  2. prompts.yaml next to the running process (Docker copies it to the app dir).
 *  3. prompts.yaml at the package root, two levels up from src/llms or lib/llms (dev).
 * Returns the first that exists; otherwise the package-root path (so the error
 * message points at the expected location).
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

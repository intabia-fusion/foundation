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

export type WelcomeMessages = Record<string, string>

/** `en` is the fallback, so a language missing from welcome.yaml still gets a greeting. */
export function pickWelcome (messages: WelcomeMessages, lang: string): string | undefined {
  const exact = messages[lang]
  if (exact !== undefined && exact.trim() !== '') return exact
  // 'pt-br' falls back to 'pt' before 'en'.
  const base = lang.split('-')[0]
  const byBase = messages[base]
  if (byBase !== undefined && byBase.trim() !== '') return byBase
  const en = messages.en
  return en !== undefined && en.trim() !== '' ? en : undefined
}

/** Greeting texts per language. Missing file is not fatal: no file - no welcome. */
export function loadWelcomeMessages (filePath?: string): WelcomeMessages {
  const resolved = filePath ?? defaultWelcomePath()
  if (!fs.existsSync(resolved)) return {}
  const raw = yaml.load(fs.readFileSync(resolved, 'utf8'))
  if (raw === null || typeof raw !== 'object') return {}
  const result: WelcomeMessages = {}
  for (const [lang, text] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof text === 'string' && text.trim() !== '') result[lang] = text
  }
  return result
}

/** WELCOME_PATH env > welcome.yaml next to the process (docker) > package root (dev). */
function defaultWelcomePath (): string {
  const fromEnv = process.env.WELCOME_PATH
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const candidates = [path.resolve(process.cwd(), 'welcome.yaml'), path.resolve(__dirname, '../welcome.yaml')]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[candidates.length - 1]
}

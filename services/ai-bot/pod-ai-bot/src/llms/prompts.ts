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
 * Shared prompts used across different LLM providers.
 *
 * Templates live in prompts.yaml (override via PROMPTS_PATH). There are no built-in
 * fallbacks: a missing file or key throws on first use. See promptStore.ts.
 */

import { loadPromptTemplates, renderPrompt, type PromptTemplates } from './promptStore'

export interface PromptParams {
  lang?: string
  contextMode?: 'direct' | 'thread'
  sharedPrompt?: string
  personalContext?: string
  currentDateTime?: string
}

const DEFAULT_LANG = 'ru'
// Localized request timestamp for the prompt (falls back to ISO on failure). Short form:
// the full/verbose form gets parroted back verbatim by weaker models.
function nowForPrompt (lang: string): string {
  const now = new Date()
  try {
    return now.toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return now.toISOString()
  }
}

let cached: PromptTemplates | undefined

/** Load templates once. Throws if prompts.yaml is missing/incomplete. */
function templates (): PromptTemplates {
  if (cached === undefined) {
    cached = loadPromptTemplates()
  }
  return cached
}

export const PROMPTS = {
  TRANSLATE_HTML: (lang: string): string => renderPrompt(templates().translateHtml, { lang }),

  SUMMARIZE_MESSAGES: (lang: string, description?: string): string =>
    renderPrompt(templates().summarizeMessages, { lang, description: description?.trim() ?? '' }),

  CORRECT_TRANSCRIPT: (lang?: string): string => renderPrompt(templates().correctTranscript, { lang: lang ?? '' }),

  DIRECT_CHAT_WITH_TOOLS: (params: PromptParams): string => {
    const lang = params.lang ?? DEFAULT_LANG
    return renderPrompt(templates().directChatWithTools, {
      sharedPrompt: params.sharedPrompt ?? '',
      personalContext: params.personalContext ?? '',
      lang,
      currentDateTime: params.currentDateTime ?? nowForPrompt(lang)
    })
  },

  THREAD_CHAT_WITH_TOOLS: (params: PromptParams): string => {
    const lang = params.lang ?? DEFAULT_LANG
    return renderPrompt(templates().threadChatWithTools, {
      sharedPrompt: params.sharedPrompt ?? '',
      lang,
      currentDateTime: params.currentDateTime ?? nowForPrompt(lang)
    })
  }
}

/** Build the system prompt for a chat-with-tools request. */
export function buildSystemPrompt (
  isDirectMode: boolean,
  sharedPrompt: string,
  personalContext: string,
  systemMessages: Array<{ content: string }>,
  lang?: string
): string {
  return isDirectMode
    ? PROMPTS.DIRECT_CHAT_WITH_TOOLS({ sharedPrompt, personalContext, lang })
    : PROMPTS.THREAD_CHAT_WITH_TOOLS({ sharedPrompt, lang }) +
        '\n\n' +
        systemMessages.map((it) => it.content).join('\n')
}

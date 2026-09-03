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
 * Shared prompts used across LLM providers; templates live in prompts.yaml (PROMPTS_PATH
 * override), no built-in fallbacks. See promptStore.ts.
 */

import {
  loadLanguageReminders,
  loadPromptTemplates,
  renderPrompt,
  type LanguageReminders,
  type PromptTemplates
} from './promptStore'

export interface PromptParams {
  lang?: string
  /** Display name of the bot (pod config FIRST_NAME); falls back to the default when empty. */
  botName?: string
  sharedPrompt?: string
  personalContext?: string
  currentDateTime?: string
  // Output cap of the serving model, rendered into the prompt so the model plans its length
  // instead of running into the cap mid-sentence.
  outputLimit?: string
}

// Appended when resuming a cut-off answer: the model must continue the text, not restart it.
export const CONTINUE_PROMPT =
  'Your previous message was cut off at the output limit. Continue it from exactly where it stopped. ' +
  'Do NOT repeat any text you already sent, do not restate the question, do not add a preamble.'

const DEFAULT_LANG = 'ru'
const DEFAULT_BOT_NAME = 'Yulia'

/** The name the bot introduces itself with: the pod's configured FIRST_NAME, never hardcoded. */
export function botName (configured?: string): string {
  const name = (configured ?? '').trim()
  return name !== '' ? name : DEFAULT_BOT_NAME
}
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
let cachedReminders: LanguageReminders | undefined

/**
 * The reply-language rule, in the target language, to be repeated at the end of the prompt.
 * Measured on a 10B model: mid-prompt and in English it is honoured about a quarter of the time,
 * at the end and in the target language about always. Falls back to English, then to nothing.
 */
export function languageReminder (lang: string): string {
  cachedReminders ??= loadLanguageReminders()
  return cachedReminders[lang] ?? cachedReminders[lang.split('-')[0]] ?? cachedReminders.en ?? ''
}

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

  /** Fold the older part of a conversation into a structured summary. */
  COMPACT_CONVERSATION: (lang: string, previousSummary?: string): string =>
    renderPrompt(templates().compactConversation, { lang, previousSummary: previousSummary ?? '' }),

  DIRECT_CHAT_WITH_TOOLS: (params: PromptParams): string => {
    const lang = params.lang ?? DEFAULT_LANG
    return renderPrompt(templates().directChatWithTools, {
      botName: botName(params.botName),
      sharedPrompt: params.sharedPrompt ?? '',
      personalContext: params.personalContext ?? '',
      lang,
      outputLimit: params.outputLimit ?? '',
      languageReminder: languageReminder(lang),
      currentDateTime: params.currentDateTime ?? nowForPrompt(lang)
    })
  },

  THREAD_CHAT_WITH_TOOLS: (params: PromptParams): string => {
    const lang = params.lang ?? DEFAULT_LANG
    return renderPrompt(templates().threadChatWithTools, {
      botName: botName(params.botName),
      sharedPrompt: params.sharedPrompt ?? '',
      lang,
      outputLimit: params.outputLimit ?? '',
      languageReminder: languageReminder(lang),
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
  lang?: string,
  maxOutputTokens?: number,
  name?: string
): string {
  const outputLimit = describeOutputLimit(maxOutputTokens)
  return isDirectMode
    ? PROMPTS.DIRECT_CHAT_WITH_TOOLS({ sharedPrompt, personalContext, lang, outputLimit, botName: name })
    : PROMPTS.THREAD_CHAT_WITH_TOOLS({ sharedPrompt, lang, outputLimit, botName: name }) +
        '\n\n' +
        systemMessages.map((it) => it.content).join('\n')
}

// Roughly 4 characters per token across the languages we serve; deliberately conservative so the
// model stops short of the cap rather than losing a whole tool call to a mid-argument cut.
const CHARS_PER_TOKEN = 4

/** Wording of the output-cap rule, empty when the serving model has no configured cap. */
export function describeOutputLimit (maxOutputTokens?: number): string {
  if (maxOutputTokens === undefined || maxOutputTokens <= 0) return ''
  const budget = Math.floor(maxOutputTokens * CHARS_PER_TOKEN * 0.8)
  return (
    `One reply cannot exceed ${maxOutputTokens} tokens (about ${budget} characters), and anything ` +
    'past that is CUT OFF and lost - a tool call cut mid-argument is lost entirely. Plan the length: ' +
    'keep chat answers well inside it, and when the content is longer (a document, a long list), ' +
    'send it across several tool calls using the batching each tool describes, never in one giant call.'
  )
}

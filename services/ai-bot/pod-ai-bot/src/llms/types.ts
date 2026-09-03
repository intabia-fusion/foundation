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

import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import type { PersonMessage } from '@hcengineering/ai-bot'
import type { AILevel } from '../config'
import type { RunnableTools, BaseFunctionsArgs } from 'openai/lib/RunnableFunction'

/**
 * Simple chat message shape used for conversation context.
 * This intentionally mirrors common LLM SDK message formats.
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/**
 * Token usage for a single LLM call; source of truth is the provider `usage`.
 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  // Reasoning tokens, when reported separately. Already counted inside completionTokens -
  // kept apart for diagnostics only, never added on top when billing.
  reasoningTokens?: number
}

/** Total billable tokens for a usage record. */
export function totalTokens (usage?: TokenUsage): number {
  if (usage === undefined) return 0
  return usage.promptTokens + usage.completionTokens
}

/** Raw `usage` shape returned by OpenAI/GigaChat APIs. */
export interface ApiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** Normalize a provider API `usage` object to `TokenUsage` (source of truth). */
export function usageFromApi (usage?: ApiUsage): TokenUsage | undefined {
  if (usage === undefined) return undefined
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    ...(reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {})
  }
}

/** Result of a tools-enabled chat completion run: final `completion` text and provider `usage`. */
export interface ChatCompletionWithToolsResult {
  completion?: string
  usage?: TokenUsage
  // Tools called while producing this answer, for the conversation snapshot.
  toolTranscript?: ToolResult[]
  // The user stopped the run: the completion is what one final step could assemble.
  cancelled?: boolean
}

/**
 * Optional observation/steering of a tool run: `onProgress` fires after every model round (so the
 * user sees tokens accumulate), `isCancelled` is checked between rounds - a cancelled run stops
 * calling tools and answers once with what it already has.
 */
export interface ToolLoopHooks {
  onProgress?: (progress: { iteration: number, usage: TokenUsage }) => void
  isCancelled?: () => Promise<boolean> | boolean
}

/** Serializable tool definition (OpenAI function schema) passed to a provider step. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** A tool call requested by the model (executed by the caller, not the provider). */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** Result of executing a tool call, fed back into the next model step. */
export interface ToolResult {
  id: string
  name: string
  content: string
  // Original call arguments, replayed so the model sees a consistent assistant turn.
  arguments?: string
}

/**
 * One step of a tool-using conversation: the model either returns final `content`
 * or requests `toolCalls`. The caller executes calls and resubmits results.
 */
export interface ChatToolStepResult {
  content?: string
  toolCalls?: ToolCall[]
  usage?: TokenUsage
  // The model stopped at its output cap (finish_reason 'length'), so `content` is cut mid-thought.
  truncated?: boolean
}

/**
 * Context mode used when creating completions with tools.
 */
export type ContextMode = 'direct' | 'thread'

/**
 * Main LLM provider interface. Implementations should catch errors internally -
 * callers often expect `undefined` on failure, not a thrown exception.
 */
export interface LLMProvider {
  /**
   * Translate HTML while preserving structure and metadata.
   */
  translateHtml: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    html: string,
    lang: string
  ) => Promise<string | undefined>

  /**
   * Create a summary from a sequence of person messages.
   */
  summarizeMessages: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    messages: PersonMessage[],
    lang: string,
    description?: string,
    level?: AILevel
  ) => Promise<string | undefined>

  /**
   * Fix ASR errors in a raw voice-note transcript (uses the given level's model).
   * Optional: providers without it just skip correction, keeping the raw text.
   */
  correctTranscript?: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    text: string,
    lang?: string,
    level?: AILevel
  ) => Promise<string | undefined>

  /**
   * Fold the older part of a conversation into a structured summary (see prompts.yaml
   * `compactConversation`). Optional: a provider without it simply never compacts, and the
   * window trim keeps behaving as before.
   */
  compactConversation?: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    transcript: string,
    lang: string,
    previousSummary?: string,
    level?: AILevel
  ) => Promise<string | undefined>

  /**
   * Create a chat completion that can use tools (provider-specific); tools are pre-built and
   * ready to use, callers handle WorkspaceClient context.
   */
  createChatCompletionWithTools: (
    tools: RunnableTools<BaseFunctionsArgs>,
    message: ChatMessage,
    contextMode: ContextMode,
    sharedPrompt: string,
    personalContext: string,
    user: string,
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    history?: ChatMessage[],
    skipCache?: boolean,
    reason?: string,
    level?: AILevel,
    lang?: string,
    hooks?: ToolLoopHooks
  ) => Promise<ChatCompletionWithToolsResult | undefined>

  /**
   * Run a single tool-using model step without executing tools: returns `toolCalls` for the
   * caller (clisr pod) to run and resubmit. Optional: providers without function-calling may omit it.
   */
  chatToolStep?: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    message: ChatMessage,
    contextMode: ContextMode,
    sharedPrompt: string,
    personalContext: string,
    user: string,
    toolDefinitions: ToolDefinition[],
    priorToolResults: ToolResult[],
    history?: ChatMessage[],
    skipCache?: boolean,
    reason?: string,
    level?: AILevel,
    lang?: string,
    // Text already produced when the model hit its cap: the step must continue it, not restart.
    continueFrom?: string
  ) => Promise<ChatToolStepResult | undefined>

  /**
   * Best-effort token counting for a sequence of `ChatMessage`.
   * Providers should implement this using a suitable tokenizer/encoding.
   */
  countTokens: (messages: ChatMessage[]) => number
}

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
 * Server-backed implementation of the LLMProvider interface.
 * Distributes LLM requests to connected external clients via Clisr.
 */

import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import type { PersonMessage } from '@hcengineering/ai-bot'
import type { AILevel, AIProviderConfig } from '../config'
import type {
  LLMProvider,
  ChatMessage,
  ChatCompletionWithToolsResult,
  ChatToolStepResult,
  ContextMode,
  ToolDefinition,
  ToolResult,
  ToolLoopHooks
} from './types'

import type { RunnableTools, BaseFunctionsArgs } from 'openai/lib/RunnableFunction'
import { runToolCalls, buildToolExecutor, MAX_TOOL_ITERATIONS } from './toolLoop'
import { providerLevels, billingMetaFor } from './modelRegistry'
import { billUsage } from '../billing'
import { ClisrServer } from '@intabiafusion/clisr'

/**
 * Request types for server provider methods
 */
export interface TranslateHtmlRequest {
  method: 'translateHtml'
  html: string
  lang: string
  workspace: WorkspaceUuid
}

export interface SummarizeMessagesRequest {
  method: 'summarizeMessages'
  messages: PersonMessage[]
  lang: string
  workspace: WorkspaceUuid
  description?: string
  level?: AILevel
}

export interface ChatCompletionWithToolsRequest {
  method: 'createChatCompletionWithTools'
  message: ChatMessage
  contextMode: ContextMode
  sharedPrompt: string
  personalContext: string
  user: string
  history?: ChatMessage[]
  skipCache?: boolean
  reason?: string
  level?: AILevel
  lang?: string
  workspace: WorkspaceUuid
  // Note: tools are not serializable, so we pass tool definitions instead.
  toolDefinitions?: ToolDefinition[]
  // Prior tool-call round: model-issued calls and the results we computed on the pod.
  // The client replays these into the conversation before continuing.
  priorToolResults?: ToolResult[]
  // Text produced so far when the model hit its output cap: the worker must continue it.
  continueFrom?: string
}

/**
 * Reply from the clisr client: final `content`, or `toolCalls` the pod must execute and resubmit.
 */
export type ChatCompletionWithToolsReply = ChatToolStepResult & {
  // The clisr worker that served this step (echoed by the client). Empty for direct providers.
  clientId?: string
}

export interface CountTokensRequest {
  method: 'countTokens'
  messages: ChatMessage[]
}

export type LLMRequest =
  | TranslateHtmlRequest
  | SummarizeMessagesRequest
  | ChatCompletionWithToolsRequest
  | CountTokensRequest

/**
 * Server provider that distributes LLM requests to connected clients via Clisr
 */
export default class ServerLLMProvider implements LLMProvider {
  private readonly defaultLevel: AILevel

  constructor (
    private readonly ctx: MeasureContext,
    private readonly server: ClisrServer,
    private readonly provider: AIProviderConfig
  ) {
    const served = providerLevels(provider)
    // strongest level is the default for ops that don't carry an explicit level
    this.defaultLevel = served[served.length - 1] ?? 'low'
  }

  /** Billing metadata for a level. */
  private billingFor (level?: AILevel): { multiplier: number, modelId: string, providerId: string, level: string } {
    return billingMetaFor(this.provider, level, this.defaultLevel, () => '')
  }

  /**
   * Select clients that have LLM capability enabled
   */
  private readonly selectLLMClient = (session: { options: { llm?: boolean } }): boolean => {
    return session.options.llm === true
  }

  async translateHtml (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    html: string,
    lang: string
  ): Promise<string | undefined> {
    const startTime = Date.now()

    try {
      const request: TranslateHtmlRequest = {
        method: 'translateHtml',
        html,
        lang,
        workspace
      }

      const result = await this.server.requestWithFilter(ctx, 'llm', [request], this.selectLLMClient)

      const elapsed = Date.now() - startTime
      this.ctx.info('Server LLM translateHtml completed', {
        provider: 'server',
        workspace,
        lang,
        elapsedMs: elapsed
      })

      return result
    } catch (err: any) {
      const elapsed = Date.now() - startTime
      this.ctx.error('Server LLM translateHtml failed', {
        provider: 'server',
        workspace,
        error: err.message,
        elapsedMs: elapsed
      })
      return undefined
    }
  }

  async summarizeMessages (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    messages: PersonMessage[],
    lang: string,
    description?: string,
    level?: AILevel
  ): Promise<string | undefined> {
    const startTime = Date.now()

    try {
      const request: SummarizeMessagesRequest = {
        method: 'summarizeMessages',
        messages,
        lang,
        workspace,
        description,
        level
      }

      const result = await this.server.requestWithFilter(ctx, 'llm', [request], this.selectLLMClient)

      const elapsed = Date.now() - startTime
      this.ctx.info('Server LLM summarizeMessages completed', {
        provider: 'server',
        workspace,
        messageCount: messages.length,
        elapsedMs: elapsed
      })

      return result
    } catch (err: any) {
      const elapsed = Date.now() - startTime
      this.ctx.error('Server LLM summarizeMessages failed', {
        provider: 'server',
        workspace,
        error: err.message,
        elapsedMs: elapsed
      })
      return undefined
    }
  }

  async createChatCompletionWithTools (
    tools: RunnableTools<BaseFunctionsArgs>,
    message: ChatMessage,
    contextMode: ContextMode,
    sharedPrompt: string,
    personalContext: string,
    user: string,
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    history: ChatMessage[] = [],
    skipCache = true,
    reason = 'chat',
    level?: AILevel,
    lang?: string,
    hooks?: ToolLoopHooks
  ): Promise<ChatCompletionWithToolsResult | undefined> {
    const startTime = Date.now()

    try {
      // Extract tool definitions (tools themselves are not serializable) and a local executor
      // bound to them (closures already carry WorkspaceClient context, built in getTools).
      const { toolDefinitions, execute, knownTools } = buildToolExecutor(tools)

      const ask = async (
        priorToolResults: ToolResult[],
        noTools?: boolean,
        continueFrom?: string
      ): Promise<ChatCompletionWithToolsReply | undefined> => {
        const request: ChatCompletionWithToolsRequest = {
          method: 'createChatCompletionWithTools',
          message,
          contextMode,
          sharedPrompt,
          personalContext,
          user,
          history,
          skipCache,
          reason,
          level,
          lang,
          workspace,
          // Final round: withhold tools so the model must produce a text answer.
          toolDefinitions: noTools === true ? [] : toolDefinitions,
          continueFrom,
          priorToolResults: priorToolResults.length > 0 ? priorToolResults : undefined
        }
        return (await this.server.requestWithFilter(ctx, 'llm', [request], this.selectLLMClient)) as
          | ChatCompletionWithToolsReply
          | undefined
      }

      const result = await runToolCalls(ask, execute, MAX_TOOL_ITERATIONS, hooks, knownTools)

      const elapsed = Date.now() - startTime
      this.ctx.info('Server LLM createChatCompletionWithTools completed', {
        provider: 'server',
        workspace,
        contextMode,
        reason,
        toolCount: toolDefinitions.length,
        hasResult: result !== undefined,
        elapsedMs: elapsed
      })

      if (result === undefined) return undefined

      billUsage(ctx, workspace, result.usage, this.billingFor(level), reason, new Date().toISOString(), result.clientId)

      return {
        completion: result.completion,
        usage: result.usage,
        cancelled: result.cancelled,
        toolTranscript: result.toolTranscript
      }
    } catch (err: any) {
      const elapsed = Date.now() - startTime
      this.ctx.error('Server LLM createChatCompletionWithTools failed', {
        provider: 'server',
        workspace,
        contextMode,
        reason,
        error: err.message,
        elapsedMs: elapsed
      })
      return undefined
    }
  }

  countTokens (messages: ChatMessage[]): number {
    // Server provider can't count tokens locally; rough char-count estimate (real counting is client-side).
    let totalChars = 0
    for (const message of messages) {
      totalChars += message.content.length
    }
    // Rough estimate: ~4 characters per token for English text
    return Math.ceil(totalChars / 4)
  }
}

/**
 * Factory function to create a server (clisr) LLM provider.
 * Routing to a specific model/endpoint is handled client-side (T9 router addressing);
 * the provider config is used here only for billing metadata.
 */
export function createServerLLMProvider (
  ctx: MeasureContext,
  server: ClisrServer,
  provider: AIProviderConfig
): ServerLLMProvider {
  return new ServerLLMProvider(ctx, server, provider)
}

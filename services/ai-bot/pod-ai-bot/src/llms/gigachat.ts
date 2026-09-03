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
 * GigaChat-backed implementation of the LLMProvider interface.
 */

import GigaChat from 'gigachat'
import { encodingForModel, getEncoding, Tiktoken } from 'js-tiktoken'

import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import type { PersonMessage } from '@hcengineering/ai-bot'
import contact from '@hcengineering/contact'
import config, { type AILevel, type AIProviderConfig } from '../config'
import { providerLevels, billingMetaFor } from './modelRegistry'
import { billUsage } from '../billing'
import { withRetry, retryNetworkErrors } from '@hcengineering/retry'
import type {
  LLMProvider,
  ChatMessage,
  ChatCompletionWithToolsResult,
  ChatToolStepResult,
  ContextMode,
  ToolCall,
  ToolDefinition,
  ToolLoopHooks,
  ToolResult
} from './types'
import { usageFromApi } from './types'
import { runToolCalls, buildToolExecutor, MAX_TOOL_ITERATIONS, type AskModel } from './toolLoop'
import type { RunnableTools, BaseFunctionsArgs } from 'openai/lib/RunnableFunction'
import { PROMPTS, buildSystemPrompt, CONTINUE_PROMPT } from './prompts'
import { buildPersonNameMap, buildMessageText, replacePersonRefs } from './summarizeUtils'

// GigaChat tokens live 30 minutes and the client refreshes only lazily (on a 401), so the first
// request after each expiry pays the OAuth round trip. Refresh ahead of it instead.
const GIGACHAT_TOKEN_REFRESH_MS = 25 * 60 * 1000

export default class GigaChatProvider implements LLMProvider {
  private readonly client: GigaChat
  private readonly encoding: Tiktoken // js-tiktoken doesn't have a direct encoding for GigaChat models
  private readonly provider: AIProviderConfig
  private readonly defaultLevel: AILevel
  private readonly tokenTimer: NodeJS.Timeout

  constructor (
    readonly ctx: MeasureContext,
    provider: AIProviderConfig
  ) {
    this.provider = provider
    // strongest served level by `order` (works for custom level ids, not a hardcoded list)
    const served = providerLevels(provider)
    this.defaultLevel = served[served.length - 1] ?? 'low'

    this.client = new GigaChat({
      credentials: (provider.endpointConfig?.credentials as string) ?? config.GigaChatCredentials ?? '',
      scope: (provider.endpointConfig?.scope as string) ?? config.GigaChatScope ?? 'GIGACHAT_API_PERS',
      model: this.modelFor(this.defaultLevel),
      baseUrl: provider.endpoint ?? config.GigaChatBaseUrl ?? 'https://gigachat.devices.sberbank.ru/api/v1/',
      timeout: config.GigaChatTimeout != null ? parseInt(config.GigaChatTimeout) : 600
    })

    try {
      this.encoding = encodingForModel('gpt-4')
    } catch {
      this.encoding = getEncoding('cl100k_base')
    }

    void this.refreshToken()
    this.tokenTimer = setInterval(() => {
      void this.refreshToken()
    }, GIGACHAT_TOKEN_REFRESH_MS)
    // Never a reason to keep the process alive.
    this.tokenTimer.unref?.()
  }

  /** Fetch a fresh OAuth token out of band, so no user request waits for the handshake. */
  private async refreshToken (): Promise<void> {
    try {
      await this.client.updateToken()
    } catch (err: any) {
      // Not fatal: the next call re-authenticates through the library's own 401 path.
      this.ctx.warn('GigaChat token refresh failed', { provider: this.provider.id, error: err?.message })
    }
  }

  /** Resolve the concrete model name for a level, falling back to the default level. */
  private modelFor (level?: AILevel): string {
    const lvl = level ?? this.defaultLevel
    return this.provider.levels[lvl]?.model ?? this.provider.levels[this.defaultLevel]?.model ?? config.GigaChatModel
  }

  // Output token cap for a level from the yaml registry (capabilities.maxOutputTokens), with the
  // provider-wide default as fallback. Keeps the limit per-configuration, not a hardcoded param.
  private maxTokensFor (level?: AILevel): number {
    const lvl = level ?? this.defaultLevel
    return (
      this.provider.levels[lvl]?.capabilities?.maxOutputTokens ??
      this.provider.levels[this.defaultLevel]?.capabilities?.maxOutputTokens ??
      config.GigaChatMaxTokens
    )
  }

  /** Billing multiplier + model id for a level (used to bill tokens). */
  private billingFor (level?: AILevel): { multiplier: number, modelId: string, providerId: string, level: string } {
    return billingMetaFor(this.provider, level, this.defaultLevel, () => this.modelFor(level))
  }

  async translateHtml (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    html: string,
    lang: string
  ): Promise<string | undefined> {
    try {
      const response = await this.client.chat({
        messages: [
          {
            role: 'system',
            content: PROMPTS.TRANSLATE_HTML(lang)
          },
          {
            role: 'user',
            content: html
          }
        ],
        model: this.modelFor()
      })

      const responseText = response.choices?.[0]?.message?.content ?? undefined
      const usage = usageFromApi(response.usage)
      billUsage(ctx, workspace, usage, this.billingFor(), 'manual-translate', new Date().toISOString())

      return responseText
    } catch (error) {
      console.error('GigaChat translation error:', error)
      return undefined
    }
  }

  async compactConversation (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    transcript: string,
    lang: string,
    previousSummary?: string,
    level?: AILevel
  ): Promise<string | undefined> {
    if (transcript.trim() === '') return undefined
    try {
      const response = await this.client.chat({
        messages: [
          { role: 'system', content: PROMPTS.COMPACT_CONVERSATION(lang, previousSummary) },
          { role: 'user', content: transcript }
        ],
        model: this.modelFor(level)
      })
      // Compaction is part of the harness: its tokens are billed like any other request, with a
      // reason of its own so the breakdown shows what compacting costs.
      billUsage(
        ctx,
        workspace,
        usageFromApi(response.usage),
        this.billingFor(level),
        'compaction',
        new Date().toISOString()
      )
      return response.choices?.[0]?.message?.content ?? undefined
    } catch (e) {
      ctx.error('gigachat compaction failed', { error: (e as any)?.message })
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
    try {
      const personToName = buildPersonNameMap(messages)
      const text = buildMessageText(messages)

      const response = await this.client.chat({
        messages: [
          {
            role: 'system',
            content: PROMPTS.SUMMARIZE_MESSAGES(lang, description)
          },
          {
            role: 'user',
            content: text
          }
        ],
        model: this.modelFor(level)
      })

      const usage = usageFromApi(response.usage)
      billUsage(ctx, workspace, usage, this.billingFor(level), 'summarize', new Date().toISOString())

      let responseText = response.choices?.[0]?.message?.content ?? undefined
      if (responseText === undefined) return undefined

      responseText = replacePersonRefs(responseText, personToName, encodeURIComponent(contact.class.Contact))

      return responseText
    } catch (error) {
      console.error('GigaChat summarization error:', error)
      return undefined
    }
  }

  async createChatCompletionWithTools (
    tools: RunnableTools<BaseFunctionsArgs>,
    message: ChatMessage,
    contextMode: 'direct' | 'thread',
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
    try {
      // GigaChat has no SDK auto-loop (unlike OpenAI runTools), so drive the shared tool loop
      // ourselves: extract serializable defs + local executors, then step via chatToolStep.
      const { toolDefinitions, execute, knownTools } = buildToolExecutor(tools)

      const ask: AskModel = async (priorToolResults, noTools, continueFrom) =>
        await this.chatToolStep(
          ctx,
          workspace,
          message,
          contextMode,
          sharedPrompt,
          personalContext,
          user,
          noTools === true ? [] : toolDefinitions,
          priorToolResults,
          history,
          skipCache,
          reason,
          level,
          lang,
          continueFrom
        )

      const result = await runToolCalls(ask, execute, MAX_TOOL_ITERATIONS, hooks, knownTools)
      return {
        completion: result?.completion,
        usage: result?.usage,
        cancelled: result?.cancelled,
        toolTranscript: result?.toolTranscript
      }
    } catch (error) {
      // Rethrow so the pod marks the request failed instead of silently returning no reply.
      ctx.error('GigaChat tools completion failed', { error: (error as any)?.message })
      throw error
    }
  }

  // GigaChat native function-calling differs from OpenAI (functions/function_call, object args);
  // normalized to the shared ToolCall shape below so the pod's tool loop stays provider-agnostic.
  async chatToolStep (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    message: ChatMessage,
    contextMode: ContextMode,
    sharedPrompt: string,
    personalContext: string,
    user: string,
    toolDefinitions: ToolDefinition[],
    priorToolResults: ToolResult[],
    history: ChatMessage[] = [],
    skipCache = true,
    reason = 'chat',
    level?: AILevel,
    lang?: string,
    continueFrom?: string
  ): Promise<ChatToolStepResult | undefined> {
    try {
      const isDirectMode = contextMode === 'direct'
      const systemMessages = history.filter((it) => it.role === 'system')
      const systemPrompt = buildSystemPrompt(
        isDirectMode,
        sharedPrompt,
        personalContext,
        systemMessages,
        lang,
        this.maxTokensFor(level),
        config.FirstName
      )

      const messages: any[] = [
        { role: 'system', content: systemPrompt },
        ...history.filter((it) => it.role !== 'system'),
        message,
        ...(continueFrom !== undefined
          ? [
              { role: 'assistant', content: continueFrom },
              { role: 'user', content: CONTINUE_PROMPT }
            ]
          : [])
      ]
      // Replay prior tool calls: GigaChat expects an assistant function_call turn (echoing
      // functions_state_id) followed by a role:'function' result. id format: `gigachat:<stateId>:<name>`.
      for (const tr of priorToolResults) {
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = tr.arguments != null && tr.arguments !== '' ? JSON.parse(tr.arguments) : {}
        } catch {
          parsedArgs = {}
        }
        const stateId = tr.id.startsWith('gigachat:') ? tr.id.split(':')[1] : ''
        const assistantTurn: any = { role: 'assistant', function_call: { name: tr.name, arguments: parsedArgs } }
        if (stateId !== '') assistantTurn.functions_state_id = stateId
        messages.push(assistantTurn)
        // GigaChat parses the function result content as JSON (a plain string 422s). Wrap the
        // tool's textual result in a JSON object so it is always valid JSON.
        messages.push({ role: 'function', name: tr.name, content: JSON.stringify({ result: tr.content }) })
      }

      const functions =
        toolDefinitions.length > 0
          ? toolDefinitions.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
          : undefined

      if (config.LLMDebug) {
        ctx.info('LLM debug -> gigachat chatToolStep', {
          model: this.modelFor(level),
          messages,
          functions: functions?.map((f) => f.name)
        })
      }

      const response = await withRetry(
        async () =>
          await this.client.chat({
            messages,
            model: this.modelFor(level),
            user,
            functions: functions as any,
            function_call: functions !== undefined ? 'auto' : undefined,
            // Per-level output cap (yaml registry); headroom for long rewrite_document bodies, else
            // GigaChat truncates the function_call mid-argument (finish_reason=length).
            max_tokens: this.maxTokensFor(level)
          } as any),
        { maxRetries: 3, isRetryable: retryNetworkErrors },
        'gigachat.chatToolStep'
      )

      const choice = response.choices?.[0]
      const msg = choice?.message
      const usage = usageFromApi(response.usage)

      if (config.LLMDebug) {
        ctx.info('LLM debug <- gigachat chatToolStep', {
          model: this.modelFor(level),
          content: msg?.content,
          functionCall: (msg as any)?.function_call,
          finishReason: choice?.finish_reason,
          // finish_reason=length is only readable next to the cap we asked for and what was spent.
          maxTokens: this.maxTokensFor(level),
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens
        })
      }

      billUsage(ctx, workspace, usage, this.billingFor(level), reason, new Date().toISOString())

      const call = (msg as any)?.function_call
      if (choice?.finish_reason === 'function_call' && call?.name != null) {
        // GigaChat needs functions_state_id echoed back on the assistant replay turn, else 422.
        // Smuggled through the ToolCall id (opaque to the loop) and decoded in the replay above.
        const stateId = (msg as any)?.functions_state_id ?? ''
        // arguments may already be a JSON string or an object; stringify only objects, else
        // double-stringifying a string corrupts markdown bodies (escaped newlines).
        const rawArgs = call.arguments ?? {}
        const toolCall: ToolCall = {
          id: `gigachat:${stateId}:${call.name}`,
          name: call.name,
          arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)
        }
        return { toolCalls: [toolCall], usage }
      }

      const str = msg?.content ?? undefined
      const truncated = choice?.finish_reason === 'length'
      // Cut off with nothing to show: the model spent its budget inside a function_call, which is
      // then lost whole. The loop retries it with an instruction to send the body in parts.
      return { content: str !== '' ? str : undefined, usage, truncated }
    } catch (e) {
      const resp = (e as any)?.response
      ctx.error('gigachat chatToolStep failed', {
        error: (e as any)?.message,
        status: resp?.status,
        data: JSON.stringify(resp?.data ?? {})
      })
      throw e
    }
  }

  countTokens (messages: ChatMessage[]): number {
    try {
      // Approximate with cl100k_base: GigaChat models aren't directly supported by js-tiktoken.
      let text = ''
      for (const message of messages) {
        text += message.content + ' '
      }
      return this.encoding.encode(text).length
    } catch {
      // Best-effort fallback: return 0 if token counting fails for any reason
      return 0
    }
  }
}

/**
 * Helper factory to create GigaChat provider when GigaChat is configured.
 */
export function createGigaChatProvider (ctx: MeasureContext, provider: AIProviderConfig): LLMProvider | undefined {
  const credentials = (provider.endpointConfig?.credentials as string) ?? config.GigaChatCredentials
  if (credentials !== '') {
    return new GigaChatProvider(ctx, provider)
  }
  return undefined
}

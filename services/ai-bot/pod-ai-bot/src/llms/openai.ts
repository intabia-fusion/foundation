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
 * OpenAI-backed implementation of the LLMProvider interface.
 */

import { encodingForModel, getEncoding, Tiktoken } from 'js-tiktoken'
import OpenAI from 'openai'

import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import type { PersonMessage } from '@hcengineering/ai-bot'
import contact from '@hcengineering/contact'
import config, { type AILevel, type AIProviderConfig } from '../config'
import { providerLevels, billingMetaFor } from './modelRegistry'
import { countTokens } from '@hcengineering/openai'
import { pushTokensData, tokensRecord, billUsage } from '../billing'
import { withRetry, retryNetworkErrors } from '@hcengineering/retry'
import type {
  LLMProvider,
  ChatMessage,
  ChatCompletionWithToolsResult,
  ContextMode,
  ToolDefinition,
  ToolResult,
  ChatToolStepResult,
  ToolLoopHooks
} from './types'
import { totalTokens, usageFromApi } from './types'
import { runToolCalls, buildToolExecutor, MAX_TOOL_ITERATIONS, type AskModel } from './toolLoop'
import type { RunnableTools, BaseFunctionsArgs } from 'openai/lib/RunnableFunction'
import { PROMPTS, buildSystemPrompt, CONTINUE_PROMPT } from './prompts'
import { buildPersonNameMap, buildMessageText, replacePersonRefs } from './summarizeUtils'
import { parseInlineToolCalls } from './inlineToolCalls'

export default class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI
  private readonly encoding: Tiktoken
  private readonly provider: AIProviderConfig
  private readonly defaultLevel: AILevel

  constructor (
    readonly ctx: MeasureContext,
    provider: AIProviderConfig
  ) {
    this.provider = provider
    // strongest served level is the default for service ops (translate/summary),
    // resolved by `order` so custom level ids work (not a hardcoded list)
    const served = providerLevels(provider)
    this.defaultLevel = served[served.length - 1] ?? 'low'

    this.client = new OpenAI({
      apiKey: (provider.endpointConfig?.apiKey as string) ?? config.OpenAIKey,
      baseURL: provider.endpoint ?? (config.OpenAIBaseUrl === '' ? undefined : config.OpenAIBaseUrl)
    })

    // Try to obtain encoding for the default model; fallback to universal encoding.
    this.encoding = (() => {
      try {
        return encodingForModel(this.modelFor(this.defaultLevel) as any)
      } catch {
        return getEncoding('cl100k_base')
      }
    })()
  }

  /** Resolve the concrete model name for a level, falling back to the default level. */
  private modelFor (level?: AILevel): string {
    const lvl = level ?? this.defaultLevel
    return this.provider.levels[lvl]?.model ?? this.provider.levels[this.defaultLevel]?.model ?? config.OpenAIModel
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
    const response = await this.client.chat.completions.create({
      model: this.modelFor(),
      messages: [
        {
          role: 'system',
          content: PROMPTS.TRANSLATE_HTML(lang)
        },
        {
          role: 'user',
          content: html
        }
      ]
    })

    const responseText = response.choices?.[0]?.message?.content ?? undefined

    const usage = usageFromApi(response.usage)
    const total = totalTokens(usage)
    if (total !== 0 && usage !== undefined) {
      const { multiplier, modelId, providerId, level } = this.billingFor()
      void pushTokensData(
        ctx,
        [
          tokensRecord(
            workspace,
            usage.promptTokens,
            usage.completionTokens,
            multiplier,
            'manual-translate',
            modelId,
            new Date((response.created ?? Date.now() / 1000) * 1000).toISOString(),
            providerId,
            level
          )
        ],
        response.id
      )
    }

    return responseText
  }

  async summarizeMessages (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    messages: PersonMessage[],
    lang: string,
    description?: string,
    level?: AILevel
  ): Promise<string | undefined> {
    const personToName = buildPersonNameMap(messages)
    const text = buildMessageText(messages)

    const response = await this.client.chat.completions.create({
      model: this.modelFor(level),
      messages: [
        {
          role: 'system',
          content: PROMPTS.SUMMARIZE_MESSAGES(lang, description)
        },
        {
          role: 'user',
          content: text
        }
      ]
    })

    const usage = usageFromApi(response.usage)
    const total = totalTokens(usage)
    if (total !== 0 && usage !== undefined) {
      const billing = this.billingFor(level)
      void pushTokensData(
        ctx,
        [
          tokensRecord(
            workspace,
            usage.promptTokens,
            usage.completionTokens,
            billing.multiplier,
            'summarize',
            billing.modelId,
            new Date((response.created ?? Date.now() / 1000) * 1000).toISOString(),
            billing.providerId,
            billing.level
          )
        ],
        response.id
      )
    }

    let responseText = response.choices?.[0]?.message?.content ?? undefined
    if (responseText === undefined) return undefined

    responseText = replacePersonRefs(responseText, personToName, encodeURIComponent(contact.class.Contact))

    return responseText
  }

  async correctTranscript (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    text: string,
    lang?: string,
    level?: AILevel
  ): Promise<string | undefined> {
    if (text.trim() === '') return text
    const response = await this.client.chat.completions.create({
      model: this.modelFor(level),
      messages: [
        { role: 'system', content: PROMPTS.CORRECT_TRANSCRIPT(lang) },
        { role: 'user', content: text }
      ]
    })
    const usage = usageFromApi(response.usage)
    if (totalTokens(usage) !== 0 && usage !== undefined) {
      billUsage(
        ctx,
        workspace,
        usage,
        this.billingFor(level),
        'transcript-correct',
        new Date((response.created ?? Date.now() / 1000) * 1000).toISOString()
      )
    }
    return response.choices?.[0]?.message?.content ?? undefined
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
    const response = await this.client.chat.completions.create({
      model: this.modelFor(level),
      messages: [
        { role: 'system', content: PROMPTS.COMPACT_CONVERSATION(lang, previousSummary) },
        { role: 'user', content: transcript }
      ]
    })
    const usage = usageFromApi(response.usage)
    if (totalTokens(usage) !== 0 && usage !== undefined) {
      // Compaction is part of the harness and its tokens are the workspace's: billed like any
      // other request, with its own reason so the breakdown shows what compacting costs.
      billUsage(
        ctx,
        workspace,
        usage,
        this.billingFor(level),
        'compaction',
        new Date((response.created ?? Date.now() / 1000) * 1000).toISOString()
      )
    }
    return response.choices?.[0]?.message?.content ?? undefined
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
      // Shared tool loop instead of the SDK's own `runTools`: only this loop reports per-round
      // progress and honours cancellation. Billing happens inside chatToolStep, per round.
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

      // Reasoning models leak their scratchpad; keep only what follows the closing tag.
      let completion = result?.completion
      const pos = (completion ?? '').indexOf('</think>')
      if (pos > 0) {
        completion = (completion ?? '').substring(pos + 8)
      }

      return { completion, usage: result?.usage, cancelled: result?.cancelled, toolTranscript: result?.toolTranscript }
    } catch (e) {
      ctx.error('openai tools completion failed', { error: (e as any)?.message })
    }

    return undefined
  }

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
    const opt: OpenAI.RequestOptions = {}
    if (skipCache) {
      opt.headers = { 'cf-skip-cache': 'true' }
    }

    try {
      const isDirectMode = contextMode === 'direct'
      const systemMessages = history.filter((it) => it.role === 'system')
      const systemPrompt = buildSystemPrompt(
        isDirectMode,
        sharedPrompt,
        personalContext,
        systemMessages,
        lang,
        this.provider.levels[level ?? this.defaultLevel]?.capabilities?.maxOutputTokens,
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
      // Replay prior tool results. A model that emitted the call inline (id `inline_*`) can't read
      // back a structured tool_calls turn, so feed those back as plain text; native callers keep the structured transcript.
      for (const tr of priorToolResults) {
        if (tr.id.startsWith('inline_')) {
          messages.push({ role: 'assistant', content: `Tool call: ${tr.name}(${tr.arguments ?? '{}'})` })
          messages.push({ role: 'user', content: `Tool result (${tr.name}):\n${tr.content}` })
          continue
        }
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: tr.id, type: 'function', function: { name: tr.name, arguments: tr.arguments ?? '{}' } }]
        })
        messages.push({ role: 'tool', tool_call_id: tr.id, content: tr.content })
      }

      const tools =
        toolDefinitions.length > 0
          ? toolDefinitions.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters }
          }))
          : undefined

      if (config.LLMDebug) {
        ctx.info('LLM debug -> openai chatToolStep', {
          model: this.modelFor(level),
          messages,
          tools: tools?.map((t) => t.function.name)
        })
      }

      // Retry transient network failures (local endpoint restart, connection drop) before
      // giving up; a hard-down endpoint still exhausts retries and rethrows so the pod notifies.
      const maxTokens = this.provider.levels[level ?? this.defaultLevel]?.capabilities?.maxOutputTokens
      const response = await withRetry(
        async () =>
          await this.client.chat.completions.create(
            { messages, model: this.modelFor(level), user, tools, stream: false, max_tokens: maxTokens },
            opt
          ),
        { maxRetries: 3, isRetryable: retryNetworkErrors },
        'openai.chatToolStep'
      )

      const choice = response.choices?.[0]?.message
      const usage = usageFromApi(response.usage)

      if (config.LLMDebug) {
        ctx.info('LLM debug <- openai chatToolStep', {
          model: this.modelFor(level),
          content: choice?.content,
          toolCalls: choice?.tool_calls,
          finishReason: response.choices?.[0]?.finish_reason
        })
      }
      billUsage(
        ctx,
        workspace,
        usage,
        this.billingFor(level),
        reason,
        new Date((response.created ?? Date.now() / 1000) * 1000).toISOString()
      )

      const rawCalls = choice?.tool_calls ?? []
      if (rawCalls.length > 0) {
        return {
          toolCalls: rawCalls.map((c: any) => ({
            id: c.id,
            name: c.function?.name ?? '',
            arguments: c.function?.arguments ?? ''
          })),
          usage
        }
      }

      // Some local OpenAI-compatible servers (gpt-oss/GigaChat harmony, no tool-call parser)
      // emit the call as TEXT in content instead of tool_calls; recover it for the tool loop.
      const inline = parseInlineToolCalls(choice?.content ?? '')
      if (inline.toolCalls.length > 0) {
        return { toolCalls: inline.toolCalls, usage }
      }

      // 'length' means the model ran into its output cap, so the text below is cut mid-thought.
      const truncated = response.choices?.[0]?.finish_reason === 'length'
      return { content: inline.content !== '' ? inline.content : undefined, usage, truncated }
    } catch (e) {
      // Rethrow so the worker rejects the WS request and the pod can notify the user
      // (an empty content is a valid model reply and returns above; this path is a real failure).
      ctx.error('openai chatToolStep failed', { error: (e as any)?.message })
      throw e
    }
  }

  countTokens (messages: ChatMessage[]): number {
    try {
      return countTokens(messages as any, this.encoding)
    } catch {
      // Best-effort fallback: return 0 if token counting fails for any reason
      return 0
    }
  }
}

/**
 * Helper factory to create an OpenAI provider for a registry provider config.
 * Returns undefined when neither the provider nor the global config supplies an API key.
 */
export function createOpenAIProvider (ctx: MeasureContext, provider: AIProviderConfig): LLMProvider | undefined {
  const apiKey = (provider.endpointConfig?.apiKey as string) ?? config.OpenAIKey
  if (apiKey !== '') {
    return new OpenAIProvider(ctx, provider)
  }
  return undefined
}

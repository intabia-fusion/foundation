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
  PlanContext,
  ToolCall,
  ToolDefinition,
  ToolResult
} from './types'
import { usageFromApi } from './types'
import { runToolCalls, type AskModel } from './toolLoop'
import type { RunnableTools, BaseFunctionsArgs } from 'openai/lib/RunnableFunction'
import { PROMPTS, buildSystemPrompt } from './prompts'
import { buildPersonNameMap, buildMessageText, replacePersonRefs } from './summarizeUtils'

// Max model<->tool round trips before we force a plain-text answer (mirrors clisr's MAX_TOOL_ITERATIONS).
const GIGACHAT_MAX_TOOL_ITERATIONS = 8

export default class GigaChatProvider implements LLMProvider {
  private readonly client: GigaChat
  private readonly encoding: Tiktoken // js-tiktoken doesn't have a direct encoding for GigaChat models
  private readonly provider: AIProviderConfig
  private readonly defaultLevel: AILevel

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
  }

  /** Resolve the concrete model name for a level, falling back to the default level. */
  private modelFor (level?: AILevel): string {
    const lvl = level ?? this.defaultLevel
    return this.provider.levels[lvl]?.model ?? this.provider.levels[this.defaultLevel]?.model ?? config.GigaChatModel
  }

  /** Billing multiplier + model id for a level (used to bill tokens). */
  private billingFor (
    level?: AILevel,
    planContext?: PlanContext
  ): { multiplier: number, modelId: string, providerId: string, level: string } {
    return billingMetaFor(this.provider, level, this.defaultLevel, () => this.modelFor(level), planContext)
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

  async summarizeMessages (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    messages: PersonMessage[],
    lang: string,
    description?: string
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
        model: this.modelFor()
      })

      const usage = usageFromApi(response.usage)
      billUsage(ctx, workspace, usage, this.billingFor(), 'summarize', new Date().toISOString())

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
    planContext?: PlanContext,
    lang?: string
  ): Promise<ChatCompletionWithToolsResult | undefined> {
    try {
      // GigaChat has no SDK auto-loop (unlike OpenAI runTools), so drive the shared tool loop
      // ourselves: extract serializable defs + local executors, then step via chatToolStep.
      const toolDefinitions: ToolDefinition[] = tools.map((tool) => ({
        name: tool.function.name ?? '',
        description: tool.function.description ?? '',
        parameters: (tool.function.parameters ?? {}) as Record<string, unknown>
      }))
      const executors = new Map<string, (args: any) => Promise<any> | any>()
      for (const tool of tools) {
        const name = tool.function.name
        if (name !== undefined && name !== '') {
          executors.set(name, tool.function.function as (args: any) => Promise<any> | any)
        }
      }

      const execute = async (call: ToolCall): Promise<string> => {
        const fn = executors.get(call.name)
        if (fn === undefined) return `Error: unknown tool '${call.name}'`
        let args: any = {}
        try {
          args = call.arguments === '' ? {} : JSON.parse(call.arguments)
        } catch {
          return `Error: invalid arguments for tool '${call.name}'`
        }
        try {
          const res = await fn(args)
          return typeof res === 'string' ? res : JSON.stringify(res)
        } catch (err: any) {
          return `Error executing tool '${call.name}': ${err?.message ?? String(err)}`
        }
      }

      const ask: AskModel = async (priorToolResults, noTools) =>
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
          planContext,
          lang
        )

      const result = await runToolCalls(ask, execute, GIGACHAT_MAX_TOOL_ITERATIONS)
      return { completion: result?.completion, usage: result?.usage }
    } catch (error) {
      // Rethrow so the pod marks the request failed instead of silently returning no reply.
      ctx.error('GigaChat tools completion failed', { error: (error as any)?.message })
      throw error
    }
  }

  // GigaChat function-calling (native, gigachat lib >=0.0.18). Differs from OpenAI: `functions`
  // (not `tools`), a single `message.function_call` (not an array), arguments as an OBJECT, and
  // detection via finish_reason === 'function_call'. We normalize to the shared ToolCall shape
  // (arguments as a JSON string) so the pod's tool loop stays provider-agnostic.
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
    planContext?: PlanContext,
    lang?: string
  ): Promise<ChatToolStepResult | undefined> {
    try {
      const isDirectMode = contextMode === 'direct'
      const systemMessages = history.filter((it) => it.role === 'system')
      const systemPrompt = buildSystemPrompt(isDirectMode, sharedPrompt, personalContext, systemMessages, lang)

      const messages: any[] = [
        { role: 'system', content: systemPrompt },
        ...history.filter((it) => it.role !== 'system'),
        message
      ]
      // Replay prior tool calls so the model continues where it left off. GigaChat expects the
      // assistant's function_call turn (echoing the functions_state_id from the original response)
      // followed by a role:'function' result carrying the name. id format: `gigachat:<stateId>:<name>`.
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
            function_call: functions !== undefined ? 'auto' : undefined
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
          finishReason: choice?.finish_reason
        })
      }

      billUsage(ctx, workspace, usage, this.billingFor(level, planContext), reason, new Date().toISOString())

      const call = (msg as any)?.function_call
      if (choice?.finish_reason === 'function_call' && call?.name != null) {
        // GigaChat needs functions_state_id from THIS response echoed back on the assistant
        // replay turn, else the follow-up 422s. Smuggle it through the ToolCall id (the loop
        // treats it as opaque) and decode it in the replay above.
        const stateId = (msg as any)?.functions_state_id ?? ''
        const toolCall: ToolCall = {
          id: `gigachat:${stateId}:${call.name}`,
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {})
        }
        return { toolCalls: [toolCall], usage }
      }

      const str = msg?.content ?? undefined
      return { content: str !== '' ? str : undefined, usage }
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
      // For GigaChat, we'll use the cl100k_base encoding as an approximation
      // since GigaChat models aren't directly supported by js-tiktoken
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

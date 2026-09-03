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

import os from 'os'
import { setMetadata } from '@hcengineering/platform'
import serverClient from '@hcengineering/server-client'
import { initStatisticsContext } from '@hcengineering/server-core'
import serverToken from '@hcengineering/server-token'

import { createOpenTelemetryMetricsContext, SplitLogger } from '@hcengineering/analytics-service'
import { type MeasureContext, newMetrics } from '@hcengineering/core'
import { join } from 'path'
import config from './config'
import { registerLoaders } from './loaders'
import { createTranscriptionProvider, TranscriptionConfig, TranscriptionOptions } from './transcription'
import { ClisrClient, createCallbackClient } from '@intabiafusion/clisr'
import { createDefaultProvider, createProvidersFromRegistry, type LLMProvider, type LLMRequest } from './llms'
import { resolveModel } from './llms/modelRegistry'
import { resolveTranscriptionConfig } from './transcription/asrRegistry'

export const startClient = async (): Promise<void> => {
  setMetadata(serverToken.metadata.Secret, config.ServerSecret)
  setMetadata(serverToken.metadata.Service, 'ai-bot-service')
  setMetadata(serverClient.metadata.UserAgent, config.ServiceID)
  setMetadata(serverClient.metadata.Endpoint, config.AccountsURL)

  registerLoaders()

  const ctx = initStatisticsContext('ai-bot-service', {
    factory: () =>
      createOpenTelemetryMetricsContext(
        'ai-bot-service',
        {},
        {},
        newMetrics(),
        new SplitLogger('ai-bot-service', {
          root: join(process.cwd(), 'logs'),
          enableConsole: (process.env.ENABLE_CONSOLE ?? 'true') === 'true'
        })
      )
  })
  ctx.info('AI Bot Client Service started', { firstName: config.FirstName, lastName: config.LastName })

  // STT_PROVIDER=none opts a worker out of ASR even when the shared registry yaml has an `asr:`
  // block (e.g. an LLM-only worker mounts the same config but must not register transcription).
  const asrDisabled = config.SttProvider === 'none'
  const transcriptionConfig: TranscriptionConfig = asrDisabled
    ? { provider: '' }
    : resolveTranscriptionConfig(config.AsrProviders, config.AsrDefaultLevel, {
      vadRmsThreshold: config.VadRmsThreshold,
      vadSpeechRatioThreshold: config.VadSpeechRatioThreshold
    })

  ctx.info('Transcription config', {
    provider: transcriptionConfig.provider,
    url: transcriptionConfig.url,
    vadRmsThreshold: transcriptionConfig.vadRmsThreshold,
    vadSpeechRatioThreshold: transcriptionConfig.vadSpeechRatioThreshold
  })

  const methods: Record<string, ClisrClient['binaryHandler']> = {}

  let transcriptionEnabled = false
  let llmEnabled = false

  // LLM_PROVIDER=none opts a worker out of LLM even when the shared registry yaml has an `llm:` block.
  const providers = config.LLMProvider === 'none' ? new Map<string, LLMProvider>() : createProvidersFromRegistry(ctx)
  const llmProvider = config.LLMProvider === 'none' ? undefined : createDefaultProvider(ctx, undefined, providers)
  // The provider serving the request's level; the default level's one when nobody serves it.
  function providerFor (level?: string): LLMProvider | undefined {
    const cfg = config.AIProviders.find((c) => c.levels[level ?? config.DefaultLevel] !== undefined)
    return (cfg !== undefined ? providers.get(cfg.id) : undefined) ?? llmProvider
  }

  // Resolve the concrete endpoint + model this client serves a request with (for logging).
  function resolveTarget (level?: string): { endpoint: string, model: string } {
    try {
      const resolved = resolveModel(level ?? config.DefaultLevel, config.AIProviders)
      return { endpoint: resolved.provider.endpoint ?? config.OpenAIBaseUrl ?? '', model: resolved.model.model }
    } catch {
      return { endpoint: config.OpenAIBaseUrl ?? '', model: '' }
    }
  }

  // Build LLM request handler
  async function handleLLMRequest (ctx: MeasureContext, args: any[]): Promise<any> {
    if (llmProvider === undefined) {
      throw new Error('LLM provider is not configured')
    }
    const request = args[0] as LLMRequest
    const level: string | undefined = (request as any).level
    const target = resolveTarget(level)
    const startTime = Date.now()
    ctx.info('LLM client request -> server', {
      method: request.method,
      level: level ?? config.DefaultLevel,
      endpoint: target.endpoint,
      model: target.model,
      workspace: (request as any).workspace
    })
    if (config.LLMDebug) {
      const r = request as any
      ctx.info('LLM debug request payload', {
        method: request.method,
        message: r.message,
        history: r.history,
        toolDefinitions: r.toolDefinitions,
        priorToolResults: r.priorToolResults,
        sharedPrompt: r.sharedPrompt,
        personalContext: r.personalContext
      })
    }
    try {
      const result = await dispatchLLMRequest(ctx, request, level)
      // Tag tool-loop steps with this worker's id so the router can attribute usage per client.
      if (config.ClientId !== '' && request.method === 'createChatCompletionWithTools' && result != null) {
        result.clientId = config.ClientId
      }
      const usage = result?.usage
      ctx.info('LLM client request <- server done', {
        method: request.method,
        model: target.model,
        elapsedMs: Date.now() - startTime,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens
      })
      if (config.LLMDebug) {
        ctx.info('LLM debug response payload', {
          method: request.method,
          content: result?.content ?? result?.completion,
          toolCalls: result?.toolCalls,
          result: result?.toolCalls === undefined && result?.content === undefined ? result : undefined
        })
      }
      return result
    } catch (err: any) {
      ctx.error('LLM client request failed', {
        method: request.method,
        model: target.model,
        elapsedMs: Date.now() - startTime,
        error: err?.message
      })
      throw err
    }
  }

  async function dispatchLLMRequest (ctx: MeasureContext, request: LLMRequest, level?: string): Promise<any> {
    const llmProvider = providerFor(level)
    if (llmProvider === undefined) {
      throw new Error('LLM provider is not configured')
    }
    switch (request.method) {
      case 'translateHtml':
        return await llmProvider.translateHtml(ctx, request.workspace, request.html, request.lang)
      case 'summarizeMessages':
        return await llmProvider.summarizeMessages(
          ctx,
          request.workspace,
          request.messages,
          request.lang,
          request.description,
          request.level
        )
      case 'createChatCompletionWithTools': {
        // Runs one model step, returning tool_calls or a final completion; falls back
        // to a tool-less completion for providers without chatToolStep.
        if (llmProvider.chatToolStep !== undefined) {
          return await llmProvider.chatToolStep(
            ctx,
            request.workspace,
            request.message,
            request.contextMode,
            request.sharedPrompt,
            request.personalContext,
            request.user,
            request.toolDefinitions ?? [],
            request.priorToolResults ?? [],
            request.history,
            request.skipCache,
            request.reason,
            request.level,
            request.lang,
            request.continueFrom
          )
        }
        return await llmProvider.createChatCompletionWithTools(
          [] as any,
          request.message,
          request.contextMode,
          request.sharedPrompt,
          request.personalContext,
          request.user,
          ctx,
          request.workspace,
          request.history,
          request.skipCache,
          request.reason,
          request.level,
          request.lang
        )
      }
      case 'countTokens':
        return llmProvider.countTokens(request.messages)
      default:
        throw new Error(`Unknown LLM method: ${(request as any).method}`)
    }
  }

  const client = await createCallbackClient(ctx, config.ServerUrl, config.ApiToken, {
    clientHost: `ai-bot-client@${os.hostname()}`,
    callback: async (ctx, task, args) => {
      if (task === 'llm') {
        return await handleLLMRequest(ctx, args)
      }
      throw new Error(`Unknown task: ${task}`)
    },
    binaryExecutor: async (ctx, method, data, headers) => {
      const handler = methods[method]
      if (handler === undefined) {
        throw new Error(`No handler for method ${method}`)
      }
      return await handler(ctx, method, data, headers)
    },
    onConnect: async (event) => {
      if (transcriptionEnabled) {
        await client.request('transcription', [true, config.SttCapacity])
      }
      if (llmEnabled) {
        await client.request('llm', [true])
      }
    }
  })

  // Register LLM capability
  if (llmProvider !== undefined) {
    llmEnabled = true
    await client.request('llm', [true])
    ctx.info('LLM provider registered with server', { provider: config.LLMProvider })
  }

  if (transcriptionConfig.provider !== undefined && transcriptionConfig.provider !== '') {
    try {
      const provider = createTranscriptionProvider(ctx, transcriptionConfig)

      methods.transcribe = async (ctx, method, data, headers) => {
        const options: TranscriptionOptions = headers?.options ?? {}
        // OGG/Opus audio format - pass directly to provider
        const result = await provider.transcribe(Buffer.from(data), options)
        // Tag with this worker's id so the router can attribute transcription usage per client.
        if (config.ClientId !== '') {
          result.clientId = config.ClientId
        }
        return result
      }
      transcriptionEnabled = true
      // Inform aibot client is enabled for transcriptions
      await client.request('transcription', [true, config.SttCapacity])
    } catch (err: any) {
      ctx.warn('Failed to create transcription provider', { error: err.message })
    }
  } else {
    ctx.info('Transcription provider not configured, skipping')
  }

  const onClose = (): void => {
    void client.close()
  }

  process.on('SIGINT', onClose)
  process.on('SIGTERM', onClose)
  process.on('uncaughtException', (e: Error) => {
    console.error(e)
  })
  process.on('unhandledRejection', (e: Error) => {
    console.error(e)
  })
}

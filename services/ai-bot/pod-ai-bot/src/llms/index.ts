//
// Copyright © 2025 Hardcore Engineering Inc.
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

import type { MeasureContext } from '@hcengineering/core'
import { ClisrServer } from '@intabiafusion/clisr'
import config, { type AIProviderConfig } from '../config'

import { createOpenAIProvider } from './openai'
import { createGigaChatProvider } from './gigachat'
import { createServerLLMProvider } from './server'
import { createMockProvider } from './mock'
import { LLMProvider } from './types'

// Re-export types for convenience
export type {
  LLMProvider,
  ChatMessage,
  ChatCompletionWithToolsResult,
  ContextMode,
  TokenUsage,
  ToolLoopHooks
} from './types'
export { totalTokens } from './types'

// Re-export server provider request types
export type {
  TranslateHtmlRequest,
  SummarizeMessagesRequest,
  ChatCompletionWithToolsRequest,
  CountTokensRequest,
  LLMRequest
} from './server'

// Re-export prompts for consistency
export { PROMPTS } from './prompts'

// Re-export provider factory for direct usage if needed
export { createOpenAIProvider } from './openai'
export { createGigaChatProvider } from './gigachat'
export { createServerLLMProvider } from './server'

/** Instantiate a single LLM provider from its registry config. */
export function createProvider (
  ctx: MeasureContext,
  cfg: AIProviderConfig,
  server?: ClisrServer
): LLMProvider | undefined {
  switch (cfg.provider) {
    case 'clisr': {
      if (server === undefined) {
        ctx.error('clisr LLM provider requires ClisrServer instance', { id: cfg.id })
        return undefined
      }
      return createServerLLMProvider(ctx, server, cfg)
    }
    case 'gigachat':
      return createGigaChatProvider(ctx, cfg)
    case 'openai':
      return createOpenAIProvider(ctx, cfg)
    case 'mock':
      return createMockProvider(ctx, cfg)
    default:
      ctx.warn('Unknown provider type', { provider: cfg.provider, id: cfg.id })
      return undefined
  }
}

/**
 * Resolve the provider serving the configured default level (for client mode and
 * service ops that are not part of the per-provider pipeline).
 */
export function createDefaultProvider (
  ctx: MeasureContext,
  server?: ClisrServer,
  built?: Map<string, LLMProvider>
): LLMProvider | undefined {
  const serves = (cfg: AIProviderConfig): boolean => cfg.levels[config.DefaultLevel] !== undefined
  const cfg = config.AIProviders.find(serves) ?? config.AIProviders[0]
  if (cfg === undefined) {
    ctx.info('No LLM providers configured, disabled')
    return undefined
  }
  // Reuse the registry instance: a second one of the same provider means a second auth timer.
  return built?.get(cfg.id) ?? createProvider(ctx, cfg, server)
}

/**
 * Build all providers from the registry, keyed by provider id (= topic suffix).
 * Providers that fail to configure (missing keys) are skipped with a warning.
 */
export function createProvidersFromRegistry (ctx: MeasureContext, server?: ClisrServer): Map<string, LLMProvider> {
  const map = new Map<string, LLMProvider>()
  for (const cfg of config.AIProviders) {
    const provider = createProvider(ctx, cfg, server)
    if (provider !== undefined) {
      ctx.info('Registered LLM provider', { id: cfg.id, provider: cfg.provider, levels: Object.keys(cfg.levels) })
      map.set(cfg.id, provider)
    } else {
      ctx.warn('Skipping unconfigured LLM provider', { id: cfg.id, provider: cfg.provider })
    }
  }
  return map
}

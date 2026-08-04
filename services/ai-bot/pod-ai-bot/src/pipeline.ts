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

import { type AIEventRequest } from '@hcengineering/ai-bot'
import { type AILevel, type AIProviderConfig } from './config'
import { resolveModel } from './llms/modelRegistry'

/** Message carried on a per-provider topic: the original event + resolved level. */
export interface AIPipelineMessage {
  event: AIEventRequest
  level: AILevel
}

/** Per-provider topic name. The provider id is the topic suffix. */
export function providerTopic (providerId: string): string {
  return `llm-${providerId}`
}

export interface DispatchTarget {
  providerId: string
  topic: string
  level: AILevel // the level actually served (may differ from requested after fallback)
  model: string
  tokenMultiplier: number
}

/**
 * Resolve a requested level to the provider topic that should handle it.
 * Pure: the dispatcher uses this to pick the destination topic; the per-provider
 * consumer uses `providerId`/`level` to pick the concrete provider + model.
 */
export function dispatch (level: AILevel, registry: AIProviderConfig[]): DispatchTarget {
  const { provider, level: served, model } = resolveModel(level, registry)
  return {
    providerId: provider.id,
    topic: providerTopic(provider.id),
    level: served,
    model: model.model,
    tokenMultiplier: model.tokenMultiplier
  }
}

/** Distinct per-provider topics that must be created on startup. */
export function providerTopics (registry: AIProviderConfig[]): string[] {
  return [...new Set(registry.map((p) => providerTopic(p.id)))]
}

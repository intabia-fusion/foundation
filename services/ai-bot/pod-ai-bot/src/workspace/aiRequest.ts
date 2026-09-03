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

import { type AILevel, type AIRequest } from '@hcengineering/ai-bot'
import { type TokenUsage } from '../llms/types'

/** Fields set when a request is first enqueued (status is added by the caller). */
type AIRequestSeed = Pick<AIRequest, 'level' | 'modelId' | 'kind'> &
Pick<AIRequest, 'promptTokens' | 'completionTokens' | 'billedTokens'>

/** Initial AIRequest data at enqueue time: zero tokens. */
export function queuedRequest (level: AILevel, modelId: string, kind: string): AIRequestSeed {
  return {
    level,
    modelId,
    kind,
    promptTokens: 0,
    completionTokens: 0,
    billedTokens: 0
  }
}

/** Patch to mark a request as completed with the final token counts. */
export function donePatch (usage: TokenUsage | undefined, multiplier: number): Partial<AIRequest> {
  const prompt = usage?.promptTokens ?? 0
  const completion = usage?.completionTokens ?? 0
  return {
    status: 'done',
    promptTokens: prompt,
    completionTokens: completion,
    billedTokens: Math.ceil((prompt + completion) * multiplier)
  }
}

/** Patch to mark a request as failed with an error message. */
export function failedPatch (error: string): Partial<AIRequest> {
  return { status: 'failed', error }
}

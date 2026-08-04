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

import type { TokenUsage, ToolCall, ToolResult } from './types'
import type { ChatCompletionWithToolsReply } from './server'

/**
 * One round of asking the model: send accumulated tool results, get back either
 * a final completion or a new batch of tool calls to execute.
 * `noTools` asks for a plain text answer (tools withheld), used for the final round.
 */
export type AskModel = (
  priorToolResults: ToolResult[],
  noTools?: boolean
) => Promise<ChatCompletionWithToolsReply | undefined>

/** Execute a single tool call (on the pod, where WorkspaceClient context lives). */
export type ExecuteTool = (call: ToolCall) => Promise<string>

export interface ToolLoopResult {
  completion?: string
  usage?: TokenUsage
  // The clisr worker that served the run (from the last reply that carried one). Empty for direct.
  clientId?: string
}

/**
 * Drive the model<->tool loop for the clisr provider.
 *
 * The clisr client only runs the model and returns `toolCalls`; the pod executes
 * them (`execute`) and resubmits the results until the model returns a final
 * `completion` or `maxIterations` is reached. Usage is summed across rounds.
 *
 * Pure orchestration: the network call (`ask`) and tool execution (`execute`) are
 * injected, so this is unit-testable without clisr or a real WorkspaceClient.
 */
export async function runToolCalls (
  ask: AskModel,
  execute: ExecuteTool,
  maxIterations: number
): Promise<ToolLoopResult | undefined> {
  const priorToolResults: ToolResult[] = []
  let promptTokens = 0
  let completionTokens = 0
  let reasoningTokens = 0
  let sawUsage = false
  let lastContent: string | undefined
  let clientId: string | undefined

  for (let iter = 0; iter < maxIterations; iter++) {
    const reply = await ask(priorToolResults)
    if (reply === undefined) {
      return undefined
    }

    if (reply.clientId !== undefined && reply.clientId !== '') {
      clientId = reply.clientId
    }
    if (reply.usage !== undefined) {
      sawUsage = true
      promptTokens += reply.usage.promptTokens
      completionTokens += reply.usage.completionTokens
      reasoningTokens += reply.usage.reasoningTokens ?? 0
    }
    if (reply.content !== undefined && reply.content !== '') {
      lastContent = reply.content
    }

    const calls = reply.toolCalls ?? []
    if (calls.length === 0) {
      // Final answer.
      return {
        completion: reply.content,
        usage: sawUsage
          ? { promptTokens, completionTokens, ...(reasoningTokens > 0 ? { reasoningTokens } : {}) }
          : undefined,
        clientId
      }
    }

    // Execute the calls on the pod and keep every result: dropping earlier rounds would
    // hide already-fetched data from the model.
    priorToolResults.push(
      ...(await Promise.all(
        calls.map(async (call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          content: await execute(call)
        }))
      ))
    )
  }

  // Exhausted iterations, or stuck re-requesting the same tool. Collapse everything the tools
  // returned into one digest and ask again with tools withheld, so the model has the data it
  // kept asking for and must answer in plain text — otherwise the user gets silence.
  // `inline_` marks results the provider must replay as plain text — the only form a model
  // that emitted inline calls can read back. Keep the native transcript otherwise.
  const wasInline = priorToolResults.some((r) => r.id.startsWith('inline_'))
  const digest: ToolResult[] =
    priorToolResults.length > 0 && wasInline
      ? [
          {
            id: 'inline_summary',
            name: 'context',
            arguments: '{}',
            content: priorToolResults.map((r) => `[${r.name}]\n${r.content}`).join('\n\n')
          }
        ]
      : priorToolResults
  const final = await ask(digest, true)
  if (final?.clientId !== undefined && final.clientId !== '') {
    clientId = final.clientId
  }
  if (final?.usage !== undefined) {
    sawUsage = true
    promptTokens += final.usage.promptTokens
    completionTokens += final.usage.completionTokens
    reasoningTokens += final.usage.reasoningTokens ?? 0
  }
  const completion = final?.content !== undefined && final.content !== '' ? final.content : lastContent
  return {
    completion,
    usage: sawUsage
      ? { promptTokens, completionTokens, ...(reasoningTokens > 0 ? { reasoningTokens } : {}) }
      : undefined,
    clientId
  }
}

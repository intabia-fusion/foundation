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

import type { TokenUsage, ToolCall, ToolResult, ToolDefinition, ToolLoopHooks } from './types'
import type { ChatCompletionWithToolsReply } from './server'
import type { RunnableTools, BaseFunctionsArgs } from 'openai/lib/RunnableFunction'

/**
 * One round of asking the model: returns a final completion or new tool calls to execute.
 * `noTools` forces a plain-text answer (tools withheld), used for the final round.
 */
export type AskModel = (
  priorToolResults: ToolResult[],
  noTools?: boolean,
  // Text produced so far when the model hit its output cap: the round must continue it, not restart.
  continueFrom?: string
) => Promise<ChatCompletionWithToolsReply | undefined>

// A cut-off answer is resumed at most this many times: enough for a long reply, bounded so a model
// that keeps hitting the cap cannot spin (each round costs a full request).
const MAX_CONTINUATIONS = 3

// One retry per run: an oversized tool call is worth another shot with an explicit instruction,
// but a model that keeps overrunning must not loop forever.
const OVERSIZE_HINT =
  'Your previous answer hit the output limit before it was finished, so it was lost entirely. ' +
  'Send the same thing again in parts: keep each tool call small and set has_more=true on every ' +
  'part except the last one. Never try to fit a long body into a single call.'

// Max model<->tool round trips before we force a plain-text answer.
export const MAX_TOOL_ITERATIONS = 8

// Invented tool names tolerated in one run. A capable model never spends one; a weak one spends
// them in the first rounds and then keeps going in circles at the price of a request each.
export const MAX_PHANTOM_CALLS = 3

/** Execute a single tool call (on the pod, where WorkspaceClient context lives). */
export type ExecuteTool = (call: ToolCall) => Promise<string>

/** Serializable defs plus a local executor bound to the (non-serializable) runnable tools. */
export interface ToolExecutor {
  toolDefinitions: ToolDefinition[]
  execute: ExecuteTool
  /** Names the executor can actually run, so the loop can spot an invented call. */
  knownTools: Set<string>
}

/** Build serializable tool defs and a local executor from SDK-runnable tools (WorkspaceClient
 * context is already bound into each tool's function closure by getTools). */
export function buildToolExecutor (tools: RunnableTools<BaseFunctionsArgs>): ToolExecutor {
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

  const execute: ExecuteTool = async (call) => {
    const fn = executors.get(call.name)
    // Weak models invent tool names. Naming what actually exists turns a dead round into a
    // usable one; the loop also gives up early when they keep inventing (see runToolCalls).
    if (fn === undefined) {
      const available = [...executors.keys()]
      return (
        `Error: tool '${call.name}' does not exist. Available tools: ${available.length > 0 ? available.join(', ') : 'none'}. ` +
        'Call one of these, or answer in plain text without calling anything.'
      )
    }
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

  return { toolDefinitions, execute, knownTools: new Set(executors.keys()) }
}

export interface ToolLoopResult {
  completion?: string
  usage?: TokenUsage
  // Every tool the model called this run, in order - kept for the conversation snapshot.
  toolTranscript?: ToolResult[]
  // The clisr worker that served the run (from the last reply that carried one). Empty for direct.
  clientId?: string
  // The user stopped the run: the completion is what could be assembled in one final step.
  cancelled?: boolean
}

/**
 * Drive the model<->tool loop: the pod executes `toolCalls` via `execute` and resubmits until
 * `completion` or `maxIterations`. Pure orchestration - `ask`/`execute` injected for testability.
 */
export async function runToolCalls (
  ask: AskModel,
  execute: ExecuteTool,
  maxIterations: number,
  hooks?: ToolLoopHooks,
  knownTools?: Set<string>
): Promise<ToolLoopResult | undefined> {
  const priorToolResults: ToolResult[] = []
  let promptTokens = 0
  let completionTokens = 0
  let reasoningTokens = 0
  let sawUsage = false
  let lastContent: string | undefined
  let clientId: string | undefined

  const addUsage = (usage?: TokenUsage): void => {
    if (usage === undefined) return
    sawUsage = true
    promptTokens += usage.promptTokens
    completionTokens += usage.completionTokens
    reasoningTokens += usage.reasoningTokens ?? 0
  }
  const usageResult = (): TokenUsage | undefined =>
    sawUsage ? { promptTokens, completionTokens, ...(reasoningTokens > 0 ? { reasoningTokens } : {}) } : undefined

  let cancelled = false
  let retriedOversize = false
  // Calls to tools that do not exist, over the whole run. Counting rounds instead was useless:
  // a weak model mixes one real call with an invented one, so no round is ever fully phantom
  // while the loop still burns a request per round.
  let phantomCalls = 0
  for (let iter = 0; iter < maxIterations; iter++) {
    const reply = await ask(priorToolResults)
    if (reply === undefined) {
      return undefined
    }

    // Nothing came back and the model was cut off: the whole answer (usually a tool call with a
    // long body) was lost. Ask again, telling it to split the payload.
    const emptyTruncated =
      reply.truncated === true &&
      (reply.content === undefined || reply.content === '') &&
      (reply.toolCalls ?? []).length === 0
    if (emptyTruncated && !retriedOversize && !cancelled) {
      retriedOversize = true
      addUsage(reply.usage)
      priorToolResults.push({ id: `oversize-${iter}`, name: 'system', content: OVERSIZE_HINT })
      continue
    }

    if (reply.clientId !== undefined && reply.clientId !== '') {
      clientId = reply.clientId
    }
    addUsage(reply.usage)
    hooks?.onProgress?.({ iteration: iter + 1, usage: { promptTokens, completionTokens } })
    if (reply.content !== undefined && reply.content !== '') {
      lastContent = reply.content
    }

    const calls = reply.toolCalls ?? []
    if (calls.length === 0) {
      // Final answer, unless the model ran into its output cap: then keep asking for the rest and
      // join it, so the user gets the whole answer instead of a sentence cut in half.
      let completion = reply.content
      if (reply.truncated === true && completion !== undefined && completion !== '' && !cancelled) {
        for (let cont = 0; cont < MAX_CONTINUATIONS; cont++) {
          const more = await ask(priorToolResults, true, completion)
          if (more?.content === undefined || more.content === '') break
          addUsage(more.usage)
          completion += more.content
          if (more.truncated !== true) break
        }
      }
      return {
        // An answer lost to the output cap leaves `content` empty: fall back to whatever the model
        // did say earlier, so the user never gets silence.
        completion: completion !== undefined && completion !== '' ? completion : lastContent,
        usage: usageResult(),
        clientId,
        toolTranscript: priorToolResults.length > 0 ? priorToolResults : undefined
      }
    }

    // Cancelled: skip the tools and drop straight to the final round, so the user gets an answer
    // built from what was already gathered instead of nothing.
    if ((await hooks?.isCancelled?.()) === true) {
      cancelled = true
      break
    }

    // Weak models pair a real call with an invented one: run the round, then stop.
    let lastRound = false
    if (knownTools !== undefined && knownTools.size > 0) {
      phantomCalls += calls.filter((c) => !knownTools.has(c.name)).length
      // Still answer: the digest round below builds a reply from whatever was gathered.
      lastRound = phantomCalls >= MAX_PHANTOM_CALLS
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
    if (lastRound) break
  }

  // Exhausted iterations, cancelled, or stuck re-requesting the same tool: collapse results into one
  // digest and ask again with tools withheld. `inline_` results must replay as plain text; keep native transcript otherwise.
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
  addUsage(final?.usage)
  hooks?.onProgress?.({ iteration: maxIterations, usage: { promptTokens, completionTokens } })
  const completion = final?.content !== undefined && final.content !== '' ? final.content : lastContent
  return {
    completion,
    usage: usageResult(),
    clientId,
    cancelled,
    toolTranscript: priorToolResults.length > 0 ? priorToolResults : undefined
  }
}

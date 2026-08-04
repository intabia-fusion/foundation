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

import { runToolCalls } from '../llms/toolLoop'
import type { ChatCompletionWithToolsReply } from '../llms/server'
import type { ToolCall, ToolResult } from '../llms/types'

describe('runToolCalls', () => {
  it('returns final completion when model issues no tool calls', async () => {
    const ask = jest.fn(async () => ({ content: 'done', usage: { promptTokens: 10, completionTokens: 5 } }))
    const execute = jest.fn(async () => 'unused')

    const result = await runToolCalls(ask, execute, 8)

    expect(result).toEqual({ completion: 'done', usage: { promptTokens: 10, completionTokens: 5 } })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledWith([]) // no prior tool results on first round
    expect(execute).not.toHaveBeenCalled()
  })

  it('executes one round of tool calls then returns completion', async () => {
    const replies: ChatCompletionWithToolsReply[] = [
      {
        toolCalls: [{ id: 'c1', name: 'get_user_memory', arguments: '{}' }],
        usage: { promptTokens: 8, completionTokens: 2 }
      },
      { content: 'answer', usage: { promptTokens: 12, completionTokens: 6 } }
    ]
    let round = 0
    const ask = jest.fn(async (prior: ToolResult[]) => replies[round++])
    const execute = jest.fn(async (call: ToolCall) => `result:${call.name}`)

    const result = await runToolCalls(ask, execute, 8)

    expect(result?.completion).toBe('answer')
    // usage summed across both rounds
    expect(result?.usage).toEqual({ promptTokens: 20, completionTokens: 8 })
    expect(execute).toHaveBeenCalledTimes(1)
    // second ask receives the executed tool result
    expect(ask).toHaveBeenNthCalledWith(2, [
      { id: 'c1', name: 'get_user_memory', arguments: '{}', content: 'result:get_user_memory' }
    ])
  })

  it('executes multiple tool calls in one round', async () => {
    const replies: ChatCompletionWithToolsReply[] = [
      {
        toolCalls: [
          { id: 'a', name: 'toolA', arguments: '{}' },
          { id: 'b', name: 'toolB', arguments: '{}' }
        ]
      },
      { content: 'final' }
    ]
    let round = 0
    const ask = jest.fn(async () => replies[round++])
    const execute = jest.fn(async (call: ToolCall) => `r-${call.id}`)

    const result = await runToolCalls(ask, execute, 8)

    expect(result?.completion).toBe('final')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(ask).toHaveBeenNthCalledWith(2, [
      { id: 'a', name: 'toolA', arguments: '{}', content: 'r-a' },
      { id: 'b', name: 'toolB', arguments: '{}', content: 'r-b' }
    ])
  })

  it('drives multiple sequential tool rounds', async () => {
    const replies: ChatCompletionWithToolsReply[] = [
      { toolCalls: [{ id: '1', name: 't', arguments: '{}' }] },
      { toolCalls: [{ id: '2', name: 't', arguments: '{}' }] },
      { content: 'ok' }
    ]
    let round = 0
    const ask = jest.fn(async () => replies[round++])
    const execute = jest.fn(async () => 'x')

    const result = await runToolCalls(ask, execute, 8)

    expect(result?.completion).toBe('ok')
    expect(ask).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('stops at maxIterations and asks once more without tools', async () => {
    const ask = jest.fn(async () => ({
      toolCalls: [{ id: 'x', name: 't', arguments: '{}' }],
      usage: { promptTokens: 1, completionTokens: 1 }
    }))
    const execute = jest.fn(async () => 'r')

    const result = await runToolCalls(ask, execute, 3)

    // 3 capped rounds + a final no-tools round
    expect(ask).toHaveBeenCalledTimes(4)
    expect(ask).toHaveBeenLastCalledWith(expect.anything(), true)
    expect(result?.usage).toEqual({ promptTokens: 4, completionTokens: 4 })
  })

  it('final round answers in plain text when the model kept asking for tools', async () => {
    // Model emits an inline call every round, then answers once tools are withheld.
    const ask = jest.fn(async (_prior: any, noTools?: boolean) =>
      noTools === true
        ? { content: 'answer from digest' }
        : { toolCalls: [{ id: 'inline_0', name: 'load_thread_history', arguments: '{}' }] }
    )
    const execute = jest.fn(async () => 'thread text')

    const result = await runToolCalls(ask, execute, 2)

    expect(result?.completion).toBe('answer from digest')
    // Inline results are collapsed into a single plain-text digest for the final round.
    const lastPrior = ask.mock.calls[ask.mock.calls.length - 1][0]
    expect(lastPrior).toHaveLength(1)
    expect(lastPrior[0].id).toBe('inline_summary')
    expect(lastPrior[0].content).toContain('thread text')
  })

  it('returns undefined when the model call fails', async () => {
    const ask = jest.fn(async () => undefined)
    const execute = jest.fn()

    const result = await runToolCalls(ask, execute, 8)

    expect(result).toBeUndefined()
    expect(execute).not.toHaveBeenCalled()
  })

  it('omits usage when no round reported it', async () => {
    const ask = jest.fn(async () => ({ content: 'no-usage' }))
    const result = await runToolCalls(ask, jest.fn(), 8)
    expect(result).toEqual({ completion: 'no-usage', usage: undefined })
  })
})

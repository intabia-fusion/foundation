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

import { buildToolExecutor, runToolCalls } from '../llms/toolLoop'
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

  describe('truncated answers', () => {
    it('resumes a cut-off answer and joins the parts', async () => {
      const ask = jest
        .fn()
        .mockResolvedValueOnce({ content: 'part one', truncated: true })
        .mockResolvedValueOnce({ content: ' and two', truncated: false })

      const result = await runToolCalls(ask, jest.fn(), 8)

      expect(result?.completion).toBe('part one and two')
      // The continuation carries the text so far, with tools withheld.
      expect(ask).toHaveBeenNthCalledWith(2, [], true, 'part one')
    })

    it('keeps resuming while the model stays truncated, up to the cap', async () => {
      const ask = jest.fn(async () => ({ content: 'x', truncated: true }))

      const result = await runToolCalls(ask, jest.fn(), 8)

      // First answer plus MAX_CONTINUATIONS follow-ups; the loop must not spin forever.
      expect(result?.completion).toBe('xxxx')
      expect(ask).toHaveBeenCalledTimes(4)
    })

    it('sums usage across continuations', async () => {
      const ask = jest
        .fn()
        .mockResolvedValueOnce({ content: 'a', truncated: true, usage: { promptTokens: 10, completionTokens: 5 } })
        .mockResolvedValueOnce({ content: 'b', usage: { promptTokens: 3, completionTokens: 2 } })

      const result = await runToolCalls(ask, jest.fn(), 8)

      expect(result?.usage).toEqual({ promptTokens: 13, completionTokens: 7 })
    })

    it('stops resuming when the continuation comes back empty', async () => {
      const ask = jest.fn().mockResolvedValueOnce({ content: 'head', truncated: true }).mockResolvedValueOnce({})

      const result = await runToolCalls(ask, jest.fn(), 8)

      expect(result?.completion).toBe('head')
      expect(ask).toHaveBeenCalledTimes(2)
    })

    it('does not resume an answer that finished normally', async () => {
      const ask = jest.fn(async () => ({ content: 'complete' }))
      await runToolCalls(ask, jest.fn(), 8)
      expect(ask).toHaveBeenCalledTimes(1)
    })
  })

  describe('hooks', () => {
    it('cancels: skips the tools and answers in one final round', async () => {
      const ask = jest
        .fn()
        .mockResolvedValueOnce({
          toolCalls: [{ id: 'c1', name: 'slow_tool', arguments: '{}' }],
          usage: { promptTokens: 5, completionTokens: 1 }
        })
        .mockResolvedValueOnce({ content: 'partial answer', usage: { promptTokens: 4, completionTokens: 2 } })
      const execute = jest.fn(async () => 'never')

      const result = await runToolCalls(ask, execute, 8, { isCancelled: () => true })

      expect(execute).not.toHaveBeenCalled()
      expect(ask).toHaveBeenCalledTimes(2)
      expect(ask).toHaveBeenNthCalledWith(2, [], true) // final round, tools withheld
      expect(result?.completion).toBe('partial answer')
      expect(result?.cancelled).toBe(true)
      expect(result?.usage).toEqual({ promptTokens: 9, completionTokens: 3 })
    })

    it('reports accumulated tokens after every model round', async () => {
      const ask = jest
        .fn()
        .mockResolvedValueOnce({
          toolCalls: [{ id: 'c1', name: 't', arguments: '{}' }],
          usage: { promptTokens: 10, completionTokens: 2 }
        })
        .mockResolvedValueOnce({ content: 'ok', usage: { promptTokens: 6, completionTokens: 3 } })
      const onProgress = jest.fn()

      await runToolCalls(
        ask,
        jest.fn(async () => 'r'),
        8,
        { onProgress }
      )

      expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
        { iteration: 1, usage: { promptTokens: 10, completionTokens: 2 } },
        { iteration: 2, usage: { promptTokens: 16, completionTokens: 5 } }
      ])
    })
  })
})

describe('oversized answer', () => {
  it('retries once with a hint when the model is cut off with nothing to show', async () => {
    // finish_reason=length inside a function call loses the call whole: content and toolCalls
    // both come back empty.
    const replies: any[] = [
      { truncated: true, usage: { promptTokens: 10, completionTokens: 4096 } },
      { content: 'short answer', usage: { promptTokens: 12, completionTokens: 5 } }
    ]
    const seen: any[][] = []
    const ask = async (priorToolResults: any[]): Promise<any> => {
      seen.push([...priorToolResults])
      return replies.shift()
    }

    const result = await runToolCalls(ask as any, async () => 'unused', 8)

    expect(result?.completion).toBe('short answer')
    // The retry carries the instruction to split the payload.
    expect(seen[1].some((r) => r.content.includes('has_more=true'))).toBe(true)
    // Tokens burnt on the lost answer are still billed.
    expect(result?.usage?.completionTokens).toBe(4101)
  })
})

describe('invented tool calls', () => {
  it('names the available tools instead of a bare error', async () => {
    const { execute } = buildToolExecutor([
      {
        type: 'function',
        function: { name: 'propose_task', description: '', parameters: {}, function: async () => 'ok' }
      }
    ] as any)
    const out = await execute({ id: '1', name: 'create_task', arguments: '{}' })
    expect(out).toContain("tool 'create_task' does not exist")
    expect(out).toContain('propose_task')
  })

  // A weak model that keeps inventing burns a full request per round.
  it('gives up once too many invented calls pile up', async () => {
    const calls: any[] = []
    const asks = jest.fn(async (prior: any[], noTools?: boolean) => {
      calls.push(noTools === true ? 'final' : 'round')
      if (noTools === true) return { content: 'ответ по собранному' }
      return { toolCalls: [{ id: 'x', name: 'get_context', arguments: '{}' }] }
    })
    const result = await runToolCalls(asks as any, async () => 'unused', 8, undefined, new Set(['propose_task']))
    expect(result?.completion).toBe('ответ по собранному')
    // three phantom calls + the final tool-less round, not the full eight
    expect(calls).toEqual(['round', 'round', 'round', 'final'])
  })

  // The real reason round-counting failed: a weak model pairs one real call with an invented one,
  // so no round is ever fully phantom while the loop still pays for each.
  it('counts invented calls even when a real one rides along', async () => {
    const rounds: string[] = []
    const asks = jest.fn(async (prior: any[], noTools?: boolean) => {
      rounds.push(noTools === true ? 'final' : 'round')
      if (noTools === true) return { content: 'итог' }
      return {
        toolCalls: [
          { id: `r${rounds.length}`, name: 'propose_task', arguments: '{}' },
          { id: `g${rounds.length}`, name: 'notify_user', arguments: '{}' }
        ]
      }
    })
    await runToolCalls(asks as any, async () => 'ok', 8, undefined, new Set(['propose_task']))
    expect(rounds.filter((r) => r === 'round').length).toBeLessThanOrEqual(3)
  })

  // Silence is the worst possible answer: an output-capped final round must not erase what was said.
  it('falls back to earlier content when the final answer is lost to the output cap', async () => {
    let n = 0
    const asks = jest.fn(async () => {
      n += 1
      if (n === 1) return { content: 'начало ответа', toolCalls: [{ id: '1', name: 'propose_task', arguments: '{}' }] }
      return { content: '', truncated: true }
    })
    const result = await runToolCalls(asks as any, async () => 'ok', 8, undefined, new Set(['propose_task']))
    expect(result?.completion).toBe('начало ответа')
  })

  // The cutoff must not swallow the round that triggered it: the real call in it still has to run.
  it('executes the round that hits the cutoff', async () => {
    const executed: string[] = []
    const asks = jest.fn(async (prior: any[], noTools?: boolean) => {
      if (noTools === true) return { content: 'итог' }
      return {
        toolCalls: [
          { id: 'real', name: 'propose_task', arguments: '{}' },
          { id: 'ghost', name: 'notify_user', arguments: '{}' }
        ]
      }
    })
    await runToolCalls(
      asks as any,
      async (call: any) => {
        executed.push(call.name)
        return 'ok'
      },
      8,
      undefined,
      new Set(['propose_task'])
    )
    // One invented call per round, so round 3 hits the cutoff - and its real call still ran.
    expect(executed.filter((n) => n === 'propose_task').length).toBe(3)
  })

  it('does not interfere when every call is real', async () => {
    const asks = jest.fn(async (prior: any[], noTools?: boolean) => {
      if (noTools === true) return { content: 'итог' }
      if (prior.length < 4) return { toolCalls: [{ id: `b${prior.length}`, name: 'propose_task', arguments: '{}' }] }
      return { content: 'готово' }
    })
    const result = await runToolCalls(asks as any, async () => 'ok', 8, undefined, new Set(['propose_task']))
    expect(result?.completion).toBe('готово')
  })
})

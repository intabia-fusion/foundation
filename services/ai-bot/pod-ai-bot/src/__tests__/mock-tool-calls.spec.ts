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

// The mock provider runs the tool calls a prompt scripts (`call:<tool> {json}`), so ui tests can
// drive a scenario to a specific tool instead of hoping a model picks it.

jest.mock('../billing', () => ({ billUsage: jest.fn() }))

const ctx: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const workspace: any = 'ws'

function makeProvider (echo = true): any {
  process.env.ACCOUNTS_URL ??= 'http://localhost:3000'
  process.env.SERVER_SECRET ??= 'secret'
  process.env.FIRST_NAME ??= 'AI'
  process.env.LAST_NAME ??= 'Bot'
  process.env.STORAGE_CONFIG ??= 'minio|localhost:9000?accessKey=x&secretKey=y'
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createMockProvider } = require('../llms/mock')
  return createMockProvider(ctx, {
    id: 'mock',
    provider: 'mock',
    concurrency: 1,
    batch: 1,
    endpointConfig: { echo, promptTokens: 5, completionTokens: 1 },
    levels: { low: { model: 'mock-model', tokenMultiplier: 1, order: 0, label: 'Mock' } }
  })
}

function tool (name: string, impl: (args: any) => any): any {
  return { type: 'function', function: { name, parameters: { type: 'object' }, function: impl } }
}

async function complete (provider: any, tools: any[], prompt: string): Promise<string | undefined> {
  const res = await provider.createChatCompletionWithTools(
    tools,
    { role: 'user', content: prompt },
    'direct',
    '',
    '',
    'user',
    ctx,
    workspace
  )
  return res?.completion
}

describe('mock provider scripted tool calls', () => {
  it('calls the scripted tool with parsed arguments', async () => {
    const draft = jest.fn().mockResolvedValue('draft applied')
    const provider = makeProvider()

    const completion = await complete(
      provider,
      [tool('edit_issue_draft', draft)],
      'поправь задачу\ncall:edit_issue_draft {"title":"Купить кофе","priority":"high"}'
    )

    expect(draft).toHaveBeenCalledWith({ title: 'Купить кофе', priority: 'high' })
    expect(completion).toContain('edit_issue_draft')
    expect(completion).toContain('draft applied')
  })

  it('runs several calls in the order they appear', async () => {
    const order: string[] = []
    const provider = makeProvider()
    const tools = [
      tool('load_thread_history', () => {
        order.push('history')
        return 'history'
      }),
      tool('edit_issue_draft', () => {
        order.push('draft')
        return 'draft'
      })
    ]

    await complete(provider, tools, 'call:load_thread_history\ncall:edit_issue_draft {"title":"X"}')

    expect(order).toEqual(['history', 'draft'])
  })

  it('takes no arguments when the call has no json', async () => {
    const impl = jest.fn().mockReturnValue('ok')
    const provider = makeProvider()

    await complete(provider, [tool('load_thread_history', impl)], 'call:load_thread_history')

    expect(impl).toHaveBeenCalledWith({})
  })

  it('reports an unknown tool instead of failing the run', async () => {
    const provider = makeProvider()

    const completion = await complete(provider, [tool('edit_issue_draft', () => 'ok')], 'call:no_such_tool {}')

    expect(completion).toContain('no_such_tool')
    expect(completion).toContain('does not exist')
  })

  it('reports a throwing tool instead of failing the run', async () => {
    const provider = makeProvider()
    const boom = jest.fn().mockRejectedValue(new Error('boom'))

    const completion = await complete(provider, [tool('create_task', boom)], 'call:create_task {"title":"X"}')

    expect(completion).toContain('create_task')
    expect(completion).toContain('boom')
  })

  it('lists the available calls and echoes when the prompt scripts none', async () => {
    const provider = makeProvider()
    const draft = tool('edit_issue_draft', () => 'ok')
    draft.function.description = 'Edit the issue the user is drafting. NOTHING IS CREATED.'
    draft.function.parameters = {
      type: 'object',
      properties: { title: { type: 'string' }, priority: { type: 'string', enum: ['none', 'high'] } }
    }

    const completion = await complete(provider, [draft], 'какая сегодня погода')

    expect(completion).toContain('**propose_issue <название>**')
    expect(completion).toContain('**split_issues <N>** (здесь недоступно) - разбить задачу')
    expect(completion).toContain('- `edit_issue_draft`: title (string), priority (none|high)')
    expect(completion).toContain('## echo')
    expect(completion).toContain('какая сегодня погода')
  })

  it('maps scenario commands onto the tools the context offers', async () => {
    const provider = makeProvider(false)
    const step = async (tools: string[], prompt: string): Promise<any> => {
      const defs = tools.map((name) => ({ name, description: '', parameters: { type: 'object' } }))
      const res = await provider.chatToolStep(
        ctx,
        workspace,
        { role: 'user', content: prompt },
        'direct',
        '',
        '',
        'u',
        defs,
        []
      )
      return res.toolCalls?.map((c: any) => ({ name: c.name, args: JSON.parse(c.arguments) }))
    }

    expect(await step(['propose_new_document', 'propose_task'], 'propose_text\n# Plan\n\nBody')).toEqual([
      { name: 'propose_new_document', args: { markdown: '# Plan\n\nBody' } }
    ])
    expect(await step(['edit_issue_draft'], 'propose_text\nNew body')).toEqual([
      { name: 'edit_issue_draft', args: { description: 'New body' } }
    ])
    expect((await step(['propose_task'], 'propose_issue Настроить мониторинг'))[0].args).toMatchObject({
      title: 'Настроить мониторинг',
      priority: 'medium'
    })
    const split = (await step(['propose_subtasks'], 'split_issues 3'))[0]
    expect(split.name).toBe('propose_subtasks')
    expect(split.args.subtasks).toHaveLength(3)
    expect(split.args.subtasks[0]).toMatchObject({
      title: expect.stringMatching(/^1\. /),
      estimation: expect.any(Number)
    })
    // No fitting tool here: falls through to the help instead of calling anything.
    expect(await step(['load_thread_history'], 'split_issues 3')).toBeUndefined()
  })

  // The clisr worker path: the pod drives chatToolStep and executes the calls itself.
  it('chatToolStep hands scripted calls to the pod and reports their results next round', async () => {
    const provider = makeProvider(false)
    const defs = [{ name: 'propose_task', description: 'Propose a task.', parameters: { type: 'object' } }]
    const step = (prior: any[], prompt: string): Promise<any> =>
      provider.chatToolStep(ctx, workspace, { role: 'user', content: prompt }, 'direct', '', '', 'u', defs, prior)

    const first = await step([], 'сделай\ncall:propose_task {"title":"X"}')
    expect(first.content).toBeUndefined()
    expect(first.toolCalls).toEqual([{ id: 'mock-0', name: 'propose_task', arguments: '{"title":"X"}' }])

    const second = await step([{ id: 'mock-0', name: 'propose_task', content: 'proposed' }], 'сделай')
    expect(second.toolCalls).toBeUndefined()
    expect(second.content).toContain('### tool propose_task\nproposed')

    const menu = await step([], 'привет')
    expect(menu.content).toContain('- `propose_task`: без параметров')
  })

  it('lists the available calls without echo when echo is off', async () => {
    const provider = makeProvider(false)

    const completion = await complete(provider, [tool('propose_task', () => 'ok')], 'привет')

    expect(completion).toContain('- `propose_task`: без параметров')
    expect(completion).not.toContain('## echo')
  })
})

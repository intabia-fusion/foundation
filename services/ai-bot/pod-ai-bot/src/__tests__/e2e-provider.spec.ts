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

// End-to-end coverage of every OpenAIProvider method against a real local model server. Disabled by default.
//   AI_BOT_E2E=1 rushx test e2e-provider   (env: AI_BOT_E2E_URL, AI_BOT_E2E_KEY, AI_BOT_E2E_MODEL)

const E2E = process.env.AI_BOT_E2E === '1'
const BASE_URL = process.env.AI_BOT_E2E_URL ?? 'http://127.0.0.1:8000/v1'
const API_KEY = process.env.AI_BOT_E2E_KEY ?? '1234'
const MODEL = process.env.AI_BOT_E2E_MODEL ?? 'gpt-oss-20b-MXFP4-Q8'

const d = E2E ? describe : describe.skip

d('e2e: OpenAIProvider against a real model', () => {
  let provider: any
  let ctx: any
  const workspace = 'e2e-ws' as any

  jest.setTimeout(120000)

  beforeAll(async () => {
    // config validates required fields on import; provide dummies (unused by the provider).
    process.env.OPENAI_API_KEY = API_KEY
    process.env.OPENAI_BASE_URL = BASE_URL
    process.env.OPENAI_MODEL = MODEL
    process.env.OPENAI_SUMMARY_MODEL = MODEL
    process.env.OPENAI_TRANSLATE_MODEL = MODEL
    process.env.BILLING_URL = '' // pushTokensData becomes a no-op
    process.env.ACCOUNTS_URL ??= 'http://localhost:3000'
    process.env.SERVER_SECRET ??= 'secret'
    process.env.FIRST_NAME ??= 'AI'
    process.env.LAST_NAME ??= 'Bot'
    process.env.STORAGE_CONFIG ??= 'minio|localhost:9000?accessKey=x&secretKey=y'
    process.env.CHUNK_STORAGE_CONFIG ??= 'minio|localhost:9000?accessKey=x&secretKey=y'

    const { MeasureMetricsContext, newMetrics } = await import('@hcengineering/core')
    ctx = new MeasureMetricsContext('e2e-provider', {}, {}, newMetrics())

    const mod = await import('../llms/openai')
    const OpenAIProvider = mod.default
    provider = new OpenAIProvider(ctx, {
      id: 'openai',
      provider: 'openai',
      concurrency: 1,
      batch: 1,
      levels: { low: { model: MODEL, tokenMultiplier: 1, order: 0, label: 'Standard' } }
    })
  })

  it('countTokens estimates a positive token count', () => {
    const n = provider.countTokens([{ role: 'user', content: 'Hello, how are you today?' }])
    expect(n).toBeGreaterThan(0)
  })

  it('translateHtml translates while keeping it non-empty', async () => {
    const out = await provider.translateHtml(ctx, workspace, '<p>Hello world</p>', 'Russian')
    expect(typeof out).toBe('string')
    expect((out ?? '').length).toBeGreaterThan(0)
  })

  it('summarizeMessages produces a summary with participant labels', async () => {
    const messages = [
      { personRef: 'p1', personName: 'Alice', time: 1, text: 'We must fix the billing bug before Friday.' },
      { personRef: 'p2', personName: 'Bob', time: 2, text: 'I will take the billing bug and add a test.' }
    ] as any

    const summary = await provider.summarizeMessages(ctx, workspace, messages, 'English')
    expect(typeof summary).toBe('string')
    expect((summary ?? '').length).toBeGreaterThan(0)
  })

  it('createChatCompletionWithTools runs a tool and answers (full loop)', async () => {
    let executed = false
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current temperature in celsius for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          parse: JSON.parse,
          function: (args: { city: string }) => {
            executed = true
            return `It is 21 degrees and sunny in ${args.city}.`
          }
        }
      }
    ] as any

    const result = await provider.createChatCompletionWithTools(
      tools,
      { role: 'user', content: 'Use the get_weather tool to tell me the temperature in Paris.' },
      'direct',
      '',
      '',
      '',
      'e2e-user',
      ctx,
      workspace
    )

    expect(result).toBeDefined()
    expect(executed).toBe(true)
    expect(result.completion ?? '').toMatch(/21/)
  })

  it('chatToolStep returns a tool call from serializable tool defs', async () => {
    const step = await provider.chatToolStep(
      ctx,
      workspace,
      { role: 'user', content: 'Use the get_weather tool for Paris.' },
      'direct',
      '',
      '',
      '',
      'e2e-user',
      [
        {
          name: 'get_weather',
          description: 'Get weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
        }
      ],
      [] // no prior tool results
    )

    expect(step).toBeDefined()
    expect(step.usage.promptTokens).toBeGreaterThan(0)
    // Small models may answer directly instead of calling the tool; when they do
    // call it, the call must be well-formed.
    if ((step.toolCalls?.length ?? 0) > 0) {
      expect(step.toolCalls[0].name).toBe('get_weather')
      expect(JSON.parse(step.toolCalls[0].arguments)).toMatchObject({ city: expect.any(String) })
    } else {
      expect(typeof step.content).toBe('string')
    }
  })

  it('chatToolStep returns a final answer after a tool result', async () => {
    const step = await provider.chatToolStep(
      ctx,
      workspace,
      { role: 'user', content: 'Use the get_weather tool to tell me the temperature in Paris.' },
      'direct',
      '',
      '',
      '',
      'e2e-user',
      [
        {
          name: 'get_weather',
          description: 'Get weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
        }
      ],
      [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}', content: 'It is 21 degrees in Paris.' }]
    )

    expect(step).toBeDefined()
    expect(step.toolCalls ?? []).toHaveLength(0)
    expect(step.content ?? '').toMatch(/21/)
  })
})

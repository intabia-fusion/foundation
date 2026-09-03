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

// End-to-end tests against a real local OpenAI-compatible server. Disabled by default.
//   AI_BOT_E2E=1 rushx test e2e-tools   (env: AI_BOT_E2E_URL, AI_BOT_E2E_KEY)

import OpenAI from 'openai'

const E2E = process.env.AI_BOT_E2E === '1'
const BASE_URL = process.env.AI_BOT_E2E_URL ?? 'http://127.0.0.1:8000/v1'
const API_KEY = process.env.AI_BOT_E2E_KEY ?? '1234'
const WANT_MODEL = process.env.AI_BOT_E2E_MODEL

// Pick the model to test: explicit env override, else a known small instruct model,
// else the first served model.
function pickModel (ids: string[]): string | undefined {
  if (WANT_MODEL !== undefined) return ids.find((id) => id === WANT_MODEL) ?? WANT_MODEL
  return ids.find((id) => /gpt-oss|qwen/i.test(id)) ?? ids[0]
}

// Gate: when the flag is off the whole suite is skipped (no server needed in CI).
const d = E2E ? describe : describe.skip

interface ToolCall {
  id: string
  name: string
  arguments: string
}

interface StepResult {
  content?: string
  toolCalls?: ToolCall[]
  usage?: { promptTokens: number, completionTokens: number }
}

d('e2e: local OpenAI-compatible tool calls', () => {
  let client: OpenAI
  let model: string

  jest.setTimeout(60000)

  beforeAll(async () => {
    client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL })
    const list = await client.models.list()
    const picked = pickModel(list.data.map((m) => m.id))
    expect(picked).toBeDefined()
    model = picked as string
  })

  // Single model step: returns tool_calls + usage (mirrors OpenAIProvider.chatToolStep).
  async function step (messages: any[], tools?: any[]): Promise<StepResult> {
    const response = await client.chat.completions.create({ model, messages, tools, stream: false })
    const choice = response.choices?.[0]?.message
    const usage =
      response.usage !== undefined
        ? { promptTokens: response.usage.prompt_tokens ?? 0, completionTokens: response.usage.completion_tokens ?? 0 }
        : undefined
    const rawCalls = (choice as any)?.tool_calls ?? []
    if (rawCalls.length > 0) {
      return {
        toolCalls: rawCalls.map((c: any) => ({
          id: c.id,
          name: c.function?.name ?? '',
          arguments: c.function?.arguments ?? ''
        })),
        usage
      }
    }
    return { content: choice?.content ?? undefined, usage }
  }

  it('returns a tool call with parsed arguments and usage', async () => {
    const result = await step(
      [{ role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' }],
      [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city']
            }
          }
        }
      ]
    )

    expect(result.toolCalls).toBeDefined()
    expect(result.toolCalls?.[0].name).toBe('get_weather')
    expect(JSON.parse(result.toolCalls?.[0].arguments ?? '{}')).toMatchObject({ city: expect.any(String) })
    expect(result.usage?.promptTokens).toBeGreaterThan(0)
    expect(result.usage?.completionTokens).toBeGreaterThan(0)
  })

  it('completes a full tool loop: model -> tool result -> final answer', async () => {
    const weatherTool = {
      type: 'function' as const,
      function: {
        name: 'get_weather',
        description: 'Get current weather (celsius) for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city']
        }
      }
    }

    const messages: any[] = [{ role: 'user', content: 'Use the get_weather tool to tell me the temperature in Paris.' }]

    // Round 1: expect a tool call.
    const first = await step(messages, [weatherTool])
    expect(first.toolCalls?.length).toBeGreaterThan(0)
    const call = first.toolCalls?.[0] as ToolCall

    // Pod-side tool execution (faked here) + replay into the conversation.
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }]
    })
    messages.push({ role: 'tool', tool_call_id: call.id, content: 'It is 21 degrees and sunny in Paris.' })

    // Round 2: expect a final natural-language answer mentioning the temperature.
    const second = await step(messages, [weatherTool])
    expect(second.toolCalls ?? []).toHaveLength(0)
    expect(second.content ?? '').toMatch(/21/)
  })
})

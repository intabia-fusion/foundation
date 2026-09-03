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

// End-to-end test of the clisr router topology with a real local model. Disabled by default.
//   AI_BOT_E2E=1 rushx test e2e-clisr-router   (env: AI_BOT_E2E_URL, AI_BOT_E2E_KEY)

// Stub config so importing the provider chain (server -> billing -> config) does not run
// the env-validating IIFE, which throws without a full pod config.
jest.mock('../config', () => ({ __esModule: true, default: {} }))

/* eslint-disable import/first */
import { MeasureMetricsContext, newMetrics, type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import OpenAI from 'openai'
import { ClisrServer, createCallbackClient, type ClisrClient } from '@intabiafusion/clisr'
import ServerLLMProvider from '../llms/server'
import type { ChatCompletionWithToolsRequest } from '../llms/server'
import type { ToolDefinition, ChatToolStepResult } from '../llms/types'
import { usageFromApi } from '../llms/types'
import type { RunnableTools, BaseFunctionsArgs } from 'openai/lib/RunnableFunction'
/* eslint-enable import/first */

const E2E = process.env.AI_BOT_E2E === '1'
const BASE_URL = process.env.AI_BOT_E2E_URL ?? 'http://127.0.0.1:8000/v1'
const API_KEY = process.env.AI_BOT_E2E_KEY ?? '1234'
const WANT_MODEL = process.env.AI_BOT_E2E_MODEL
const PORT = 47821
const TOKEN = 'e2e-token'

function pickModel (ids: string[]): string | undefined {
  if (WANT_MODEL !== undefined) return ids.find((id) => id === WANT_MODEL) ?? WANT_MODEL
  return ids.find((id) => /gpt-oss|qwen/i.test(id)) ?? ids[0]
}

const d = E2E ? describe : describe.skip

// Client-side handler: one model step from serializable tool defs, returning
// tool_calls without executing them (mirrors OpenAIProvider.chatToolStep).
async function modelStep (
  client: OpenAI,
  model: string,
  req: ChatCompletionWithToolsRequest
): Promise<ChatToolStepResult> {
  const messages: any[] = [
    { role: 'system', content: 'You are a helpful assistant. Use tools when asked.' },
    ...(req.history ?? []).filter((it) => it.role !== 'system'),
    req.message
  ]
  for (const tr of req.priorToolResults ?? []) {
    // Reconstruct the assistant tool_call + tool result so the model continues.
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: tr.id, type: 'function', function: { name: tr.name, arguments: tr.arguments ?? '{}' } }]
    })
    messages.push({ role: 'tool', tool_call_id: tr.id, content: tr.content })
  }

  const tools =
    (req.toolDefinitions ?? []).length > 0
      ? (req.toolDefinitions as ToolDefinition[]).map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters }
        }))
      : undefined

  const response = await client.chat.completions.create({ model, messages, tools, stream: false })
  const choice = response.choices?.[0]?.message
  const usage = usageFromApi(response.usage)
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

d('e2e: clisr router + client tool loop', () => {
  let ctx: MeasureContext
  let server: ClisrServer
  let client: ClisrClient
  let openai: OpenAI
  let model: string

  jest.setTimeout(90000)

  beforeAll(async () => {
    ctx = new MeasureMetricsContext('e2e-clisr', {}, {}, newMetrics())

    openai = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL })
    const list = await openai.models.list()
    const picked = pickModel(list.data.map((m) => m.id))
    expect(picked).toBeDefined()
    model = picked as string

    // Router: accept our token, track llm/transcription capability via handshake.
    server = new ClisrServer(
      ctx,
      async (token) => token === TOKEN,
      '1.0',
      undefined,
      async (ctx, method, ops, session) => {
        if (method === 'llm') session.options.llm = ops[0] as boolean
        if (method === 'transcription') session.options.transcription = ops[0] as boolean
        return {}
      }
    )
    await server.start(ctx, PORT)

    // Client: registers llm capability and answers llm tasks via the real model.
    let llmEnabled = false
    client = await createCallbackClient(ctx, `ws://localhost:${PORT}`, TOKEN, {
      clientHost: 'e2e-client',
      callback: async (ctx, task, args) => {
        if (task === 'llm') {
          const req = args[0] as ChatCompletionWithToolsRequest
          if (req.method === 'createChatCompletionWithTools') {
            return await modelStep(openai, model, req)
          }
          throw new Error(`unsupported llm method ${(req as any).method}`)
        }
        throw new Error(`unknown task ${task}`)
      },
      onConnect: async () => {
        if (llmEnabled) await client.request('llm', [true])
      }
    })
    llmEnabled = true
    await client.request('llm', [true])

    // Give the router a moment to register the session.
    await new Promise((resolve) => setTimeout(resolve, 300))
  })

  afterAll(async () => {
    await client?.close()
    await server?.close()
  })

  it('runs a full tool loop through the router', async () => {
    const provider = new ServerLLMProvider(ctx, server, {
      id: 'clisr',
      provider: 'clisr',
      concurrency: 1,
      batch: 1,
      levels: { low: { model: 'm', tokenMultiplier: 0.1, order: 0, label: 'L' } }
    } as any)

    // A weather tool whose closure executes on the pod (here: fake result).
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
    ] as unknown as RunnableTools<BaseFunctionsArgs>

    const result = await provider.createChatCompletionWithTools(
      tools,
      { role: 'user', content: 'Use the get_weather tool to tell me the temperature in Paris.' },
      'direct',
      '',
      '',
      'e2e-user',
      ctx,
      'e2e-ws' as WorkspaceUuid
    )

    expect(result).toBeDefined()
    expect(executed).toBe(true) // tool ran on the pod
    expect(result?.completion ?? '').toMatch(/21/) // final answer used the tool result
    expect(result?.usage?.promptTokens).toBeGreaterThan(0)
  })
})

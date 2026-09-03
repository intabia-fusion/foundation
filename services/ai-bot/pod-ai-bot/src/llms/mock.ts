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

import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import type { PersonMessage } from '@hcengineering/ai-bot'
import type { RunnableTools, BaseFunctionsArgs } from 'openai/lib/RunnableFunction'

import { type AIProviderConfig, type AILevel } from '../config'
import { billUsage } from '../billing'
import { billingMetaFor, providerLevels } from './modelRegistry'
import { buildToolExecutor, MAX_TOOL_ITERATIONS, runToolCalls } from './toolLoop'
import {
  type ChatCompletionWithToolsResult,
  type ChatMessage,
  type ChatToolStepResult,
  type ContextMode,
  type LLMProvider,
  type ToolDefinition,
  type ToolResult
} from './types'

// Tool call scripted in the prompt: `call:<tool_name> {json}` on its own line, json optional.
const TOOL_CALL_RE = /(?:^|\n)\s*call:([a-zA-Z0-9_]+)[ \t]*(\{[\s\S]*?\})?[ \t]*(?=\n|$)/g

const STUB_BODY =
  '## Контекст\n\nТекст-заглушка от мока для проверки карточки.\n\n## Что сделать\n\n- первый шаг\n- второй шаг'
const VERBS = ['Проверить', 'Настроить', 'Описать', 'Починить', 'Собрать', 'Протестировать', 'Согласовать']
const OBJECTS = ['логин', 'экспорт', 'уведомления', 'поиск', 'миграцию', 'дашборд', 'права доступа', 'кэш']
const PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low']
const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]

function randomSubtasks (
  n: number
): Array<{ title: string, description: string, priority: string, estimation: number }> {
  return Array.from({ length: n }, (_, i) => ({
    title: `${i + 1}. ${pick(VERBS)} ${pick(OBJECTS)}`,
    description: 'Подзадача-заглушка от мока.',
    priority: pick(PRIORITIES),
    estimation: 1 + Math.floor(Math.random() * 8)
  }))
}

// Scenario commands: first line of the message is `<cmd> <arg>`, the rest is the payload. Each maps
// onto the first of its tools available in the context, so the same command works in a document
// thread, an issue thread and the create-issue dialog.
interface Scenario {
  cmd: string
  usage: string
  hint: string
  example: string
  tools: string[]
  args: (arg: string, payload: string, tool: string) => Record<string, unknown>
}
const SCENARIOS: Scenario[] = [
  {
    cmd: 'propose_text',
    usage: 'propose_text',
    hint: 'предложение по тексту: следующие строки становятся новой версией документа/описания (карточка с диффом)',
    example: 'propose_text\n# Новый план\n\nПервый абзац новой версии.',
    tools: ['propose_new_document', 'edit_issue_draft'],
    args: (arg, payload, tool) => {
      const text = payload !== '' ? payload : arg !== '' ? arg : STUB_BODY
      return tool === 'propose_new_document' ? { markdown: text } : { description: text }
    }
  },
  {
    cmd: 'propose_issue',
    usage: 'propose_issue <название>',
    hint: 'предлагает задачу с таким названием и текстом-заглушкой (карточка задачи)',
    example: 'propose_issue Настроить мониторинг',
    tools: ['propose_task', 'edit_issue_draft'],
    args: (arg, _payload, tool) => ({
      title: arg !== '' ? arg : 'Задача от мока',
      description: STUB_BODY,
      ...(tool === 'propose_task' ? { priority: 'medium', estimation: 4 } : {})
    })
  },
  {
    cmd: 'split_issues',
    usage: 'split_issues <N>',
    hint: 'разбить задачу на N случайных подзадач (карточка подзадач)',
    example: 'split_issues 5',
    tools: ['propose_subtasks', 'propose_task'],
    args: (arg, _payload, tool) => {
      const n = parseInt(arg, 10)
      const subtasks = randomSubtasks(Number.isNaN(n) ? 5 : Math.min(10, Math.max(1, n)))
      return tool === 'propose_task' ? { title: 'Разбиение задачи', subtasks } : { subtasks }
    }
  }
]

function scenarioCall (content: string, available: Set<string>): { name: string, arguments: string } | undefined {
  const [first = '', ...rest] = content.trim().split('\n')
  const m = /^(\w+)\s*(.*)$/.exec(first.trim())
  if (m === null) return undefined
  const scenario = SCENARIOS.find((s) => s.cmd === m[1])
  const tool = scenario?.tools.find((t) => available.has(t))
  if (scenario === undefined || tool === undefined) return undefined
  return { name: tool, arguments: JSON.stringify(scenario.args(m[2].trim(), rest.join('\n').trim(), tool)) }
}

// Deterministic offline provider for tests (fixed usage, no network). Scripted `call:` lines become
// tool calls the pod executes; anything else gets the menu of available calls (+ context dump when echo).
class MockProvider implements LLMProvider {
  private readonly reply: string
  private readonly echo: boolean
  private readonly usage: { promptTokens: number, completionTokens: number }
  private readonly defaultLevel: AILevel

  constructor (
    readonly ctx: MeasureContext,
    private readonly provider: AIProviderConfig
  ) {
    const cfg = provider.endpointConfig ?? {}
    this.reply = (cfg.reply as string) ?? 'pong'
    this.echo = cfg.echo === true
    this.usage = {
      promptTokens: (cfg.promptTokens as number) ?? 50,
      completionTokens: (cfg.completionTokens as number) ?? 10
    }
    const served = providerLevels(provider)
    this.defaultLevel = served[served.length - 1] ?? 'low'
  }

  // Markdown dump of everything the provider received. Section headers are stable so tests
  // can match on them; `-` marks an absent/empty part.
  private echoMarkdown (parts: {
    message?: ChatMessage
    history?: ChatMessage[]
    contextMode?: ContextMode
    sharedPrompt?: string
    personalContext?: string
    tools?: string[]
  }): string {
    const lines: string[] = ['## echo']
    lines.push(`### mode\n${parts.contextMode ?? '-'}`)
    lines.push(`### prompt\n${parts.message?.content ?? '-'}`)
    const history = (parts.history ?? []).map((m) => `- **${m.role}**: ${m.content ?? ''}`)
    lines.push(`### history (${history.length})\n${history.length > 0 ? history.join('\n') : '-'}`)
    lines.push(
      `### shared\n${parts.sharedPrompt !== undefined && parts.sharedPrompt !== '' ? parts.sharedPrompt : '-'}`
    )
    lines.push(
      `### personal\n${
        parts.personalContext !== undefined && parts.personalContext !== '' ? parts.personalContext : '-'
      }`
    )
    if (parts.tools !== undefined) {
      lines.push(`### tools (${parts.tools.length})\n${parts.tools.length > 0 ? parts.tools.join(', ') : '-'}`)
    }
    // Fenced: a debug dump, not something the chat should typeset as headings.
    return '```\n' + lines.join('\n\n') + '\n```'
  }

  private billingFor (level?: AILevel): { multiplier: number, modelId: string, providerId: string, level: string } {
    return billingMetaFor(this.provider, level, this.defaultLevel, () => 'mock')
  }

  private bill (ctx: MeasureContext, workspace: WorkspaceUuid, reason: string, level?: AILevel): void {
    billUsage(ctx, workspace, this.usage, this.billingFor(level), reason, new Date().toISOString())
  }

  async translateHtml (_ctx: MeasureContext, _workspace: WorkspaceUuid, html: string): Promise<string | undefined> {
    return html
  }

  async summarizeMessages (
    _ctx: MeasureContext,
    _workspace: WorkspaceUuid,
    _messages: PersonMessage[]
  ): Promise<string | undefined> {
    return this.reply
  }

  async createChatCompletionWithTools (
    tools: RunnableTools<BaseFunctionsArgs>,
    message: ChatMessage,
    contextMode: ContextMode,
    sharedPrompt: string,
    personalContext: string,
    _user: string,
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    history?: ChatMessage[],
    _skipCache?: boolean,
    reason = 'chat',
    level?: AILevel,
    _lang?: string
  ): Promise<ChatCompletionWithToolsResult | undefined> {
    // Same loop the pod runs for a clisr worker, so both paths behave the same.
    const { toolDefinitions, execute, knownTools } = buildToolExecutor(tools)
    const ask = async (prior: ToolResult[]): Promise<ChatToolStepResult | undefined> =>
      await this.chatToolStep(
        ctx,
        workspace,
        message,
        contextMode,
        sharedPrompt,
        personalContext,
        _user,
        toolDefinitions,
        prior,
        history,
        _skipCache,
        reason,
        level
      )
    const result = await runToolCalls(ask, execute, MAX_TOOL_ITERATIONS, undefined, knownTools)
    return result === undefined ? undefined : { completion: result.completion, usage: result.usage }
  }

  // Scripted `call:` lines -> toolCalls for the pod to run; the round after -> their results;
  // nothing scripted -> the menu of available calls (+ context dump when echo).
  async chatToolStep (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    message: ChatMessage,
    contextMode: ContextMode,
    sharedPrompt: string,
    personalContext: string,
    _user: string,
    toolDefinitions: ToolDefinition[],
    priorToolResults: ToolResult[],
    history?: ChatMessage[],
    _skipCache?: boolean,
    reason = 'chat',
    level?: AILevel
  ): Promise<ChatToolStepResult | undefined> {
    this.bill(ctx, workspace, reason, level)
    if (priorToolResults.length > 0) {
      const lines = priorToolResults.map((r) => `### tool ${r.name}\n${r.content}`)
      return { content: ['## tools', ...lines].join('\n\n'), usage: this.usage }
    }
    const content = message.content ?? ''
    const available = new Set(toolDefinitions.map((t) => t.name))
    const scenario = scenarioCall(content, available)
    if (scenario !== undefined) {
      return { toolCalls: [{ id: 'mock-0', ...scenario }], usage: this.usage }
    }
    const calls = [...content.matchAll(TOOL_CALL_RE)]
    if (calls.length > 0) {
      return {
        toolCalls: calls.map(([, name, rawArgs], i) => ({ id: `mock-${i}`, name, arguments: rawArgs ?? '{}' })),
        usage: this.usage
      }
    }
    const parts = [this.callMenu(toolDefinitions)]
    if (this.echo) {
      const tools = toolDefinitions.map((t) => t.name)
      parts.push(this.echoMarkdown({ message, history, contextMode, sharedPrompt, personalContext, tools }))
    }
    return { content: parts.join('\n\n'), usage: this.usage }
  }

  // Help for a tester: the scenario commands first, the raw tool list after.
  private callMenu (tools: ToolDefinition[]): string {
    const available = new Set(tools.map((t) => t.name))
    const scenarios = SCENARIOS.map((s) => {
      const usable = s.tools.some((t) => available.has(t))
      return `**${s.usage}**${usable ? '' : ' (здесь недоступно)'} - ${s.hint}\n\`\`\`\n${s.example}\n\`\`\``
    })
    const raw = tools.map((t) => {
      const props: Record<string, any> = (t.parameters as any)?.properties ?? {}
      const params = Object.entries(props).map(([k, s]) => `${k} (${s?.enum?.join('|') ?? s?.type ?? 'any'})`)
      return `- \`${t.name}\`: ${params.length > 0 ? params.join(', ') : 'без параметров'}`
    })
    return [
      '## Мок-модель',
      'Тестовая модель без ИИ. Понимает только команды ниже (первой строкой сообщения); на всё остальное ' +
        'отвечает этой справкой. Ответом на команду придёт карточка/результат тула, как от настоящей Юли.',
      scenarios.join('\n\n'),
      'Сырой вызов любого тула: `call:<tool> {json}` (по одному на строке, JSON в одну строку, переносы как `\\n`). ' +
        'Доступные здесь тулы:',
      raw.length > 0 ? raw.join('\n') : '- нет'
    ].join('\n\n')
  }

  countTokens (messages: ChatMessage[]): number {
    // Rough: 1 token per 4 chars, matches the 'approx' tokenizer well enough for tests.
    return Math.ceil(messages.reduce((n, m) => n + (m.content?.length ?? 0), 0) / 4)
  }
}

export function createMockProvider (ctx: MeasureContext, provider: AIProviderConfig): LLMProvider {
  ctx.info('Mock LLM provider configured', { id: provider.id })
  return new MockProvider(ctx, provider)
}

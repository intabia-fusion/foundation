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
import {
  type ChatCompletionWithToolsResult,
  type ChatMessage,
  type ContextMode,
  type LLMProvider,
  type PlanContext
} from './types'

// Deterministic offline provider for tests: reports a fixed token usage so billing/window
// enforcement runs the same as with a real model. No network.
// endpointConfig.echo=true makes it reply with the whole received context as markdown, so
// tests can assert what actually reached the model; otherwise it replies endpointConfig.reply.
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
    return lines.join('\n\n')
  }

  private billingFor (
    level?: AILevel,
    planContext?: PlanContext
  ): { multiplier: number, modelId: string, providerId: string, level: string } {
    return billingMetaFor(this.provider, level, this.defaultLevel, () => 'mock', planContext)
  }

  private bill (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    reason: string,
    level?: AILevel,
    planContext?: PlanContext
  ): void {
    billUsage(ctx, workspace, this.usage, this.billingFor(level, planContext), reason, new Date().toISOString())
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
    planContext?: PlanContext,
    _lang?: string
  ): Promise<ChatCompletionWithToolsResult | undefined> {
    this.bill(ctx, workspace, reason, level, planContext)
    if (!this.echo) {
      return { completion: this.reply, usage: this.usage }
    }
    const names = (tools as any[]).map((t) => t?.function?.name ?? t?.name).filter((n) => typeof n === 'string')
    const completion = this.echoMarkdown({
      message,
      history,
      contextMode,
      sharedPrompt,
      personalContext,
      tools: names
    })
    return { completion, usage: this.usage }
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

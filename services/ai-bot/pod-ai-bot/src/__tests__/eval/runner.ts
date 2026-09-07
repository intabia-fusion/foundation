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

/**
 * Runs a scenario against a live model through the real harness: real tool definitions, real
 * system prompt from prompts.yaml, real tool loop, real provider. Only the workspace is faked.
 *
 * A scenario is judged by the state of the world after the last turn, not by what the model said.
 */

import fs from 'fs'
import path from 'path'
import * as yaml from 'js-yaml'
import type { Class, Doc, Ref } from '@hcengineering/core'

import { toolBudgets } from '../../utils/budget'
import {
  appendSummary,
  contextTurns,
  type ConversationSnapshot,
  type SnapshotTurn
} from '../../workspace/conversationSnapshot'
import { planCompaction, renderForSummary } from '../../workspace/compaction'
import { summarizeVerdicts } from './judge'
import { getTools, type ReqCtx } from '../../utils/tools'
import { buildDocPromptText } from '../../workspace/docPrompt'
import {
  applyPending,
  EVAL_ROOT_CLASS,
  EVAL_ROOT_ID,
  EVAL_SPACE,
  FakeWorkspaceClient,
  type EvalWorld,
  type WorldIssue
} from './world'

export interface ScenarioTurn {
  ask: string
  /** When the proposal becomes the world. `auto` (default) - right after this turn. */
  apply?: 'auto' | 'never'
}

export interface ScenarioExpect {
  document?: {
    title?: string
    contains?: string[]
    notContains?: string[]
    unchanged?: boolean
  }
  issues?: {
    count?: number
    titlesMatch?: string
    subtasksOfRoot?: number
    /** Body of the root task after the run: an issue is edited through its description, not a new task. */
    rootDescription?: { contains?: string[], notContains?: string[] }
  }
  /** The whole world untouched: for scenarios where the right move is to just answer. */
  worldUnchanged?: boolean
  /** Text of the last answer. A weak check by design - the state is the real verdict. */
  answer?: {
    contains?: string[]
    /** At least one of these: for facts a model may name in more than one way. */
    containsAny?: string[]
    notContains?: string[]
  }
  /** Arguments a tool was called with, across all its calls. */
  toolArgs?: Record<string, { has?: string[], matches?: Record<string, string> }>
  /** Batching rule: no single call may carry more than this many sub-tasks. */
  maxSubtasksPerCall?: number
  /** What was staged but deliberately not applied (`apply: never`), e.g. an issue draft. */
  staged?: {
    kind?: 'task' | 'edit'
    titleMatches?: string
    contains?: string[]
  }
  toolsCalled?: string[]
  forbidTools?: string[]
  maxRoundsTotal?: number
  /** The run had to fold the older part of the conversation at least once. */
  compacted?: boolean
}

export interface Scenario {
  name: string
  mode?: 'direct' | 'thread'
  purpose?: 'issue-draft'
  lang?: string
  /** Lowered thresholds so compaction can be exercised without a hundred long turns. */
  compaction?: { budgetTokens?: number, reserveTokens?: number, keepRecentTokens?: number }
  /** Pins the context budget: an overflow scenario is meaningless when a wider model fits everything. */
  contextBudgetTokens?: number
  world?: {
    /** `repeat` multiplies the body: the only way to write a document that overflows a window. */
    document?: { title: string, body: string, repeat?: number }
    issues?: Array<{ title: string, description?: string, subtasks?: string[] }>
    history?: Array<{ role: 'user' | 'assistant', content: string, archived?: boolean }>
  }
  requirements?: Array<{ id: string, text: string }>
  turns: ScenarioTurn[]
  expect?: ScenarioExpect
}

export interface TraceTurn {
  n: number
  ask: string
  /** `result` is what the tool returned: without it the judge cannot tell real data from invention. */
  toolCalls: Array<{ name: string, args: string, result?: string }>
  applied: string[]
  /** Proposal left unapplied on this turn, when the scenario said not to apply it. */
  staged?: { kind: string, title?: string, markdown?: string, subtasks?: number }
  answer: string
  rounds: number
}

export interface AssertResult {
  id: string
  what: string
  ok: boolean
  detail?: string
}

export interface Trace {
  scenario: string
  model: string
  /** How many times the conversation was compacted during the run. */
  compactions: number
  /** The conversation as it stood before the first turn: what any "as agreed earlier" refers to. */
  historyBefore: Array<{ role: string, content: string }>
  /** Summaries produced by compaction during the run, oldest first. */
  summaries: string[]
  /** State before the first turn. Without it "left unchanged" cannot be judged at all. */
  initialWorld: EvalWorld
  /** Filled after the run when a judge is configured; see judge.ts. */
  judge?: { model: string, verdicts?: Array<{ id: string, met: boolean, evidence: string }> }
  requirements: Array<{ id: string, text: string }>
  turns: TraceTurn[]
  world: EvalWorld
  asserts: AssertResult[]
  usage: { promptTokens: number, completionTokens: number }
  ms: number
  ok: boolean
  error?: string
}

export function loadScenario (file: string): Scenario {
  const parsed = yaml.load(fs.readFileSync(file, 'utf8'))
  if (parsed === null || typeof parsed !== 'object') throw new Error(`Bad scenario: ${file}`)
  return parsed as Scenario
}

export function scenarioFiles (dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => path.join(dir, f))
    .sort()
}

function buildWorld (scenario: Scenario): EvalWorld {
  const issues: WorldIssue[] = []
  let n = 0
  for (const spec of scenario.world?.issues ?? []) {
    n += 1
    const id = `seed-${n}`
    issues.push({ id, identifier: `EVAL-${n}`, title: spec.title, description: spec.description })
    for (const sub of spec.subtasks ?? []) {
      n += 1
      issues.push({ id: `seed-${n}`, identifier: `EVAL-${n}`, title: sub, parent: id })
    }
  }
  return {
    document:
      scenario.world?.document !== undefined
        ? {
            id: 'seed-doc',
            title: scenario.world.document.title,
            body:
              scenario.world.document.repeat !== undefined
                ? Array(scenario.world.document.repeat).fill(scenario.world.document.body).join('\n\n')
                : scenario.world.document.body
          }
        : undefined,
    issues,
    history: (scenario.world?.history ?? []).map((m) => ({
      role: m.role,
      content: m.content,
      archived: m.archived
    }))
  }
}

/**
 * The object block, worded exactly as the pod words it (buildDocPromptText is shared), including
 * the decision to show an outline instead of a body that does not fit.
 */
async function docPrompt (
  client: FakeWorkspaceClient,
  world: EvalWorld,
  countTokens: (text: string) => number,
  budgetTokens: number
): Promise<{ text: string, oversized: boolean } | undefined> {
  if (world.document !== undefined) {
    const oversized = countTokens(world.document.body) > budgetTokens
    return {
      oversized,
      text: buildDocPromptText({
        kind: 'document',
        title: world.document.title,
        body: world.document.body,
        oversized
      })
    }
  }
  const root = world.issues.find((i) => i.parent === undefined)
  if (root === undefined) return undefined
  const body = root.description ?? ''
  const oversized = countTokens(body) > budgetTokens
  return {
    oversized,
    text: buildDocPromptText({
      kind: 'issue',
      title: root.title,
      identifier: root.identifier,
      body,
      oversized,
      subtasksListing: await client.listSubIssues(root.id as Ref<Doc>)
    })
  }
}

export interface RunOptions {
  provider: any
  ctx: any
  model: string
  workspace: string
  level?: string
  /** Window of the model under test; tool-result ceilings are derived from it. */
  contextBudgetTokens?: number
}

export async function runScenario (scenario: Scenario, opts: RunOptions): Promise<Trace> {
  const started = Date.now()
  const budgetTokens = scenario.contextBudgetTokens ?? opts.contextBudgetTokens ?? 100000
  const world = buildWorld(scenario)
  const client = new FakeWorkspaceClient(world)
  const contextMode = scenario.mode ?? 'thread'
  const before = JSON.stringify(world)

  const turns: TraceTurn[] = []
  const usage = { promptTokens: 0, completionTokens: 0 }
  let compactions = 0
  const summaries: string[] = []

  // The conversation is kept as the pod keeps it - as snapshot turns - so the run goes through the
  // same compaction path instead of a simplified copy of it.
  const seedTurns: SnapshotTurn[] = (scenario.world?.history ?? [])
    .filter((m) => m.archived !== true)
    .map((m, i) => ({
      role: m.role,
      author: m.role === 'user' ? 'Пользователь' : 'Юля',
      at: i,
      messageId: `seed-${i}`,
      content: m.content
    }))

  let snapshot: ConversationSnapshot = { conversation: 'eval', cursor: 0, turns: [...seedTurns] }

  const countTokens = (text: string): number => opts.provider.countTokens([{ role: 'user', content: text }]) ?? 0

  /** Same call the pod makes before assembling the context. */
  async function compactIfNeeded (): Promise<void> {
    if (opts.provider.compactConversation === undefined) return
    const plan = planCompaction({
      turns: snapshot.turns,
      firstKept: snapshot.firstKept,
      countTokens,
      budgetTokens: scenario.compaction?.budgetTokens ?? budgetTokens,
      reserveTokens: scenario.compaction?.reserveTokens,
      keepRecentTokens: scenario.compaction?.keepRecentTokens
    })
    if (!plan.needed) return
    const previous = [...snapshot.turns].reverse().find((t) => t.role === 'summary')?.content
    const summary = await opts.provider.compactConversation(
      opts.ctx,
      opts.workspace,
      renderForSummary(plan.toSummarize),
      scenario.lang ?? 'ru',
      previous,
      opts.level
    )
    if (summary === undefined || summary.trim() === '') return
    snapshot = appendSummary(snapshot, summary.trim(), plan.firstKeptId, Date.now())
    summaries.push(summary.trim())
    compactions++
  }

  const historyFor = (): Array<{ role: 'user' | 'assistant' | 'system', content: string }> =>
    contextTurns(snapshot)
      .filter((t) => t.role !== 'tool')
      .map((t) => ({
        role: t.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: t.role === 'summary' ? `[Summary of the earlier part of this conversation]\n${t.content}` : t.content
      }))

  let error: string | undefined
  try {
    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i]
      // Same ceilings the pod applies, so a scenario sees what production would.
      const budgets = toolBudgets(budgetTokens)
      const reqCtx: ReqCtx = {
        objectId: EVAL_ROOT_ID,
        objectClass: EVAL_ROOT_CLASS as Ref<Class<Doc>>,
        space: EVAL_SPACE,
        collection: 'replies',
        purpose: scenario.purpose,
        perCallChars: budgets.perCall,
        budget: { maxChars: budgets.perRun, spentChars: 0 }
      }
      await compactIfNeeded()
      const history = historyFor()
      const block = await docPrompt(
        client,
        world,
        (text) => opts.provider.countTokens([{ role: 'user', content: text }]) ?? 0,
        Math.floor(budgetTokens * 0.45)
      )
      reqCtx.documentReadOnly = block?.oversized === true
      const tools = getTools(client as any, contextMode, 'eval-user' as any, reqCtx, undefined, scenario.purpose)
      const withDoc = block !== undefined ? [...history, { role: 'user' as const, content: block.text }] : history

      let rounds = 0
      const result = await opts.provider.createChatCompletionWithTools(
        tools,
        { role: 'user', content: turn.ask },
        contextMode,
        '',
        '',
        'eval-user',
        opts.ctx,
        opts.workspace,
        withDoc,
        true,
        'eval',
        opts.level,
        scenario.lang ?? 'ru',
        {
          onProgress: ({ iteration }: { iteration: number }) => {
            rounds = Math.max(rounds, iteration)
          }
        }
      )

      const answer = result?.completion ?? ''
      const pending = reqCtx.pending
      const applied = turn.apply === 'never' ? [] : applyPending(world, pending)
      usage.promptTokens += result?.usage?.promptTokens ?? 0
      usage.completionTokens += result?.usage?.completionTokens ?? 0

      turns.push({
        n: i + 1,
        ask: turn.ask,
        toolCalls: (result?.toolTranscript ?? []).map((t: any) => ({
          name: t.name,
          args: t.arguments ?? '{}',
          result: t.content
        })),
        applied,
        staged:
          pending !== undefined
            ? pending.kind === 'task'
              ? { kind: 'task', title: pending.title, subtasks: (pending.subtasks ?? []).length }
              : { kind: 'edit', title: pending.title, markdown: pending.markdown }
            : undefined,
        answer,
        rounds
      })

      const at = Date.now()
      const fresh: SnapshotTurn[] = [
        { role: 'user', author: 'Пользователь', at, messageId: `ask-${i}`, content: turn.ask }
      ]
      if (answer !== '') {
        fresh.push({ role: 'assistant', author: 'Юля', at, messageId: `answer-${i}`, content: answer })
      }
      snapshot = { ...snapshot, turns: [...snapshot.turns, ...fresh] }
    }
  } catch (err: any) {
    error = err?.message ?? String(err)
  }

  const asserts = error === undefined ? checkExpectations(scenario, world, turns, before, compactions) : []
  return {
    scenario: scenario.name,
    model: opts.model,
    compactions,
    historyBefore: seedTurns.map((t) => ({ role: t.role, content: t.content })),
    summaries,
    initialWorld: JSON.parse(before),
    requirements: scenario.requirements ?? [],
    turns,
    world,
    asserts,
    usage,
    ms: Date.now() - started,
    ok: error === undefined && asserts.every((a) => a.ok),
    error
  }
}

function checkExpectations (
  scenario: Scenario,
  world: EvalWorld,
  turns: TraceTurn[],
  before: string,
  compactions: number
): AssertResult[] {
  const out: AssertResult[] = []
  const expect = scenario.expect ?? {}
  const called = new Set(turns.flatMap((t) => t.toolCalls.map((c) => c.name)))
  let n = 0
  const add = (what: string, ok: boolean, detail?: string): void => {
    n += 1
    out.push({ id: `A${n}`, what, ok, detail })
  }

  const doc = world.document
  if (expect.document !== undefined) {
    if (expect.document.title !== undefined) {
      add(`document.title == "${expect.document.title}"`, doc?.title === expect.document.title, doc?.title)
    }
    for (const needle of expect.document.contains ?? []) {
      add(`document contains "${needle}"`, (doc?.body ?? '').includes(needle))
    }
    for (const needle of expect.document.notContains ?? []) {
      add(`document lacks "${needle}"`, !(doc?.body ?? '').includes(needle))
    }
    if (expect.document.unchanged === true) {
      const now = JSON.parse(before) as EvalWorld
      add('document body unchanged', (doc?.body ?? '') === (now.document?.body ?? ''))
    }
  }

  // Double-escaped rewrites leave literal \n in the body, which `contains` asserts happily ignore.
  if (doc !== undefined && expect.document?.unchanged !== true) {
    add('document has no literal \\n', !doc.body.includes('\\n'), doc.body.slice(0, 120))
  }

  if (expect.issues !== undefined) {
    if (expect.issues.count !== undefined) {
      add(
        `issues.count == ${expect.issues.count}`,
        world.issues.length === expect.issues.count,
        `${world.issues.length}`
      )
    }
    if (expect.issues.subtasksOfRoot !== undefined) {
      const root = world.issues.find((i) => i.parent === undefined)
      const subs = world.issues.filter((i) => i.parent === root?.id).length
      add(`root has ${expect.issues.subtasksOfRoot} sub-tasks`, subs === expect.issues.subtasksOfRoot, `${subs}`)
    }
    if (expect.issues.rootDescription !== undefined) {
      const body = world.issues.find((i) => i.parent === undefined)?.description ?? ''
      for (const needle of expect.issues.rootDescription.contains ?? []) {
        add(`root description contains "${needle}"`, body.includes(needle), body.slice(0, 120))
      }
      for (const needle of expect.issues.rootDescription.notContains ?? []) {
        add(`root description lacks "${needle}"`, !body.includes(needle), body.slice(0, 120))
      }
    }
    if (expect.issues.titlesMatch !== undefined) {
      const re = new RegExp(expect.issues.titlesMatch)
      const bad = world.issues.filter((i) => !re.test(i.title)).map((i) => i.title)
      add(`titles match /${expect.issues.titlesMatch}/`, bad.length === 0, bad.join(', '))
    }
  }

  if (expect.worldUnchanged === true) {
    const same = JSON.stringify(world) === before
    add('мир не изменился', same, same ? undefined : 'что-то создалось или изменилось')
  }

  const lastAnswer = turns[turns.length - 1]?.answer ?? ''
  for (const needle of expect.answer?.contains ?? []) {
    add(`ответ содержит "${needle}"`, lastAnswer.includes(needle), lastAnswer.slice(0, 100))
  }
  const anyOf = expect.answer?.containsAny ?? []
  if (anyOf.length > 0) {
    add(
      `ответ упоминает одно из [${anyOf.join(', ')}]`,
      anyOf.some((n) => lastAnswer.includes(n)),
      lastAnswer.slice(0, 100)
    )
  }
  for (const needle of expect.answer?.notContains ?? []) {
    add(`ответ без "${needle}"`, !lastAnswer.includes(needle), lastAnswer.slice(0, 100))
  }

  for (const [tool, rule] of Object.entries(expect.toolArgs ?? {})) {
    const calls = turns.flatMap((t) => t.toolCalls.filter((c) => c.name === tool))
    if (calls.length === 0) {
      add(`аргументы ${tool}`, false, 'инструмент не вызывался')
      continue
    }
    const parsed = calls.map((c) => {
      try {
        return JSON.parse(c.args === '' ? '{}' : c.args)
      } catch {
        return {}
      }
    })
    for (const key of rule.has ?? []) {
      const ok = parsed.some((a) => a?.[key] !== undefined && a[key] !== '')
      add(`${tool} передал ${key}`, ok, JSON.stringify(parsed).slice(0, 120))
    }
    for (const [key, pattern] of Object.entries(rule.matches ?? {})) {
      const re = new RegExp(pattern)
      const ok = parsed.some((a) => typeof a?.[key] === 'string' && re.test(a[key]))
      add(`${tool}.${key} ~ /${pattern}/`, ok, JSON.stringify(parsed.map((a) => a?.[key])).slice(0, 120))
    }
  }

  if (expect.maxSubtasksPerCall !== undefined) {
    // One call carrying a long list runs into the output cap and is lost whole; the tools say so,
    // and this is where we find out whether the model listened.
    const sizes = turns
      .flatMap((t) => t.toolCalls)
      .map((c) => {
        try {
          return (JSON.parse(c.args === '' ? '{}' : c.args)?.subtasks ?? []).length
        } catch {
          return 0
        }
      })
    const worst = Math.max(0, ...sizes)
    add(
      `не больше ${expect.maxSubtasksPerCall} подзадач за вызов`,
      worst <= expect.maxSubtasksPerCall,
      `максимум ${worst}`
    )
  }

  if (expect.staged !== undefined) {
    const staged = [...turns].reverse().find((t) => t.staged !== undefined)?.staged
    if (staged === undefined) {
      add('предложение подготовлено', false, 'ничего не подготовлено')
    } else {
      if (expect.staged.kind !== undefined) {
        add(`подготовлено ${expect.staged.kind}`, staged.kind === expect.staged.kind, staged.kind)
      }
      if (expect.staged.titleMatches !== undefined) {
        const re = new RegExp(expect.staged.titleMatches)
        add(`заголовок ~ /${expect.staged.titleMatches}/`, re.test(staged.title ?? ''), staged.title)
      }
      for (const needle of expect.staged.contains ?? []) {
        const text = `${staged.title ?? ''}\n${staged.markdown ?? ''}`
        add(`предложение содержит "${needle}"`, text.includes(needle), text.slice(0, 100))
      }
    }
  }

  for (const tool of expect.toolsCalled ?? []) {
    add(`called ${tool}`, called.has(tool), [...called].join(', '))
  }
  if (expect.compacted === true) {
    add('разговор был сжат', compactions > 0, `${compactions} компактизаций`)
  }
  for (const tool of expect.forbidTools ?? []) {
    add(`${tool} not called`, !called.has(tool), [...called].join(', '))
  }
  if (expect.maxRoundsTotal !== undefined) {
    const total = turns.reduce((sum, t) => sum + t.rounds, 0)
    add(`rounds <= ${expect.maxRoundsTotal}`, total <= expect.maxRoundsTotal, `${total}`)
  }
  return out
}

/** One row per scenario; the report is meant to be pasted into a task and compared across models. */
export function renderReport (traces: Trace[]): string {
  const judged = traces.some((t) => t.judge !== undefined)
  const rows = traces.map((t) => {
    const failed = t.asserts.filter((a) => !a.ok)
    const why = t.error !== undefined ? `error: ${t.error}` : failed.map((a) => a.what).join('; ')
    const tools = [...new Set(t.turns.flatMap((x) => x.toolCalls.map((c) => c.name)))].join(', ')
    const rounds = t.turns.reduce((s, x) => s + x.rounds, 0)
    const judge = judged ? ` ${summarizeVerdicts(t.judge?.verdicts)} |` : ''
    return `| ${t.scenario} | ${t.ok ? 'ok' : 'FAIL'} |${judge} ${rounds} | ${t.usage.promptTokens}/${t.usage.completionTokens} | ${Math.round(t.ms / 1000)}s | ${tools} | ${why} |`
  })
  const passed = traces.filter((t) => t.ok).length
  // With repeats the share per scenario is the signal: a model honours a rule probabilistically.
  const byName = new Map<string, { ok: number, total: number }>()
  for (const t of traces) {
    const cur = byName.get(t.scenario) ?? { ok: 0, total: 0 }
    byName.set(t.scenario, { ok: cur.ok + (t.ok ? 1 : 0), total: cur.total + 1 })
  }
  const repeated = [...byName.entries()].filter(([, v]) => v.total > 1)
  const shares =
    repeated.length > 0
      ? ['', 'Доля успешных прогонов:', ...repeated.map(([name, v]) => `- ${name}: ${v.ok}/${v.total}`)]
      : []
  const prompt = traces.reduce((n, t) => n + t.usage.promptTokens, 0)
  const completion = traces.reduce((n, t) => n + t.usage.completionTokens, 0)
  const seconds = Math.round(traces.reduce((n, t) => n + t.ms, 0) / 1000)
  return [
    `Модель: ${traces[0]?.model ?? '-'} · сценариев ${traces.length}, прошло ${passed}`,
    `Токенов всего: ${prompt + completion} (prompt ${prompt}, completion ${completion}) · время ${seconds}s`,
    ...shares,
    '',
    judged
      ? '| Сценарий | Итог | Судья | Раунды | Токены p/c | Время | Инструменты | Что не сошлось |'
      : '| Сценарий | Итог | Раунды | Токены p/c | Время | Инструменты | Что не сошлось |',
    judged ? '|---|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|---|',
    ...rows
  ].join('\n')
}

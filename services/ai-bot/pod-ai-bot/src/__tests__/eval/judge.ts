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
 * The judge: reads a run trace and says whether each requirement was met.
 *
 * It is the second layer, not the first. Anything checkable by comparison is already checked by
 * the asserts; the judge only covers what cannot be formalized - whether the split makes sense,
 * whether the summary reflects the document, whether the answer is on point.
 *
 * It never sees our system prompt or which model produced the run: given that, a model starts
 * justifying the behaviour instead of judging it. Its answer is forced through a strict json
 * schema - prose from a judge is not worth parsing.
 */

import type { Trace } from './runner'

export interface Verdict {
  id: string
  met: boolean
  evidence: string
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          met: { type: 'boolean' },
          evidence: { type: 'string' }
        },
        required: ['id', 'met', 'evidence'],
        additionalProperties: false
      }
    }
  },
  required: ['verdicts'],
  additionalProperties: false
}

const SYSTEM =
  'You judge whether an assistant did what was asked. You are given the requirements and a trace ' +
  'of what happened: the state of the workspace before, the user turns, the tools the assistant ' +
  'called with their arguments, what was applied, and the state of the workspace after. Compare ' +
  'before and after to judge what changed and what was left alone. For each requirement answer whether it was met, ' +
  'quoting the part of the trace that shows it. Judge only what the trace shows: if the trace does ' +
  'not show a requirement being met, it was not met. Return JSON only.'

/** Compact rendering of a run: enough to judge, short enough not to drown the judge. */
export function serializeTrace (trace: Trace): string {
  const parts: string[] = []
  parts.push('REQUIREMENTS:')
  for (const r of trace.requirements) {
    parts.push(`  ${r.id}: ${r.text}`)
  }
  if (trace.historyBefore.length > 0) {
    // What "as agreed earlier" refers to. Without it the judge cannot tell whether an instruction
    // given at the start of the conversation was honoured or lost.
    parts.push('', 'CONVERSATION BEFORE THIS RUN:')
    for (const m of trace.historyBefore) {
      parts.push(`  [${m.role}]: ${m.content.replace(/\s+/g, ' ').slice(0, 400)}`)
    }
  }
  if (trace.summaries.length > 0) {
    // The older part was folded into a summary mid-run: this is exactly what survived it.
    parts.push('', 'THE OLDER PART WAS COMPACTED INTO THIS SUMMARY:')
    for (const summary of trace.summaries) {
      parts.push(summary.slice(0, 1500))
    }
  }
  parts.push('', 'WORKSPACE BEFORE:')
  parts.push(...describeWorld(trace.initialWorld))
  parts.push('', 'TRACE:')
  for (const turn of trace.turns) {
    parts.push(`  [turn ${turn.n}] user: ${turn.ask}`)
    for (const call of turn.toolCalls) {
      parts.push(`    tool ${call.name}(${call.args.slice(0, 600)})`)
      // The answer may only repeat what a tool returned; without the result that is unjudgeable.
      if (call.result !== undefined && call.result !== '') {
        parts.push(`      -> ${call.result.replace(/\s+/g, ' ').slice(0, 800)}`)
      }
    }
    if (turn.applied.length > 0) parts.push(`    applied: ${turn.applied.join(', ')}`)
    // A proposal the user has not applied yet changes nothing in the workspace, but it IS the
    // result of the turn - an issue draft never leaves this state on purpose.
    if (turn.staged !== undefined) {
      const staged = turn.staged
      const what =
        staged.kind === 'task'
          ? `task draft "${staged.title ?? ''}"${staged.subtasks !== undefined && staged.subtasks > 0 ? `, ${staged.subtasks} sub-tasks` : ''}`
          : `document edit (${(staged.markdown ?? '').length} characters)`
      parts.push(`    prepared but not applied: ${what}`)
    }
    if (turn.answer !== '') parts.push(`    assistant: ${turn.answer.replace(/\s+/g, ' ').slice(0, 600)}`)
  }
  parts.push('', 'WORKSPACE AFTER:')
  parts.push(...describeWorld(trace.world))
  return parts.join('\n')
}

/** Both states are rendered the same way, so the judge can diff them by eye. */
function describeWorld (world: Trace['world']): string[] {
  const out: string[] = []
  if (world.document !== undefined) {
    // The length is what makes a truncated body comparable: 70000 -> 561 is invisible otherwise.
    out.push(`  document "${world.document.title}" (${world.document.body.length} characters):`)
    out.push(`    ${world.document.body.slice(0, 2000)}`)
  }
  if (world.issues.length > 0) {
    out.push('  tasks:')
    for (const issue of world.issues) {
      out.push(`    ${issue.parent !== undefined ? '- sub:' : '-'} ${issue.title}`)
    }
  }
  if (world.document === undefined && world.issues.length === 0) {
    out.push('  (empty)')
  }
  return out
}

export interface JudgeConfig {
  endpoint: string
  key: string
  model: string
}

/**
 * Ask the judge about one trace. Returns undefined when judging itself failed - a judge that
 * cannot answer must not turn into a verdict about the run.
 */
export async function judgeTrace (cfg: JudgeConfig, trace: Trace): Promise<Verdict[] | undefined> {
  if (trace.requirements.length === 0) return []
  try {
    const res = await fetch(`${cfg.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: serializeTrace(trace) }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'verdicts', strict: true, schema: VERDICT_SCHEMA }
        }
      })
    })
    if (!res.ok) {
      console.error(`  (судья: HTTP ${res.status}: ${(await res.text()).slice(0, 300)})`)
      return undefined
    }
    const body: any = await res.json()
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '')
    if (!Array.isArray(parsed?.verdicts)) return undefined
    return parsed.verdicts.filter((v: any) => typeof v?.id === 'string' && typeof v?.met === 'boolean') as Verdict[]
  } catch (err: any) {
    console.error(`  (судья: ${err?.message ?? String(err)})`)
    return undefined
  }
}

/** `2/3` plus the ids that were not confirmed, for the report row. */
export function summarizeVerdicts (verdicts: Verdict[] | undefined): string {
  if (verdicts === undefined) return 'судья не ответил'
  if (verdicts.length === 0) return '-'
  const met = verdicts.filter((v) => v.met).length
  const failed = verdicts.filter((v) => !v.met).map((v) => v.id)
  return failed.length === 0 ? `${met}/${verdicts.length}` : `${met}/${verdicts.length} (нет: ${failed.join(', ')})`
}

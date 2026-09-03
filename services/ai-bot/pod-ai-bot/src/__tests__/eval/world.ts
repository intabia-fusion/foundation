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
 * In-memory workspace for scenario runs: the smallest thing the real tools can act on.
 *
 * It is a model of the world, not a stub - proposals actually land (the document changes, the
 * tasks appear), because a scenario is judged by what the workspace looks like at the end.
 * Applying is what a person does with a button in production, so the runner decides when it
 * happens (see `apply` in a scenario).
 */

import type { Class, Doc, Ref } from '@hcengineering/core'
import document from '@hcengineering/document'
import tracker from '@hcengineering/tracker'
import aiBot from '@hcengineering/ai-bot'

import type { PendingProposal, ReqCtx } from '../../utils/tools'
import { sanitizeDocumentMarkdown } from '../../utils/documentMarkdown'

export interface WorldIssue {
  id: string
  identifier: string
  title: string
  description?: string
  /** Sub-tasks hang off their parent by id; a top-level task has none. */
  parent?: string
}

export interface WorldDocument {
  id: string
  title: string
  body: string
}

export interface WorldMessage {
  role: 'user' | 'assistant'
  content: string
  /** Older than today, reachable only through load_thread_history. */
  archived?: boolean
}

export interface EvalWorld {
  document?: WorldDocument
  issues: WorldIssue[]
  history: WorldMessage[]
}

/** The object a conversation is linked to, as the root AIContextMessage would carry it. */
export interface EvalLink {
  targetId: string
  targetClass: Ref<Class<Doc>>
  targetAttr: 'content' | 'description'
}

let seq = 0
function nextId (prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

/**
 * Stands in for WorkspaceClient in the nine methods the tools reach for. Everything else the real
 * client does (transactor, storage, billing) never runs in a scenario.
 */
export class FakeWorkspaceClient {
  constructor (readonly world: EvalWorld) {}

  private link (): EvalLink | undefined {
    if (this.world.document !== undefined) {
      return { targetId: this.world.document.id, targetClass: document.class.Document, targetAttr: 'content' }
    }
    const root = this.world.issues.find((i) => i.parent === undefined)
    if (root !== undefined) {
      return { targetId: root.id, targetClass: tracker.class.Issue, targetAttr: 'description' }
    }
    return undefined
  }

  private currentBody (): string {
    if (this.world.document !== undefined) return this.world.document.body
    const root = this.world.issues.find((i) => i.parent === undefined)
    return root?.description ?? ''
  }

  async loadThreadHistory (
    _objectId: Ref<Doc>,
    _objectClass: Ref<Class<Doc>>,
    _beforeMs: number,
    limit: number
  ): Promise<string> {
    const older = this.world.history.filter((m) => m.archived === true).slice(-limit)
    if (older.length === 0) return 'No older messages found.'
    return older.map((m) => m.content).join('\n')
  }

  async resolveEditTarget (): Promise<EvalLink | undefined> {
    return this.link()
  }

  async resolveLinkedIssue (): Promise<Ref<Doc> | undefined> {
    const root = this.world.issues.find((i) => i.parent === undefined)
    return root !== undefined ? (root.id as Ref<Doc>) : undefined
  }

  async existingSubIssueTitles (parentId: Ref<Doc>): Promise<Set<string>> {
    return new Set(
      this.world.issues
        .filter((i) => i.parent === parentId)
        .map((i) => i.title.trim().toLowerCase().replace(/\s+/g, ' '))
    )
  }

  async listSubIssues (parentId: Ref<Doc>, limit = 100): Promise<string> {
    const subs = this.world.issues.filter((i) => i.parent === parentId).slice(0, limit)
    if (subs.length === 0) return 'This task has no sub-tasks yet.'
    const lines = subs.map((s) => {
      const short = (s.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      return `- ${s.identifier} ${s.title}${short !== '' ? ` — ${short}` : ''}`
    })
    return `Existing sub-tasks (${subs.length}):\n${lines.join('\n')}`
  }

  // A rename is staged like any other change; the user applies it (see applyPending).
  async proposeRename (ctx: ReqCtx, target: EvalLink, title: string): Promise<boolean> {
    const current =
      this.world.document !== undefined && this.world.document.id === target.targetId
        ? this.world.document.title
        : this.world.issues.find((i) => i.id === target.targetId)?.title
    if (current === undefined || current === title) return false
    const staged = ctx.pending?.kind === 'edit' ? ctx.pending : undefined
    ctx.pending = {
      ...(staged ?? {
        kind: 'edit',
        targetId: target.targetId as Ref<Doc>,
        targetClass: target.targetClass,
        targetAttr: target.targetAttr
      }),
      title
    }
    return true
  }

  // Same staging rules as production (workspaceClient.postEditProposal): parts accumulate, a
  // finished proposal identical to the current body is a no-op.
  async postEditProposal (ctx: ReqCtx, target: EvalLink, markdown: string, hasMore: boolean = false): Promise<boolean> {
    const staged = ctx.pending?.kind === 'edit' && ctx.pending.awaitingMore === true ? ctx.pending.markdown : undefined
    const full = sanitizeDocumentMarkdown(staged !== undefined ? staged + markdown : markdown)
    if (!hasMore && normalize(this.currentBody()) === normalize(full)) {
      ctx.pending = undefined
      return false
    }
    ctx.pending = {
      kind: 'edit',
      targetId: target.targetId as Ref<Doc>,
      targetClass: target.targetClass,
      targetAttr: target.targetAttr,
      markdown: full,
      awaitingMore: hasMore,
      // The markup conversion is a pod concern; a scenario compares markdown.
      proposedMarkup: ''
    }
    return true
  }

  async postTaskProposal (ctx: ReqCtx, proposal: any): Promise<boolean> {
    ctx.pending = { kind: 'task', ...proposal }
    return true
  }

  /** Datalab-only tools need it; they are unregistered without an API key, so it stays empty. */
  readonly client = {
    findAll: async () => [],
    findOne: async () => undefined
  }
}

function normalize (md: string): string {
  return md.replace(/\s+/g, ' ').trim()
}

/** What a person does with the Apply button: the proposal becomes the world. */
export function applyPending (world: EvalWorld, pending: PendingProposal | undefined): string[] {
  if (pending === undefined) return []
  if (pending.kind === 'edit') {
    if (world.document !== undefined && world.document.id === pending.targetId) {
      if (pending.markdown !== undefined) world.document.body = pending.markdown
      if (pending.title !== undefined) world.document.title = pending.title
      return [`document:${world.document.title}`]
    }
    const issue = world.issues.find((i) => i.id === pending.targetId)
    if (issue !== undefined) {
      if (pending.markdown !== undefined) issue.description = pending.markdown
      if (pending.title !== undefined) issue.title = pending.title
      return [`issue:${issue.title}`]
    }
    return []
  }

  const applied: string[] = []
  const parent = pending.parent as string | undefined
  // A proposal with sub-tasks and no parent creates the parent too, exactly as the card does.
  let parentId = parent
  if (parentId === undefined && pending.title !== '') {
    parentId = nextId('issue')
    world.issues.push({
      id: parentId,
      identifier: `EVAL-${world.issues.length + 1}`,
      title: pending.title,
      description: pending.description
    })
    applied.push(`issue:${pending.title}`)
  }
  for (const sub of pending.subtasks ?? []) {
    world.issues.push({
      id: nextId('issue'),
      identifier: `EVAL-${world.issues.length + 1}`,
      title: sub.title,
      description: sub.description,
      parent: parentId
    })
    applied.push(`issue:${sub.title}`)
  }
  return applied
}

/** Refs the tools receive; a scenario has exactly one conversation, so they are constants. */
export const EVAL_ROOT_ID = 'eval-root' as Ref<Doc>
export const EVAL_ROOT_CLASS = aiBot.class.AIContextMessage
export const EVAL_SPACE = 'eval-space' as Ref<any>

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
 * The context block describing the object a conversation is about. Pure: the caller reads the
 * document/issue, this only words it. Shared by the pod and by the scenario runner, so what the
 * model is told about a document is defined in exactly one place.
 */

export interface DocPromptData {
  kind: 'issue' | 'document'
  title: string
  /** Current editable body as markdown; empty when the document has none yet. */
  body: string
  /** Issue only: `identifier` as shown to people (TSK-38). */
  identifier?: string
  /** Issue only: the rendering of existing sub-tasks, as `listSubIssues` produces it. */
  subtasksListing?: string
  /**
   * The body does not fit the level's window. Then it is NOT truncated: an outline plus the
   * opening goes in instead, and editing is refused outright. A proposal built from half a
   * document silently deletes the other half - worse than answering that it cannot be done.
   */
  oversized?: boolean
  /** Characters of the body shown when `oversized`. */
  previewChars?: number
}

/** Markdown headings, in order: cheap, and makes "what is in the document" answerable. */
export function documentOutline (body: string): string[] {
  return body.split('\n').filter((line) => /^#{1,6}\s+\S/.test(line))
}

export function buildDocPromptText (data: DocPromptData): string {
  const parts: string[] = []
  if (data.kind === 'issue') {
    parts.push(`This conversation is about task ${data.identifier ?? ''}.`)
    parts.push('TITLE: ' + data.title)
    // The sub-tasks come with the task itself: asked to review the split, the model used to
    // propose a fresh list without ever calling list_subtasks.
    parts.push('EXISTING SUB-TASKS:')
    parts.push(data.subtasksListing ?? '')
    parts.push(
      'Those already exist. When the user asks about the split, judge THIS list: say what is ' +
        'missing, redundant or misnamed. Only propose sub-tasks that are genuinely new, and never ' +
        'restate the existing ones as a proposal.'
    )
  } else {
    parts.push('This conversation is about document ' + data.title + '.')
    parts.push('TITLE: ' + data.title)
  }
  if (data.oversized === true) {
    const outline = documentOutline(data.body)
    parts.push(
      `This document is too large to fit in the context (${data.body.length} characters), so only its ` +
        'outline and opening are shown.'
    )
    if (outline.length > 0) {
      parts.push('OUTLINE (headings, in order):')
      parts.push(outline.join('\n'))
    }
    parts.push('OPENING OF THE BODY (the rest is NOT shown):')
    parts.push('```markdown\n' + data.body.slice(0, data.previewChars ?? 2000) + '\n```')
    parts.push(
      'You do NOT have the full text, so you cannot rewrite this document: any new version you ' +
        'produced would drop everything you were not shown. There is no tool to edit it in this ' +
        'conversation. If the user asks to change, rewrite or fill it, tell them plainly that the ' +
        'document is too large to edit as a whole and that editing it in parts is still in development. ' +
        'Questions about its structure and about the part shown you can answer normally.'
    )
    return parts.join('\n')
  }

  const what = data.kind === 'issue' ? "this task's description" : 'the document'
  parts.push(
    data.kind === 'issue'
      ? 'This is the current description of that task (markdown):'
      : 'This is the current document body (markdown):'
  )
  parts.push('```markdown\n' + data.body + '\n```')
  // "Never invent details" in the system prompt otherwise wins and the model asks what to write.
  parts.push(
    `Writing ${what} is not inventing facts: it is a draft the user reviews before applying. Asked to ` +
      'write, extend or detail it, produce a concrete version built from the title and the conversation ' +
      'instead of asking the user what to put in it.'
  )
  parts.push(
    `To change ${what} - extend it, rewrite it, fill it in, split it into stages - call the ` +
      'propose_new_document tool. Its `markdown` argument must be the full new body: copy the current ' +
      'body above verbatim, apply ONLY the change the user asked for, and pass the result.'
  )
  if (data.kind === 'issue') {
    // Asked to extend the description, the model used to call propose_task and offer a second task.
    parts.push(
      'propose_task creates a SEPARATE new task and is not how this one is edited: never call it when ' +
        'the user asks to change the description, title or content of the task above.'
    )
  }
  parts.push(
    'STRICT rules for the markdown you pass:\n' +
      '- Output ONLY the document itself. The document ends where its content ends.\n' +
      '- Do NOT append examples, alternatives, samples, notes, explanations, or "here is another way".\n' +
      '- Reproduce code and ```mermaid blocks EXACTLY as in the current body unless the user asked to change them.\n' +
      '- Do NOT add a new mermaid/code block unless explicitly requested.\n' +
      '- Do NOT wrap the whole thing in a code fence, and do NOT include the user request or chat text.'
  )
  return parts.join('\n')
}

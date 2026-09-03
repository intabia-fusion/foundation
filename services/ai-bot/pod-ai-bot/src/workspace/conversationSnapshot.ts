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
 * The conversation transcript kept as one MDX file per AI thread: chunks separated by `---`, each
 * headed by `## <role> · <author> · <iso>[ · <messageId>]`. Written after every reply, so the next
 * turn reads the file instead of re-querying (and re-tokenizing) the whole thread, and the user
 * can download exactly what the model was given.
 *
 * What is NOT frozen here: the object the conversation is about (issue, document, draft). Its
 * current state is always re-read - a snapshot of it would go stale the moment someone edits it.
 */

/** `summary` is a compaction record: it replaces the turns folded into it. */
export type SnapshotRole = 'user' | 'assistant' | 'tool' | 'summary'

export interface SnapshotTurn {
  role: SnapshotRole
  /** Display name of the author, or the tool name for `role: 'tool'`. */
  author: string
  at: number
  /** Chunter message this turn came from; absent for tool calls, which have no message. */
  messageId?: string
  content: string
}

export interface ConversationSnapshot {
  conversation: string
  /** `<class>:<id>` of the object the thread is about, informational. */
  object?: string
  /**
   * `modifiedOn` of the newest *incoming* message in the file. The database is re-read from here
   * (not from the answer's timestamp): messages other people posted while the model was thinking
   * sit between the two, and anchoring on the answer would skip them. Turns already in the file are
   * recognized by their message id, so re-reading the answer costs nothing.
   */
  cursor: number
  /**
   * `messageId` of the first turn that is still verbatim. Everything before it is represented by
   * the newest `summary` turn. Absent until the conversation is first compacted.
   */
  firstKept?: string
  turns: SnapshotTurn[]
}

const CHUNK_SEP = '\n\n---\n\n'
const HEADER = /^## (user|assistant|tool|summary) · (.*?) · (\S+?)(?: · (\S+))?$/

/** `---` at line start would split the file into a bogus chunk, so it is escaped on write. */
function escapeBody (body: string): string {
  return body.replace(/^---$/gm, '\\---')
}

function unescapeBody (body: string): string {
  return body.replace(/^\\---$/gm, '---')
}

function quote (value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function unquote (value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  return trimmed
}

function renderTurn (turn: SnapshotTurn): string {
  const at = new Date(turn.at).toISOString()
  const head = `## ${turn.role} · ${turn.author} · ${at}${turn.messageId !== undefined ? ` · ${turn.messageId}` : ''}`
  return `${head}\n\n${escapeBody(turn.content)}`
}

export function renderSnapshot (snapshot: ConversationSnapshot): string {
  const frontmatter = [
    '---',
    `conversation: ${quote(snapshot.conversation)}`,
    ...(snapshot.object !== undefined ? [`object: ${quote(snapshot.object)}`] : []),
    ...(snapshot.firstKept !== undefined ? [`firstKept: ${quote(snapshot.firstKept)}`] : []),
    `cursor: ${snapshot.cursor}`,
    `turns: ${snapshot.turns.length}`,
    '---'
  ].join('\n')

  return [frontmatter, ...snapshot.turns.map(renderTurn)].join(CHUNK_SEP) + '\n'
}

/** Parse a file written by `renderSnapshot`. Anything unrecognized yields undefined - the caller
 *  then falls back to reading the thread from the database. */
export function parseSnapshot (text: string): ConversationSnapshot | undefined {
  const chunks = text.split(/\n\n---\n\n/)
  const head = chunks[0]
  if (head === undefined || !head.startsWith('---\n')) return undefined

  const meta = new Map<string, string>()
  for (const line of head.split('\n')) {
    if (line === '---') continue
    const at = line.indexOf(':')
    if (at <= 0) continue
    meta.set(line.slice(0, at).trim(), line.slice(at + 1))
  }
  const conversation = meta.get('conversation')
  if (conversation === undefined) return undefined

  const turns: SnapshotTurn[] = []
  for (const chunk of chunks.slice(1)) {
    const nl = chunk.indexOf('\n')
    const header = (nl === -1 ? chunk : chunk.slice(0, nl)).trim()
    const match = HEADER.exec(header)
    if (match === null) continue
    const at = Date.parse(match[3])
    turns.push({
      role: match[1] as SnapshotRole,
      author: match[2],
      at: Number.isNaN(at) ? 0 : at,
      messageId: match[4],
      content: unescapeBody(nl === -1 ? '' : chunk.slice(nl + 1).replace(/^\n/, '')).trimEnd()
    })
  }

  const cursor = Number(unquote(meta.get('cursor') ?? ''))
  return {
    conversation: unquote(conversation),
    object: meta.get('object') !== undefined ? unquote(meta.get('object') as string) : undefined,
    firstKept: meta.get('firstKept') !== undefined ? unquote(meta.get('firstKept') as string) : undefined,
    cursor: Number.isFinite(cursor) ? cursor : 0,
    turns
  }
}

/**
 * Append this turn to what the file already holds. Turns already present (same message id) are
 * dropped: a Kafka redelivery must not duplicate the conversation.
 */
export function appendTurns (
  snapshot: ConversationSnapshot | undefined,
  conversation: string,
  object: string | undefined,
  incoming: SnapshotTurn[],
  cap: number
): ConversationSnapshot {
  const seen = new Set((snapshot?.turns ?? []).map((t) => t.messageId).filter((id) => id !== undefined))
  const fresh = incoming.filter((t) => t.messageId === undefined || !seen.has(t.messageId))
  const turns = [...(snapshot?.turns ?? []), ...fresh].slice(-cap)
  const cursor = turns.reduce(
    (max, t) => (t.role === 'user' && t.messageId !== undefined && t.at > max ? t.at : max),
    0
  )
  return { conversation, object: object ?? snapshot?.object, firstKept: snapshot?.firstKept, cursor, turns }
}

/**
 * Record a compaction: the summary becomes a turn of its own and `firstKept` marks where the
 * verbatim tail begins. Folded turns stay in the file - it is also the transcript a person
 * downloads - but `contextTurns` stops handing them to the model.
 */
export function appendSummary (
  snapshot: ConversationSnapshot,
  summary: string,
  firstKeptId: string | undefined,
  at: number
): ConversationSnapshot {
  return {
    ...snapshot,
    firstKept: firstKeptId,
    turns: [...snapshot.turns, { role: 'summary', author: 'compaction', at, content: summary }]
  }
}

/**
 * What the model gets: the newest summary, then the turns from `firstKept` on. Without a
 * compaction it is simply every turn.
 */
export function contextTurns (snapshot: ConversationSnapshot | undefined): SnapshotTurn[] {
  if (snapshot === undefined) return []
  const summaries = snapshot.turns.filter((t) => t.role === 'summary')
  const summary = summaries[summaries.length - 1]
  if (summary === undefined) return snapshot.turns.filter((t) => t.role !== 'summary')

  const from =
    snapshot.firstKept !== undefined ? snapshot.turns.findIndex((t) => t.messageId === snapshot.firstKept) : -1
  // firstKept gone (edited file, deleted message): fall back to everything after the summary
  // rather than dropping the tail.
  const tailStart = from >= 0 ? from : snapshot.turns.indexOf(summary) + 1
  return [summary, ...snapshot.turns.slice(tailStart).filter((t) => t.role !== 'summary')]
}

/** Storage object name. Deterministic, so a thread keeps overwriting one file. */
export function snapshotBlobId (conversation: string): string {
  return `ai-snapshot-${conversation}.mdx`
}

/** Message ids the file already holds, so re-reading the tail from the DB cannot duplicate them. */
export function snapshotMessageIds (snapshot: ConversationSnapshot | undefined): Set<string> {
  return new Set((snapshot?.turns ?? []).map((t) => t.messageId).filter((id): id is string => id !== undefined))
}

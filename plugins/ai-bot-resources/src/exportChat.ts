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

import { type Doc, type PersonId, type Ref, SortingOrder } from '@hcengineering/core'
import chunter, { type ChatMessage } from '@hcengineering/chunter'
import aiBot, { type AIEditProposalMessage } from '@hcengineering/ai-bot'
import { getClient } from '@hcengineering/presentation'
import { getPersonByPersonId } from '@hcengineering/contact-resources'
import { markupToJSON } from '@hcengineering/text'
import { markupToMarkdown } from '@hcengineering/text-markdown'
import { get } from 'svelte/store'

import { aiBotSocialIdentityStore } from './utils'

/** Chunks are separated by `---`, so a body containing one at line start would split the file. */
function escapeChunkSeparators (md: string): string {
  return md.replace(/^---$/gm, '\\---')
}

function frontmatterValue (value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function authorName (personId: PersonId | undefined): Promise<string> {
  if (personId === undefined) return 'Unknown'
  const person = await getPersonByPersonId(personId)
  return person?.name ?? 'Unknown'
}

function messageBody (message: ChatMessage): string {
  // Edit proposals carry a whole document body that the user may never have applied - keep the
  // transcript about what was said, not about the draft.
  if (message._class === aiBot.class.AIEditProposalMessage) {
    const applied = (message as AIEditProposalMessage).applied === true
    return applied ? '_[document edit proposed and applied]_' : '_[document edit proposed, not applied]_'
  }
  return escapeChunkSeparators(markupToMarkdown(markupToJSON(message.message)))
}

/**
 * The whole conversation as MDX: a frontmatter header, then one `---`-separated chunk per turn.
 * Read back by a human, or fed to a model as the history of this conversation.
 */
export async function exportConversationMdx (root: ChatMessage, title: string): Promise<string> {
  const client = getClient()
  const limit = 1000
  const replies = await client.findAll(
    chunter.class.ChatMessage,
    { attachedTo: root._id as Ref<Doc> },
    { sort: { createdOn: SortingOrder.Ascending }, limit }
  )
  const botSocialId = get(aiBotSocialIdentityStore)?._id

  const chunks: string[] = [
    [
      '---',
      `title: ${frontmatterValue(title)}`,
      `exported: ${new Date().toISOString()}`,
      `messages: ${replies.length + 1}`,
      // Say so rather than hand over a silently cut transcript.
      ...(replies.length === limit ? [`truncated: ${limit}`] : []),
      '---'
    ].join('\n')
  ]

  for (const message of [root, ...replies]) {
    const role = message.createdBy !== undefined && message.createdBy === botSocialId ? 'assistant' : 'user'
    const name = await authorName(message.createdBy)
    const at = new Date(message.createdOn ?? message.modifiedOn).toISOString()
    chunks.push(`## ${role} · ${name} · ${at}\n\n${messageBody(message)}`)
  }

  return chunks.join('\n\n---\n\n') + '\n'
}

export function downloadMdx (fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(link.href)
}

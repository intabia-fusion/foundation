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

import type { PersonMessage } from '@hcengineering/ai-bot'

/** Build per-sender name map with disambiguation suffixes for duplicate display names. */
export function buildPersonNameMap (messages: PersonMessage[]): Map<string, string> {
  const personToName = new Map<string, string>()
  for (const m of messages) {
    if (!personToName.has(m.personRef)) {
      personToName.set(m.personRef, m.personName)
    }
  }

  const nameUsage = new Map<string, number>()
  for (const [personRef, name] of personToName) {
    const idx = nameUsage.get(name) ?? 0
    if (idx > 0) {
      personToName.set(personRef, name + ` no.${idx}`)
    }
    nameUsage.set(name, idx + 1)
  }

  return personToName
}

/** Format messages as a flat text block for summarization. */
export function buildMessageText (messages: PersonMessage[]): string {
  return messages.map((p) => `---\n\n@${p.personName}\n${p.text}`).join('\n\n')
}

/** Replace bolded @Name references in text with internal ref URIs. */
export function replacePersonRefs (text: string, personToName: Map<string, string>, classURI: string): string {
  for (const [personRef, name] of personToName) {
    const idURI = encodeURIComponent(personRef)
    const nameURI = encodeURIComponent(name)
    const refString = `[](ref://?_class=${classURI}&_id=${idURI}&label=${nameURI})`
    text = text.replaceAll(`**@${name}**`, refString)
  }
  return text
}

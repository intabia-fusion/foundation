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

import { apiKeyOperations, type ApiKeyOperation } from '@hcengineering/account-client'
import { type Class, type Doc, type Ref } from '@hcengineering/core'
import document from '@hcengineering/document'
import tracker from '@hcengineering/tracker'

// Resolving refs and calling `ops` live in the transactor now (pods/server/src/opsApi.ts); this pod
// keeps only what it needs without a model: known action names and which body fields carry markdown.

export function isKnownOperation (action: unknown): action is ApiKeyOperation {
  return typeof action === 'string' && (apiKeyOperations as string[]).includes(action)
}

/** `inline` converts markdown in place; `blob` uploads it and sends the `Ref<Blob>` under `refField`;
 * `raw` is already markdown and is forwarded unchanged - the transactor (opsApi.ts) converts and
 * uploads it itself, keyed by the shared `body` field. */
export type MarkdownFieldSpec =
  | { kind: 'inline' }
  | { kind: 'blob', refField: string, objectClass: Ref<Class<Doc>> }
  | { kind: 'raw' }

// Keep in sync with pods/server/src/opsApi.ts's `operations` registry, which is what actually reads
// `descriptionRef`/`contentRef`/`body`/the converted `message`.
export const markdownFields: Partial<Record<ApiKeyOperation, Record<string, MarkdownFieldSpec>>> = {
  'issue:create': {
    description: { kind: 'blob', refField: 'descriptionRef', objectClass: tracker.class.Issue },
    body: { kind: 'raw' }
  },
  'issue:update': {
    description: { kind: 'blob', refField: 'descriptionRef', objectClass: tracker.class.Issue },
    body: { kind: 'raw' }
  },
  'issue:comment': { message: { kind: 'inline' } },
  // No markdown/collaborative field - TimeSpendReport.description is plain text.
  'issue:time_report': {},
  'chat:post': { message: { kind: 'inline' } },
  'doc:create': {
    content: { kind: 'blob', refField: 'contentRef', objectClass: document.class.Document },
    body: { kind: 'raw' }
  },
  'doc:update': {
    content: { kind: 'blob', refField: 'contentRef', objectClass: document.class.Document },
    body: { kind: 'raw' }
  }
}

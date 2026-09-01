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

import { type Class, type Doc, type Ref } from '@hcengineering/core'
import chunter from '@hcengineering/chunter'
import document from '@hcengineering/document'
import tracker from '@hcengineering/tracker'
import { type WebhookEventType } from '@hcengineering/setting'

// Tx class and field -> domain event name. Sits next to operations.ts so both directions of this pod
// use one vocabulary; the executing registry lives in pods/server/src/opsApi.ts, which is a deployable.

/** A create of `objectClass` (optionally narrowed to attachments under `attachedToClass`, e.g. telling
 * an issue comment apart from a channel post - both are a ChatMessage create). `dataFields` lists which
 * attributes end up in the event's `data`, alongside the object id which is always included. */
export interface CreateRule {
  kind: 'create'
  objectClass: Ref<Class<Doc>>
  attachedToClass?: Ref<Class<Doc>>
  type: WebhookEventType
  dataFields: string[]
}

/** An update of `objectClass` that touches `field`. One rule per tracked field, not per class - so an
 * issue update touching both `status` and `assignee` produces two distinct domain events. */
export interface UpdateRule {
  kind: 'update'
  objectClass: Ref<Class<Doc>>
  field: string
  type: WebhookEventType
}

/** A remove of `objectClass`. `data` for these is whatever this pod still has cached for the object
 * (see txTranslator.ts) - there is no live document left to read. */
export interface RemoveRule {
  kind: 'remove'
  objectClass: Ref<Class<Doc>>
  type: WebhookEventType
}

export type DomainRule = CreateRule | UpdateRule | RemoveRule

// No remove event is defined yet, so deletions produce no webhook. The collapsing engine already
// handles remove, so adding one is a table entry, not new logic.
export const domainRules: DomainRule[] = [
  {
    kind: 'create',
    objectClass: tracker.class.Issue,
    type: 'issue.created',
    dataFields: ['identifier', 'title', 'status', 'assignee', 'priority']
  },
  { kind: 'update', objectClass: tracker.class.Issue, field: 'status', type: 'issue.status_changed' },
  { kind: 'update', objectClass: tracker.class.Issue, field: 'assignee', type: 'issue.assigned' },
  {
    kind: 'create',
    objectClass: chunter.class.ChatMessage,
    attachedToClass: tracker.class.Issue,
    type: 'issue.commented',
    dataFields: ['message']
  },
  {
    kind: 'create',
    objectClass: chunter.class.ChatMessage,
    attachedToClass: chunter.class.Channel,
    type: 'message.posted',
    dataFields: ['message']
  },
  { kind: 'create', objectClass: document.class.Document, type: 'document.created', dataFields: ['title'] }
]

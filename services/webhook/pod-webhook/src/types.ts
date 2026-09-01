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
import type { PersonId, PersonUuid, Ref, Space, WorkspaceUuid } from '@hcengineering/core'
import type { ApiKeyOperation } from '@hcengineering/account-client'
import type { WebhookEndpoint } from '@hcengineering/setting'

// Domain event body, Linear-shaped: a receiver never parses a raw Tx to learn what changed.
// `webhookId`/`webhookTimestamp` are added by delivery.ts right before signing, not here.
export interface WebhookEvent {
  action: 'create' | 'update' | 'remove'
  // Domain event name, e.g. 'issue.status_changed' - see eventTable.ts's domainRules for the full set.
  type: string
  actor: PersonId
  // For an issue update event, `identifier` (e.g. 'PROJ-123') rides along when this pod's in-process
  // cache still has it from the create - unknown, not wrong, right after a restart (see txTranslator.ts).
  data: Record<string, unknown>
  // Only meaningful for action:'update' - the touched fields' values before this change. Omitted
  // (rather than guessed) for a field this pod has no prior recorded value for - see eventTable.ts.
  updatedFrom?: Record<string, unknown>
  // Not populated yet: a deep link needs a per-class lookup (an issue's identifier lives on its
  // Project). Kept in the shape so receivers need no parser change later.
  url?: string
  organizationId: WorkspaceUuid
}

// Job for QueueTopic.Webhook, forwarded by the consumer to the transactor's `/api/v1/ops`. `ops`/
// `spaces` mirror the key's grant, so building the token needs no second verifyApiKey round trip.
export interface WebhookJobMessage {
  jobId: string
  workspace: WorkspaceUuid
  keyId: string
  // Key's display name - carried along so the consumer can materialize the integration's workspace
  // identity (contact.class.Person) without a second verifyApiKey round trip.
  name: string
  socialId: PersonId
  personUuid: PersonUuid
  action: ApiKeyOperation
  ops: ApiKeyOperation[]
  spaces: Ref<Space>[]
  // Raw request body (action/space plus action-specific fields), forwarded as-is to the consumer.
  payload: Record<string, unknown>
  receivedAt: number
  // Retry counter, bumped by the consumer on each re-schedule through time-machine.
  attempt: number
}

export type WebhookJobStatus = 'queued' | 'done' | 'failed'

export interface WebhookJobRecord {
  jobId: string
  workspace: WorkspaceUuid
  keyId: string
  status: WebhookJobStatus
  createdAt: number
  expiresAt: number
  result?: Record<string, unknown>
  error?: string
}

// One per (recipient, event), from txTranslator.ts. `deliveryId` survives retries unchanged, while
// `webhookId`/`webhookTimestamp` are stamped at send time so they stay fresh.
export interface WebhookDeliveryMessage {
  deliveryId: string
  workspace: WorkspaceUuid
  endpointId: Ref<WebhookEndpoint>
  event: WebhookEvent
  // Retry counter, bumped by the delivery consumer on each re-schedule through time-machine.
  attempt: number
}

// Duplicated (minimal) from server-plugins/process/src/types.ts - depending on @hcengineering/server-process
// just for this 5-field shape would pull in @hcengineering/card + @hcengineering/process transitively.
export interface TimeMachineMessage {
  type: 'schedule' | 'cancel'
  id: string
  targetDate?: number
  topic?: string
  data?: unknown
}

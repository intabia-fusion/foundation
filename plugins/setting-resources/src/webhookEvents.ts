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

import { webhookEventTypes, type WebhookEventType } from '@hcengineering/setting'
import type { IntlString } from '@hcengineering/platform'
import settingRes from './plugin'

// Translated label per shared event type - the type list itself is @hcengineering/setting's
// webhookEventTypes (also used by pod-webhook's eventTable.ts), so a new event only needs a label
// added here, never a second list of the type strings.
export const webhookEventLabels: Record<WebhookEventType, IntlString> = {
  'issue.created': settingRes.string.WebhookEventIssueCreated,
  'issue.status_changed': settingRes.string.WebhookEventIssueStatusChanged,
  'issue.assigned': settingRes.string.WebhookEventIssueAssigned,
  'issue.commented': settingRes.string.WebhookEventIssueCommented,
  'message.posted': settingRes.string.WebhookEventMessagePosted,
  'document.created': settingRes.string.WebhookEventDocumentCreated
}

export { webhookEventTypes, type WebhookEventType }

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

import { type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import type { PlatformQueueProducer } from '@hcengineering/server-core'
import type { WebhookEndpoint } from '@hcengineering/setting'

// Shape services/mail's pod-mail consumer expects off QueueTopic.NotificationQueue - duplicated here
// (as billing/crm/gmail-resources each do) rather than depending on a mail-service-only package.
export interface EmailNotification {
  type: 'email'
  data: { to: string, subject: string, text: string, html: string }
}

function escapeHtml (str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Best-effort - a failed notification must not affect the disable itself, which already happened. */
export async function notifyOwnerDisabled (
  ctx: MeasureContext,
  accountsUrl: string,
  token: string,
  workspace: WorkspaceUuid,
  producer: PlatformQueueProducer<EmailNotification>,
  endpoint: Pick<WebhookEndpoint, '_id' | 'url'>,
  reason: string
): Promise<void> {
  try {
    const recipients = await getAccountClient(accountsUrl, token).getWorkspaceOwnerEmails(workspace)
    if (recipients.length === 0) {
      ctx.warn('webhook: no email found to notify about endpoint disablement', { endpointId: endpoint._id })
      return
    }

    const subject = 'Outgoing webhook disabled'
    const text =
      `Your outgoing webhook to ${endpoint.url} was disabled after repeated delivery failures.\n` +
      `Last error: ${reason}\n\nRe-enable it from workspace settings once the issue is fixed.`
    const html =
      `<p>Your outgoing webhook to <code>${escapeHtml(endpoint.url)}</code> was disabled after repeated ` +
      `delivery failures.</p><p>Last error: ${escapeHtml(reason)}</p>` +
      '<p>Re-enable it from workspace settings once the issue is fixed.</p>'

    for (const to of recipients) {
      await producer.send(ctx, '' as WorkspaceUuid, [{ type: 'email', data: { to, subject, text, html } }], to)
    }
  } catch (err) {
    ctx.error('webhook: failed to notify owner about endpoint disablement', { endpointId: endpoint._id, err })
  }
}

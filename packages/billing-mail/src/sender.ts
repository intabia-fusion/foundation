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

import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import type { PlatformQueueProducer } from '@hcengineering/server-core'

import type { MailMessage, MailSender } from './types'

/**
 * What pod-mail's notification consumer reads off QueueTopic.NotificationQueue.
 */
export interface EmailNotification {
  type: 'email'
  data: {
    from?: string
    to: string
    subject: string
    text: string
    html: string
  }
}

/**
 * Publish billing mail to the platform notification queue. *
 * `from` is optional — omit it to let pod-mail use its configured SOURCE.
 */
export function createQueueSender (producer: PlatformQueueProducer<EmailNotification>, from?: string): MailSender {
  return async (ctx: MeasureContext, to: string, msg: MailMessage): Promise<void> => {
    await producer.send(
      ctx,
      '' as WorkspaceUuid,
      [
        {
          type: 'email',
          data: { ...(from !== undefined ? { from } : {}), to, subject: msg.subject, text: msg.text, html: msg.html }
        }
      ],
      to
    )
  }
}

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

import { type SendMailOptions } from 'nodemailer'
import { MeasureContext } from '@hcengineering/core'
import { ClisrServer } from '@intabiafusion/clisr'
import { ConsumerControl } from '@hcengineering/server-core'

import config from './config'
import { MailClient } from './mail'
import { EmailNotification } from './types'

/**
 * Creates an email message object from notification data.
 */
export function createEmailMessage (data: EmailNotification): SendMailOptions {
  const emailMessage: SendMailOptions = {
    ...(data as SendMailOptions)
  }

  // Set from address
  const fromAddress = config.source
  emailMessage.from = fromAddress

  // Set reply-to if configured and from address matches source
  if (config.replyTo !== undefined && fromAddress === config.source) {
    emailMessage.replyTo = config.replyTo
  }

  return emailMessage
}

/**
 * Handles email sending in queue mode (direct SMTP sending).
 */
export async function handleQueueMode (
  ctx: MeasureContext,
  client: MailClient | undefined,
  emailMessage: SendMailOptions
): Promise<void> {
  try {
    await client?.sendMessage(emailMessage, ctx)
  } catch (err: any) {
    ctx.error(err.message)
  }
}

/**
 * Handles email sending in server mode (forward to connected clients).
 */
export async function handleServerMode (
  measureCtx: MeasureContext,
  server: ClisrServer | undefined,
  emailMessage: SendMailOptions,
  control: ConsumerControl
): Promise<void> {
  if (server === undefined) {
    measureCtx.error('Server is not initialized in server mode')
    return
  }

  const heartbeatInterval = setInterval(() => {
    void control.heartbeat()
  }, 1000)

  try {
    await server.request(measureCtx, 'send', [emailMessage])
  } finally {
    clearInterval(heartbeatInterval)
  }
}

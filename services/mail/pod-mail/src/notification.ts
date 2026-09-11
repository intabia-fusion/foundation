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

import { MeasureContext, WorkspaceUuid, systemAccountUuid, SocialIdType } from '@hcengineering/core'
import { getAccountClient } from '@hcengineering/server-client'
import { generateToken } from '@hcengineering/server-token'
import gmail from '@hcengineering/gmail'
import { QueueNotificationMessage } from '@hcengineering/notification'
import { ClisrServer } from '@intabiafusion/clisr'
import { ConsumerControl } from '@hcengineering/server-core'

import config from './config'
import { MailClient } from './mail'
import { createEmailMessage, handleQueueMode, handleServerMode } from './utils'

export function createUserNotificationsHandler (
  measureCtx: MeasureContext,
  client: MailClient | undefined,
  server: ClisrServer | undefined
) {
  return async (
    ctx: MeasureContext,
    message: { workspace: WorkspaceUuid, value: QueueNotificationMessage },
    control: ConsumerControl
  ) => {
    try {
      const msg = message.value
      if (msg.template == null) return
      const shouldEmail = (msg.providers[gmail.providers.EmailNotificationProvider]?.length ?? 0) > 0
      if (!shouldEmail) return

      const token = generateToken(systemAccountUuid, message.workspace, { service: config.serviceId })
      const personInfo = await getAccountClient(token).getPersonInfo(msg.account)
      if (personInfo?.socialIds === undefined) {
        ctx.error(`No person info found for account: ${msg.account}`)
        return
      }

      const emails = personInfo.socialIds.filter(
        (id) =>
          (id.type === SocialIdType.EMAIL || id.type === SocialIdType.GOOGLE) &&
          id.verifiedOn !== undefined &&
          id.verifiedOn > 0 &&
          id.isDeleted !== true
      )

      if (emails.length === 0) {
        ctx.warn(`No verified email found for account: ${msg.account}`)
        return
      }

      const emailAddress = emails[0].value

      const emailMessage = createEmailMessage({
        html: wrapWithHtmlCard(msg.template.html, config.appName),
        text: msg.template.text,
        subject: msg.template.subject,
        to: emailAddress
      })

      switch (config.mode) {
        case 'queue':
          await handleQueueMode(ctx, client, emailMessage)
          break
        case 'server':
          await handleServerMode(measureCtx, server, emailMessage, control)
          break
        default:
          ctx.warn(`Unexpected mode for user notification handling: ${config.mode}`)
      }
    } catch (e: any) {
      ctx.error('Failed to process user email notification', { e, message })
    }
  }
}

export function wrapWithHtmlCard (html: string, appName: string): string {
  if (html.includes('<html') || html.includes('<!DOCTYPE')) {
    return html
  }

  let bodyHtml = html
  // Extract and wrap the message part with a styled divider and font size wrapper
  const firstCloseIdx = html.indexOf('</p>')
  const lastOpenIdx = html.lastIndexOf('<p>')
  if (firstCloseIdx !== -1 && lastOpenIdx !== -1 && lastOpenIdx > firstCloseIdx + 4) {
    const senderPart = html.substring(0, firstCloseIdx + 4)
    const middlePart = html.substring(firstCloseIdx + 4, lastOpenIdx)
    const linkPart = html.substring(lastOpenIdx)
    if (middlePart.trim().length > 0) {
      bodyHtml = `${senderPart}<div style="border-top: 1px solid #F4F4F5; margin: 20px 0;"></div><div class="notification-message-body">${middlePart}</div>${linkPart}`
    }
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>a { color: #18181B; font-weight: 600; text-decoration: underline; } .notification-content { color: #52525B; font-size: 15px; line-height: 1.6; } .notification-content > p:first-child { margin: 0 0 16px 0 !important; color: #18181B; font-size: 16px; font-weight: 500; } .notification-message-body { font-size: 14px; line-height: 1.2; } .notification-message-body > *:first-child { margin-top: 0 !important; } .notification-message-body > *:last-child { margin-bottom: 0 !important; } .notification-content > p:last-child { margin: 24px 0 0 0 !important; } .notification-content > p:last-child a { display: inline-block !important; background-color: #18181B !important; color: #FFFFFF !important; font-weight: 600 !important; text-decoration: none !important; padding: 12px 24px !important; border-radius: 8px !important; font-size: 14px !important; letter-spacing: -0.1px !important; } .notification-content > p:last-child a:hover { background-color: #27272A !important; } pre { background-color: #FAFBFB; border: 1px solid #E4E4E7; border-radius: 6px; padding: 12px 14px; overflow-x: auto; font-family: 'Courier New', Courier, monospace; font-size: 13px; line-height: 1.2; color: #09090B; margin: 16px 0; } pre code { background-color: transparent; padding: 0; border-radius: 0; color: #09090B; } code { font-family: 'Courier New', Courier, monospace; background-color: #F4F4F5; padding: 2px 6px; border-radius: 4px; font-size: 13px; color: #B63F00; } blockquote { margin: 16px 0; padding-left: 16px; border-left: 3px solid #B63F00; color: #52525B; } span[data-type="reference"], a[data-type="reference"] { background-color: #FAF5F2; color: #B63F00; padding: 2px 6px; border-radius: 4px; font-weight: 600; text-decoration: none !important; }</style></head><body style="margin:0;padding:0;background-color:#F2F2F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F2F2F7;padding:40px 16px"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%"><tr><td style="background-color:#18181B;border-radius:12px 12px 0 0;padding:24px 40px"><span style="display:inline-block;font-size:18px;font-weight:700;color:#FFFFFF;letter-spacing:-0.3px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">${appName}</span></td></tr><tr><td style="background-color:#FFFFFF;padding:36px 40px;border:1px solid #E4E4E7;border-top:none;border-radius:0 0 12px 12px"><div class="notification-content">${bodyHtml}</div></td></tr><tr><td align="center" style="padding:20px 0"><p style="margin:0;font-size:12px;color:#9CA3AF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">&copy; ${appName} &mdash; All rights reserved</p></td></tr></table></td></tr></table></body></html>`
}

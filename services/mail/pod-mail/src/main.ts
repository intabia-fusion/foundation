//
// Copyright © 2025 Hardcore Engineering Inc.
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

import os from 'os'
import { Request, Response } from 'express'
import { type SendMailOptions } from 'nodemailer'
import Mail from 'nodemailer/lib/mailer'
import { join } from 'path'

import { Analytics } from '@hcengineering/analytics'
import { configureAnalytics, createOpenTelemetryMetricsContext, SplitLogger } from '@hcengineering/analytics-service'
import { MeasureContext, newMetrics, WorkspaceUuid } from '@hcengineering/core'
import {
  ConsumerHandle,
  initStatisticsContext,
  PlatformQueue,
  PlatformQueueProducer,
  QueueTopic
} from '@hcengineering/server-core'
import { readToken } from '@hcengineering/server-client'

import config from './config'
import { MailClient } from './mail'
import { createServer } from './server'
import { AccountNotification, EmailNotification, Endpoint } from './types'
import { getPlatformQueue } from '@hcengineering/kafka'
import { ClisrClient, ClisrServer, createCallbackClient } from '@intabiafusion/clisr'

/**
 * Main entry point for the mail service.
 * Initializes the service based on the configured mode (queue, server, or client).
 */
export const main = async (): Promise<void> => {
  configureAnalytics('mail', process.env.VERSION ?? '0.7.0')
  Analytics.setTag('application', 'mail')
  const measureCtx = initStatisticsContext('mail', {
    factory: () =>
      createOpenTelemetryMetricsContext(
        'mail',
        {},
        {},
        newMetrics(),
        new SplitLogger('mail', {
          root: join(process.cwd(), 'logs'),
          enableConsole: (process.env.ENABLE_CONSOLE ?? 'true') === 'true'
        })
      )
  })

  // Initialize components based on mode
  const { client, platformQueue, server, serverClient, notificationConsumer } = await initializeComponents(measureCtx)

  measureCtx.info('Mail service has been started')

  // Start the server
  await server?.start(measureCtx, config.port)

  // Setup graceful shutdown
  setupShutdownHandlers(measureCtx, notificationConsumer, platformQueue, client, serverClient, server)
}

/**
 * Initializes components based on the configured mode.
 */
async function initializeComponents (measureCtx: MeasureContext): Promise<{
  client: MailClient | undefined
  platformQueue: PlatformQueue | undefined
  server: ClisrServer | undefined
  serverClient: ClisrClient | undefined
  notificationConsumer: ConsumerHandle | undefined
  notificationProducer: PlatformQueueProducer<AccountNotification> | undefined
}> {
  // Initialize mail client if needed (not in server mode)
  const client = config.mode !== 'server' ? new MailClient() : undefined

  // Initialize platform queue if needed (not in client mode)
  const platformQueue = config.mode !== 'client' ? getPlatformQueue('mail') : undefined
  const notificationProducer = platformQueue?.getProducer<AccountNotification>(measureCtx, QueueTopic.NotificationQueue)

  // Create server endpoints
  const endpoints: Endpoint[] = [
    {
      endpoint: '/send',
      type: 'post',
      handler: async (req, res) => {
        await handleSendMail(notificationProducer, client, req, res, measureCtx)
      }
    }
  ]
  const app = createServer(endpoints)

  // Initialize CLISR server if needed (queue or server mode)
  const server =
    config.mode !== 'client'
      ? new ClisrServer(measureCtx, async (token) => token === config.apiKey, '1.0', app)
      : undefined

  // Initialize notification consumer if needed (queue or server mode)
  const notificationConsumer = platformQueue?.createConsumer<AccountNotification>(
    measureCtx,
    QueueTopic.NotificationQueue,
    'mail-notifications',
    createNotificationHandler(measureCtx, client, server)
  )

  // Initialize server client if in client mode
  const serverClient = config.mode === 'client' ? await initializeClientMode(measureCtx, client) : undefined

  return {
    client,
    platformQueue,
    server,
    serverClient,
    notificationConsumer,
    notificationProducer
  }
}

/**
 * Creates a notification handler function based on the current mode.
 */
function createNotificationHandler (
  measureCtx: MeasureContext,
  client: MailClient | undefined,
  server: ClisrServer | undefined
) {
  return async (ctx: MeasureContext, message: { value: AccountNotification }, control: any) => {
    if (message.value.type === 'email') {
      const emailMessage = createEmailMessage(message.value.data as EmailNotification)

      ctx.info('Received email from notification queue', { to: emailMessage.to, mode: config.mode })
      switch (config.mode) {
        case 'queue':
          await handleQueueMode(ctx, client, emailMessage)
          break
        case 'server':
          await handleServerMode(measureCtx, server, emailMessage, control)
          break
        default:
          ctx.warn(`Unexpected mode for notification handling: ${config.mode}`)
      }
    }
  }
}

/**
 * Handles email sending in queue mode (direct SMTP sending).
 */
async function handleQueueMode (
  ctx: MeasureContext,
  client: MailClient | undefined,
  emailMessage: SendMailOptions
): Promise<void> {
  try {
    ctx.info('Forwarding email to SMTP provider', { to: emailMessage.to })
    await client?.sendMessage(emailMessage, ctx)
    ctx.info('Email forwarded to SMTP provider', { to: emailMessage.to })
  } catch (err: any) {
    ctx.error('Failed to forward email to SMTP provider', { to: emailMessage.to, error: err.message })
  }
}

/**
 * Handles email sending in server mode (forward to connected clients).
 */
async function handleServerMode (
  measureCtx: MeasureContext,
  server: ClisrServer | undefined,
  emailMessage: SendMailOptions,
  control: any
): Promise<void> {
  if (server === undefined) {
    measureCtx.error('Server is not initialized in server mode')
    return
  }

  const heartbeatInterval = setInterval(() => {
    void control.heartbeat()
  }, 1000)

  try {
    measureCtx.info('Forwarding email to clisr mail client', { to: emailMessage.to })
    await server.request(measureCtx, 'send', [emailMessage])
    measureCtx.info('Email forwarded to clisr mail client', { to: emailMessage.to })
  } finally {
    clearInterval(heartbeatInterval)
  }
}

/**
 * Initializes client mode components.
 */
async function initializeClientMode (
  measureCtx: MeasureContext,
  client: MailClient | undefined
): Promise<ClisrClient | undefined> {
  const serverUrl = config.serverUrl
  if (serverUrl === undefined) {
    console.error('SERVER_URL should be specified')
    process.exit(1)
  }

  return await createCallbackClient(measureCtx, serverUrl, config.apiKey ?? '', {
    clientHost: `mail-client@${os.hostname()}`,
    callback: async (ctx, method, data) => {
      if (method === 'send' && client !== undefined) {
        const msg: SendMailOptions = data[0]

        if (config.source !== undefined) {
          // Rewrite source
          msg.from = config.source
        }
        if (config.replyTo !== undefined) {
          // Rewrite reply-to
          msg.replyTo = config.replyTo
        }
        await client.sendMessage(msg, measureCtx)
      }
      return {}
    }
  })
}

/**
 * Sets up graceful shutdown handlers.
 */
function setupShutdownHandlers (
  measureCtx: MeasureContext,
  notificationConsumer: any,
  platformQueue: any,
  client: MailClient | undefined,
  serverClient: ClisrClient | undefined,
  server: ClisrServer | undefined
): void {
  const shutdown = (): void => {
    void notificationConsumer?.close()
    void platformQueue?.shutdown()
    void client?.close()
    void serverClient?.close()
    void server?.close().then(() => {
      process.exit()
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('uncaughtException', (e: any) => {
    measureCtx.error(e.message)
  })
  process.on('unhandledRejection', (e: any) => {
    measureCtx.error(e.message)
  })
}

/**
 * Creates an email message object from notification data.
 */
export function createEmailMessage (data: EmailNotification): SendMailOptions {
  const emailMessage: SendMailOptions = {
    ...(data as SendMailOptions)
  }

  const fromAddress = (data as SendMailOptions).from ?? config.source
  emailMessage.from = fromAddress

  // Set reply-to if configured and from address matches source
  if (config.replyTo !== undefined && fromAddress === config.source) {
    emailMessage.replyTo = config.replyTo
  }

  return emailMessage
}

/**
 * Handles the send mail request based on the current mode.
 */
export async function handleSendMail (
  notificationProducer: PlatformQueueProducer<AccountNotification> | undefined,
  client: MailClient | undefined,
  req: Request,
  res: Response,
  ctx: MeasureContext
): Promise<void> {
  // Extract request data
  const { from, to, subject, text, html, attachments, headers, password } = req.body

  const token = readToken(req.headers)

  // Validate authorization
  if (!isAuthorized(token)) {
    ctx.warn('Unauthorized access attempt to send email', { from, to })
    res.status(401).send({ err: 'Unauthorized' })
    return
  }

  // Validate required fields
  const validationError = validateEmailRequest(from, to, subject, text, html)
  if (validationError != null) {
    ctx.warn(validationError.message, { from, to })
    res.status(400).send({ err: validationError.message })
    return
  }

  // Create email message
  const message = createEmailMessageFromRequest(from, to, subject, text, html, headers, attachments)

  // Send based on mode
  if (config.mode !== 'client') {
    // In queue or server mode, push to queue
    await notificationProducer?.send(ctx, '' as WorkspaceUuid, [{ type: 'email', data: message }], to)
  } else {
    // In client mode, send directly
    try {
      await client?.sendMessage(message, ctx, password)
    } catch (err: any) {
      ctx.error(err.message)
    }
  }

  res.send()
}

/**
 * Checks if the request is authorized.
 */
function isAuthorized (apiKey: string | undefined): boolean {
  return config.apiKey === undefined || config.apiKey === apiKey
}

/**
 * Validates the email request fields.
 */
function validateEmailRequest (
  from: string | undefined,
  to: string | string[] | undefined,
  subject: string | undefined,
  text: string | undefined,
  html: string | undefined
): { message: string } | null {
  const fromAddress = from ?? config.source

  if (text === undefined && html === undefined) {
    return { message: "'text' and 'html' are missing" }
  }

  if (subject === undefined) {
    return { message: "'subject' is missing" }
  }

  if (to === undefined) {
    return { message: "'to' is missing" }
  }

  if (fromAddress === undefined) {
    return { message: "'from' is missing" }
  }

  return null
}

/**
 * Creates an email message from request data.
 */
function createEmailMessageFromRequest (
  from: string | undefined,
  to: string | string[],
  subject: string,
  text: string | undefined,
  html: string | undefined,
  headers: any,
  attachments: any
): SendMailOptions {
  const fromAddress = from ?? config.source
  const message: SendMailOptions = {
    from: fromAddress,
    to,
    subject,
    text
  }

  // Set reply-to if configured and from address matches source
  if (config.replyTo !== undefined && fromAddress === config.source) {
    message.replyTo = config.replyTo
  }

  if (html !== undefined) {
    message.html = html
  }

  if (headers !== undefined) {
    message.headers = headers
  }

  if (attachments !== undefined) {
    message.attachments = getAttachments(attachments)
  }

  return message
}

/**
 * Processes attachments from request data.
 */
function getAttachments (attachments: any): Mail.Attachment[] | undefined {
  if (attachments === undefined || attachments === null) {
    return undefined
  }

  if (!Array.isArray(attachments)) {
    console.error('attachments is not array')
    return undefined
  }

  return attachments.map((a) => {
    const attachment: Mail.Attachment = {
      content: a.content,
      contentType: a.contentType,
      path: a.path,
      filename: a.filename,
      cid: a.cid,
      encoding: a.encoding,
      contentTransferEncoding: a.contentTransferEncoding,
      headers: a.headers,
      raw: a.raw
    }
    return attachment
  })
}

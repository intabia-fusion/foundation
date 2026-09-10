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

import { MeasureContext } from '@hcengineering/core'
import cors from 'cors'
import express, { type Express, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import { type Server } from 'http'

import { AmoCrmClient } from './amocrm/client'
import { Config } from './config'
import { getLeadNotificationEmail, parseCookies, sendEmail } from './utils'

const KEEP_ALIVE_TIMEOUT = 5 // seconds

interface LeadRequestBody {
  name: string
  phone: string
  comment?: string
}

async function handleLeadRequest (ctx: MeasureContext, config: Config, req: Request, res: Response): Promise<void> {
  try {
    const body: LeadRequestBody = req.body
    const { name, phone, comment } = body

    if (name === '' || phone === '') {
      res.status(400).json({ error: 'name and phone are required' })
      return
    }

    try {
      const email = await getLeadNotificationEmail(name, phone, comment ?? '', config.LeadNotificationEmail)
      await sendEmail(email, ctx)
      ctx.info('Lead notification email sent', { to: config.LeadNotificationEmail })
    } catch (emailError: unknown) {
      ctx.error('Failed to send lead notification email', {
        error: emailError instanceof Error ? emailError.message : String(emailError),
        to: config.LeadNotificationEmail
      })
    }

    const cookies = parseCookies(req.headers.cookie)
    const amocrm = new AmoCrmClient(ctx)
    await amocrm.createLead(cookies, config.AmoCrmNotProcessedStatus, name, undefined, undefined, phone, comment)

    res.status(200).json({ success: true })
  } catch (err: unknown) {
    ctx.error('Failed to create lead', { error: err })
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' })
    }
  }
}

export async function createServer (
  ctx: MeasureContext,
  config: Config
): Promise<{
  app: Express
  close: () => void
}> {
  const app = express()
  app.set('trust proxy', true)
  app.use(cors())
  app.use(express.json())

  const leadRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many lead submission requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false
  })

  app.post('/api/v1/lead', leadRateLimiter, (req: Request, res: Response) => {
    void handleLeadRequest(ctx, config, req, res)
  })

  app.use((_req, res) => {
    res.status(404).json({ message: 'Not Found' })
  })

  return {
    app,
    close: () => {}
  }
}

export function listen (e: Express, port: number, host?: string): Server {
  const cb = (): void => {
    console.log(`CRM service started at ${host ?? '*'}:${port}`)
  }

  const server = host !== undefined ? e.listen(port, host, cb) : e.listen(port, cb)
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT * 1000 + 1000
  server.headersTimeout = KEEP_ALIVE_TIMEOUT * 1000 + 2000

  return server
}

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

import express, { type Express, type NextFunction, type Request, type Response } from 'express'

import type { Config } from './config'
import { PAGE_HTML } from './page'
import { DeliveryStore } from './store'
import type { ReceiveResponseMode } from './types'
import { verifyStandardSignature } from './verify'

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next)
  }

function tryParseJson (text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function createServer (config: Config, store: DeliveryStore = new DeliveryStore()): Express {
  const app = express()
  let responseMode: ReceiveResponseMode = 200

  app.get('/', (_req, res) => {
    res.type('html').send(PAGE_HTML)
  })

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  // The address to paste into a workspace's WebhookEndpoint - captures whatever pod-webhook's
  // delivery worker sends, raw (no body-parsing) so the exact bytes are available for signature checks.
  app.post('/receive', express.raw({ type: () => true, limit: '5mb' }), (req, res) => {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[name] = value
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
    store.add(headers, rawBody)
    res.status(responseMode).json(responseMode === 200 ? { ok: true } : { error: `mock responded ${responseMode}` })
  })

  app.get('/api/deliveries', (_req, res) => {
    res.status(200).json(store.list())
  })

  app.post('/api/deliveries/clear', (_req, res) => {
    store.clear()
    res.status(200).json({ ok: true })
  })

  app.post('/api/deliveries/:id/verify', express.json(), (req, res) => {
    const item = store.get(req.params.id)
    if (item === undefined) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    const body = req.body as Record<string, unknown>
    const secret = typeof body.secret === 'string' ? body.secret : ''
    res.status(200).json(verifyStandardSignature(secret, item.headers, item.rawBody))
  })

  app.get('/api/response-mode', (_req, res) => {
    res.status(200).json({ mode: responseMode })
  })

  app.post('/api/response-mode', express.json(), (req, res) => {
    const body = req.body as Record<string, unknown>
    const mode = body.mode
    if (mode !== 200 && mode !== 500 && mode !== 429) {
      res.status(400).json({ error: 'invalid mode' })
      return
    }
    responseMode = mode
    res.status(200).json({ mode: responseMode })
  })

  // Relays "send incoming webhook" calls to the real pod-webhook - the browser only ever talks to
  // this pod, so no CORS setup is needed and one place shows the address it is currently pointed at.
  app.post(
    '/api/send',
    express.json(),
    wrap(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const { key, keyLocation, payload } = body
      if (typeof key !== 'string' || typeof payload !== 'object' || payload === null) {
        res.status(400).json({ error: 'key and payload are required' })
        return
      }
      const url =
        keyLocation === 'path'
          ? `${config.WebhookUrl}/api/v1/webhook/k/${encodeURIComponent(key)}`
          : `${config.WebhookUrl}/api/v1/webhook/action`
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyLocation !== 'path') headers.Authorization = `Bearer ${key}`
      const upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })
      const bodyText = await upstream.text()
      res.status(200).json({ status: upstream.status, body: tryParseJson(bodyText) })
    })
  )

  app.post(
    '/api/job',
    express.json(),
    wrap(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const { key, jobId } = body
      if (typeof key !== 'string' || typeof jobId !== 'string') {
        res.status(400).json({ error: 'key and jobId are required' })
        return
      }
      const url = `${config.WebhookUrl}/api/v1/webhook/job/${encodeURIComponent(jobId)}`
      const upstream = await fetch(url, { headers: { Authorization: `Bearer ${key}` } })
      const bodyText = await upstream.text()
      res.status(200).json({ status: upstream.status, body: tryParseJson(bodyText) })
    })
  )

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' })
  })

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : 'internal_error' })
  })

  return app
}

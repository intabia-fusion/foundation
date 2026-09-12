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
import { createServer, type IncomingHttpHeaders, type Server } from 'http'
import type { AddressInfo, Socket } from 'net'

export interface CapturedRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  // Not JSON-parsed on purpose - callers need the exact bytes to verify a signature.
  body: Buffer
}

export interface QueuedResponse {
  status: number
  body?: string
  headers?: Record<string, string>
}

const DEFAULT_RESPONSE: QueuedResponse = { status: 200, body: '{}' }

// Stand-in for an external system receiving outgoing webhooks (delivery itself doesn't exist yet -
// see docs/memory/webhook_ingest_pod.md). Plain `http`, not express: no body parsing gets in the way
// of checking raw bytes.
export interface MockReceiver {
  url: string
  requests: CapturedRequest[]
  /** Responses are served in request order; once the queue is empty every request gets 200 {}. */
  queueResponses: (...responses: QueuedResponse[]) => void
  close: () => Promise<void>
}

export async function startMockReceiver (): Promise<MockReceiver> {
  const requests: CapturedRequest[] = []
  const responses: QueuedResponse[] = []
  const sockets = new Set<Socket>()

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks)
      })
      const next = responses.shift() ?? DEFAULT_RESPONSE
      for (const [name, value] of Object.entries(next.headers ?? {})) res.setHeader(name, value)
      res.statusCode = next.status
      res.end(next.body ?? '')
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    queueResponses: (...items) => {
      responses.push(...items)
    },
    close: async () => {
      // server.close() alone waits for keep-alive sockets to go idle - destroy them so jest doesn't hang.
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve()
        })
      )
    }
  }
}

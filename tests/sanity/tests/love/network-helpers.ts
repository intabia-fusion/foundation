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

import net from 'net'
import type { Page } from '@playwright/test'

const LIVEKIT_HOST = '127.0.0.1'
const LIVEKIT_PORT = 7890

export interface LiveKitProxy {
  /** ws:// URL the browser must use instead of the real LiveKit endpoint. */
  url: string
  /** Drop every live connection and refuse new ones - a hard network cut. */
  cut: () => void
  /** Accept connections again. */
  restore: () => void
  close: () => Promise<void>
}

// TCP proxy in front of the LiveKit signal port. Only signalling goes through it - media keeps
// using the RTC ports, and the reconnect logic under test hangs off the signal channel anyway.
export async function startLiveKitProxy (latency: number = 0): Promise<LiveKitProxy> {
  let cutting = false
  const sockets = new Set<net.Socket>()

  const pipe = (from: net.Socket, to: net.Socket): void => {
    from.on('data', (chunk) => {
      if (latency <= 0) {
        to.write(chunk)
        return
      }
      // Equal-delay timers fire in registration order, so chunk order holds.
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk)
      }, latency)
    })
  }

  const server = net.createServer((client) => {
    if (cutting) {
      client.destroy()
      return
    }
    const upstream = net.connect(LIVEKIT_PORT, LIVEKIT_HOST)
    sockets.add(client)
    sockets.add(upstream)

    pipe(client, upstream)
    pipe(upstream, client)

    const drop = (): void => {
      sockets.delete(client)
      sockets.delete(upstream)
      client.destroy()
      upstream.destroy()
    }
    client.on('error', drop)
    upstream.on('error', drop)
    client.on('close', drop)
    upstream.on('close', drop)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as net.AddressInfo).port

  return {
    url: `ws://localhost:${port}`,
    cut: () => {
      cutting = true
      for (const s of sockets) s.destroy()
      sockets.clear()
    },
    restore: () => {
      cutting = false
    },
    close: async () => {
      for (const s of sockets) s.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
  }
}

/** Rewrites `LIVEKIT_WS` in the front config. Must be installed before the first navigation. */
export async function routeLiveKitThroughProxy (page: Page, proxy: LiveKitProxy): Promise<void> {
  await page.route('**/config.json', async (route) => {
    const response = await route.fetch()
    const config = await response.json()
    await route.fulfill({ response, json: { ...config, LIVEKIT_WS: proxy.url } })
  })
}

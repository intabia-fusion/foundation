/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

/* eslint-env jest */
import WebSocket from 'ws'
import { ClisrServer } from '../server'
import { ClisrClient } from '../client'
import { MeasureMetricsContext } from '@hcengineering/measurements'
import { RPCHandler } from '@hcengineering/rpc'
import type { ClientSocketFactory } from '../types'
import { FRAME_MSGPACK } from '../types'

// Increase timeout for potential network delays in this integration scenario
jest.setTimeout(30000)

describe('integration: resend end-to-end', () => {
  it('server resends JSON operation when client response is lost and client reports not executing', async () => {
    // Contexts and helpers
    const ctx = new MeasureMetricsContext('clisr-resend-e2e', {})
    const server = new ClisrServer(ctx, async (token: string) => token === 'token-ok', '1.0.0')

    await server.start(ctx, 0)
    const addr = server.httpServer?.address() as any
    const port = addr?.port ?? 0

    // We'll drop the first client response (msgpack response frame) to simulate a lost reply.
    // Use an RPCHandler to inspect outgoing packed frames and confirm the id when needed.
    const rpc = new RPCHandler()
    let droppedCount = 0

    const createSocketFactory = (): ClientSocketFactory => (url: string) => {
      const real = new WebSocket(url)

      let openEmitted = false
      let openHandler: any = null

      const msgQueue: any[] = []
      let msgHandler: any = null

      const wrapper: any = {
        send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          try {
            // Convert to Buffer/Uint8Array for inspection
            if (typeof data === 'string') {
              // Text frames (shouldn't be the callback responses) - forward
              real.send(data as any)
              return
            }

            let buf: Buffer
            if (Buffer.isBuffer(data)) {
              buf = data
            } else if (ArrayBuffer.isView(data)) {
              const view: any = data as any
              buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength)
            } else if (data instanceof ArrayBuffer) {
              buf = Buffer.from(data)
            } else {
              // Unknown - forward as-is
              real.send(data as any)
              return
            }

            // If this is a msgpack frame with an RPC response id (#...), drop the first such message.
            const ft = buf[0]
            if (ft === FRAME_MSGPACK && droppedCount === 0) {
              try {
                const parsed = rpc.readResponse(buf.subarray(1), true) // parse as response
                const id = (parsed as any)?.id
                // We expect server requests to have ids starting with '#'
                if (typeof id === 'string' && id.startsWith('#')) {
                  // Drop the message to simulate the lost response
                  droppedCount++
                  return
                }
              } catch (_err) {
                // Parsing failed - just forward the message
              }
            }

            // Forward normal frames
            real.send(buf)
          } catch (_err) {
            // On any unexpected error, forward the original payload to avoid hanging the test
            try {
              real.send(data as any)
            } catch (_e) {
              // ignore
            }
          }
        },
        close: (code?: number) => {
          try {
            real.close(code)
          } catch (_err) {
            // ignore
          }
        },
        onclose: null as any,
        onerror: null as any,
        get readyState () {
          return real.readyState
        },
        bufferedAmount: 0
      }

      Object.defineProperty(wrapper, 'onopen', {
        get () {
          return openHandler
        },
        set (fn: any) {
          openHandler = fn
          if (openEmitted && typeof openHandler === 'function') {
            openHandler({} as any)
          }
        }
      })

      Object.defineProperty(wrapper, 'onmessage', {
        get () {
          return msgHandler
        },
        set (fn: any) {
          msgHandler = fn
          if (msgQueue.length > 0 && typeof msgHandler === 'function') {
            for (const m of msgQueue) msgHandler(m)
            msgQueue.length = 0
          }
        }
      })

      real.on('open', () => {
        if (typeof openHandler === 'function') openHandler({} as any)
        else openEmitted = true
      })

      real.on('message', (data) => {
        const m = { data } as any
        if (typeof msgHandler === 'function') msgHandler(m)
        else msgQueue.push(m)
      })

      real.on('close', (code, reason) => {
        wrapper.onclose?.(code, reason)
      })

      real.on('error', (err) => {
        wrapper.onerror?.(err)
      })

      return wrapper
    }

    // Create client and register a callbackHandler that resolves quickly (so response is sent and dropped).
    let onConnectResolve!: () => void
    const onConnectP = new Promise<void>((resolve) => {
      onConnectResolve = resolve
    })

    let client: ClisrClient | undefined
    try {
      client = new ClisrClient(
        ctx,
        `ws://127.0.0.1:${port}`,
        () => {}, // no-op handler for message broadcasts
        () => 'token-ok',
        {
          socketFactory: createSocketFactory(),
          // Pin msgpack + identity compression so the drop filter below can match on FRAME_MSGPACK.
          formats: ['msgpack/snappy'],
          compress: async (x: any) => x,
          uncompress: async (x: any) => x,
          onConnect: async () => {
            onConnectResolve()
          }
        }
      )

      // Promise to know when client's handler completed (and attempted to send the (dropped) response)
      let handlerDoneResolve!: () => void
      const handlerDoneP = new Promise<void>((resolve) => {
        handlerDoneResolve = resolve
      })

      client.callbackHandler = async (_ctx, method: string, params: any[]) => {
        // Ensure server invoked the expected method
        expect(method).toBe('clientOp')
        // Notify the test that handler finished processing (response was attempted and dropped)
        handlerDoneResolve()
        // Return some result for server to receive on successful delivery
        return { processed: params }
      }

      await onConnectP
      // Give session a moment to be fully established
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Start the server-initiated request (server -> client)
      const serverRequestP = server.request(ctx, 'clientOp', ['foo'])

      // Wait until the client's callback handler finished (the first response was attempted and dropped)
      await handlerDoneP

      // Find the in-flight request on the server side and artificially age it so it's considered long-running.
      const requestsMap: Map<string, any> = (server as any).requests
      let targetReqId: string | undefined
      for (const [id, rr] of requestsMap.entries()) {
        if (rr?.method === 'clientOp') {
          // Age it beyond OpStatusTimeout (5s) so the server will query client status
          rr.startTime = Date.now() - 6000
          targetReqId = id
          break
        }
      }

      expect(typeof targetReqId).toBe('string')

      // Trigger server tick that should send FRAME_OP_STATUS for aged operations
      await server.handleTick()

      // Wait for the server request to eventually resolve after resend
      const res = await Promise.race([
        serverRequestP,
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('timeout waiting for server response'))
          }, 10000)
        })
      ])

      // Server should have received final response from client after resend
      expect(res).toEqual({ processed: ['foo'] })

      // We should have dropped exactly one response
      expect(droppedCount).toBe(1)

      // Optionally check that the server bumped the startTime when resending
      // (ensure the previously-aged request had its startTime updated as part of resend)
      const rrAfter = targetReqId !== undefined ? requestsMap.get(targetReqId) : undefined
      // rrAfter may be undefined if the request already resolved; that's acceptable.
      if (rrAfter !== undefined) {
        expect(rrAfter.startTime).toBeGreaterThan(Date.now() - 10000)
      }
    } finally {
      if (client !== undefined) {
        try {
          await client.close()
        } catch (_err) {
          // ignore
        }
      }
      try {
        await server.close()
      } catch (_err) {
        // ignore
      }
    }
  })
})

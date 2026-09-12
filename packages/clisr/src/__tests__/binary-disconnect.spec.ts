/* eslint-env jest */
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

// Disconnect/recovery tests for server-initiated binary requests.
// Reproduces hangs that happen when a worker dies silently and verifies that
// round-robin retry / reconnect-resend keep tasks flowing without manual restart.
//
// To keep tests fast we shrink ping/reconnect/hang thresholds on the server instance
// instead of waiting for production-sized timeouts.

import WebSocket from 'ws'
import { ClisrServer } from '../server'
import { ClisrClient } from '../client'
import { MeasureMetricsContext } from '@hcengineering/measurements'
import type { ClientSocketFactory } from '../types'

jest.setTimeout(15000)

const createSocketFactory = (): ClientSocketFactory => (url: string) => {
  const real = new WebSocket(url)
  let openEmitted = false
  let openHandler: any = null
  const msgQueue: any[] = []
  let msgHandler: any = null

  const wrapper: any = {
    send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
      real.send(data as any)
    },
    close: (code?: number) => {
      try {
        real.close(code)
      } catch (_err) {}
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
      if (openEmitted && typeof openHandler === 'function') openHandler({} as any)
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

interface TestEnv {
  server: ClisrServer
  port: number
  ctx: MeasureMetricsContext
}

async function startServer (): Promise<TestEnv> {
  const ctx = new MeasureMetricsContext('clisr-binary-disc', {})
  const server = new ClisrServer(
    ctx,
    async (token: string) => token === 'token-ok',
    '1.0.0',
    undefined,
    async (_ctx, method, ops, session) => {
      if (method === 'transcription') {
        session.options.transcription = ops[0] as boolean
      }
      return {}
    }
  )
  // Compress test thresholds so tests finish in milliseconds, not seconds.
  server.pingTimeout = 500
  server.pingProbeAfter = 200
  server.reconnectTimeout = 200
  server.hangLogTimeout = 100
  server.hangLogInterval = 100
  server.tickIntervalMs = 50
  await server.start(ctx, 0)
  const addr = server.httpServer?.address() as any
  return { server, port: addr.port, ctx }
}

async function makeClient (
  ctx: MeasureMetricsContext,
  port: number,
  binaryHandler: (data: Uint8Array) => Promise<Uint8Array | any>,
  clientHost?: string
): Promise<ClisrClient> {
  let onConnectResolve!: () => void
  const onConnectP = new Promise<void>((resolve) => {
    onConnectResolve = resolve
  })
  const client = new ClisrClient(
    ctx,
    `ws://127.0.0.1:${port}`,
    () => {},
    () => 'token-ok',
    {
      socketFactory: createSocketFactory(),
      clientHost,
      onConnect: async () => {
        onConnectResolve()
      }
    }
  )
  client.binaryHandler = async (_c, _method, data) => await binaryHandler(data)
  await onConnectP
  await client.request('transcription', [true])
  return client
}

async function waitFor (predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

describe('binary request disconnect/recovery', () => {
  it('round-robin reroutes to a healthy client when one client silently dies', async () => {
    const { server, port, ctx } = await startServer()
    let healthyHandlerCalled = 0

    const dying = await makeClient(
      ctx,
      port,
      async (_data) => {
        // Simulate process death: close the socket and never respond.
        setTimeout(() => {
          void dying.close()
        }, 5)
        // Never resolve so the client cannot emit an error frame before close.
        return await new Promise<Uint8Array>(() => {})
      },
      'dying'
    )
    await waitFor(() => (server as any).sessions.size === 1)

    const healthy = await makeClient(
      ctx,
      port,
      async (data) => {
        healthyHandlerCalled++
        const out = new Uint8Array(data.length)
        for (let i = 0; i < data.length; i++) out[i] = (data[i] + 1) & 0xff
        return out
      },
      'healthy'
    )
    await waitFor(() => (server as any).sessions.size === 2)

    try {
      const input = new Uint8Array([10, 20, 30])
      const result = await server.binaryRequest<Uint8Array>(ctx, 'transcribe', input, undefined, () => true)
      expect(result.length).toBe(input.length)
      expect(healthyHandlerCalled).toBeGreaterThanOrEqual(1)
      // Every byte must be data[i]+1 — proves the response came from the healthy client.
      for (let i = 0; i < input.length; i++) {
        expect(result[i]).toBe((input[i] + 1) & 0xff)
      }
    } finally {
      try {
        await healthy.close()
      } catch (_e) {}
      try {
        await dying.close()
      } catch (_e) {}
      await server.close()
    }
  })

  it('binaryRequest waits when no clients are connected and resolves once one shows up', async () => {
    const { server, port, ctx } = await startServer()

    const input = new Uint8Array([1, 2, 3])
    const reqP = server.binaryRequest<Uint8Array>(ctx, 'transcribe', input, undefined, () => true)

    // Connect a client right away — binaryRequest should pick it up via round-robin.
    const client = await makeClient(
      ctx,
      port,
      async (data) => {
        const out = new Uint8Array(data.length)
        for (let i = 0; i < data.length; i++) out[i] = data[i] * 2
        return out
      },
      'late'
    )

    try {
      const result = await reqP
      expect(Array.from(result)).toEqual([2, 4, 6])
    } finally {
      try {
        await client.close()
      } catch (_e) {}
      await server.close()
    }
  })

  it('rejects pending binary request from dead session so round-robin can retry', async () => {
    const { server, port, ctx } = await startServer()

    const dying = await makeClient(
      ctx,
      port,
      async (_data) => {
        setTimeout(() => {
          void dying.close()
        }, 5)
        return await new Promise<Uint8Array>(() => {})
      },
      'first'
    )
    await waitFor(() => (server as any).sessions.size === 1)

    const second = await makeClient(
      ctx,
      port,
      async (data) => {
        const out = new Uint8Array(data.length)
        for (let i = 0; i < data.length; i++) out[i] = data[i] + 1
        return out
      },
      'second'
    )
    await waitFor(() => (server as any).sessions.size === 2)

    try {
      const result = await server.binaryRequest<Uint8Array>(
        ctx,
        'transcribe',
        new Uint8Array([5, 6]),
        undefined,
        () => true
      )
      expect(Array.from(result)).toEqual([6, 7])
      // After ReconnectTimeout the old session must be evicted and its requests cleaned.
      await waitFor(() => (server as any).reconnectQueue.size === 0, 2000)
      // No leftover pending entries from the dying client.
      const leftover = Array.from((server as any).requests.keys()).filter((k: any) => `${k}`.startsWith('#b'))
      expect(leftover).toEqual([])
    } finally {
      try {
        await second.close()
      } catch (_e) {}
      try {
        await dying.close()
      } catch (_e) {}
      await server.close()
    }
  })

  it('handleTick logs hang warning for long-running request without rejecting it', async () => {
    const { server, port, ctx } = await startServer()
    const warnings: any[] = []
    const origWarn = (server.ctx as any).warn?.bind(server.ctx)
    ;(server.ctx as any).warn = (...args: any[]) => {
      warnings.push(args)
      origWarn?.(...args)
    }

    let resolveSlow!: (data: Uint8Array) => void
    const slowP = new Promise<Uint8Array>((resolve) => {
      resolveSlow = resolve
    })
    const client = await makeClient(ctx, port, async (_data) => await slowP, 'slow-worker')
    await waitFor(() => (server as any).sessions.size === 1)

    try {
      const reqP = server.binaryRequest<Uint8Array>(ctx, 'transcribe', new Uint8Array([7]), undefined, () => true)

      // Wait for the request to be registered, then artificially backdate startTime
      // to trigger the hang log without waiting for hangLogTimeout.
      await waitFor(() => (server as any).requests.size >= 1)
      for (const [, r] of (server as any).requests) {
        r.startTime = Date.now() - (server.hangLogTimeout + 50)
      }
      // handleTick fires every tickIntervalMs (50ms). Wait for at least one cycle.
      await waitFor(() => warnings.some((w) => `${w[0]}`.includes('request running long')), 1000)

      const hangWarn = warnings.find((w) => `${w[0]}`.includes('request running long'))
      expect(hangWarn).toBeDefined()
      // Request must NOT be rejected — worker is still alive.
      resolveSlow(new Uint8Array([42]))
      const result = await reqP
      expect(Array.from(result)).toEqual([42])
    } finally {
      try {
        await client.close()
      } catch (_e) {}
      await server.close()
    }
  })

  it('detects silently-dead session via ping timeout and rejects its pending requests', async () => {
    const { server, port, ctx } = await startServer()

    const client = await makeClient(
      ctx,
      port,
      async (_data) => await new Promise<Uint8Array>(() => {}), // never resolves
      'silent'
    )
    await waitFor(() => (server as any).sessions.size === 1)

    try {
      // Track if the underlying binary promise is rejected by session timeout.
      let rejected = false
      let rejectError: string | undefined
      // Reach into the server to capture the per-session promise after it is dispatched.
      const reqP = server.binaryRequest<Uint8Array>(
        ctx,
        'transcribe',
        new Uint8Array([1]),
        undefined,
        (s) => s.clientHost === 'silent'
      )
      // Start a guard observer: when the promise rejects (round-robin retries), we
      // exit the inner round-robin via a fake healthy client matching the same filter.
      void reqP.catch(() => {})

      await waitFor(() => (server as any).requests.size >= 1)

      // Backdate lastPing AND drive handleTick directly — avoids any timer-race surprises.
      const sess = Array.from((server as any).sessions.values())[0] as any
      sess.lastPing = Date.now() - (server.pingTimeout + 100)
      await (server as any).handleTick()
      expect((server as any).sessions.size).toBe(0)
      expect((server as any).reconnectQueue.size).toBe(1)

      // Watch the inner per-session request reject. We tap into requests map BEFORE second
      // handleTick clears it.
      const innerEntry = Array.from((server as any).requests.entries()).find(([k]: any) =>
        `${k}`.startsWith('#b')
      ) as any
      expect(innerEntry).toBeDefined()
      innerEntry[1].promise.catch((e: Error) => {
        rejected = true
        rejectError = e.message
      })

      // Force reconnect window to elapse and tick again.
      const queued = Array.from((server as any).reconnectQueue.values())[0] as any
      queued.lastPing = Date.now() - (server.reconnectTimeout + 100)
      await (server as any).handleTick()
      // Allow the rejection callback to flush.
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect((server as any).reconnectQueue.size).toBe(0)
      expect(rejected).toBe(true)
      expect(rejectError ?? '').toContain('Session reconnect timeout')

      // After rejection, round-robin loops — provide a healthy client to drain the outer reqP.
      const healthy = await makeClient(
        ctx,
        port,
        async (data) => {
          const out = new Uint8Array(data.length)
          for (let i = 0; i < data.length; i++) out[i] = data[i] + 10
          return out
        },
        'silent'
      )
      try {
        const r = await reqP
        expect(Array.from(r)).toEqual([11])
      } finally {
        try {
          await healthy.close()
        } catch (_e) {}
      }
    } finally {
      try {
        await client.close()
      } catch (_e) {}
      await server.close()
    }
  })
})

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

// Tests for retry pacing behaviour added to ClisrServer.binaryRequest /
// requestWithFilter: when a downstream client keeps failing, retries must use
// exponential backoff (start 100ms, x1.5, cap 5s) instead of a fixed 100ms
// tight loop. This prevents idle CPU burn when a worker fails repeatedly.

import { ClisrServer } from '../server'
import { ClisrClient } from '../client'
import { MeasureMetricsContext } from '@hcengineering/measurements'
import { createSocketFactory } from './utils/socket-factory'

jest.setTimeout(30000)

interface TestEnv {
  server: ClisrServer
  port: number
  ctx: MeasureMetricsContext
}

async function startServer (): Promise<TestEnv> {
  const ctx = new MeasureMetricsContext('clisr-retry-backoff', {})
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
  server.pingTimeout = 5000
  server.pingProbeAfter = 2000
  server.reconnectTimeout = 1000
  server.hangLogTimeout = 60_000
  server.hangLogInterval = 60_000
  server.tickIntervalMs = 200
  await server.start(ctx, 0)
  const addr = server.httpServer?.address() as any
  return { server, port: addr.port, ctx }
}

async function makeFailingBinaryClient (
  ctx: MeasureMetricsContext,
  port: number,
  onCall: () => void,
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
  // Always fail — every binary request returns an error to the server,
  // which will then go through the retry path.
  client.binaryHandler = async (_c, _method, _data) => {
    onCall()
    throw new Error('synthetic failure')
  }
  await onConnectP
  await client.request('transcription', [true])
  return client
}

async function makeFailingJsonClient (
  ctx: MeasureMetricsContext,
  port: number,
  onCall: () => void,
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
  client.callbackHandler = async (_c, _method, _params) => {
    onCall()
    throw new Error('synthetic failure')
  }
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

describe('binaryRequest retry backoff', () => {
  it('throttles retries with exponential backoff when client keeps failing', async () => {
    const { server, port, ctx } = await startServer()
    const callTimes: number[] = []

    const client = await makeFailingBinaryClient(
      ctx,
      port,
      () => {
        callTimes.push(Date.now())
      },
      'failing'
    )
    await waitFor(() => (server as any).sessions.size === 1)

    // Fire one binaryRequest that will retry forever (every attempt fails).
    const reqP = server.binaryRequest<Uint8Array>(ctx, 'transcribe', new Uint8Array([1]), undefined, () => true)
    // Mark as caught so an unhandled rejection doesn't blow up the test
    // when we close the server while the request is still pending.
    reqP.catch(() => {})

    // Sample ~2 seconds: with the old 100ms tight loop we'd see ~20 attempts.
    // With backoff (100, 150, 225, 337, 506, 759, 1138, 1707, ...) we should
    // see far fewer in 2s — and successive gaps must grow.
    await new Promise((resolve) => setTimeout(resolve, 2200))

    try {
      // Drop the noisy "before" attempt — sometimes the first call lands a hair
      // before the very first retry timer fires. We only care about gap growth.
      expect(callTimes.length).toBeGreaterThanOrEqual(4)
      // Tight loop would have produced ~22 calls. Backoff must keep this much lower.
      expect(callTimes.length).toBeLessThan(12)

      // Verify gaps grow: late gap should be at least ~1.5x an early gap.
      const gaps: number[] = []
      for (let i = 1; i < callTimes.length; i++) gaps.push(callTimes[i] - callTimes[i - 1])
      const earlyGap = gaps[0]
      const lateGap = gaps[gaps.length - 1]
      expect(lateGap).toBeGreaterThan(earlyGap * 1.3)
    } finally {
      try {
        await client.close()
      } catch (_e) {}
      await server.close()
    }
  })

  it('caps backoff at the configured ceiling — gap between attempts never exceeds the cap', async () => {
    const { server, port, ctx } = await startServer()
    // Shrink backoff so the test reaches the cap in ~1.5s instead of ~12s.
    server.retryBackoffStartMs = 50
    server.retryBackoffMaxMs = 500
    server.retryBackoffFactor = 1.5
    const callTimes: number[] = []

    const client = await makeFailingBinaryClient(
      ctx,
      port,
      () => {
        callTimes.push(Date.now())
      },
      'failing-cap'
    )
    await waitFor(() => (server as any).sessions.size === 1)

    const reqP = server.binaryRequest<Uint8Array>(ctx, 'transcribe', new Uint8Array([1]), undefined, () => true)
    reqP.catch(() => {})

    // 50,75,112,168,253,379,500,500,... — cap reached after ~1.5s. Sample ~3s
    // so we see several capped gaps.
    await new Promise((resolve) => setTimeout(resolve, 3000))

    try {
      expect(callTimes.length).toBeGreaterThan(5)
      const gaps: number[] = []
      for (let i = 1; i < callTimes.length; i++) gaps.push(callTimes[i] - callTimes[i - 1])
      // Allow 20% slack on the cap for timer jitter.
      for (const g of gaps) {
        expect(g).toBeLessThan(600)
      }
      // At least one of the late gaps should be near the cap (>300ms).
      const maxGap = Math.max(...gaps)
      expect(maxGap).toBeGreaterThan(300)
    } finally {
      try {
        await client.close()
      } catch (_e) {}
      await server.close()
    }
  })

  it('backs off when no clients are connected', async () => {
    const { server, ctx } = await startServer()

    const start = Date.now()
    const reqP = server.binaryRequest<Uint8Array>(ctx, 'transcribe', new Uint8Array([1]), undefined, () => true)
    reqP.catch(() => {})

    // After ~1.5s, the request must still be pending (no sessions, just waiting).
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const elapsed = Date.now() - start
    // Allow timer jitter (Node setTimeout can fire a few ms early).
    expect(elapsed).toBeGreaterThanOrEqual(1490)

    await server.close()
    await reqP.catch(() => {})
  })
})

describe('close() rejects pending requests', () => {
  it('binaryRequest pending against a failing client rejects with SERVER_CLOSED on close()', async () => {
    const { server, port, ctx } = await startServer()
    const client = await makeFailingBinaryClient(ctx, port, () => {}, 'failing-close')
    await waitFor(() => (server as any).sessions.size === 1)

    const reqP = server.binaryRequest<Uint8Array>(ctx, 'transcribe', new Uint8Array([1]), undefined, () => true)
    // Let it spin through at least one failed attempt so a sendRequest promise is in-flight.
    await new Promise((resolve) => setTimeout(resolve, 250))

    await server.close()

    await expect(reqP).rejects.toMatchObject({ code: 'SERVER_CLOSED' })
    try {
      await client.close()
    } catch (_e) {}
  })

  it('binaryRequest waiting for sessions rejects with SERVER_CLOSED on close()', async () => {
    const { server, ctx } = await startServer()
    // No client connected — request sits in the wait-for-session loop.
    const reqP = server.binaryRequest<Uint8Array>(ctx, 'transcribe', new Uint8Array([1]), undefined, () => true)
    await new Promise((resolve) => setTimeout(resolve, 150))

    await server.close()

    await expect(reqP).rejects.toMatchObject({ code: 'SERVER_CLOSED' })
  })

  it('requestWithFilter pending against a failing client rejects with SERVER_CLOSED on close()', async () => {
    const { server, port, ctx } = await startServer()
    const client = await makeFailingJsonClient(ctx, port, () => {}, 'json-failing-close')
    await waitFor(() => (server as any).sessions.size === 1)

    const reqP = server.requestWithFilter(ctx, 'doStuff', [], () => true)
    await new Promise((resolve) => setTimeout(resolve, 250))

    await server.close()

    await expect(reqP).rejects.toMatchObject({ code: 'SERVER_CLOSED' })
    try {
      await client.close()
    } catch (_e) {}
  })
})

describe('requestWithFilter retry backoff', () => {
  it('throttles retries with exponential backoff for JSON requests', async () => {
    const { server, port, ctx } = await startServer()
    const callTimes: number[] = []

    const client = await makeFailingJsonClient(
      ctx,
      port,
      () => {
        callTimes.push(Date.now())
      },
      'json-failing'
    )
    await waitFor(() => (server as any).sessions.size === 1)

    const reqP = server.requestWithFilter(ctx, 'doStuff', [], () => true)
    reqP.catch(() => {})

    await new Promise((resolve) => setTimeout(resolve, 2200))

    try {
      expect(callTimes.length).toBeGreaterThanOrEqual(4)
      expect(callTimes.length).toBeLessThan(12)

      const gaps: number[] = []
      for (let i = 1; i < callTimes.length; i++) gaps.push(callTimes[i] - callTimes[i - 1])
      const earlyGap = gaps[0]
      const lateGap = gaps[gaps.length - 1]
      expect(lateGap).toBeGreaterThan(earlyGap * 1.3)
    } finally {
      try {
        await client.close()
      } catch (_e) {}
      await server.close()
    }
  })
})

/* eslint-env jest */
// Dispatch capacity: a worker declares `options.capacity` and the router hands it that many
// requests at once, so the next one is already there while the current one runs.

import { MeasureMetricsContext } from '@hcengineering/measurements'
import { ClisrClient } from '../client'
import { ClisrServer } from '../server'
import type { Session } from '../types'
import { createSocketFactory } from './utils/socket-factory'

jest.setTimeout(30000)

const ctx = new MeasureMetricsContext('capacity', {})

const fakeSession = (inflight: number, capacity?: number): Session =>
  ({
    sessionId: `s${inflight}`,
    requests: new Map(Array.from({ length: inflight }, (_, i) => [String(i), {}])),
    options: capacity === undefined ? {} : { capacity }
  }) as unknown as Session

describe('pickSession', () => {
  const server = new ClisrServer(ctx, async () => true, '1.0.0')

  it('prefers the least loaded client', () => {
    const idle = fakeSession(0)
    const picked = server.pickSession([fakeSession(3), idle, fakeSession(1)])
    expect(picked).toBe(idle)
  })

  it('round-robins between equally loaded clients', () => {
    const a = fakeSession(1)
    const b = fakeSession(1)
    const picks = [server.pickSession([a, b]), server.pickSession([a, b]), server.pickSession([a, b])]
    expect(new Set(picks).size).toBe(2)
    expect(picks[0]).toBe(picks[2])
  })

  it('skips a client that is already at capacity', () => {
    const full = fakeSession(2, 2)
    const free = fakeSession(5)
    expect(server.pickSession([full, free])).toBe(free)
  })

  it('reports no client when every one is full', () => {
    expect(server.pickSession([fakeSession(2, 2), fakeSession(1, 1)])).toBeUndefined()
  })

  it('never blocks a client that declared no capacity', () => {
    expect(server.pickSession([fakeSession(100)])).not.toBeUndefined()
  })
})

interface Harness {
  server: ClisrServer
  clients: ClisrClient[]
  close: () => Promise<void>
}

/** Starts a server plus `capacities.length` clients, each registered with its own capacity. */
async function startHarness (
  capacities: number[],
  handler: (clientIndex: number, data: Uint8Array) => Promise<any>
): Promise<Harness> {
  const server = new ClisrServer(
    ctx,
    async (token: string) => token === 'token-ok',
    '1.0.0',
    undefined,
    async (_c, method, params, session) => {
      // 0 stands for "declares nothing", the pre-capacity client.
      if (method === 'register' && params[0] > 0) {
        session.options.capacity = params[0]
      }
      return {}
    }
  )
  await server.start(ctx, 0)
  const port = (server.httpServer?.address() as any)?.port

  const clients: ClisrClient[] = []
  for (let i = 0; i < capacities.length; i++) {
    const client = new ClisrClient(
      ctx,
      `ws://127.0.0.1:${port}`,
      () => {},
      () => 'token-ok',
      {
        socketFactory: createSocketFactory(),
        useGlobalRPCHandler: false
      }
    )
    client.binaryHandler = async (_ctx, _method, data) => await handler(i, data)
    await client.request('register', [capacities[i]])
    clients.push(client)
  }

  return {
    server,
    clients,
    close: async () => {
      for (const c of clients) {
        await c.close()
      }
      await server.close()
    }
  }
}

describe('integration: in-flight depth', () => {
  it('keeps exactly `capacity` chunks on a worker at once', async () => {
    let active = 0
    let peak = 0
    const h = await startHarness([2], async (_i, data) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 50))
      active--
      return { n: data[0] }
    })

    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => h.server.binaryRequest(ctx, 'transcribe', new Uint8Array([i])))
      )
      expect(results.map((r: any) => r.n)).toEqual([0, 1, 2, 3, 4, 5])
      // Exactly 2: one chunk running while the next is already on the worker.
      expect(peak).toBe(2)
    } finally {
      await h.close()
    }
  })

  it('spreads work over workers instead of piling onto one', async () => {
    const handled = [0, 0]
    const h = await startHarness([2, 2], async (i) => {
      handled[i]++
      await new Promise((resolve) => setTimeout(resolve, 50))
      return {}
    })

    try {
      await Promise.all(Array.from({ length: 4 }, () => h.server.binaryRequest(ctx, 'transcribe', new Uint8Array([1]))))
      expect(handled).toEqual([2, 2])
    } finally {
      await h.close()
    }
  })

  it('leaves dispatch unbounded when no capacity is declared', async () => {
    let peak = 0
    let active = 0
    const h = await startHarness([0], async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 50))
      active--
      return {}
    })

    try {
      await Promise.all(Array.from({ length: 5 }, () => h.server.binaryRequest(ctx, 'transcribe', new Uint8Array([1]))))
      expect(peak).toBe(5)
    } finally {
      await h.close()
    }
  })
})

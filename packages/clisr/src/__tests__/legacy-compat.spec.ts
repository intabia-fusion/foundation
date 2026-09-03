/* eslint-env jest */
// Old peers against new ones. Skipped until the pre-negotiation sources are materialised
// (`legacy/` is gitignored), which pins the check to a revision instead of vendoring it:
//
//   REV=<commit before negotiation>; mkdir -p src/__tests__/legacy
//   for f in client server types frame-utils tmgr index; do
//     git show $REV:packages/clisr/src/$f.ts > src/__tests__/legacy/$f.ts; done

import { MeasureMetricsContext } from '@hcengineering/measurements'
import { existsSync } from 'fs'
import { join } from 'path'
import { ClisrClient } from '../client'
import { ClisrServer } from '../server'
import { FRAME_DATA, FRAME_MSGPACK, FRAME_MSGPACK_SNAPPY } from '../types'
import { createSocketFactory } from './utils/socket-factory'

jest.setTimeout(30000)

const d = existsSync(join(__dirname, 'legacy', 'client.ts')) ? describe : describe.skip
let OldClient: typeof ClisrClient
let OldServer: typeof ClisrServer

const ctx = new MeasureMetricsContext('legacy-compat', {})
const echo = async (_ctx: any, _method: string, params: any[]): Promise<any> => ({ echo: params[0] })

const frameNames = (frames: number[]): Set<string> =>
  new Set(
    frames
      .filter((f) => f === FRAME_DATA || f === FRAME_MSGPACK || f === FRAME_MSGPACK_SNAPPY)
      .map((f) => (f === FRAME_DATA ? 'data' : 'msgpack'))
  )

d('old peer against new peer', () => {
  beforeAll(() => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    OldClient = require('./legacy/client').ClisrClient
    OldServer = require('./legacy/server').ClisrServer
    /* eslint-enable @typescript-eslint/no-var-requires */
  })

  it('old client -> new server stays on msgpack and works', async () => {
    const server = new ClisrServer(ctx, async (t: string) => t === 'ok', '1.0.0', undefined, echo)
    await server.start(ctx, 0)
    const port = (server.httpServer?.address() as any)?.port

    const sent: number[] = []
    const received: number[] = []
    const client = new OldClient(
      ctx,
      `ws://127.0.0.1:${port}`,
      () => {},
      () => 'ok',
      {
        useGlobalRPCHandler: false,
        socketFactory: createSocketFactory({ sent: (f) => sent.push(f[0]), received: (f) => received.push(f[0]) })
      } as any
    )

    try {
      expect(await client.request('echo', ['from-old'])).toEqual({ echo: 'from-old' })
      // Big payload too, so the compressed frame code is exercised as well.
      expect(await client.request('echo', ['x'.repeat(4096)])).toEqual({ echo: 'x'.repeat(4096) })
      expect(frameNames(sent)).toEqual(new Set(['msgpack']))
      expect(frameNames(received)).toEqual(new Set(['msgpack']))
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('new client -> old server falls back to msgpack and works', async () => {
    const server = new OldServer(ctx, async (t: string) => t === 'ok', '1.0.0', undefined, echo)
    await server.start(ctx, 0)
    const port = (server.httpServer?.address() as any)?.port

    const sent: number[] = []
    const received: number[] = []
    // Default formats ask for json/snappy first; the old server cannot answer that.
    const client = new ClisrClient(
      ctx,
      `ws://127.0.0.1:${port}`,
      () => {},
      () => 'ok',
      {
        useGlobalRPCHandler: false,
        socketFactory: createSocketFactory({ sent: (f) => sent.push(f[0]), received: (f) => received.push(f[0]) })
      }
    )

    try {
      expect(await client.request('echo', ['from-new'])).toEqual({ echo: 'from-new' })
      expect(await client.request('echo', ['x'.repeat(4096)])).toEqual({ echo: 'x'.repeat(4096) })
      expect((client as any).format).toEqual({ codec: 'msgpack', compression: 'snappy' })
      expect(frameNames(sent)).toEqual(new Set(['msgpack']))
      expect(frameNames(received)).toEqual(new Set(['msgpack']))
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('old client and new client share one new server', async () => {
    const server = new ClisrServer(ctx, async (t: string) => t === 'ok', '1.0.0', undefined, echo)
    await server.start(ctx, 0)
    const port = (server.httpServer?.address() as any)?.port

    const oldSent: number[] = []
    const newSent: number[] = []
    const oldClient = new OldClient(
      ctx,
      `ws://127.0.0.1:${port}`,
      () => {},
      () => 'ok',
      {
        useGlobalRPCHandler: false,
        socketFactory: createSocketFactory({ sent: (f) => oldSent.push(f[0]) })
      } as any
    )
    const newClient = new ClisrClient(
      ctx,
      `ws://127.0.0.1:${port}`,
      () => {},
      () => 'ok',
      {
        useGlobalRPCHandler: false,
        socketFactory: createSocketFactory({ sent: (f) => newSent.push(f[0]) })
      }
    )

    try {
      const [a, b] = await Promise.all([oldClient.request('echo', ['old']), newClient.request('echo', ['new'])])
      expect(a).toEqual({ echo: 'old' })
      expect(b).toEqual({ echo: 'new' })
      // Same server, one connection on msgpack and one on JSON at the same time.
      expect(frameNames(oldSent)).toEqual(new Set(['msgpack']))
      expect(frameNames(newSent)).toEqual(new Set(['data']))
    } finally {
      await oldClient.close()
      await newClient.close()
      await server.close()
    }
  })

  it('old client binary request through a new server', async () => {
    const server = new ClisrServer(ctx, async (t: string) => t === 'ok', '1.0.0')
    server.binaryHandler = async (_s, _m, data) => ({ size: data.length })
    await server.start(ctx, 0)
    const port = (server.httpServer?.address() as any)?.port

    const client = new OldClient(
      ctx,
      `ws://127.0.0.1:${port}`,
      () => {},
      () => 'ok',
      {
        useGlobalRPCHandler: false,
        socketFactory: createSocketFactory()
      } as any
    )

    try {
      // JSON result travels back as a `##` callback, the path that broke on the undefined/null flip.
      expect(await client.binaryRequest('process', new Uint8Array(10))).toEqual({ size: 10 })
    } finally {
      await client.close()
      await server.close()
    }
  })
})

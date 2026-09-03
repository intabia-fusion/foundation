/* eslint-env jest */
// Wire format negotiation: the client offers formats, the server picks one. Pins both halves -
// the frame a sender emits, and what a hello exchange agrees on.

import { MeasureMetricsContext } from '@hcengineering/measurements'
import { RPCHandler, type Request, type Response } from '@hcengineering/rpc'
import { ClisrClient } from '../client'
import { decodeFrameBody, handleFrame, sendFrame } from '../frame-utils'
import { ClisrServer } from '../server'
import {
  FRAME_DATA,
  FRAME_MSGPACK,
  FRAME_MSGPACK_SNAPPY,
  dataFrameType,
  formatId,
  legacyWireFormat,
  negotiateFormat,
  parseFormatId,
  readDataFrame,
  wireCodecs,
  type ConnectionSocket,
  type HelloRequest,
  type HelloResponse,
  type Session,
  type WireFormat
} from '../types'
import { createSocketFactory } from './utils/socket-factory'

jest.setTimeout(30000)

const ctx = new MeasureMetricsContext('wire-format', {})

// Opaque codec: the frame says whether a body is compressed, not what compressed it.
const identity = async (input: any): Promise<any> => input

const fmt = (id: string): WireFormat => {
  const parsed = parseFormatId(id)
  if (parsed === undefined) throw new Error(`unknown format ${id}`)
  return parsed
}

const capture = async (msg: Request<any> | Response<any>, format: WireFormat): Promise<Uint8Array> => {
  let out: Uint8Array | undefined
  await sendFrame(
    ctx,
    (data) => {
      out = data
    },
    msg,
    identity,
    format
  )
  if (out === undefined) throw new Error('frame was not sent')
  return out
}

describe('format ids', () => {
  it('round-trips through its token', () => {
    expect(formatId({ codec: 'json', compression: 'snappy' })).toBe('json/snappy')
    expect(formatId({ codec: 'msgpack', compression: 'none' })).toBe('msgpack')
    expect(parseFormatId('json/snappy')).toEqual({ codec: 'json', compression: 'snappy' })
    expect(parseFormatId('msgpack')).toEqual({ codec: 'msgpack', compression: 'none' })
  })

  it('rejects a codec or a compression this build cannot speak', () => {
    expect(parseFormatId('cbor/snappy')).toBeUndefined()
    expect(parseFormatId('json/brotli')).toBeUndefined()
  })

  it('rejects an id with extra segments instead of silently taking the first two', () => {
    expect(parseFormatId('json/snappy/extra')).toBeUndefined()
    expect(negotiateFormat(['json/snappy/extra'])).toEqual(legacyWireFormat)
  })

  it('does not resolve prototype keys as codecs', () => {
    // The id comes from the peer's hello; `wireCodecs.constructor` must not look like a codec.
    for (const id of ['constructor', 'toString', '__proto__', 'valueOf']) {
      expect(parseFormatId(id)).toBeUndefined()
    }
    expect(negotiateFormat(['constructor'])).toEqual(legacyWireFormat)
  })
})

describe('negotiateFormat', () => {
  it('takes the first offer it can speak', () => {
    expect(negotiateFormat(['cbor/gzip', 'json/snappy', 'msgpack'])).toEqual({
      codec: 'json',
      compression: 'snappy'
    })
  })

  it('falls back to msgpack when nothing is offered', () => {
    expect(negotiateFormat(undefined)).toEqual(legacyWireFormat)
    expect(negotiateFormat([])).toEqual(legacyWireFormat)
  })

  it('falls back to msgpack when no offer is supported', () => {
    expect(negotiateFormat(['cbor', 'protobuf/gzip'])).toEqual(legacyWireFormat)
  })
})

describe('frame selection', () => {
  it('keeps the legacy codes for msgpack', () => {
    expect(dataFrameType(fmt('msgpack'), false)).toBe(FRAME_MSGPACK)
    expect(dataFrameType(fmt('msgpack/snappy'), true)).toBe(FRAME_MSGPACK_SNAPPY)
  })

  it('puts every other codec on FRAME_DATA', () => {
    expect(dataFrameType(fmt('json'), false)).toBe(FRAME_DATA)
    expect(dataFrameType(fmt('json/snappy'), true)).toBe(FRAME_DATA)
  })

  it('reads the codec of a FRAME_DATA frame from the connection format', () => {
    const frame = new Uint8Array([FRAME_DATA, 1, 0x7b, 0x7d])
    expect(readDataFrame(frame, fmt('json/snappy'))).toEqual({
      codec: 'json',
      compressed: true,
      body: frame.subarray(2)
    })
  })

  it('reads a msgpack frame regardless of what the connection agreed on', () => {
    const frame = new Uint8Array([FRAME_MSGPACK, 0x80])
    expect(readDataFrame(frame, fmt('json'))?.codec).toBe('msgpack')
  })

  it('ignores a frame that carries no data', () => {
    expect(readDataFrame(new Uint8Array([0]), legacyWireFormat)).toBeUndefined()
  })
})

describe('sendFrame', () => {
  it('defaults to msgpack when no format is given', async () => {
    let out: Uint8Array | undefined
    await sendFrame(
      ctx,
      (data) => {
        out = data
      },
      { method: 'ping', params: [] },
      identity
    )
    expect(out?.[0]).toBe(FRAME_MSGPACK)
  })

  it('emits a JSON body that is parseable as text', async () => {
    const frame = await capture({ method: 'echo', params: ['hi'] }, fmt('json'))
    expect(frame[0]).toBe(FRAME_DATA)
    expect(frame[1]).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(2)))).toEqual({ method: 'echo', params: ['hi'] })
  })

  it('compresses only above the 1024 byte threshold', async () => {
    const small = await capture({ method: 'm', params: ['x'] }, fmt('json/snappy'))
    const large = await capture({ method: 'm', params: ['x'.repeat(4096)] }, fmt('json/snappy'))
    expect(small[1]).toBe(0)
    expect(large[1]).toBe(1)
  })

  it('never compresses when the format asks for no compression', async () => {
    const frame = await capture({ method: 'm', params: ['x'.repeat(4096)] }, fmt('json'))
    expect(frame[1]).toBe(0)
  })

  it('refuses a codec this build cannot speak', async () => {
    await expect(capture({ method: 'm', params: [] }, { codec: 'cbor', compression: 'none' })).rejects.toThrow(
      'unsupported wire codec: cbor'
    )
  })
})

describe('round trip', () => {
  const msg: Response<any> = { id: '_1', result: { text: 'привет', nested: [1, 2, { a: true }] } }

  for (const id of ['msgpack', 'msgpack/snappy', 'json', 'json/snappy']) {
    it(`survives ${id}`, async () => {
      // Above the threshold so the compressed variants take the compressed branch.
      const payload: Response<any> = { ...msg, result: { ...msg.result, pad: 'y'.repeat(2048) } }
      const format = fmt(id)
      const frame = await capture(payload, format)
      const received: Response<any>[] = []
      await handleFrame(
        ctx,
        frame,
        async (resp) => {
          received.push(resp)
        },
        async () => {},
        identity,
        format
      )
      expect(received).toHaveLength(1)
      expect(received[0].result).toEqual(payload.result)
    })
  }

  it('decodes a JSON body that a plain toString would mangle', async () => {
    // readResponse calls toString() on what it gets; a raw Uint8Array stringifies to
    // comma-separated byte values, so the json codec has to hand it text.
    const frame = await capture({ id: 1, result: { v: 'ok' } }, fmt('json'))
    const decoded = await decodeFrameBody(new RPCHandler(), frame.subarray(2), 'json', false, identity)
    expect(decoded.result).toEqual({ v: 'ok' })
  })
})

describe('hello negotiation', () => {
  const fakeSocket = (): ConnectionSocket => {
    const sent: Uint8Array[] = []
    return {
      id: 'cs',
      isClosed: false,
      close: () => {},
      send: async () => {},
      sendRaw: async (_ctx, buf) => {
        sent.push(new Uint8Array(buf))
      },
      sendPong: () => {},
      data: () => ({ sent }),
      readRequest: () => ({ method: '', params: [] }),
      isBackpressure: () => false,
      backpressure: async () => {},
      checkState: () => true,
      format: { ...legacyWireFormat }
    }
  }

  const helloWith = async (
    hello: Partial<HelloRequest>
  ): Promise<{ cs: ConnectionSocket, resp: HelloResponse, raw: Uint8Array }> => {
    const server = new ClisrServer(ctx, async () => true, '1.0.0')
    const cs = fakeSocket()
    const session = { sid: 's', sessionId: 's', socket: cs, requests: new Map(), options: {} } as unknown as Session
    const req: HelloRequest = { method: 'hello', params: [], token: 't', ...hello }
    await server.checkHello(session, req, cs)
    const raw: Uint8Array = (cs.data() as any).sent[0]
    const codec = cs.format.codec === 'msgpack' ? wireCodecs.msgpack : wireCodecs.json
    return { cs, resp: codec.decodeResponse(new RPCHandler(), raw.subarray(1)) as HelloResponse, raw }
  }

  it('picks the client first offer it can speak', async () => {
    const { cs, resp } = await helloWith({ formats: ['cbor', 'json/snappy', 'msgpack'] })
    expect(cs.format).toEqual({ codec: 'json', compression: 'snappy' })
    expect(resp.format).toBe('json/snappy')
  })

  it('keeps msgpack for a client that predates negotiation', async () => {
    const { cs, resp } = await helloWith({})
    expect(cs.format).toEqual(legacyWireFormat)
    expect(resp.format).toBe('msgpack/snappy')
  })

  it('answers a JSON client in JSON, so it never has to read msgpack', async () => {
    const { raw } = await helloWith({ formats: ['json'] })
    expect(JSON.parse(new TextDecoder().decode(raw.subarray(1))).format).toBe('json')
  })

  it('leaves the client on msgpack when the server answers without a format', () => {
    const client = new ClisrClient(
      ctx,
      'ws://unused',
      () => {},
      () => 'token',
      { autoStart: false }
    )
    // A server that predates negotiation echoes no `format` field.
    const resp: HelloResponse = { serverVersion: '1.0.0', sessionId: 's', result: 'hello' }
    client.handleHello(1, resp)
    expect((client as any).format).toEqual(legacyWireFormat)
    void client.close()
  })

  it('leaves the client on msgpack when the server names a format it cannot speak', () => {
    const client = new ClisrClient(
      ctx,
      'ws://unused',
      () => {},
      () => 'token',
      { autoStart: false }
    )
    const resp: HelloResponse = { serverVersion: '1.0.0', sessionId: 's', result: 'hello', format: 'cbor/gzip' }
    client.handleHello(1, resp)
    expect((client as any).format).toEqual(legacyWireFormat)
    void client.close()
  })
})

describe('integration: negotiated JSON over a real socket', () => {
  it('carries requests both ways without a single msgpack data frame', async () => {
    const server = new ClisrServer(
      ctx,
      async (token: string) => token === 'token-ok',
      '1.0.0',
      undefined,
      async (_ctx: any, _method: string, params: any[]) => ({ echo: params[0] })
    )
    await server.start(ctx, 0)
    const port = (server.httpServer?.address() as any)?.port

    const sent: number[] = []
    const received: number[] = []
    const client = new ClisrClient(
      ctx,
      `ws://localhost:${port}`,
      () => {},
      () => 'token-ok',
      {
        formats: ['json'],
        useGlobalRPCHandler: false,
        socketFactory: createSocketFactory({
          sent: (f) => sent.push(f[0]),
          received: (f) => received.push(f[0])
        })
      }
    )

    try {
      expect(await client.request('echo', ['payload'])).toEqual({ echo: 'payload' })

      expect(sent).toContain(FRAME_DATA)
      expect(received).toContain(FRAME_DATA)
      // Hello stays msgpack in both directions; no data frame does.
      expect(sent.filter((f) => f === FRAME_MSGPACK || f === FRAME_MSGPACK_SNAPPY)).toHaveLength(0)
      expect(received.filter((f) => f === FRAME_MSGPACK || f === FRAME_MSGPACK_SNAPPY)).toHaveLength(0)
    } finally {
      await client.close()
      await server.close()
    }
  })
})

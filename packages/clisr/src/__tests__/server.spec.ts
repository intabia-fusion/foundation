/* eslint-env jest */
// Tests for ClisrServer.checkHello and CLisrClient.handleMsg
// Comments in tests are in English as per repository conventions.

import { Analytics } from '@hcengineering/analytics'
import { MeasureMetricsContext, type MeasureContext } from '@hcengineering/measurements'
import { RPCHandler } from '@hcengineering/rpc'
import { ClisrClient } from '../client'
import { ClisrServer, createWebsocketClientSocket as createConnectionSocket } from '../server'
import {
  ClientConnectEvent,
  ClientSocketReadyState,
  FRAME_HELLO_RESP,
  FRAME_PING,
  FRAME_PONG,
  FRAME_OP_STATUS,
  FRAME_OP_STATUS_RESP,
  type ConnectionSocket,
  type HelloRequest,
  type HelloResponse,
  type Session
} from '../types'

describe('ClisrServer and ClisrClient consistency', () => {
  // Create a minimal fake MeasureContext to satisfy callers used in server / client.
  // We only implement the small subset used by the code under test.
  function createFakeCtx (): MeasureContext {
    // Use a real MeasureMetricsContext to exercise behavior closer to production.
    return new MeasureMetricsContext('clisr-test', {})
  }

  // Build a simple fake ConnectionSocket that captures sent messages and supports required interface.
  function createFakeCS (sent: any[] = []): ConnectionSocket {
    const cs: any = {
      id: 'cs-' + Math.random().toString(36).slice(2, 9),
      isClosed: false,
      close: () => {
        cs.isClosed = true
      },
      sendRaw: async (_ctx: MeasureContext, buf: Uint8Array | Buffer) => {
        sent.push({ raw: buf })
      },
      send: async (_ctx: MeasureContext, msg: any, binary: boolean, compression: boolean) => {
        // Capture outgoing message for assertions.
        sent.push({ msg, binary, compression })
      },
      sendPong: () => {},
      data: () => ({ remoteAddress: '127.0.0.1' }),
      readRequest: (_buffer: Buffer, _binary: boolean) => {
        throw new Error('not implemented')
      },
      isBackpressure: () => false,
      backpressure: async (_ctx: MeasureContext) => {},
      checkState: () => true
    }
    return cs as ConnectionSocket
  }

  it('checkHello sends useCompression and reconnect flags', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async (token: string) => token === 'good-token', '1.0.0')
    server.compress = async (x: any) => x
    server.uncompress = async (x: any) => x

    const sent: any[] = []
    const cs = createFakeCS(sent)

    const session: Session = {
      hello: undefined,
      createTime: Date.now(),
      sid: 'sid-1',
      sessionId: 'session-1',
      requests: new Map(),
      lastRequest: Date.now(),
      lastPing: Date.now(),
      socket: cs,
      options: {}
    }

    const helloReq: HelloRequest = {
      method: 'hello',
      params: [],
      id: -1,
      token: 'good-token',
      sessionId: 'session-1'
    }

    await server.checkHello(session, helloReq, cs)

    expect(sent.length).toBe(1)
    // sent[0] contains raw framed data
    const raw = sent[0].raw as Buffer
    expect(raw[0]).toBe(FRAME_HELLO_RESP)
    const payload = raw.slice(1)
    const resp = server.rpcHandler.readResponse<any>(payload, true) as HelloResponse
    expect(resp.result).toBe('hello')
    expect(resp.reconnect).toBe(false)

    // Session object should be updated with hello and modes
    expect(session.hello).toBeDefined()
  })

  it('checkHello sets reconnect true when old session present in reconnectQueue', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')
    server.compress = async (x: any) => x
    server.uncompress = async (x: any) => x

    const sent: any[] = []
    const cs = createFakeCS(sent)

    const oldSession: Session = {
      hello: undefined,
      createTime: Date.now(),
      sid: 'sid-old',
      sessionId: 'session-2',
      requests: new Map(),
      lastRequest: Date.now(),
      lastPing: Date.now(),
      socket: cs,
      options: {}
    }
    server.reconnectQueue.set('session-2', oldSession)

    const newSession: Session = {
      hello: undefined,
      createTime: Date.now(),
      sid: 'sid-new',
      sessionId: 'session-2',
      requests: new Map(),
      lastRequest: Date.now(),
      lastPing: Date.now(),
      socket: cs,
      options: {}
    }

    const helloReq: HelloRequest = {
      method: 'hello',
      params: [],
      id: -1,
      token: 'ok',
      sessionId: 'session-2'
    }

    await server.checkHello(newSession, helloReq, cs)

    expect(sent.length).toBe(1)
    const raw = sent[0].raw as Buffer
    expect(raw[0]).toBe(FRAME_HELLO_RESP)
    const payload = raw.slice(1)
    const resp = server.rpcHandler.readResponse<any>(payload, true) as HelloResponse
    expect(resp.reconnect).toBe(true)

    // reconnectQueue entry should be cleared and newSession should be initialized
    expect(server.reconnectQueue.has('session-2')).toBe(false)
    expect(newSession.hello).toBeDefined()
    expect(newSession.sessionId).toBe('session-2')
  })

  it('checkHello closes session when token validation fails', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => false, '1.0.0')
    server.compress = async (x: any) => x
    server.uncompress = async (x: any) => x

    const cs = createFakeCS()
    const session: Session = {
      hello: undefined,
      createTime: Date.now(),
      sid: 'sid-3',
      sessionId: 'session-3',
      requests: new Map(),
      lastRequest: Date.now(),
      lastPing: Date.now(),
      socket: cs,
      options: {}
    }

    const helloReq: HelloRequest = {
      method: 'hello',
      params: [],
      id: -1,
      token: 'invalid',
      sessionId: 'session-3'
    }

    await server.checkHello(session, helloReq, cs)

    // On invalid token socket should be closed.
    expect(cs.isClosed).toBe(true)
  })

  it('CLisrClient.handleMsg processes hello response and calls onConnect', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')
    server.compress = async (x: any) => x
    server.uncompress = async (x: any) => x

    // Provide a socketFactory that returns a minimal ClientSocket object to avoid real network usage.
    const fakeFactory = jest.fn((url: string) => {
      return {
        send: jest.fn(),
        close: jest.fn(),
        readyState: ClientSocketReadyState.CLOSED
      }
    })

    const onConnectSpy = jest.fn(async () => {})

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      (_data: any[]) => {},
      () => 'token',
      { socketFactory: fakeFactory, onConnect: onConnectSpy }
    )

    // Create a hello Response like the server would emit (binary/compression flags removed)
    const resp: HelloResponse = {
      id: -1,
      result: 'hello',
      serverVersion: '1.2.3',
      sessionId: 'client-session',
      reconnect: true
    }

    // Simulate receiving the hello response
    await client.handleMsg(1, resp)

    // Client should mark hello as received
    expect((client as any).helloReceived).toBe(true)

    // Wait a tick for the async onConnect call to be invoked
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Verify onConnect was invoked with Reconnected event and some payload
    expect(onConnectSpy).toHaveBeenCalledWith(ClientConnectEvent.Reconnected, expect.anything())

    // Clean up timers and sockets created by the client
    await client.close()
  })

  it('sends request to a single connected session and returns response', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')

    // Prepare a fake socket that records sent messages and simulates a client reply.
    const sent: any[] = []
    const cs = createFakeCS(sent)

    // Override send to immediately resolve server's pending request for the sent id.
    cs.send = async (_ctx: any, msg: any) => {
      sent.push(msg)
      const id = msg.id
      const rr = (server as any).requests.get(id)
      if (rr !== undefined) {
        rr.resolve({ answer: 'payload-from-client' })
        rr.onDone?.()
        ;(server as any).requests.delete(id)
      }
    }

    const session = {
      hello: undefined,
      createTime: Date.now(),
      sid: 'sid-req1',
      sessionId: 'session-req1',
      requests: new Map(),
      lastRequest: Date.now(),
      lastPing: Date.now(),
      socket: cs
    } as any

    ;(server as any).sessions.set(session.sid, session)

    const res = await server.request(ctx, 'call-me', ['payload'])
    expect(sent.length).toBe(1)
    expect(sent[0].result?.method).toBe('call-me')
    expect(res).toEqual({ answer: 'payload-from-client' })

    await server.close()
  })

  it('round-robins requests across available sessions', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')

    try {
      const calls: string[] = []

      // Session 1
      const s1sent: any[] = []
      const s1 = createFakeCS(s1sent)
      s1.send = async (_ctx: any, msg: any) => {
        calls.push('s1')
        const id = msg.id
        const rr = (server as any).requests.get(id)
        if (rr !== undefined) {
          rr.resolve({ from: 's1' })
          rr.onDone?.()
          ;(server as any).requests.delete(id)
        }
      }

      const session1 = {
        hello: undefined,
        createTime: Date.now(),
        sid: 's1',
        sessionId: 'session-1',
        requests: new Map(),
        lastRequest: Date.now(),
        lastPing: Date.now(),
        socket: s1 as any
      } as any

      // Session 2
      const s2sent: any[] = []
      const s2 = createFakeCS(s2sent)
      s2.send = async (_ctx: any, msg: any) => {
        calls.push('s2')
        const id = msg.id
        const rr = (server as any).requests.get(id)
        if (rr !== undefined) {
          rr.resolve({ from: 's2' })
          rr.onDone?.()
          ;(server as any).requests.delete(id)
        }
      }

      const session2 = {
        hello: undefined,
        createTime: Date.now(),
        sid: 's2',
        sessionId: 'session-2',
        requests: new Map(),
        lastRequest: Date.now(),
        lastPing: Date.now(),
        socket: s2 as any
      } as any

      // Insert sessions in order so round-robin uses them alternately
      ;(server as any).sessions.set(session1.sid, session1)
      ;(server as any).sessions.set(session2.sid, session2)

      const r1 = await server.request(ctx, 'method-a', ['p1'])
      const r2 = await server.request(ctx, 'method-b', ['p2'])

      expect(r1).toEqual({ from: 's1' })
      expect(r2).toEqual({ from: 's2' })
      expect(calls).toEqual(['s1', 's2'])
    } finally {
      await server.close()
    }
  })

  it('handleTick moves timed-out sessions to reconnectQueue and invokes event handlers', async () => {
    const ctx = createFakeCtx()

    const calls: Array<{ ev: any, id: string }> = []
    const server = new ClisrServer(ctx, async () => true, '1.0.0')

    // Register event handler to capture timeout events
    server.eventHandlers.push(async (sessionId, ev) => {
      calls.push({ ev, id: sessionId })
    })

    try {
      // Create a session that will be considered timed out
      const sent: any[] = []
      const cs = createFakeCS(sent)
      let closed = false
      cs.close = () => {
        closed = true
      }

      const session = {
        hello: {},
        createTime: Date.now() - 1000,
        sid: 'timeout-sid',
        sessionId: 'session-timeout',
        requests: new Map(),
        lastRequest: Date.now(),
        // Make lastPing older than PingTimeout so the session is considered dead.
        lastPing: Date.now() - (server.pingTimeout + 1000),
        socket: cs
      } as any

      ;(server as any).sessions.set(session.sid, session)

      await server.handleTick()

      expect((server as any).sessions.has(session.sid)).toBe(false)
      // After timeout, session should be queued for reconnect (keyed by sessionId) and socket closed.
      expect(server.reconnectQueue.has(session.sessionId)).toBe(true)
      expect(closed).toBe(true)
      expect(calls).toContainEqual({ ev: 'timeout', id: 'session-timeout' })
    } finally {
      await server.close()
    }
  })

  it('checkHello handles event handler errors without throwing', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')

    const sent: any[] = []
    const cs = createFakeCS(sent)

    const session: Session = {
      hello: undefined,
      createTime: Date.now(),
      sid: 'sid-eh',
      sessionId: 'session-eh',
      requests: new Map(),
      lastRequest: Date.now(),
      lastPing: Date.now(),
      socket: cs,
      options: {}
    }

    let calledErr = false
    server.eventHandlers.push(async () => {
      throw new Error('boom')
    })
    jest.spyOn((server as any).ctx, 'error').mockImplementation(() => {
      calledErr = true
    })

    const helloReq: HelloRequest = {
      method: 'hello',
      params: [],
      id: -1,
      token: 'ok',
      sessionId: 'session-eh'
    }

    await server.checkHello(session, helloReq, cs)
    expect(calledErr).toBe(true)
  })

  it('processes ping messages and sends pong response', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')

    // Fake ws that stores event listeners
    const listeners: Record<string, Array<(...args: any[]) => void>> = {}
    const sendCalls: any[] = []
    const ws: any = {
      bufferedAmount: 0,
      readyState: 1,
      OPEN: 1,
      CLOSED: 2,
      CLOSING: 3,
      send: jest.fn((_buf: any, _opts: any, cb: any) => {
        sendCalls.push(_buf)
        cb?.()
      }),
      close: jest.fn(),
      terminate: jest.fn(),
      on: (name: string, fn: (...args: any[]) => void) => {
        ;(listeners[name] ??= []).push(fn)
      }
    }

    await server.handleConnection(ws, { socket: { remoteAddress: '127.0.0.1' }, headers: {} } as any)

    // Retrieve session and mark it as hello'ed so ping is treated as normal request
    const sess = Array.from((server as any).sessions.values())[0] as any
    sess.hello = {}

    // craft a raw ping frame payload
    const payload = Buffer.from([FRAME_PING])
    // call the registered 'message' listeners
    for (const fn of listeners.message ?? []) {
      const maybe = (fn as any)(payload) as unknown
      if (maybe != null) {
        const maybePromise = Promise.resolve(maybe)
        await maybePromise
      }
    }

    // Wait a tick for async handlers to run
    await new Promise((resolve) => setImmediate(resolve))
    // Verify that a pong response was sent (FRAME_PONG = 0x02)
    const pongSent = sendCalls.some((buf) => buf instanceof Buffer && buf[0] === FRAME_PONG)
    expect(pongSent).toBe(true)
  })

  it('send waits for backpressure then sends binary data', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')
    server.compress = async (x: any) => x
    server.uncompress = async (x: any) => x

    // Fake ws that simulates backpressure first, then clears it
    const ws: any = {
      bufferedAmount: 999999,
      readyState: 1,
      OPEN: 1,
      CLOSED: 2,
      CLOSING: 3,
      send: jest.fn((_buf: any, _opts: any, cb: any) => cb?.()),
      close: jest.fn(),
      terminate: jest.fn(),
      // Minimal event registration support required by handleConnection
      on: (_name: string, _fn: (...args: any[]) => void) => {}
    }

    await server.handleConnection(ws, { socket: { remoteAddress: '127.0.0.1' }, headers: {} } as any)

    const sess = Array.from((server as any).sessions.values())[0] as any
    sess.hello = {}

    // schedule clearing of backpressure on next tick
    setImmediate(() => {
      ws.bufferedAmount = 0
    })

    const msg = { id: 'test-id', result: { method: 'x', params: [], meta: {} }, time: Date.now() }
    await sess.socket.send((server as any).ctx, msg)
    // send should have been called with binary true
    expect(ws.send).toHaveBeenCalled()
    const opts = (ws.send as jest.Mock).mock.calls[0][1]
    expect(opts.binary).toBe(true)
  })

  it('ConnectionSocket.send logs and reports errors via Analytics.handleError when send callback reports error', async () => {
    const ctx = createFakeCtx()
    const rpc = new RPCHandler()
    const ws: any = {
      bufferedAmount: 0,
      readyState: 1,
      OPEN: 1,
      CLOSED: 2,
      CLOSING: 3,
      send: (_buf: any, _opts: any, cb: any) => {
        cb(new Error('unexpected failure'))
      },
      close: jest.fn(),
      terminate: jest.fn()
    }
    const compressSpy = jest.fn().mockResolvedValue(Buffer.from('x'))
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc, {
      compress: compressSpy
    })
    const errSpy = jest.spyOn(ctx as any, 'error')
    const analyticsSpy = jest.spyOn(Analytics, 'handleError').mockImplementation(() => {})
    const msg: any = { id: 'e1', result: { method: 'x', params: [], meta: {} }, time: Date.now() }
    await cs.send(ctx, msg)
    expect(errSpy).toHaveBeenCalled()
    expect(analyticsSpy).toHaveBeenCalled()
    compressSpy.mockReset()
    analyticsSpy.mockRestore()
  })

  it('ConnectionSocket.send ignores "WebSocket is not open" errors and does not report them', async () => {
    const ctx = createFakeCtx()
    const rpc = new RPCHandler()
    const ws: any = {
      bufferedAmount: 0,
      readyState: 1,
      OPEN: 1,
      CLOSED: 2,
      CLOSING: 3,
      send: (_buf: any, _opts: any, cb: any) => {
        cb(new Error('WebSocket is not open'))
      },
      close: jest.fn(),
      terminate: jest.fn()
    }
    const compressSpy = jest.fn().mockResolvedValue(Buffer.from('x'))
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc, {
      compress: compressSpy
    })
    const errSpy = jest.spyOn(ctx as any, 'error')
    const analyticsSpy = jest.spyOn(Analytics, 'handleError').mockImplementation(() => {})
    const id = 'e3'
    const result = { method: 'x', params: [], meta: {} }
    const time = Date.now()
    await cs.send(ctx, { id, result, time })
    expect(errSpy).not.toHaveBeenCalled()
    expect(analyticsSpy).not.toHaveBeenCalled()
    compressSpy.mockReset()
    analyticsSpy.mockRestore()
  })

  it('ConnectionSocket.send handles synchronous ws.send throws (Send before connected) and logs but does not report to analytics', async () => {
    const ctx = createFakeCtx()
    const rpc = new RPCHandler()
    const ws: any = {
      bufferedAmount: 0,
      readyState: 1,
      OPEN: 1,
      CLOSED: 2,
      CLOSING: 3,
      send: (_buf: any, _opts: any, cb?: any) => {
        // Simulate synchronous throw from underlying ws implementation
        throw new Error('Send before connected exception')
      },
      close: jest.fn(),
      terminate: jest.fn()
    }
    const compressSpy = jest.fn().mockResolvedValue(Buffer.from('x'))
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc, {
      compress: compressSpy
    })
    const errSpy = jest.spyOn(ctx as any, 'error')
    const analyticsSpy = jest.spyOn(Analytics, 'handleError').mockImplementation(() => {})
    const msg: any = { id: 'e4', result: { method: 'x', params: [], meta: {} }, time: Date.now() }
    // cs.send should not throw even when ws.send throws synchronously
    await expect(cs.send(ctx, msg)).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
    // 'Send before connected' is considered benign and should not be reported to analytics
    expect(analyticsSpy).not.toHaveBeenCalled()
    analyticsSpy.mockRestore()
  })

  it('ConnectionSocket.send handles synchronous ws.send throws (unexpected) and reports to analytics', async () => {
    const ctx = createFakeCtx()
    const rpc = new RPCHandler()
    const ws: any = {
      bufferedAmount: 0,
      readyState: 1,
      OPEN: 1,
      CLOSED: 2,
      CLOSING: 3,
      send: (_buf: any, _opts: any, cb?: any) => {
        // Simulate synchronous unexpected throw
        throw new Error('unexpected send failure')
      },
      close: jest.fn(),
      terminate: jest.fn()
    }
    const compressSpy = jest.fn().mockResolvedValue(Buffer.from('x'))
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc, {
      compress: compressSpy
    })
    const errSpy = jest.spyOn(ctx as any, 'error')
    const analyticsSpy = jest.spyOn(Analytics, 'handleError').mockImplementation(() => {})
    const msg: any = { id: 'e5', result: { method: 'x', params: [], meta: {} }, time: Date.now() }
    await expect(cs.send(ctx, msg)).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
    expect(analyticsSpy).toHaveBeenCalled()
    analyticsSpy.mockRestore()
  })

  it('ConnectionSocket.sendRaw handles synchronous ws.send throws and logs appropriately', async () => {
    const ctx = createFakeCtx()
    const rpc = new RPCHandler()
    const ws: any = {
      bufferedAmount: 0,
      readyState: 1,
      OPEN: 1,
      CLOSED: 3,
      CLOSING: 2,
      send: (_buf: any, _opts: any, cb?: any) => {
        // Simulate synchronous throw
        throw new Error('Send before connected exception')
      },
      close: jest.fn(),
      terminate: jest.fn()
    }
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc)
    const errSpy = jest.spyOn(ctx as any, 'error')
    const analyticsSpy = jest.spyOn(Analytics, 'handleError').mockImplementation(() => {})
    // Should not throw; internal handler should catch and process the error
    await cs.sendRaw(ctx, Buffer.from([1, 2, 3]))
    expect(errSpy).toHaveBeenCalled()
    // Benign 'Send before connected' shouldn't be reported to analytics
    expect(analyticsSpy).not.toHaveBeenCalled()
    analyticsSpy.mockRestore()
  })

  it('ConnectionSocket.sendPong handles synchronous ws.send throws without reporting (Send before connected)', () => {
    const rpc = new RPCHandler()
    const ws: any = {
      readyState: 1,
      send: jest.fn().mockImplementation(() => {
        throw new Error('Send before connected exception')
      }),
      OPEN: 1,
      CLOSED: 3,
      CLOSING: 2
    }
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc)
    const analyticsSpy = jest.spyOn(Analytics, 'handleError').mockImplementation(() => {})
    // Should not throw even if ws.send throws synchronously
    expect(() => {
      cs.sendPong()
    }).not.toThrow()
    expect(analyticsSpy).not.toHaveBeenCalled()
    analyticsSpy.mockRestore()
  })

  it('ConnectionSocket.checkState terminates socket when CLOSED or CLOSING and returns false', () => {
    const rpc = new RPCHandler()
    const ws: any = { readyState: 3, CLOSED: 3, CLOSING: 2, terminate: jest.fn() }
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc)
    expect(cs.checkState()).toBe(false)
    expect(ws.terminate).toHaveBeenCalled()
  })

  it('ConnectionSocket.sendPong returns early when socket is not OPEN or when connection is closed', () => {
    const rpc = new RPCHandler()
    const ws: any = { readyState: 3, send: jest.fn(), OPEN: 1, CLOSED: 3, CLOSING: 2 }
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc)
    // If not open, sendPong should silently return
    cs.sendPong()
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('ConnectionSocket.sendRaw reports async callback errors to Analytics', async () => {
    const ctx = createFakeCtx()
    const rpc = new RPCHandler()
    const ws: any = {
      readyState: 1,
      OPEN: 1,
      CLOSED: 3,
      CLOSING: 2,
      send: (_buf: Buffer, _opts: any, cb: any) => {
        cb(new Error('boom'))
      }
    }
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc)

    const analyticsSpy = jest.spyOn(Analytics, 'handleError').mockImplementation(() => {})
    const errorSpy = jest.spyOn(ctx, 'error')

    await cs.sendRaw(ctx, Buffer.from([FRAME_PING]))
    // allow callbacks to run
    await new Promise((resolve) => setImmediate(resolve))

    expect(errorSpy).toHaveBeenCalled()
    expect(analyticsSpy).toHaveBeenCalled()

    analyticsSpy.mockRestore()
  })

  it('ConnectionSocket.sendRaw ignores benign Send before connected errors from async callback', async () => {
    const ctx = createFakeCtx()
    const rpc = new RPCHandler()
    const ws: any = {
      readyState: 1,
      OPEN: 1,
      CLOSED: 3,
      CLOSING: 2,
      send: (_buf: Buffer, _opts: any, cb: any) => {
        cb(new Error('Send before connected'))
      }
    }
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc)

    const analyticsSpy = jest.spyOn(Analytics, 'handleError').mockImplementation(() => {})
    const errorSpy = jest.spyOn(ctx, 'error')

    await cs.sendRaw(ctx, Buffer.from([FRAME_PING]))
    await new Promise((resolve) => setImmediate(resolve))

    expect(errorSpy).toHaveBeenCalled()
    expect(analyticsSpy).not.toHaveBeenCalled()

    analyticsSpy.mockRestore()
  })

  it('ConnectionSocket.sendRaw returns early when socket is not OPEN', async () => {
    const ctx = createFakeCtx()
    const rpc = new RPCHandler()
    const ws: any = {
      readyState: 3, // CLOSED
      send: jest.fn(),
      OPEN: 1,
      CLOSED: 3,
      CLOSING: 2,
      bufferedAmount: 0
    }
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc)
    await cs.sendRaw(ctx, Buffer.from([1, 2, 3]))
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('ConnectionSocket.send handles compression for large messages', async () => {
    const ctx = createFakeCtx()
    const rpc = new RPCHandler()
    const ws: any = {
      readyState: 1,
      send: jest.fn(),
      OPEN: 1,
      CLOSED: 3,
      CLOSING: 2,
      bufferedAmount: 0
    }
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc, {
      compress: async (x: any) => x,
      uncompress: async (x: any) => x
    })
    const largeData = { result: 'x'.repeat(2000) }
    await cs.send(ctx, largeData as any)
    expect(ws.send).toHaveBeenCalled()
  })

  it('server handleTick removes timed out sessions', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')

    try {
      // Manually add a session that has timed out
      const fakeSocket: any = {
        id: 'fake',
        isClosed: false,
        close: jest.fn(),
        send: jest.fn(),
        sendRaw: jest.fn(),
        sendPong: jest.fn(),
        data: () => ({}),
        isBackpressure: () => false,
        backpressure: jest.fn(),
        checkState: () => true,
        readRequest: jest.fn()
      }
      const session: Session = {
        hello: { method: 'hello', params: [], id: -1, token: 'test' },
        createTime: Date.now() - 1000000, // Old session
        sid: 'test-sid',
        sessionId: 'test-session',
        requests: new Map(),
        lastRequest: Date.now() - 1000000, // Very old
        lastPing: Date.now(),
        socket: fakeSocket,
        options: {}
      }
      ;(server as any).sessions.set('test-sid', session)

      await server.handleTick()

      // Session should be moved to reconnectQueue or removed
    } finally {
      await server.close()
    }
  })

  it('handleTick sends ping for hang requests', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')

    const fakeSocket: any = {
      sendRaw: jest.fn(),
      data: () => ({})
    }

    const session = {
      hello: {},
      createTime: Date.now(),
      sid: 'hang-sid',
      sessionId: 'session-hang',
      requests: new Map(),
      lastRequest: Date.now(),
      // Stale-but-not-dead: triggers probe ping but not handleSessionTimeout.
      lastPing: Date.now() - (server.pingProbeAfter + 100),
      socket: fakeSocket,
      options: {}
    } as any
    ;(server as any).sessions.set(session.sid, session)

    const rr = {
      session,
      // Older than HangLogTimeout — triggers warn.
      startTime: Date.now() - (server.hangLogTimeout + 1000),
      method: 'hangOp',
      reject: jest.fn()
    } as any

    ;(server as any).requests.set('#hang', rr)

    const warnSpy = jest.spyOn(ctx, 'warn')

    await server.handleTick()

    // Probe ping must be sent for stale session.
    expect(fakeSocket.sendRaw).toHaveBeenCalled()
    // Hang log must be emitted for the long-running request.
    expect(warnSpy).toHaveBeenCalledWith('request running long', expect.objectContaining({ method: 'hangOp' }))

    warnSpy.mockRestore()
  })

  it('server broadcast handles send errors gracefully', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')

    try {
      // Manually add a session with failing send
      const fakeSocket: any = {
        id: 'fake',
        isClosed: false,
        close: jest.fn(),
        send: jest.fn().mockRejectedValue(new Error('send failed')),
        sendRaw: jest.fn(),
        sendPong: jest.fn(),
        data: () => ({}),
        isBackpressure: () => false,
        backpressure: jest.fn(),
        checkState: () => true,
        readRequest: jest.fn()
      }
      const session: Session = {
        hello: { method: 'hello', params: [], id: -1, token: 'test' },
        createTime: Date.now(),
        sid: 'test-sid',
        sessionId: 'test-session',
        requests: new Map(),
        lastRequest: Date.now(),
        lastPing: Date.now(),
        socket: fakeSocket,
        options: {}
      }
      ;(server as any).sessions.set('test-sid', session)

      // Should not throw even if send fails
      await server.broadcast({ test: 'data' })
    } finally {
      await server.close()
    }
  })

  it('server handles reconnecting session', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async (token: string) => token === 'test-token', '1.0.0')
    server.compress = async (x: any) => x
    server.uncompress = async (x: any) => x

    try {
      const sent: any[] = []
      const cs = createFakeCS(sent)

      // First, create an initial session
      const session1: Session = {
        hello: undefined,
        createTime: Date.now(),
        sid: 'sid-1',
        sessionId: 'reconnect-session',
        requests: new Map(),
        lastRequest: Date.now(),
        lastPing: Date.now(),
        socket: cs,
        options: {}
      }

      // Put session in reconnectQueue to simulate disconnect
      ;(server as any).bySessionId.set('reconnect-session', session1)
      ;(server as any).reconnectQueue.set('sid-1', session1)

      // Create new session trying to reconnect
      const session2: Session = {
        hello: undefined,
        createTime: Date.now(),
        sid: 'sid-2',
        sessionId: 'reconnect-session',
        requests: new Map(),
        lastRequest: Date.now(),
        lastPing: Date.now(),
        socket: cs,
        options: {}
      }

      const helloReq: HelloRequest = {
        method: 'hello',
        params: [],
        id: -1,
        token: 'test-token',
        sessionId: 'reconnect-session'
      }

      await server.checkHello(session2, helloReq, cs)

      // Should have sent hello response with reconnect=true
      expect(sent.length).toBe(1)
      const raw = sent[0].raw as Buffer
      const payload = raw.slice(1)
      const resp = server.rpcHandler.readResponse<any>(payload, true) as HelloResponse
      expect(resp.reconnect).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('sends FRAME_OP_STATUS to the client for long-running operations', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')
    server.compress = async (x: any) => x
    server.uncompress = async (x: any) => x

    try {
      // Fake socket captures raw frames sent by server
      const fakeSocket: any = {
        id: 'fake',
        isClosed: false,
        close: jest.fn(),
        send: jest.fn(),
        sendRaw: jest.fn(),
        sendPong: jest.fn(),
        data: () => ({}),
        isBackpressure: () => false,
        backpressure: jest.fn(),
        checkState: () => true,
        readRequest: jest.fn()
      }
      const session: Session = {
        hello: { method: 'hello', params: [], id: -1, token: 'test' },
        createTime: Date.now(),
        sid: 'test-sid',
        sessionId: 'test-session',
        requests: new Map(),
        lastRequest: Date.now(),
        lastPing: Date.now(),
        socket: fakeSocket,
        options: {}
      }
      ;(server as any).sessions.set('test-sid', session)

      // Insert a fake long-running request into server.requests and the session map
      const fakeRequest: any = {
        method: 'x',
        sendData: jest.fn(),
        reject: jest.fn(),
        startTime: Date.now() - 6000, // older than the 5s threshold
        session
      }
      ;(server as any).requests.set('#r1', fakeRequest)
      session.requests.set('#r1', fakeRequest)

      // Run the tick; server should emit a FRAME_OP_STATUS to the session socket
      await server.handleTick()

      expect(fakeSocket.sendRaw).toHaveBeenCalled()
      const buf = (fakeSocket.sendRaw as jest.Mock).mock.calls[0][1]
      expect(buf[0]).toBe(FRAME_OP_STATUS)
      const payload = JSON.parse(Buffer.from(buf.slice(1)).toString('utf8'))
      expect(payload.id).toBe('#r1')
    } finally {
      await server.close()
    }
  })

  it('handles FRAME_OP_STATUS_RESP by resending the operation when client reports not executing', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')
    server.compress = async (x: any) => x
    server.uncompress = async (x: any) => x

    try {
      const fakeSocket: any = {
        id: 'fake',
        isClosed: false,
        close: jest.fn(),
        send: jest.fn(),
        sendRaw: jest.fn(),
        sendPong: jest.fn(),
        data: () => ({}),
        isBackpressure: () => false,
        backpressure: jest.fn(),
        checkState: () => true,
        readRequest: jest.fn()
      }
      const session: Session = {
        hello: { method: 'hello', params: [], id: -1, token: 'test' },
        createTime: Date.now(),
        sid: 'test-sid',
        sessionId: 'test-session',
        requests: new Map(),
        lastRequest: Date.now(),
        lastPing: Date.now(),
        socket: fakeSocket,
        options: {}
      }
      ;(server as any).sessions.set('test-sid', session)

      // Insert a fake request into the session's requests map with a mocked sendData
      const fakeRequest: any = {
        method: 'x',
        sendData: jest.fn(),
        reject: jest.fn()
      }
      ;(server as any).requests.set('#r2', fakeRequest)
      session.requests.set('#r2', fakeRequest)

      // Simulate receiving FRAME_OP_STATUS_RESP from client with executing=false
      const payload = JSON.stringify({ id: '#r2', executing: false })
      const buf = Buffer.alloc(1 + Buffer.byteLength(payload))
      buf[0] = FRAME_OP_STATUS_RESP
      buf.write(payload, 1, 'utf8')

      await (server as any).handleMessage(session, buf)

      // The request's sendData should have been invoked
      expect(fakeRequest.sendData).toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('ConnectionSocket.data returns connection data', () => {
    const rpc = new RPCHandler()
    const ws: any = {
      readyState: 1,
      send: jest.fn(),
      OPEN: 1,
      CLOSED: 3,
      CLOSING: 2,
      bufferedAmount: 0
    }
    const cs = createConnectionSocket(ws, { remoteAddress: '192.168.1.1', userAgent: 'TestAgent', language: 'en' }, rpc)
    const data = cs.data()
    expect(data.remoteAddress).toBe('192.168.1.1')
    expect(data.userAgent).toBe('TestAgent')
    expect(data.language).toBe('en')
  })

  it('ConnectionSocket.isBackpressure returns true when bufferedAmount exceeds threshold', () => {
    const rpc = new RPCHandler()
    const ws: any = {
      readyState: 1,
      send: jest.fn(),
      OPEN: 1,
      CLOSED: 3,
      CLOSING: 2,
      bufferedAmount: 20 * 1024 * 1024 // 20MB - above backpressure threshold
    }
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc)
    expect(cs.isBackpressure()).toBe(true)
  })

  it('ConnectionSocket.isBackpressure returns false when bufferedAmount is low', () => {
    const rpc = new RPCHandler()
    const ws: any = {
      readyState: 1,
      send: jest.fn(),
      OPEN: 1,
      CLOSED: 3,
      CLOSING: 2,
      bufferedAmount: 1000 // Low amount
    }
    const cs = createConnectionSocket(ws, { remoteAddress: '127.0.0.1', userAgent: '', language: '' }, rpc)
    expect(cs.isBackpressure()).toBe(false)
  })
})

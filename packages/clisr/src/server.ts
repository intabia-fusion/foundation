//
// Copyright © 2023 Hardcore Engineering Inc.
// Copyright © 2025 Intabia Fusion.
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

import { Analytics } from '@hcengineering/analytics'
import { type MeasureContext } from '@hcengineering/measurements'
import { type ReqId, RPCHandler, type Response, type Request } from '@hcengineering/rpc'

import 'bufferutil'
import cors from 'cors'
import express, { type Express, type Response as ExpressResponse, type NextFunction } from 'express'
import http, { type IncomingMessage } from 'http'
import morgan from 'morgan'
import os from 'os'
import { setImmediate } from 'timers/promises'
import 'utf-8-validate'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'

import {
  type ConnectionSocket,
  FRAME_PING,
  FRAME_PONG,
  FRAME_HELLO,
  FRAME_HELLO_RESP,
  FRAME_BINARY,
  FRAME_BINARY_RESP,
  FRAME_OP_STATUS,
  FRAME_OP_STATUS_RESP,
  RequestPromise,
  type Session,
  type HelloRequest,
  type HelloResponse,
  formatId,
  isJsonBody,
  legacyWireFormat,
  negotiateFormat,
  readDataFrame,
  callbackMethod,
  decodeBinaryRequest,
  encodeBinaryResponse,
  encodeBinaryRequest,
  decodeBinaryResponse
} from './types'
import { randomUUID } from 'crypto'
import { setTimeout } from 'timers'
import { codecFor, sendFrame as sharedSendFrame } from './frame-utils'
import { unknownError } from '@hcengineering/platform'

// Lazy-import snappy at runtime to avoid initializing native handles during test collection
let _snappyCompress: ((input: any) => Promise<any>) | undefined
let _snappyUncompress: ((input: any) => Promise<any>) | undefined
const lazyCompress = async (input: any): Promise<any> => {
  if (_snappyCompress === undefined) {
    const m = await import('snappy')
    _snappyCompress = m.compress.bind(m)
    _snappyUncompress = m.uncompress.bind(m)
  }
  if (_snappyCompress === undefined) {
    throw new Error('snappy compress function not available')
  }
  return await _snappyCompress(input)
}
const lazyUncompress = async (input: any): Promise<any> => {
  if (_snappyUncompress === undefined) {
    const m = await import('snappy')
    _snappyCompress = _snappyCompress ?? m.compress.bind(m)
    _snappyUncompress = m.uncompress.bind(m)
  }
  if (_snappyUncompress === undefined) {
    throw new Error('snappy uncompress function not available')
  }
  return await _snappyUncompress(input)
}

export type RequestHandler = (req: Request<any>, res: ExpressResponse, next?: NextFunction) => Promise<void>

const backpressureSize = 100 * 1024

// If a session has not exchanged any ping/pong/message within this window, treat it as dead.
const PingTimeout = 30 * 1000 // 30 seconds
// Probe interval: when stale-but-not-dead, send an explicit ping.
const PingProbeAfter = 10 * 1000 // 10 seconds
// How long we keep a closed session in reconnectQueue before rejecting its pending requests.
const ReconnectTimeout = 5 * 1000 // 5 seconds
// Pending request that has been running longer than this triggers a warn log (not a reject).
// Workers may legitimately take long; we just want visibility.
const HangLogTimeout = 5 * 60 * 1000 // 5 minutes
// Repeat hang warn no more often than this for the same request.
const HangLogInterval = 5 * 60 * 1000 // 5 minutes

// Retry pacing for round-robin requests when sessions reject calls.
// We start at 100ms and grow exponentially up to a 5s cap so that idle/error loops
// (e.g. clients failing to reach an external service) don't burn CPU.
const RetryBackoffStartMs = 100
const RetryBackoffMaxMs = 5000
const RetryBackoffFactor = 1.5
// Throttle retry warn logs to avoid flooding when a request is stuck.
const RetryLogIntervalMs = 5000

// Operation status check threshold: if a server->client operation has been executing
// longer than this, server will query the client whether it is still executing the operation.
const OpStatusTimeout = 5 * 1000 // 5 seconds

// Minimum interval between repeated status checks for the same request (ms)
const OpStatusCheckInterval = 5 * 1000 // 5 seconds

export type ConnectionEventType = 'connected' | 'reconnect' | 'disconnect' | 'timeout'

export class ClisrServer {
  private readonly sessions = new Map<string, Session>()
  private readonly bySessionId = new Map<string, Session>()
  private cindex = 0
  private msgIndex = 0
  rpcHandler = new RPCHandler()

  private readonly requests = new Map<ReqId, RequestPromise>()

  // Binary request handler for incoming binary requests from clients
  // Can return Uint8Array for binary response, or any other type for JSON response
  public binaryHandler?: (
    session: Session,
    method: string,
    data: Uint8Array,
    headers?: Record<string, any>
  ) => Promise<Uint8Array | any>

  // Allow overriding compression functions (default to snappy).
  // Tests can override the instance methods instead of mocking the native module.
  compress: (input: any) => Promise<any> = lazyCompress
  uncompress: (input: any) => Promise<any> = lazyUncompress

  public eventHandlers: ((session: string, event: ConnectionEventType) => Promise<void>)[] = []

  reconnectQueue = new Map<string, Session>()

  wss?: WebSocketServer
  httpServer?: http.Server
  private tickTimer?: ReturnType<typeof setInterval>
  // Set to true by close(); long-running retry loops observe it to exit cleanly
  // instead of spinning forever after the server is shut down.
  private closed = false

  // Tunables (overridable for tests). Defaults match the production constants.
  pingTimeout = PingTimeout
  pingProbeAfter = PingProbeAfter
  reconnectTimeout = ReconnectTimeout
  hangLogTimeout = HangLogTimeout
  hangLogInterval = HangLogInterval
  tickIntervalMs = 1000
  retryBackoffStartMs = RetryBackoffStartMs
  retryBackoffMaxMs = RetryBackoffMaxMs
  retryBackoffFactor = RetryBackoffFactor

  // Promise that resolves when close() is called. Used to make retry sleeps
  // interruptible so shutdown does not wait for the full backoff window.
  private closeWaiters: Array<() => void> = []

  private nextBackoff (current: number): number {
    return Math.min(Math.floor(current * this.retryBackoffFactor), this.retryBackoffMaxMs)
  }

  // Sleep for `ms` or until close() fires, whichever comes first.
  private async sleepInterruptible (ms: number): Promise<void> {
    if (this.closed) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.closeWaiters.indexOf(onClose)
        if (idx >= 0) this.closeWaiters.splice(idx, 1)
        resolve()
      }, ms)
      const onClose = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.closeWaiters.push(onClose)
    })
  }

  private slotWaiters: Array<() => void> = []

  /** A request finished, so a capacity slot may have freed: wake whoever is waiting for one. */
  private notifySlotFree (): void {
    const waiters = this.slotWaiters
    this.slotWaiters = []
    for (const w of waiters) {
      try {
        w()
      } catch (_e) {}
    }
  }

  /** Waits for a freed slot rather than polling for it; `ms` is only an upper bound. */
  private async waitForSlot (ms: number): Promise<void> {
    if (this.closed) return
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        const si = this.slotWaiters.indexOf(done)
        if (si >= 0) this.slotWaiters.splice(si, 1)
        const ci = this.closeWaiters.indexOf(done)
        if (ci >= 0) this.closeWaiters.splice(ci, 1)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.slotWaiters.push(done)
      this.closeWaiters.push(done)
    })
  }

  private isClosedError (err: any): boolean {
    return err?.code === 'SERVER_CLOSED'
  }

  constructor (
    readonly ctx: MeasureContext,
    readonly validateToken: (token: string) => Promise<boolean>,
    readonly serverVersion: string,
    readonly app: Express = express(),
    readonly messageHandler?: (ctx: MeasureContext, method: string, params: any[], session: Session) => Promise<any>
  ) {}

  async handleTick (): Promise<void> {
    const now = Date.now()
    // Reject sessions that did not return within ReconnectTimeout
    for (const [sid, session] of this.reconnectQueue.entries()) {
      if (now - session.lastPing > this.reconnectTimeout) {
        await this.handleSessionDisconnect(sid, session)
      }
    }
    // Detect dead sessions via ping. Active sessions update lastPing on any incoming frame.
    for (const [sid, session] of this.sessions.entries()) {
      const sinceLastPing = now - session.lastPing
      if (sinceLastPing > this.pingTimeout) {
        this.ctx.warn('session ping timeout, marking dead', {
          sessionId: session.sessionId,
          client: session.clientHost,
          sinceLastPingMs: sinceLastPing
        })
        await this.handleSessionTimeout(sid, session)
        continue
      }
      // Stale but not dead: send a probe ping to refresh liveness signal.
      // Throttled to at most one probe per pingProbeAfter window so we don't spam
      // an unresponsive client with pings on every tick.
      if (sinceLastPing > this.pingProbeAfter) {
        const lastProbe = session.lastProbePingAt ?? 0
        if (now - lastProbe > this.pingProbeAfter) {
          session.lastProbePingAt = now
          try {
            void session.socket.sendRaw(this.ctx, Buffer.from([FRAME_PING]))
          } catch (err: any) {
            this.ctx.error('failed to send probe ping', { err })
          }
        }
      }
    }
    // Visibility for long-running requests, and op-status checks.
    for (const [reqId, r] of this.requests.entries()) {
      if (r.session === undefined) continue
      const elapsed = now - r.startTime

      // Hang log: warn if a request runs longer than hangLogTimeout, repeat every hangLogInterval.
      if (elapsed > this.hangLogTimeout) {
        if (r.lastHangLogAt === undefined || now - r.lastHangLogAt > this.hangLogInterval) {
          r.lastHangLogAt = now
          this.ctx.warn('request running long', {
            id: reqId,
            method: r.method,
            elapsedMs: elapsed,
            client: r.session.clientHost ?? r.session.sessionId
          })
        }
      }

      // For moderately long operations (> OpStatusTimeout), ask client whether it has the operation.
      // We send a dedicated FRAME_OP_STATUS frame carrying the operation id and expect a FRAME_OP_STATUS_RESP
      // from the client with { id, executing: boolean }.
      if (elapsed > OpStatusTimeout) {
        if (r.lastStatusCheckAt === undefined || now - r.lastStatusCheckAt > OpStatusCheckInterval) {
          r.lastStatusCheckAt = now
          try {
            const payloadJson = JSON.stringify({ id: reqId })
            const payloadBytes = Buffer.from(payloadJson, 'utf8')
            const out = Buffer.alloc(1 + payloadBytes.length)
            out[0] = FRAME_OP_STATUS
            out.set(payloadBytes, 1)
            void r.session.socket.sendRaw(this.ctx, out)
          } catch (err: any) {
            this.ctx.error('failed to send op status request', { err, id: reqId })
          }
        }
      }
    }
  }

  private async handleSessionTimeout (sid: string, session: Session): Promise<void> {
    this.sessions.delete(sid)
    session.socket.close()
    // Reset lastPing so reconnectQueue countdown starts fresh from now.
    session.lastPing = Date.now()
    this.reconnectQueue.set(session.sessionId, session)
    this.ctx.info('session timed out', { sessionId: session.sessionId, client: session.clientHost })
    for (const eh of this.eventHandlers) {
      try {
        await eh(session.sessionId, 'timeout')
      } catch (err: any) {
        this.ctx.error('event handler error', { err })
      }
    }
  }

  private async handleSessionDisconnect (sessionId: string, session: Session): Promise<void> {
    this.reconnectQueue.delete(sessionId)
    this.bySessionId.delete(session.sessionId)
    const clientInfo = session.clientHost ?? session.sessionId
    this.ctx.info('session reconnect timed out', { sessionId: session.sessionId, client: session.clientHost })

    // Reject pending requests bound to this session in the global registry as well, so
    // round-robin callers (binaryRequest/requestWithFilter) can retry against another client.
    for (const [rid, r] of this.requests) {
      if (r.session === session) {
        this.requests.delete(rid)
        r.reject(new Error(`Session reconnect timeout (client: ${clientInfo})`))
      }
    }
    for (const rr of session.requests.values()) {
      rr.reject(new Error(`Session reconnect timeout (client: ${clientInfo})`))
    }
    session.requests.clear()
    this.notifySlotFree()

    for (const eh of this.eventHandlers) {
      try {
        await eh(session.sessionId, 'disconnect')
      } catch (err: any) {
        this.ctx.error('event handler error', { err })
      }
    }
  }

  async broadcast (msg: any): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        await session.socket.send(this.ctx, msg)
      } catch (err: any) {
        this.ctx.error('broadcast error', { err })
      }
    }
  }

  private sendRequest (
    socket: Session,
    data: {
      method: string
      params: any[]
      handleResult?: (result: any) => Promise<void>
    }
  ): Promise<any> {
    return this.ctx.with(
      'send-request',
      {},
      async (ctx) => {
        const id = `#${this.msgIndex++}`
        const promise = new RequestPromise(data.method, data.params, data.handleResult)
        promise.session = socket

        this.requests.set(id, promise)
        promise.onDone = () => {
          socket.requests.delete(id.toString())
          this.notifySlotFree()
        }

        promise.sendData = (): void => {
          if (!socket.socket.isClosed) {
            promise.startTime = Date.now()

            const msg: Response<any> = {
              result: {
                method: data.method,
                params: data.params,
                meta: ctx.extractMeta()
              },
              id,
              time: Date.now()
            }

            socket.requests.set(id.toString(), promise)
            void socket.socket.send(this.ctx, msg)
          }
        }
        promise.sendData()
        return await promise.promise
      },
      { method: data.method },
      {
        span: 'skip'
      }
    )
  }

  /** Least loaded eligible client, round-robin among ties; `undefined` when every one is full. */
  pickSession (sessions: Session[]): Session | undefined {
    const free = sessions.filter((s) => s.requests.size < (s.options?.capacity ?? Number.POSITIVE_INFINITY))
    if (free.length === 0) {
      return undefined
    }
    const minLoad = free.reduce((min, s) => Math.min(min, s.requests.size), Number.POSITIVE_INFINITY)
    const idle = free.filter((s) => s.requests.size === minLoad)
    return idle[this.cindex++ % idle.length]
  }

  // Perform a round robin call to one of the connected clients and wait for response from it
  // if client is not responding for a timeout, try next one client.
  async request (ctx: MeasureContext, method: string, params: any[]): Promise<any> {
    return await this.requestWithFilter(ctx, method, params)
  }

  /**
   * Perform a round robin call to one of the connected clients that matches the filter.
   * If sessionFilter is provided, only sessions that pass the filter will be considered.
   * @param ctx - measure context
   * @param method - method name to invoke
   * @param params - parameters to pass to the method
   * @param sessionFilter - optional filter function to select eligible sessions
   * @returns Promise with response data
   */
  async requestWithFilter (
    ctx: MeasureContext,
    method: string,
    params: any[],
    sessionFilter?: (session: Session) => boolean
  ): Promise<any> {
    let attempt = 0
    let lastNoSessionsLog = 0
    let lastRetryLog = 0
    let waitDelay = this.retryBackoffStartMs
    let retryDelay = this.retryBackoffStartMs
    while (true) {
      if (this.closed) {
        const err = new Error('server is closed')
        ;(err as any).code = 'SERVER_CLOSED'
        throw err
      }
      // Keep trying indefinitely
      let sessions = Array.from(this.sessions.values())
      if (sessionFilter !== undefined) {
        sessions = sessions.filter(sessionFilter)
      }
      if (sessions.length === 0) {
        const now = Date.now()
        if (now - lastNoSessionsLog > RetryLogIntervalMs) {
          lastNoSessionsLog = now
          ctx.warn('request waiting for available client', { method, attempt, delayMs: waitDelay })
        }
        await this.sleepInterruptible(waitDelay)
        waitDelay = this.nextBackoff(waitDelay)
        continue
      }
      // Reset wait-for-session backoff once sessions are available.
      waitDelay = this.retryBackoffStartMs

      attempt++
      const s = this.pickSession(sessions)
      if (s === undefined) {
        const now = Date.now()
        if (now - lastNoSessionsLog > RetryLogIntervalMs) {
          lastNoSessionsLog = now
          ctx.warn('request waiting for client capacity', { method, attempt, delayMs: waitDelay })
        }
        await this.waitForSlot(waitDelay)
        waitDelay = this.nextBackoff(waitDelay)
        continue
      }
      waitDelay = this.retryBackoffStartMs
      const clientInfo = s.clientHost ?? s.sessionId
      try {
        const res = await ctx.with(method, {}, (ctx) =>
          this.sendRequest(s, {
            method,
            params
          })
        )
        return res
      } catch (err: any) {
        // Shutdown short-circuit: do not retry/log/sleep after the server is closed.
        if (this.closed || this.isClosedError(err)) {
          if (this.isClosedError(err)) throw err
          const closedErr = new Error('server is closed')
          ;(closedErr as any).code = 'SERVER_CLOSED'
          throw closedErr
        }
        const now = Date.now()
        if (now - lastRetryLog > RetryLogIntervalMs) {
          lastRetryLog = now
          ctx.warn('request retry', {
            method,
            attempt,
            client: clientInfo,
            error: err.message,
            delayMs: retryDelay
          })
        }
        await this.sleepInterruptible(retryDelay)
        retryDelay = this.nextBackoff(retryDelay)
        continue
      }
    }
  }

  /**
   * Send a binary request to a specific session and wait for response.
   * Response can be either binary (Uint8Array) or JSON, depending on client handler.
   * @param session - target session
   * @param method - method name to invoke
   * @param data - binary payload
   * @param headers - optional headers to pass to the client handler
   * @returns Promise with response data (binary or JSON based on client handler)
   */
  private async sendBinaryRequest<T = Uint8Array>(
    session: Session,
    method: string,
    data: Uint8Array,
    headers?: Record<string, any>
  ): Promise<T> {
    return await this.ctx.with('binary-request', { method }, async (ctx) => {
      const clientInfo = session.clientHost ?? session.sessionId
      if (session.socket.isClosed) {
        throw new Error(`session is closed (client: ${clientInfo}), cannot send binary request ${method}`)
      }

      const id = `#b${this.msgIndex++}`
      const promise = new RequestPromise(method, [])
      promise.session = session

      // Pass meta separately from headers
      const meta = ctx.extractMeta()
      const frame = encodeBinaryRequest(id, method, data, meta, headers)

      // sendData is used both for the initial send and for resend after reconnect.
      promise.sendData = (): void => {
        const target = promise.session ?? session
        if (target.socket.isClosed) {
          return
        }
        promise.startTime = Date.now()
        try {
          void target.socket.sendRaw(this.ctx, frame)
        } catch (err: any) {
          this.ctx.error('failed to send binary frame', { err, id, method })
        }
      }
      promise.onDone = () => {
        const s = promise.session ?? session
        s.requests.delete(id)
      }

      this.requests.set(id, promise)
      session.requests.set(id, promise)

      try {
        promise.sendData()
      } catch (err: any) {
        this.requests.delete(id)
        session.requests.delete(id)
        throw err
      }

      try {
        return (await promise.promise) as T
      } finally {
        // Ensure cleanup regardless of resolve/reject path.
        this.requests.delete(id)
        ;(promise.session ?? session).requests.delete(id)
        this.notifySlotFree()
      }
    })
  }

  /**
   * Send a binary request to any connected session (round-robin) and wait for response.
   * Response can be either binary (Uint8Array) or JSON, depending on client handler.
   * @param ctx - measure context
   * @param method - method name to invoke
   * @param data - binary payload
   * @param headers - optional headers to pass to the client handler
   * @returns Promise with response data (binary or JSON based on client handler)
   */
  async binaryRequest<T = Uint8Array>(
    ctx: MeasureContext,
    method: string,
    data: Uint8Array,
    headers?: Record<string, any>,
    sessionCheck?: (session: Session) => boolean
  ): Promise<T> {
    let attempt = 0
    let lastNoSessionsLog = 0
    let lastRetryLog = 0
    let waitDelay = this.retryBackoffStartMs
    let retryDelay = this.retryBackoffStartMs
    while (true) {
      if (this.closed) {
        const err = new Error('server is closed')
        ;(err as any).code = 'SERVER_CLOSED'
        throw err
      }
      let sessions = Array.from(this.sessions.values())
      if (sessionCheck !== undefined) {
        sessions = sessions.filter(sessionCheck)
      }
      if (sessions.length === 0) {
        const now = Date.now()
        // Throttle "no clients" warning to avoid log spam.
        if (now - lastNoSessionsLog > RetryLogIntervalMs) {
          lastNoSessionsLog = now
          ctx.warn('binary request waiting for available client', { method, attempt, delayMs: waitDelay })
        }
        await this.sleepInterruptible(waitDelay)
        waitDelay = this.nextBackoff(waitDelay)
        continue
      }
      // Reset wait-for-session backoff once sessions are available.
      waitDelay = this.retryBackoffStartMs

      attempt++
      const s = this.pickSession(sessions)
      if (s === undefined) {
        const now = Date.now()
        if (now - lastNoSessionsLog > RetryLogIntervalMs) {
          lastNoSessionsLog = now
          ctx.warn('binary request waiting for client capacity', { method, attempt, delayMs: waitDelay })
        }
        await this.waitForSlot(waitDelay)
        waitDelay = this.nextBackoff(waitDelay)
        continue
      }
      waitDelay = this.retryBackoffStartMs
      const clientInfo = s.clientHost ?? s.sessionId

      try {
        return await this.sendBinaryRequest<T>(s, method, data, headers)
      } catch (err: any) {
        // Shutdown short-circuit: do not retry/log/sleep after the server is closed.
        if (this.closed || this.isClosedError(err)) {
          if (this.isClosedError(err)) throw err
          const closedErr = new Error('server is closed')
          ;(closedErr as any).code = 'SERVER_CLOSED'
          throw closedErr
        }
        const now = Date.now()
        if (now - lastRetryLog > RetryLogIntervalMs) {
          lastRetryLog = now
          ctx.warn('binary request retry', {
            method,
            attempt,
            client: clientInfo,
            error: err.message,
            delayMs: retryDelay
          })
        }
        await this.sleepInterruptible(retryDelay)
        retryDelay = this.nextBackoff(retryDelay)
        continue
      }
    }
  }

  async start (ctx: MeasureContext, port: number): Promise<void> {
    ctx.info('starting server on', {
      port,
      parallel: os.availableParallelism()
    })

    this.tickTimer = setInterval(() => {
      void this.handleTick()
    }, this.tickIntervalMs)
    // tickTimer will be cleared in `close()`; ensure tests call `server.close()` to cleanup timers
    this.app.use(cors())

    class MyStream {
      write (text: string): void {
        ctx.info(text)
      }
    }

    const myStream = new MyStream()

    this.app.use(morgan('short', { stream: myStream }))

    this.httpServer = http.createServer(this.app)
    this.wss = this.createWebsocketServer()

    this.wss.on('connection', (ws, request) => {
      void this.handleConnection(ws, request)
    })

    const wss = this.wss
    this.httpServer.on('upgrade', (request: IncomingMessage, socket: any, head: Buffer) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        void this.handleConnection(ws, request)
      })
    })
    this.httpServer.on('error', (err) => {
      ctx.error('server error', err)
    })

    this.httpServer.listen(port)
  }

  private createWebsocketServer (): WebSocketServer {
    return new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      skipUTF8Validation: true,
      maxPayload: 250 * 1024 * 1024,
      clientTracking: false
    })
  }

  async handleConnection (ws: WebSocket, request: IncomingMessage): Promise<void> {
    const data = {
      remoteAddress: request.socket.remoteAddress ?? '',
      userAgent: request.headers['user-agent'] ?? '',
      language: request.headers['accept-language'] ?? ''
    }
    const cs: ConnectionSocket = createWebsocketClientSocket(ws, data, this.rpcHandler, {
      compress: this.compress,
      uncompress: this.uncompress
    })

    const sid = randomUUID().toString()
    const session: Session = this.createSession(sid, cs)
    this.sessions.set(sid, session)

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    ws.on('message', async (msg: RawData) => {
      // Any incoming traffic from a client is a liveness signal, refresh lastPing
      // so the session is not falsely marked dead while it is actively communicating.
      session.lastPing = Date.now()
      await this.handleMessage(session, msg)
    })
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    ws.on('close', (code: number, reason: Buffer) => {
      this.sessions.delete(sid)
      // Reset lastPing so reconnect window starts from now.
      session.lastPing = Date.now()
      // Put into reconnect queue
      this.reconnectQueue.set(session.sessionId, session)
      this.ctx.info('connection closed', { code, reason: reason.toString(), user: session.sessionId })
    })

    ws.on('error', (err) => {
      Analytics.handleError(err)
      this.ctx.error('ws error', { err })
    })
  }

  private payloadToString (buf: Buffer): string {
    return buf.toString('utf-8')
  }

  private async unpackMessage (buff: any): Promise<any> {
    // Require compressed data. Decompress before parsing and fail fast if decompression errors.
    try {
      const uncmp: unknown = await this.uncompress(buff)
      if (Buffer.isBuffer(uncmp)) {
        return uncmp
      } else if (uncmp instanceof Uint8Array) {
        // Convert Uint8Array to Buffer (preserve bytes without assuming a specific backing ArrayBuffer)
        return Buffer.from(uncmp.buffer, uncmp.byteOffset, uncmp.byteLength)
      } else if (typeof uncmp === 'string') {
        // Unexpected but handle gracefully: convert UTF-8 string to Buffer so we can at least attempt parsing.
        return Buffer.from(uncmp, 'utf-8')
      } else {
        throw new Error(`decompress returned unexpected type: ${JSON.stringify({ type: typeof uncmp })}`)
      }
    } catch (err: any) {
      // Log detailed context and close the socket to surface the protocol error.
      throw new Error(`decompress failed unexpected type: ${err.message}`)
    }
  }

  private async handleMessage (session: Session, msg: RawData): Promise<void> {
    try {
      let buff: Buffer | undefined
      if (msg instanceof Buffer) {
        buff = msg
      } else if (Array.isArray(msg)) {
        buff = Buffer.concat(msg as any)
      }
      if (buff !== undefined) {
        try {
          // Inspect first byte frame type
          const ft = buff[0]
          if (ft === FRAME_PING || ft === FRAME_PONG) {
            session.lastPing = Date.now()
            if (ft === FRAME_PING) {
              // Send pong back
              try {
                session.socket.sendPong()
              } catch (err: any) {
                this.ctx.error('failed to send pong', { err })
              }
            }
            return
          }

          if (ft === FRAME_OP_STATUS_RESP) {
            // Client reports operation execution status. Payload is JSON: { id: string, executing: boolean }
            try {
              const payload = buff.slice(1)
              const obj = JSON.parse(payload.toString('utf8'))
              const rid = obj?.id
              const executing = obj?.executing
              if (typeof rid === 'string') {
                if (executing === false) {
                  const rr = this.requests.get(rid)
                  if (rr !== undefined) {
                    try {
                      rr.sendData()
                      // bump startTime so we don't immediately re-check
                      rr.startTime = Date.now()
                    } catch (err: any) {
                      this.ctx.error('failed to resend request after op status response', { err, id: rid })
                    }
                  } else {
                    this.ctx.error('unknown op status response id', { id: rid })
                  }
                }
              } else {
                this.ctx.error('invalid op status response payload', { payload: obj })
              }
            } catch (err: any) {
              this.ctx.error('failed to parse op status response', { err })
            }
            return
          }

          if (ft === FRAME_HELLO || ft === FRAME_HELLO_RESP) {
            // Hello carries an RPC-serialized payload (no compression) in either encoding.
            const payload = buff.slice(1)
            const request = session.socket.readRequest(payload, !isJsonBody(payload))
            await this.handleRequest(session, request)
            return
          }

          if (ft === FRAME_BINARY) {
            // Handle incoming binary request from client
            try {
              const binaryRequest = decodeBinaryRequest(
                new Uint8Array(buff.buffer, buff.byteOffset + 1, buff.byteLength - 1)
              )
              await this.handleBinaryRequest(
                session,
                binaryRequest.id,
                binaryRequest.method,
                binaryRequest.data,
                binaryRequest.meta,
                binaryRequest.headers
              )
            } catch (err: any) {
              this.ctx.error('failed to handle binary request', { err })
            }
            return
          }

          if (ft === FRAME_BINARY_RESP) {
            // Handle binary response from client (for server-initiated binary requests)
            try {
              const response = decodeBinaryResponse(
                new Uint8Array(buff.buffer, buff.byteOffset + 1, buff.byteLength - 1)
              )
              const promise = this.requests.get(response.id)
              if (promise !== undefined) {
                this.requests.delete(response.id)
                if (response.error !== undefined) {
                  promise.reject(new Error(response.error))
                } else {
                  promise.resolve(response.data ?? new Uint8Array(0))
                }
              } else {
                this.ctx.error('unknown binary response id', { id: response.id })
              }
            } catch (err: any) {
              this.ctx.error('failed to parse binary response', { err })
            }
            return
          }

          const frame = readDataFrame(buff, session.socket.format)
          if (frame !== undefined) {
            // A view, not a copy: this runs on every incoming message.
            let body: Buffer = Buffer.from(frame.body.buffer, frame.body.byteOffset, frame.body.byteLength)
            if (frame.compressed) {
              try {
                const dec = await this.uncompress(body)
                if (Buffer.isBuffer(dec)) {
                  body = dec
                } else if (dec instanceof Uint8Array) {
                  body = Buffer.from(dec.buffer, dec.byteOffset, dec.byteLength)
                } else {
                  throw new Error('decompress returned unexpected type')
                }
              } catch (err: any) {
                this.ctx.error('failed to decompress incoming message', {
                  err,
                  len: buff.length,
                  sid: session.sid,
                  preview: buff.slice(0, Math.min(20, buff.length)).toString('hex')
                })
                session.socket.close()
                return
              }
            }
            let request: Request<any>
            try {
              request = codecFor(frame.codec).decodeRequest(this.rpcHandler, body)
            } catch (err: any) {
              this.ctx.error('failed to parse data frame', { err, frame: ft })
              session.socket.close()
              return
            }
            await this.handleRequest(session, request)
            return
          }

          // Unknown frame - try to parse as compressed message (backwards compatibility)
          let requestBuffer: Buffer
          try {
            requestBuffer = await this.unpackMessage(buff)
          } catch (err: any) {
            // Log detailed context and close the socket to surface the protocol error.
            this.ctx.error('failed to decompress incoming message', {
              err,
              len: buff.length,
              sid: session.sid,
              preview: buff.slice(0, Math.min(20, buff.length)).toString('hex')
            })
            session.socket.close()
            return
          }

          const request = session.socket.readRequest(requestBuffer, true)

          await this.handleRequest(session, request)
        } catch (err: any) {
          if (((err.message as string) ?? '').includes('Data read, but end of buffer not reached')) {
            // ignore it
          } else {
            throw err
          }
        }
      }
    } catch (err: any) {
      Analytics.handleError(err)
      this.ctx.error('message error', { err })
    }
  }

  /**
   * Handle incoming binary request from client
   * Handler can return Uint8Array for binary response, or any other type for JSON response
   */
  private async handleBinaryRequest (
    session: Session,
    id: string,
    method: string,
    data: Uint8Array,
    meta?: Record<string, any>,
    headers?: Record<string, any>
  ): Promise<void> {
    session.lastRequest = Date.now()

    const handler = this.binaryHandler
    if (handler === undefined) {
      this.ctx.error('no binary handler registered', { method })
      const responseFrame = encodeBinaryResponse(id, undefined, 'No binary handler registered')
      await session.socket.sendRaw(this.ctx, responseFrame)
      return
    }

    try {
      const result = await this.ctx.with(
        'handle-binary',
        { method },
        async () => await handler(session, method, data, headers),
        {},
        {
          meta: meta ?? {}
        }
      )

      // Check if result is binary (Uint8Array) or JSON
      if (result instanceof Uint8Array) {
        // Send binary response
        const responseFrame = encodeBinaryResponse(id, result)
        await session.socket.sendRaw(this.ctx, responseFrame)
      } else {
        // Send JSON response via standard RPC mechanism
        const response: Response<any> = {
          id,
          result,
          time: Date.now()
        }
        await session.socket.send(this.ctx, response)
      }
    } catch (err: any) {
      const responseFrame = encodeBinaryResponse(id, undefined, err.message ?? 'Unknown error')
      await session.socket.sendRaw(this.ctx, responseFrame)
    }
  }

  private async handleRequest (session: Session, request: Request<any>): Promise<void> {
    // Check if hello is not received yet.
    if (session.hello === undefined) {
      // Assume request is hello one
      const hello = request as HelloRequest
      void this.checkHello(session, hello, session.socket)
      return
    }

    // Handle responses to server's previous requests (client -> server reply to '#...' messages)
    if (request.id !== undefined && request.method === callbackMethod) {
      const rr = this.requests.get(request.id)
      this.requests.delete(request.id)
      if (rr !== undefined) {
        const [response, error] = request.params
        // JSON turns an explicit `undefined` slot into null, so an absent error reads as null here.
        if (error != null) {
          // Handle error response from client
          const errorMessage = error.message ?? 'Unknown error from client callback'
          const err = new Error(errorMessage)
          if (error.stack !== undefined) {
            err.stack = error.stack
          }
          rr.reject(err)
        } else {
          // Handle successful response
          void rr.handleResult?.(response)
          rr.resolve(response)
        }
        rr.onDone?.()
        return
      }
    }

    // Ok we authorized - invoke registered handlers
    void this.messageHandler?.(this.ctx, request.method, request.params, session)
      .then((result) => {
        const resp: Response<any> = {
          id: request.id,
          result
        }
        void session.socket.send(this.ctx, resp)
      })
      .catch((err) => {
        const resp: Response<any> = {
          id: request.id,
          result: undefined,
          error: unknownError(err)
        }
        void session.socket.send(this.ctx, resp)
      })
  }

  private createSession (sid: string, cs: ConnectionSocket, clientHost?: string): Session {
    return {
      hello: undefined,
      createTime: Date.now(),
      sid,
      sessionId: sid,
      clientHost,
      requests: new Map<string, any>(),
      lastRequest: Date.now(),
      lastPing: Date.now(),
      socket: cs,
      options: {}
    }
  }

  async close (): Promise<void> {
    this.closed = true
    // Wake up any retry loop sleeping on sleepInterruptible so they observe
    // `this.closed` immediately instead of after the full backoff window.
    const waiters = this.closeWaiters
    this.closeWaiters = []
    for (const w of waiters) {
      try {
        w()
      } catch (_e) {}
    }
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer)
      this.tickTimer = undefined
    }
    // Reject any in-flight requests so callers (including those waiting in the
    // round-robin retry loop with `await sendRequest(...)`) get a synchronous
    // rejection on shutdown instead of dangling forever.
    for (const [rid, r] of this.requests) {
      this.requests.delete(rid)
      const err = new Error('server is closed')
      ;(err as any).code = 'SERVER_CLOSED'
      r.reject(err)
    }
    for (const session of this.sessions.values()) {
      session.requests.clear()
      try {
        session.socket.close()
      } catch (_e) {}
    }
    this.sessions.clear()
    this.bySessionId.clear()
    this.reconnectQueue.clear()
    if (this.wss !== undefined) {
      const wss = this.wss
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => {
          if (err != null) {
            reject(err)
          }
          resolve()
        })
      })
    }
    if (this.httpServer !== undefined) {
      const httpServer = this.httpServer
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => {
          if (err != null) {
            reject(err)
          }
          resolve()
        })
      )
    }
  }

  async checkHello (session: Session, hello: HelloRequest, cs: ConnectionSocket): Promise<void> {
    try {
      if (!(await this.validateToken(hello.token))) {
        throw new Error('Invalid token')
      }
      session.hello = hello
      session.sessionId = hello.sessionId ?? session.sessionId
      session.clientHost = hello.clientHost

      const oldSession = this.reconnectQueue.get(session.sessionId) ?? this.bySessionId.get(session.sessionId)
      this.reconnectQueue.delete(session.sessionId)

      let event: ConnectionEventType = 'connected'
      if (oldSession !== undefined) {
        event = 'reconnect'
        // Transfer pending requests from old session to new session
        if (oldSession.requests != null) {
          for (const [reqId, request] of oldSession.requests) {
            session.requests.set(reqId, request)
            // Update the session reference in the request
            request.session = session
          }
        }
        // Update the server's main requests map - replace requests that were from the old session
        // with references to the new session, and resend server-initiated binary requests
        // (JSON callback resends are driven by the client side via reconnect()).
        for (const [reqId, request] of this.requests) {
          if (request.session === oldSession) {
            request.session = session
            if (typeof reqId === 'string' && reqId.startsWith('#b')) {
              try {
                request.sendData()
              } catch (err: any) {
                this.ctx.error('failed to resend binary request after reconnect', { err, id: reqId })
              }
            }
          }
        }
        oldSession.socket.close() // Just in case
      }
      for (const eh of this.eventHandlers) {
        try {
          await eh(session.sessionId, event)
        } catch (err: any) {
          this.ctx.error('event handler error', { err })
        }
      }

      this.bySessionId.set(session.sessionId, session)

      // Log client connection
      this.ctx.info('client connected', {
        sessionId: session.sessionId,
        client: session.clientHost,
        reconnect: oldSession !== undefined
      })

      // A client that predates negotiation offers nothing, and msgpack is all it can read.
      cs.format = negotiateFormat(hello.formats)

      const resp: HelloResponse = {
        reconnect: oldSession !== undefined,
        serverVersion: this.serverVersion,
        sessionId: session.sessionId,
        id: hello.id,
        result: 'hello',
        format: formatId(cs.format)
      }

      // Answer in the agreed codec, so a client without msgpack never has to read msgpack.
      // Hello is never compressed, so any codec is readable straight off the frame.
      const codec = codecFor(cs.format.codec)
      const out = Buffer.concat([Buffer.from([FRAME_HELLO_RESP]), Buffer.from(codec.encode(this.rpcHandler, resp))])
      await cs.sendRaw(this.ctx, out)
    } catch (err: any) {
      this.ctx.error('hello parse error', { err })
      this.sessions.delete(session.sid)
      cs.close()
    }
  }
}
export function createWebsocketClientSocket (
  ws: WebSocket,
  data: {
    remoteAddress: string
    userAgent: string
    language: string
  },
  rpcHandler: RPCHandler,
  opts?: { compress?: (input: any) => Promise<any>, uncompress?: (input: any) => Promise<any> }
): ConnectionSocket {
  const cs: ConnectionSocket = {
    id: randomUUID().toString(),
    isClosed: false,
    close: () => {
      cs.isClosed = true
      ws.close()
      ws.terminate()
    },
    isBackpressure: () => ws.bufferedAmount > backpressureSize,
    backpressure: async (ctx) => {
      if (ws.bufferedAmount < backpressureSize) {
        return
      }
      await ctx.with('backpressure', {}, async () => {
        while (ws.bufferedAmount > backpressureSize) {
          await setImmediate()
        }
      })
    },
    checkState: () => {
      if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) {
        ws.terminate()
        return false
      }
      return true
    },
    format: { ...legacyWireFormat },
    readRequest: (buffer: Buffer, binary: boolean) => {
      return rpcHandler.readRequest(buffer, binary)
    },
    data: () => data,
    sendPong: () => {
      if (ws.readyState !== ws.OPEN || cs.isClosed) {
        return
      }
      const buf = Buffer.from([FRAME_PONG])
      try {
        ws.send(buf, { binary: true })
      } catch (err: any) {
        const msg = `${err?.message ?? ''}`
        // Ignore common benign errors (not open / send before connected), but report others
        if (!msg.includes('WebSocket is not open') && !msg.includes('Send before connected')) {
          Analytics.handleError(err)
        }
      }
    },
    // Send raw Uint8/Buffer frame (first byte is frame type)
    sendRaw: async (ctx: MeasureContext, buf: Uint8Array | Buffer): Promise<void> => {
      if (ws.readyState !== ws.OPEN || cs.isClosed) {
        return
      }
      if (cs.isBackpressure()) {
        await cs.backpressure(ctx)
      }
      const st = performance.now()
      await new Promise<void>((resolve) => {
        const handleErr = (err?: Error): void => {
          ctx.measure('msg-send-delta', performance.now() - st)
          if (err != null) {
            // Always record the error in the context so metrics/alerts capture the event
            ctx.error('send error', { err })
            const msg = `${err?.message ?? ''}`
            // Only report unexpected errors to analytics; ignore benign transport noise
            if (!msg.includes('WebSocket is not open') && !msg.includes('Send before connected')) {
              Analytics.handleError(err)
            }
          }
          resolve()
        }
        try {
          ws.send(Buffer.from(buf as Buffer), { binary: true }, handleErr)
        } catch (err: any) {
          // If ws.send throws synchronously, forward to the same handler so the promise resolves
          handleErr(err)
        }
      })
    },
    // Send an RPC message, compressing only if larger than 1024 bytes
    send: async (ctx: MeasureContext, msg): Promise<void> => {
      if (ws.readyState !== ws.OPEN || cs.isClosed) {
        return
      }

      // We need to be sure all data is send before we will send more.
      if (cs.isBackpressure()) {
        await cs.backpressure(ctx)
      }

      // Use shared sendFrame utility
      const compressFn = opts?.compress ?? lazyCompress
      const sendFn = (data: Uint8Array): void => {
        const out = Buffer.from(data)
        const st = performance.now()
        ws.send(out, { binary: true }, (err?: Error) => {
          ctx.measure('msg-send-delta', performance.now() - st)
          if (err != null) {
            if (!`${err.message}`.includes('WebSocket is not open')) {
              ctx.error('send error', { err })
              Analytics.handleError(err)
            }
          }
        })
      }

      await sharedSendFrame(ctx, sendFn, msg, compressFn, cs.format)
    }
  }
  return cs
}

//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021 Hardcore Engineering Inc.
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
import {
  type ClientSocket,
  ClientSocketReadyState,
  FRAME_PING,
  FRAME_PONG,
  FRAME_OP_STATUS,
  FRAME_OP_STATUS_RESP,
  FRAME_HELLO,
  FRAME_HELLO_RESP,
  FRAME_BINARY,
  FRAME_BINARY_RESP,
  ClientConnectEvent,
  type OperationHandler,
  type ClientFactoryOptions,
  type HelloResponse,
  type HelloRequest,
  RequestPromise,
  callbackMethod,
  encodeBinaryRequest,
  encodeBinaryResponse,
  decodeBinaryResponse,
  decodeBinaryRequest,
  isJsonBody,
  legacyWireFormat,
  defaultFormats,
  parseFormatId,
  readDataFrame,
  wireCodecs,
  type WireFormat
} from './types'
import { type RateLimitInfo, type ReqId, type Response, RPCHandler } from '@hcengineering/rpc'
import { type MeasureContext } from '@hcengineering/measurements'
import { randomUUID } from 'crypto'
import { decodeFrameBody, sendFrame as sharedSendFrame } from './frame-utils'

// Lazy-import snappy at runtime to avoid initializing native handles during test collection
let _snappyCompress: ((input: any) => Promise<any>) | undefined
let _snappyUncompress: ((input: any) => Promise<any>) | undefined
const lazyCompress = async (input: any): Promise<any> => {
  if (_snappyCompress === undefined) {
    const m = await import('snappy')
    // Cache the bound functions so subsequent calls don't re-import
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

// Rollback lever: CLISR_FORMATS='msgpack/snappy' puts the wire back on msgpack without a code
// change. Comma separated, best first.
const envFormats = (): string[] | undefined => {
  const v = process.env.CLISR_FORMATS
  return v === undefined || v === '' ? undefined : v.split(',').map((it) => it.trim())
}

const SECOND = 1000
const pingTimeout = 10 * SECOND
const hangTimeout = 5 * 60 * SECOND
const dialTimeout = 30 * SECOND

const globalRPCHandler: RPCHandler = new RPCHandler()

interface OnConnectHandler {
  resolve: () => void
  reject: (err: Error) => void
}

export class ClisrClient {
  private websocket: ClientSocket | null = null
  private readonly requests = new Map<ReqId, RequestPromise>()
  private readonly pendingResponses = new Map<ReqId, { method: string, params: any[], meta: any }>()
  private readonly processingRequests = new Set<ReqId>()
  private lastId = 0
  private interval: any
  private dialTimer: any

  private sockets = 0
  private openAction: any

  private readonly sessionId: string | undefined
  private readonly clientHost: string | undefined
  private closed = false

  private pingResponse: number = Date.now()

  private helloReceived: boolean = false

  // What we offer at hello, and what the server actually picked.
  private readonly offeredFormats: string[]
  private format: WireFormat = { ...legacyWireFormat }

  private serverVersion: string | undefined

  onConnect?: (event: ClientConnectEvent, data: any) => Promise<void>

  rpcHandler: RPCHandler

  handlers: OperationHandler[] = []

  // Server callback handler (also support legacy `operationHandler` name)
  callbackHandler?: (ctx: MeasureContext, msg: string, args: any[]) => Promise<any>

  // Binary request handler for incoming binary requests from server
  // Can return Uint8Array for binary response, or any other type for JSON response
  binaryHandler?: (
    ctx: MeasureContext,
    method: string,
    data: Uint8Array,
    headers?: Record<string, any>
  ) => Promise<Uint8Array | any>

  // Overridable compression functions (default to snappy). Tests can override instance methods.
  compress: (input: any) => Promise<any> = lazyCompress
  uncompress: (input: any) => Promise<any> = lazyUncompress

  constructor (
    private readonly ctx: MeasureContext,
    private readonly url: string,
    handler: OperationHandler,
    private readonly tokenProvider: () => string,
    readonly opt?: ClientFactoryOptions
  ) {
    if (typeof window !== 'undefined' && typeof sessionStorage !== 'undefined') {
      // Find local session id in session storage only if user refresh a page.
      const sKey = 'session.id.' + this.url
      let sessionId = sessionStorage.getItem(sKey) ?? undefined
      if (sessionId === undefined) {
        sessionId = randomUUID().toString()
        console.log('Generate new SessionId', sessionId)
        this.sessionId = sessionId
      } else {
        this.sessionId = sessionId
        sessionStorage.removeItem(sKey)
      }
      window.addEventListener('beforeunload', () => {
        sessionStorage.setItem(sKey, sessionId)
      })
    } else {
      this.sessionId = randomUUID().toString()
    }
    this.offeredFormats = opt?.formats ?? envFormats() ?? defaultFormats
    // A typo in CLISR_FORMATS would otherwise show up only as a silent fall back to msgpack.
    const unknown = this.offeredFormats.filter((it) => parseFormatId(it) === undefined)
    if (unknown.length > 0) {
      ctx.warn('ignoring wire formats this build cannot speak', { formats: unknown })
    }
    this.rpcHandler = (opt?.useGlobalRPCHandler ?? true) ? globalRPCHandler : new RPCHandler()
    this.pushHandler(handler)
    this.onConnect = opt?.onConnect

    // Apply optional compression overrides from factory options
    this.compress = opt?.compress ?? this.compress
    this.uncompress = opt?.uncompress ?? this.uncompress

    // Store client host for identification
    this.clientHost = opt?.clientHost

    // Auto-start connection by default, but allow tests to opt out for deterministic cleanup
    if (opt?.autoStart ?? true) {
      this.scheduleOpen(this.ctx, false)
    }
  }

  pushHandler (handler: OperationHandler): void {
    this.handlers.push(handler)
  }

  private schedulePing (socketId: number): void {
    this.pingResponse = Date.now()
    const wSocket = this.websocket

    clearInterval(this.interval)
    this.interval = setInterval(() => {
      if (wSocket !== this.websocket) {
        clearInterval(this.interval)
        return
      }
      if (this.pingResponse !== 0 && Date.now() - this.pingResponse > hangTimeout) {
        // No ping response from server.

        if (this.websocket !== null) {
          this.ctx.info('no ping response from server. Closing socket.', { socketId })
          clearInterval(this.interval)
          this.websocket.close(1000)
          return
        }
      }

      if (!this.closed) {
        // Send a one-byte ping frame and rely on incoming pong frame to update pingResponse
        try {
          this.websocket?.send(new Uint8Array([FRAME_PING]))
        } catch (err: any) {
          this.ctx.error('failed to send ping frame', { err })
        }
      } else {
        clearInterval(this.interval)
      }
    }, pingTimeout)
    // Timer will be cleared on close(); ensure tests call `client.close()` to cleanup timers
  }

  async close (): Promise<void> {
    this.closed = true
    clearTimeout(this.openAction)
    clearTimeout(this.dialTimer)
    clearInterval(this.interval)
    for (const handler of this.onConnectHandlers) {
      handler.reject(new Error('Connection closed'))
    }
    for (const req of this.requests.values()) {
      req.reject(new Error('Connection closed'))
    }
    if (this.websocket !== null) {
      this.websocket.close(1000)
      this.websocket = null
    }
  }

  isConnected (): boolean {
    return this.websocket != null && this.websocket.readyState === ClientSocketReadyState.OPEN && this.helloReceived
  }

  delay = 0
  onConnectHandlers: OnConnectHandler[] = []

  private waitOpenConnection (ctx: MeasureContext): Promise<void> | undefined {
    if (this.isConnected()) {
      return undefined
    }

    return ctx.with(
      'wait-connection',
      {},
      (ctx) =>
        new Promise((resolve, reject) => {
          this.onConnectHandlers.push({
            resolve,
            reject
          })
          // Websocket is null for first time
          this.scheduleOpen(ctx, false)
        })
    )
  }

  scheduleOpen (ctx: MeasureContext, force: boolean): void {
    if (force) {
      ctx.withSync('close-ws', {}, () => {
        if (this.websocket !== null) {
          this.websocket.close()
          this.websocket = null
        }
      })
      clearTimeout(this.openAction)
      this.openAction = undefined
    }
    clearInterval(this.interval)
    if (!this.closed && this.openAction === undefined) {
      if (this.websocket === null) {
        const socketId = ++this.sockets
        // Re create socket in case of error, if not closed
        if (this.delay === 0) {
          this.openConnection(ctx, socketId)
        } else {
          this.openAction = setTimeout(() => {
            this.openAction = undefined
            this.openConnection(ctx, socketId)
          }, this.delay * 1000)
          // openAction will be cleared via clearTimeout in `close()` or overwritten by subsequent scheduleOpen calls
        }
      }
    }
  }

  currentRateLimit: RateLimitInfo | undefined
  slowDownTimer = 0

  handleHello (socketId: number, resp: Response<any>): void {
    const helloResp = resp as HelloResponse

    if (this.serverVersion !== undefined && helloResp.serverVersion !== this.serverVersion) {
      // Server version changed
      this.opt?.onUpgrade?.(helloResp.serverVersion)
    }
    this.serverVersion = helloResp.serverVersion

    // We need to clear dial timer, since we receive hello response.
    clearTimeout(this.dialTimer)
    this.dialTimer = undefined

    const serverVersion = helloResp.serverVersion

    if (this.opt?.onHello !== undefined && !this.opt.onHello(serverVersion)) {
      this.closed = true
      this.websocket?.close()
      return
    }
    this.helloReceived = true
    // A server without negotiation answers with no `format`: stay on msgpack.
    this.format = (helloResp.format !== undefined ? parseFormatId(helloResp.format) : undefined) ?? {
      ...legacyWireFormat
    }

    // Notify all waiting connection listeners
    const handlers = this.onConnectHandlers.splice(0, this.onConnectHandlers.length)
    for (const h of handlers) {
      h.resolve()
    }

    for (const [, v] of this.requests.entries()) {
      v.reconnect?.()
    }

    const event = helloResp.reconnect === true ? ClientConnectEvent.Reconnected : ClientConnectEvent.Connected
    const onConnectP = this.onConnect?.(event, this.sessionId)
    void onConnectP
      ?.then(() => {})
      .catch((err) => {
        this.ctx.error('failed to call onConnect', { err })
      })

    // If this is a reconnection, send any pending responses that were not sent before disconnect
    if (helloResp.reconnect === true && this.pendingResponses.size > 0) {
      this.ctx.info('Sending pending responses after reconnect', { count: this.pendingResponses.size })
      for (const [respId, response] of this.pendingResponses) {
        const responseToSend = {
          method: response.method,
          params: response.params,
          meta: response.meta,
          id: respId,
          time: Date.now()
        }
        // Send the response without waiting, as it's best effort
        void this.sendResponse(responseToSend, respId)
      }
    }

    this.schedulePing(socketId)
  }

  async handleMsg (socketId: number, resp: Response<any>): Promise<void> {
    if (this.closed) {
      return
    }

    this.handleRateLimitMsg(resp)

    if (resp.error !== undefined) {
      if (resp.terminate === true) {
        this.closed = true
        this.websocket?.close()
        this.opt?.onError?.(resp.error.code)
      }

      if (resp.id !== undefined) {
        const promise = this.requests.get(resp.id)

        // Support rate limits
        if (resp.rateLimit !== undefined) {
          const { remaining, retryAfter } = resp.rateLimit
          if (remaining === 0) {
            void new Promise((resolve) => setTimeout(resolve, retryAfter ?? 1)).then(() => {
              // Retry after a while, so rate limits allow to call more.
              promise?.sendData()
            })
            return
          }
        }

        if (promise !== undefined) {
          promise.reject(new Error(`resp.error:${JSON.stringify(resp.error)}`))
        }
      }

      return
    }

    if (resp.id === -1) {
      this.delay = 0
      if (resp.result === 'hello') {
        this.handleHello(socketId, resp)
        return
      } else {
        Analytics.handleError(new Error(`unexpected response: ${JSON.stringify(resp)}`))
      }
      return
    }
    if (resp.id !== undefined) {
      if (typeof resp.id === 'string' && resp.id.startsWith('#')) {
        // A request from server
        void this.handleCallbackMsg(resp).catch((err) => {
          this.ctx.error('failed to process callback', { err })
        })
        return
      }

      const request = this.requests.get(resp.id)
      if (request === undefined) {
        this.ctx.error('unknown response id', { id: resp.id, requests: Array.from(this.requests.keys()) })
        return
      }

      if (resp.chunk !== undefined) {
        request.chunks = [
          ...(request.chunks ?? []),
          {
            index: resp.chunk.index,
            data: resp.result as any[]
          }
        ]
        if (resp.chunk.final) {
          request.chunks.sort((a, b) => a.index - b.index)
          let result: any[] = []

          for (const c of request.chunks) {
            result = result.concat(c.data)
          }
          resp.result = result
          resp.chunk = undefined
        } else {
          // Not all chunks are available yet.
          return
        }
      }

      request.handleTime?.(Date.now() - request.startTime, resp.result, resp.time ?? 0, resp.queue ?? 0)
      // Remove pending request before resolving/rejecting so state is consistent for logs/observers.
      this.requests.delete(resp.id)
      if (resp.error !== undefined) {
        this.ctx.error('response contains error', { id: resp.id, err: resp.error })
        request.reject(new Error(`resp.error:${JSON.stringify(resp.error)}`))
      } else {
        if (request?.handleResult !== undefined) {
          void request
            .handleResult(resp.result)
            .then(() => {
              request.resolve(resp.result)
            })
            .catch((err) => {
              this.ctx.error('failed to handleResult', { err })
            })
        } else {
          request.resolve(resp.result)
        }
      }
    } else {
      const txArr = Array.isArray(resp.result) ? resp.result : [resp.result]
      this.handlers.forEach((handler) => {
        handler(txArr)
      })
    }
  }

  private async handleCallbackMsg (resp: Response<any>): Promise<void> {
    const handlerFn = this.callbackHandler
    if (resp.id === undefined) {
      return
    }
    if (handlerFn !== undefined) {
      const { method, params, meta } = resp.result ?? {}
      const id = resp.id // Capture id in a variable that TypeScript knows is defined

      // Track that we are processing this operation so status checks can detect it.
      this.processingRequests.add(id)

      // Call the handler function and handle the result or error
      try {
        // Call the handler and await the result (handler should return a value or throw an error)
        const result = await this.ctx.with(
          'handle-callback',
          {},
          async (ctx) => await handlerFn(ctx, method, params ?? []),
          {},
          {
            meta
          }
        )

        // Store the response to be sent in [response, error] format
        const responseToSend = {
          method: callbackMethod,
          params: [result, undefined], // [response, error]
          meta,
          id,
          time: Date.now()
        }

        // Store in pending responses in case we need to resend after reconnect
        this.pendingResponses.set(id, responseToSend)

        await this.sendResponse(responseToSend, id)
      } catch (error: any) {
        // Send error back to the server in [response, error] format
        const message = { message: error.message ?? 'Unknown error', stack: error.stack }
        await this.sendError(resp as any, message, {})
      } finally {
        // Operation finished processing (we either sent a response or an error)
        this.processingRequests.delete(id)
      }
    } else {
      // Send error back to the server in [response, error] format
      await this.sendError(resp as any, { message: 'No callback defined' }, {})
    }
  }

  private async sendError (resp: Response<any> & { id: ReqId }, message: any, meta: any): Promise<void> {
    // Send error back to the server in [response, error] format
    const errorResponse = {
      method: callbackMethod,
      params: [undefined, message], // [response, error]
      meta,
      id: resp.id,
      time: Date.now()
    }

    // Store in pending responses in case we need to resend after reconnect
    this.pendingResponses.set(resp.id, errorResponse)

    await this.sendResponse(errorResponse, resp.id)
  }

  private async sendResponse (responseToSend: any, respId: ReqId): Promise<void> {
    try {
      // Wait for connection to be ready before sending
      if (this.websocket == null || this.websocket.readyState !== ClientSocketReadyState.OPEN) {
        // Wait for connection to be established
        const connectionPromise = this.waitOpenConnection(this.ctx)
        if (connectionPromise instanceof Promise) {
          await connectionPromise
        }
      }

      const sendFn = (data: Uint8Array): void => {
        this.websocket?.send(data)
      }
      await sharedSendFrame(this.ctx, sendFn, responseToSend, this.compress, this.format)

      // Remove from pending responses after successful send
      this.pendingResponses.delete(respId)
    } catch (err: any) {
      this.ctx.error('failed to send operation response', { err })
      this.websocket?.close()
    }
  }

  private handleRateLimitMsg (resp: Response<any>): void {
    if (resp.rateLimit !== undefined && resp.rateLimit.remaining < 50) {
      this.currentRateLimit = resp.rateLimit
      if (this.currentRateLimit.remaining < this.currentRateLimit.limit / 3) {
        if (this.slowDownTimer < 50) {
          this.slowDownTimer += 50
        }
        this.slowDownTimer++
      } else if (this.slowDownTimer > 0) {
        this.slowDownTimer--
      }
    }
  }

  checkArrayBufferPing (data: Uint8Array): boolean {
    if (data.byteLength === 0) return false
    const ft = data[0]
    if (ft === FRAME_PING) {
      // respond with pong frame
      try {
        this.websocket?.send(new Uint8Array([FRAME_PONG]))
      } catch (err: any) {
        this.ctx.error('failed to send pong', { err })
      }
      return true
    }
    if (ft === FRAME_PONG) {
      this.pingResponse = Date.now()
      return true
    }
    return false
  }

  private openConnection (ctx: MeasureContext, socketId: number): void {
    // Force binary mode for simplicity
    this.helloReceived = false
    this.format = { ...legacyWireFormat }
    // Use defined factory or browser default one.
    const clientSocketFactory =
      this.opt?.socketFactory ??
      ((url: string) => {
        const s = new WebSocket(url)
        // s.binaryType = 'arraybuffer'
        return s as ClientSocket
      })

    if (socketId !== this.sockets) {
      return
    }
    const wsocket = ctx.withSync('create-socket', {}, () => clientSocketFactory(this.url))

    if (socketId !== this.sockets) {
      wsocket.close()
      return
    }
    this.websocket = wsocket
    if (this.dialTimer === undefined) {
      this.dialTimer = setTimeout(() => {
        this.dialTimer = undefined
        if (!this.closed) {
          void this.opt?.onDialTimeout?.()?.catch((err) => {
            this.ctx.error('failed to handle dial timeout', { err })
          })
          this.scheduleOpen(this.ctx, true)
        }
      }, dialTimeout)
      // dialTimer will be cleared when socket receives hello or when client is closed
    }

    wsocket.onmessage = async (event: MessageEvent) => {
      /* onmessage received */
      if (this.closed) {
        return
      }
      if (this.websocket !== wsocket) {
        return
      }
      // If data is raw bytes (ArrayBuffer/Blob) we expect framed messages with first byte
      const handleFrame = async (u8: Uint8Array): Promise<void> => {
        const ft = u8[0]
        if (ft === FRAME_PING) {
          // Respond with pong
          try {
            this.websocket?.send(new Uint8Array([FRAME_PONG]))
          } catch (err: any) {
            this.ctx.error('failed to send pong frame', { err })
          }
          return
        }
        if (ft === FRAME_PONG) {
          this.pingResponse = Date.now()
          return
        }
        if (ft === FRAME_OP_STATUS) {
          // Operation status check from server: payload is JSON { id: string }
          const payload = u8.subarray(1)
          try {
            const text = new TextDecoder().decode(payload)
            const obj = JSON.parse(text)
            const opId = obj?.id
            const executing =
              (this.processingRequests?.has(opId) ?? false) || (this.pendingResponses?.has(opId) ?? false)
            const respObj = { id: opId, executing }
            const respBytes = new TextEncoder().encode(JSON.stringify(respObj))
            const out = new Uint8Array(1 + respBytes.length)
            out[0] = FRAME_OP_STATUS_RESP
            out.set(respBytes, 1)
            try {
              this.websocket?.send(out)
            } catch (err: any) {
              this.ctx.error('failed to send op status response', { err })
            }
          } catch (err: any) {
            this.ctx.error('failed to parse op status request', { err })
          }
          return
        }
        if (ft === FRAME_BINARY_RESP) {
          // Handle binary response - use unified requests map
          try {
            const response = decodeBinaryResponse(u8.subarray(1))
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
        if (ft === FRAME_BINARY) {
          // Handle incoming binary request from server
          try {
            const {
              id: reqId,
              method: reqMethod,
              data: reqData,
              meta: reqMeta,
              headers: reqHeaders
            } = decodeBinaryRequest(u8.subarray(1))

            if (this.binaryHandler !== undefined) {
              try {
                const result = await this.ctx.with(
                  'handle-binary',
                  {},
                  async (ctx) => await this.binaryHandler?.(ctx, reqMethod, reqData, reqHeaders),
                  {},
                  {
                    meta: reqMeta ?? {}
                  }
                )

                // Check if result is binary (Uint8Array) or JSON
                if (result instanceof Uint8Array) {
                  // Send binary response
                  const responseFrame = encodeBinaryResponse(reqId, result)
                  this.websocket?.send(responseFrame)
                } else {
                  // Send JSON response using callbackMethod pattern (same as regular callbacks)
                  const responseToSend = {
                    method: callbackMethod,
                    params: [result, undefined], // [response, error]
                    id: reqId,
                    time: Date.now()
                  }
                  await sharedSendFrame(
                    this.ctx,
                    (data) => this.websocket?.send(data),
                    responseToSend,
                    this.compress,
                    this.format
                  )
                }
              } catch (err: any) {
                // Send error using callbackMethod pattern
                const errorResponse = {
                  method: callbackMethod,
                  params: [undefined, { message: err.message ?? 'Unknown error' }],
                  id: reqId,
                  time: Date.now()
                }
                await sharedSendFrame(
                  this.ctx,
                  (data) => this.websocket?.send(data),
                  errorResponse,
                  this.compress,
                  this.format
                )
              }
            } else {
              this.ctx.error('no binary handler registered', { method: reqMethod })
              // Send error using callbackMethod pattern
              const errorResponse = {
                method: callbackMethod,
                params: [undefined, { message: 'No binary handler registered' }],
                id: reqId,
                time: Date.now()
              }
              await sharedSendFrame(
                this.ctx,
                (data) => this.websocket?.send(data),
                errorResponse,
                this.compress,
                this.format
              )
            }
          } catch (err: any) {
            this.ctx.error('failed to handle binary request', { err })
          }
          return
        }
        if (ft === FRAME_HELLO_RESP || ft === FRAME_HELLO) {
          const payload = u8.subarray(1)
          try {
            const codec = isJsonBody(payload) ? wireCodecs.json : wireCodecs.msgpack
            const resp = codec.decodeResponse(this.rpcHandler, payload)
            if (ft === FRAME_HELLO_RESP) {
              await this.handleMsg(socketId, resp)
            } else {
              // Received a hello? treat it as a message
              await this.handleMsg(socketId, resp)
            }
          } catch (err: any) {
            this.ctx.error('failed to parse hello response', { err })
            this.websocket?.close()
          }
          return
        }
        const frame = readDataFrame(u8, this.format)
        if (frame !== undefined) {
          try {
            const resp = await decodeFrameBody(
              this.rpcHandler,
              frame.body,
              frame.codec,
              frame.compressed,
              this.uncompress
            )
            await this.handleMsg(socketId, resp)
          } catch (err: any) {
            this.ctx.error('failed to parse data frame', { err, frame: ft })
            this.websocket?.close()
          }
          return
        }

        // Unknown frame: attempt legacy decompress path
        try {
          const dec = await this.uncompress(u8)
          let u8dec: Uint8Array
          if (Buffer.isBuffer(dec)) {
            u8dec = new Uint8Array(dec.buffer, dec.byteOffset, dec.byteLength)
          } else {
            u8dec = dec as unknown as Uint8Array
          }
          this.ctx.info('[ClisrClient] decompressed incoming data', { len: u8dec.byteLength })
          try {
            const resp = this.rpcHandler.readResponse<any>(u8dec, true)
            await this.handleMsg(socketId, resp)
          } catch (err: any) {
            this.ctx.error('failed to parse message after decompress', { err })
            this.websocket?.close()
          }
        } catch (err: any) {
          this.ctx.error('failed to decompress incoming data', { err })
          this.websocket?.close()
        }
      }

      if (event.data instanceof ArrayBuffer) {
        const u8 = new Uint8Array(event.data)
        if (this.checkArrayBufferPing(u8)) {
          return
        }
        await handleFrame(u8)
        return
      }
      // Node Buffer arrives as plain Buffer, treat similarly to ArrayBuffer
      if (Buffer.isBuffer(event.data)) {
        const buf = event.data
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        if (this.checkArrayBufferPing(u8)) {
          return
        }
        await handleFrame(u8)
        return
      }
      if (event.data instanceof Blob) {
        void event.data
          .bytes()
          .then(async (data) => {
            if (this.checkArrayBufferPing(data)) {
              // Support ping/pong
              return
            }
            await handleFrame(new Uint8Array(data))
          })
          .catch((err) => {
            this.ctx.error('failed to decode array buffer', { err })
          })
      } else {
        const data = event.data
        // Require decompression for all incoming messages. If uncompress fails we treat
        // it as a protocol error and close the connection.
        try {
          const dec = await this.uncompress(data)
          let u8: Uint8Array
          if (Buffer.isBuffer(dec)) {
            u8 = new Uint8Array(dec.buffer, dec.byteOffset, dec.byteLength)
          } else {
            u8 = dec as unknown as Uint8Array
          }
          this.ctx.info('[ClisrClient] decompressed incoming data', { len: u8.byteLength })
          try {
            const resp = this.rpcHandler.readResponse<any>(u8, true)
            await this.handleMsg(socketId, resp)
          } catch (err: any) {
            this.ctx.error('failed to parse message after decompress', { err })
            this.websocket?.close()
          }
        } catch (err: any) {
          this.ctx.error('failed to decompress incoming data', { err })
          this.websocket?.close()
        }
      }
    }
    wsocket.onclose = (ev) => {
      if (this.websocket !== wsocket) {
        wsocket.close()
        return
      }
      this.scheduleOpen(this.ctx, true)
    }
    wsocket.onopen = async () => {
      if (this.websocket !== wsocket) {
        return
      }
      /* socket opened */
      const helloRequest: HelloRequest = {
        method: 'hello',
        params: [],
        id: -1,
        token: this.tokenProvider(),
        sessionId: this.sessionId,
        clientHost: this.clientHost,
        formats: this.offeredFormats
      }
      // Hello itself stays msgpack: the format is not agreed yet, and every server version
      // reads this frame that way.
      const dta = wireCodecs.msgpack.encode(this.rpcHandler, helloRequest)
      try {
        const out = new Uint8Array(1 + dta.byteLength)
        out[0] = FRAME_HELLO
        out.set(new Uint8Array(dta), 1)
        ctx.withSync('send-hello', {}, () => this.websocket?.send(out))
        this.ctx.info('[ClisrClient] sent hello (framed)', { len: dta.byteLength })
      } catch (err: any) {
        this.ctx.error('failed to send hello', { err })
        this.websocket?.close()
      }
    }

    // FIX: remove undefined variable 'opened'
    wsocket.onerror = (dta) => {
      if (this.websocket !== wsocket) {
        return
      }
      if (this.delay < 3) {
        this.delay += 1
      }
      this.ctx.error('client websocket error', { socketId, url: this.url, dta })
    }
  }

  private sendRequest (data: {
    method: string
    params: any[]
    // If not defined, on reconnect with timeout, will retry automatically.
    retry?: () => Promise<boolean>
    handleResult?: (result: any) => Promise<void>
    once?: boolean // Require handleResult to retrieve result
    measure?: (time: number, result: any, serverTime: number, queue: number) => void
    allowReconnect?: boolean
    overrideId?: number
  }): Promise<any> {
    return this.ctx.with(
      'send-request',
      {},
      async (ctx) => {
        if (this.closed) {
          throw new Error(`connection is closed, cannot send request ${data.method}`)
        }

        if (this.slowDownTimer > 0) {
          // We need to wait a bit to avoid ban.
          await new Promise((resolve) => setTimeout(resolve, this.slowDownTimer))
        }

        if (data.once === true) {
          // Check if has same request already then skip
          const dparams = JSON.stringify(data.params)
          for (const [, v] of this.requests) {
            if (v.method === data.method && JSON.stringify(v.params) === dparams) {
              // We have same unanswered, do not add one more.
              return
            }
          }
        }

        const id: string = `_${data.overrideId ?? this.lastId++}` // For client requests use _ prefix
        const promise = new RequestPromise(data.method, data.params, data.handleResult)
        promise.handleTime = data.measure

        const w = this.waitOpenConnection(ctx)
        if (w instanceof Promise) {
          await w
        }
        this.requests.set(id, promise)
        promise.sendData = (): void => {
          if (this.websocket?.readyState === ClientSocketReadyState.OPEN) {
            promise.startTime = Date.now()

            // Use shared sendFrame utility
            void (async () => {
              try {
                const msg = {
                  method: data.method,
                  params: data.params,
                  meta: ctx.extractMeta(),
                  id,
                  time: Date.now()
                }
                const sendFn = (data: Uint8Array): void => {
                  this.websocket?.send(data)
                }
                await sharedSendFrame(this.ctx, sendFn, msg, this.compress, this.format)
              } catch (err: any) {
                this.ctx.error('failed to send request', { err })
                this.websocket?.close()
              }
            })()
          }
        }
        if (data.allowReconnect ?? true) {
          promise.reconnect = () => {
            const reconnectOp = async (): Promise<void> => {
              // In case we don't have response yet.
              if (this.requests.has(id) && ((await data.retry?.()) ?? true)) {
                promise.sendData()
              }
            }
            setTimeout(() => {
              void reconnectOp()
            }, 50)
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

  request<T = any>(method: string, params: any[], once: boolean = true): Promise<T> {
    return this.sendRequest({
      method,
      params,
      retry: async () => true,
      once,
      allowReconnect: true
    }) as Promise<T>
  }

  /**
   * Send a binary request to the server and wait for response.
   * Response can be either binary (Uint8Array) or JSON, depending on server handler.
   * @param method - method name to invoke
   * @param data - binary payload
   * @param headers - optional headers to pass to the server handler
   * @returns Promise with response data (binary or JSON based on server handler)
   */
  async binaryRequest<T = Uint8Array>(method: string, data: Uint8Array, headers?: Record<string, any>): Promise<T> {
    return await this.ctx.with('binary-request', { method }, async (ctx) => {
      if (this.closed) {
        throw new Error(`connection is closed, cannot send binary request ${method}`)
      }

      const w = this.waitOpenConnection(ctx)
      if (w instanceof Promise) {
        await w
      }

      const id = `_b${this.lastId++}`
      const promise = new RequestPromise(method, [])

      this.requests.set(id, promise)

      // Pass meta separately from headers
      const meta = ctx.extractMeta()

      try {
        const frame = encodeBinaryRequest(id, method, data, meta, headers)
        this.websocket?.send(frame)
      } catch (err: any) {
        this.requests.delete(id)
        throw err
      }

      return (await promise.promise) as T
    })
  }
}

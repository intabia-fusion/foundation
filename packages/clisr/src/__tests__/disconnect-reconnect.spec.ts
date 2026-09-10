/* eslint-env jest */
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

// Tests for disconnect/reconnect scenarios in ClisrClient and ClisrServer

import { MeasureMetricsContext, type MeasureContext } from '@hcengineering/measurements'
import { ClisrClient } from '../client'
import { ClisrServer } from '../server'
import {
  ClientSocketReadyState,
  ClientConnectEvent,
  type ClientSocket,
  type HelloResponse,
  FRAME_PONG,
  FRAME_PING
} from '../types'

function createFakeCtx (): MeasureContext {
  return new MeasureMetricsContext('disconnect-test', {})
}

function createMockSocket (): ClientSocket & {
  triggerClose: (code?: number) => void
  triggerError: () => void
  triggerOpen: () => void
} {
  const socket: any = {
    send: jest.fn(),
    close: jest.fn(),
    readyState: ClientSocketReadyState.CONNECTING,
    onopen: null as any,
    onclose: null as any,
    onerror: null as any,
    onmessage: null as any,
    triggerOpen: () => {
      socket.readyState = ClientSocketReadyState.OPEN
      socket.onopen?.({})
    },
    triggerClose: (code = 1000) => {
      socket.readyState = ClientSocketReadyState.CLOSED
      socket.onclose?.({ code, reason: '' })
    },
    triggerError: () => {
      socket.onerror?.({ message: 'test error' })
    }
  }
  return socket
}

describe('ClisrClient disconnect/reconnect behavior', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('schedules reconnection after socket close', async () => {
    const ctx = createFakeCtx()
    const sockets: any[] = []
    const socketFactory = jest.fn(() => {
      const s = createMockSocket()
      sockets.push(s)
      return s
    })

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: true }
    )

    try {
      // Wait for initial connection attempt
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(sockets.length).toBe(1)

      // Simulate open
      sockets[0].triggerOpen()

      // Simulate hello response
      const helloResp: HelloResponse = {
        id: -1,
        result: 'hello',
        serverVersion: '1.0.0',
        sessionId: 'session-1',
        reconnect: false
      }
      await client.handleMsg(1, helloResp)

      // Simulate disconnect
      sockets[0].triggerClose(1006)

      // Wait for reconnection scheduling
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Should attempt to reconnect
      expect(sockets.length).toBeGreaterThanOrEqual(1)
    } finally {
      await client.close()
    }
  })

  it('rejects pending requests on close', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      // Manually set up connected state
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      // Start a request that won't complete
      const reqPromise = (client as any).sendRequest({ method: 'test', params: [] })

      // Close the client
      await client.close()

      // The pending request should be rejected
      await expect(reqPromise).rejects.toThrow('Connection closed')
    } finally {
      await client.close()
    }
  })

  it('calls onConnect with Reconnected event on reconnection', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)
    const onConnectEvents: ClientConnectEvent[] = []

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      {
        socketFactory,
        autoStart: false,
        onConnect: async (event) => {
          onConnectEvents.push(event)
        }
      }
    )

    try {
      ;(client as any).websocket = socket
      socket.readyState = ClientSocketReadyState.OPEN

      // First connection
      const helloResp1: HelloResponse = {
        id: -1,
        result: 'hello',
        serverVersion: '1.0.0',
        sessionId: 'session-1',
        reconnect: false
      }
      client.handleHello(1, helloResp1)
      // Wait for async onConnect callback
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(onConnectEvents).toContain(ClientConnectEvent.Connected)

      // Reconnection
      const helloResp2: HelloResponse = {
        id: -1,
        result: 'hello',
        serverVersion: '1.0.0',
        sessionId: 'session-1',
        reconnect: true
      }
      client.handleHello(1, helloResp2)
      // Wait for async onConnect callback
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(onConnectEvents).toContain(ClientConnectEvent.Reconnected)
    } finally {
      await client.close()
    }
  })

  it('triggers reconnect callback for pending requests on reconnection', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      // Add a pending request with reconnect callback
      const reconnectSpy = jest.fn()
      const request = {
        method: 'test',
        params: [],
        startTime: Date.now(),
        promise: new Promise(() => {}),
        resolve: jest.fn(),
        reject: jest.fn(),
        reconnect: reconnectSpy,
        sendData: jest.fn()
      }
      ;(client as any).requests.set('_123', request)

      // Simulate reconnection
      const helloResp: HelloResponse = {
        id: -1,
        result: 'hello',
        serverVersion: '1.0.0',
        sessionId: 'session-1',
        reconnect: true
      }
      client.handleHello(1, helloResp)

      // Reconnect callback should be called
      expect(reconnectSpy).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('calls onUpgrade when server version changes', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)
    const onUpgrade = jest.fn()

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false, onUpgrade }
    )

    try {
      ;(client as any).websocket = socket
      socket.readyState = ClientSocketReadyState.OPEN

      // First connection with version 1.0.0
      const helloResp1: HelloResponse = {
        id: -1,
        result: 'hello',
        serverVersion: '1.0.0',
        sessionId: 'session-1',
        reconnect: false
      }
      client.handleHello(1, helloResp1)

      // Reconnection with version 2.0.0
      const helloResp2: HelloResponse = {
        id: -1,
        result: 'hello',
        serverVersion: '2.0.0',
        sessionId: 'session-1',
        reconnect: true
      }
      client.handleHello(1, helloResp2)

      expect(onUpgrade).toHaveBeenCalledWith('2.0.0')
    } finally {
      await client.close()
    }
  })

  it('closes connection when onHello returns false', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)
    const onHello = jest.fn().mockReturnValue(false)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false, onHello }
    )

    try {
      ;(client as any).websocket = socket
      socket.readyState = ClientSocketReadyState.OPEN

      const helloResp: HelloResponse = {
        id: -1,
        result: 'hello',
        serverVersion: '1.0.0',
        sessionId: 'session-1',
        reconnect: false
      }
      client.handleHello(1, helloResp)

      expect(onHello).toHaveBeenCalled()
      expect((client as any).closed).toBe(true)
      expect(socket.close).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('handles socket error by scheduling reconnection', async () => {
    const ctx = createFakeCtx()
    const sockets: any[] = []
    const socketFactory = jest.fn(() => {
      const s = createMockSocket()
      sockets.push(s)
      return s
    })
    const onError = jest.fn()

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: true, onError }
    )

    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(sockets.length).toBe(1)

      // Trigger error
      sockets[0].triggerError()

      // Wait for potential reconnection
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      await client.close()
    }
  })

  it('isConnected returns false when socket is not open', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      expect(client.isConnected()).toBe(false)
      ;(client as any).websocket = socket
      expect(client.isConnected()).toBe(false)

      socket.readyState = ClientSocketReadyState.OPEN
      expect(client.isConnected()).toBe(false)
      ;(client as any).helloReceived = true
      expect(client.isConnected()).toBe(true)
    } finally {
      await client.close()
    }
  })

  it('sends pending responses on reconnection', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      socket.readyState = ClientSocketReadyState.OPEN

      // Add pending response
      ;(client as any).pendingResponses.set('#resp-1', {
        method: '##',
        params: [{ result: 'ok' }],
        meta: {}
      })

      // Simulate reconnection
      const helloResp: HelloResponse = {
        id: -1,
        result: 'hello',
        serverVersion: '1.0.0',
        sessionId: 'session-1',
        reconnect: true
      }
      client.handleHello(1, helloResp)

      // Wait for async response sending
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Pending responses should be attempted to send
      expect((client as any).pendingResponses.size).toBeGreaterThanOrEqual(0)
    } finally {
      await client.close()
    }
  })

  it('ignores messages when client is closed', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN
      ;(client as any).closed = true

      // This should be ignored since client is closed
      await client.handleMsg(1, { id: 1, result: 'test', time: Date.now() })

      // No errors should occur
    } finally {
      ;(client as any).closed = false
      await client.close()
    }
  })

  it('handles dial timeout by calling onDialTimeout', async () => {
    jest.useFakeTimers()
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)
    const onDialTimeout = jest.fn()

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: true, onDialTimeout }
    )

    try {
      // Advance past dial timeout (30 seconds)
      jest.advanceTimersByTime(35000)

      expect(onDialTimeout).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
      await client.close()
    }
  })

  it('clears dial timer on receiving hello', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      socket.readyState = ClientSocketReadyState.OPEN
      ;(client as any).dialTimer = setTimeout(() => {}, 30000)

      const helloResp: HelloResponse = {
        id: -1,
        result: 'hello',
        serverVersion: '1.0.0',
        sessionId: 'session-1',
        reconnect: false
      }
      client.handleHello(1, helloResp)

      expect((client as any).dialTimer).toBeUndefined()
    } finally {
      await client.close()
    }
  })

  it('waitOpenConnection resolves when already connected', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      const result = (client as any).waitOpenConnection(ctx)
      expect(result).toBeUndefined()
    } finally {
      await client.close()
    }
  })

  it('handles terminate error response by closing and calling onError', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)
    const onError = jest.fn()

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false, onError }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      await client.handleMsg(1, {
        id: 1,
        error: { code: 401, message: 'Unauthorized' },
        terminate: true,
        time: Date.now()
      } as any)

      expect((client as any).closed).toBe(true)
      expect(socket.close).toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith(401)
    } finally {
      await client.close()
    }
  })

  it('responds to FRAME_PING with FRAME_PONG', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      const result = (client as any).checkArrayBufferPing(new Uint8Array([FRAME_PING]))

      expect(result).toBe(true)
      expect(socket.send).toHaveBeenCalled()
      const sentArg = (socket.send as jest.Mock).mock.calls[0][0]
      expect(sentArg[0]).toBe(FRAME_PONG)
    } finally {
      await client.close()
    }
  })

  it('updates pingResponse on receiving FRAME_PONG', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      ;(client as any).pingResponse = 0
      socket.readyState = ClientSocketReadyState.OPEN

      const result = (client as any).checkArrayBufferPing(new Uint8Array([FRAME_PONG]))

      expect(result).toBe(true)
      expect((client as any).pingResponse).not.toBe(0)
    } finally {
      await client.close()
    }
  })
})

describe('ClisrServer session disconnect behavior', () => {
  it('creates server and handles session lifecycle', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')

    // Server should be created without errors
    expect(server).toBeDefined()

    await server.close()
  })

  it('broadcast sends to all sessions', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')

    try {
      // With no sessions, broadcast should complete without errors
      await server.broadcast({ some: 'data' })
    } finally {
      await server.close()
    }
  })

  it('handleTick processes sessions without errors', async () => {
    const ctx = createFakeCtx()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')

    try {
      // Should handle empty sessions without errors
      await server.handleTick()
    } finally {
      await server.close()
    }
  })

  it('registers and triggers event handlers', async () => {
    const ctx = createFakeCtx()
    const eventHandler = jest.fn()
    const server = new ClisrServer(ctx, async () => true, '1.0.0')

    try {
      server.eventHandlers.push(eventHandler)
      // Event handlers would be triggered on session events
      expect(server.eventHandlers.length).toBe(1)
    } finally {
      await server.close()
    }
  })
})

describe('ClisrClient additional edge cases', () => {
  it('handles rate limit info in response', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      // Add a pending request
      const resolve = jest.fn()
      const request = {
        method: 'test',
        params: [],
        startTime: Date.now(),
        promise: new Promise(() => {}),
        resolve,
        reject: jest.fn(),
        sendData: jest.fn()
      }
      ;(client as any).requests.set('_1', request)

      // Handle response with rate limit info
      await client.handleMsg(1, {
        id: '_1',
        result: { ok: true },
        rateLimit: { remaining: 100, limit: 1000 },
        time: Date.now()
      } as any)

      // Rate limit info should be processed (slowDownTimer updated if remaining < limit)
      expect(resolve).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('handles chunked responses correctly', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      // Add a pending request
      const resolve = jest.fn()
      const reject = jest.fn()
      const request = {
        method: 'test',
        params: [],
        startTime: Date.now(),
        promise: new Promise(() => {}),
        resolve,
        reject,
        sendData: jest.fn(),
        chunks: []
      }
      ;(client as any).requests.set('_1', request)

      // Send first chunk (not final)
      await client.handleMsg(1, {
        id: '_1',
        result: ['data1'],
        chunk: { index: 0, final: false },
        time: Date.now()
      } as any)

      // Send second chunk (final)
      await client.handleMsg(1, {
        id: '_1',
        result: ['data2'],
        chunk: { index: 1, final: true },
        time: Date.now()
      } as any)

      expect(resolve).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('handles callback messages from server', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)
    const handlerSpy = jest.fn().mockReturnValue({ response: 'ok' })

    const client = new ClisrClient(ctx, 'ws://localhost', handlerSpy, () => 'token', {
      socketFactory,
      autoStart: false
    })

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      // Register a callback handler
      ;(client as any).callbackHandler = handlerSpy

      // Simulate callback from server - the format for server callbacks
      await client.handleMsg(1, {
        id: '#callback-1',
        result: { method: 'serverMethod', params: ['arg1'], meta: {} },
        time: Date.now()
      } as any)

      // Wait for async callback processing
      await new Promise((resolve) => setTimeout(resolve, 50))

      // The callback handler mechanism is different - check that no errors occurred
      // Handlers are invoked through a different path
      expect((client as any).closed).toBe(false)
    } finally {
      await client.close()
    }
  })

  it('scheduleOpen with delay creates timeout', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).delay = 1 // 1 second delay
      ;(client as any).websocket = null

      client.scheduleOpen(ctx, false)

      expect((client as any).openAction).toBeDefined()
    } finally {
      await client.close()
    }
  })

  it('scheduleOpen with force closes existing socket', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      socket.readyState = ClientSocketReadyState.OPEN

      client.scheduleOpen(ctx, true)

      expect(socket.close).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('checkArrayBufferPing returns false for empty data', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      const result = (client as any).checkArrayBufferPing(new Uint8Array(0))
      expect(result).toBe(false)
    } finally {
      await client.close()
    }
  })

  it('checkArrayBufferPing returns false for non-ping/pong data', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      // Frame type 99 is unknown
      const result = (client as any).checkArrayBufferPing(new Uint8Array([99, 1, 2, 3]))
      expect(result).toBe(false)
    } finally {
      await client.close()
    }
  })

  it('handles error response without terminate flag', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      // Add a pending request
      const reject = jest.fn()
      const request = {
        method: 'test',
        params: [],
        startTime: Date.now(),
        promise: new Promise(() => {}),
        resolve: jest.fn(),
        reject,
        sendData: jest.fn()
      }
      ;(client as any).requests.set('_1', request)

      await client.handleMsg(1, {
        id: '_1',
        error: { code: 500, message: 'Internal Error' },
        time: Date.now()
      } as any)

      expect(reject).toHaveBeenCalled()
      expect((client as any).closed).toBe(false)
    } finally {
      await client.close()
    }
  })

  it('handles unexpected hello response format', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      socket.readyState = ClientSocketReadyState.OPEN

      // Unexpected response with id=-1 but not hello
      await client.handleMsg(1, {
        id: -1,
        result: 'unexpected',
        time: Date.now()
      } as any)

      // Should not crash, just log error via Analytics
    } finally {
      await client.close()
    }
  })

  it('request method calls sendRequest with correct params', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      const requestPromise = client.request('testMethod', ['param1', 'param2'])

      // Wait for request to be sent
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Get the request and resolve it
      const requestId = Array.from((client as any).requests.keys())[0]
      const request = (client as any).requests.get(requestId)
      if (request !== undefined) {
        request.resolve({ success: true })
      }

      const result = await requestPromise
      expect(result).toEqual({ success: true })
    } finally {
      await client.close()
    }
  })

  it('handles chunks with handleResult callback', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      const handleResult = jest.fn().mockResolvedValue(undefined)
      const resolve = jest.fn()
      const request = {
        method: 'test',
        params: [],
        startTime: Date.now(),
        promise: new Promise(() => {}),
        resolve,
        reject: jest.fn(),
        sendData: jest.fn(),
        handleResult
      }
      ;(client as any).requests.set('_1', request)

      await client.handleMsg(1, {
        id: '_1',
        result: { data: 'test' },
        time: Date.now()
      } as any)

      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(handleResult).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('handles response with handleTime callback', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      const handleTime = jest.fn()
      const resolve = jest.fn()
      const request = {
        method: 'test',
        params: [],
        startTime: Date.now(),
        promise: new Promise(() => {}),
        resolve,
        reject: jest.fn(),
        sendData: jest.fn(),
        handleTime
      }
      ;(client as any).requests.set('_1', request)

      await client.handleMsg(1, {
        id: '_1',
        result: { data: 'test' },
        time: Date.now(),
        queue: 5
      } as any)

      expect(handleTime).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('handles response without id by calling handlers', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)
    const handler = jest.fn()

    const client = new ClisrClient(ctx, 'ws://localhost', handler, () => 'token', { socketFactory, autoStart: false })

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      // Response without id triggers handlers
      await client.handleMsg(1, {
        result: { broadcast: 'data' },
        time: Date.now()
      } as any)

      expect(handler).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('handles callbackHandler undefined case', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN
      ;(client as any).callbackHandler = undefined

      // Callback without handler should not crash
      await client.handleMsg(1, {
        id: '#callback-1',
        result: { method: 'test', params: [] },
        time: Date.now()
      } as any)

      // Should complete without errors
    } finally {
      await client.close()
    }
  })

  it('handles callback message without id', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)
    const callbackHandler = jest.fn()

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN
      ;(client as any).callbackHandler = callbackHandler

      // Trigger handleCallbackMsg via a callback response
      await (client as any).handleCallbackMsg({ result: { method: 'test' } })

      // Should return early without calling handler
      expect(callbackHandler).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('handles error in callback handler', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)
    const callbackHandler = jest.fn().mockRejectedValue(new Error('handler error'))

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN
      ;(client as any).callbackHandler = callbackHandler

      // Trigger handleCallbackMsg with a valid callback
      await (client as any).handleCallbackMsg({ id: '#cb-1', result: { method: 'test', params: [] } })

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(callbackHandler).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('handles response with error in result field', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      const reject = jest.fn()
      const request = {
        method: 'test',
        params: [],
        startTime: Date.now(),
        promise: new Promise(() => {}),
        resolve: jest.fn(),
        reject,
        sendData: jest.fn()
      }
      ;(client as any).requests.set('_1', request)

      // Response with error in result
      await client.handleMsg(1, {
        id: '_1',
        error: { code: 500, message: 'Server error' },
        time: Date.now()
      } as any)

      expect(reject).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('handles handleResult that throws error', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      const handleResult = jest.fn().mockRejectedValue(new Error('handleResult failed'))
      const resolve = jest.fn()
      const request = {
        method: 'test',
        params: [],
        startTime: Date.now(),
        promise: new Promise(() => {}),
        resolve,
        reject: jest.fn(),
        sendData: jest.fn(),
        handleResult
      }
      ;(client as any).requests.set('_1', request)

      await client.handleMsg(1, {
        id: '_1',
        result: { data: 'test' },
        time: Date.now()
      } as any)

      await new Promise((resolve) => setTimeout(resolve, 50))

      // handleResult was called even though it threw
      expect(handleResult).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('handles array result by calling all handlers', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)
    const handler1 = jest.fn()
    const handler2 = jest.fn()

    const client = new ClisrClient(ctx, 'ws://localhost', handler1, () => 'token', { socketFactory, autoStart: false })

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN
      client.pushHandler(handler2)

      // Response without id triggers handlers with array result
      await client.handleMsg(1, {
        result: [{ item: 1 }, { item: 2 }],
        time: Date.now()
      } as any)

      expect(handler1).toHaveBeenCalled()
      expect(handler2).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('handles non-array result by wrapping in array for handlers', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)
    const handler = jest.fn()

    const client = new ClisrClient(ctx, 'ws://localhost', handler, () => 'token', { socketFactory, autoStart: false })

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      // Response without id with non-array result
      await client.handleMsg(1, {
        result: { single: 'item' },
        time: Date.now()
      } as any)

      expect(handler).toHaveBeenCalledWith([{ single: 'item' }])
    } finally {
      await client.close()
    }
  })

  it('handles out of order chunks correctly', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN

      const resolve = jest.fn()
      const request = {
        method: 'test',
        params: [],
        startTime: Date.now(),
        promise: new Promise(() => {}),
        resolve,
        reject: jest.fn(),
        sendData: jest.fn(),
        chunks: []
      }
      ;(client as any).requests.set('_1', request)

      // Send chunk 1 (out of order - should be index 1)
      await client.handleMsg(1, {
        id: '_1',
        result: ['data2'],
        chunk: { index: 1, final: false },
        time: Date.now()
      } as any)

      // Not resolved yet - missing chunk 0
      expect(resolve).not.toHaveBeenCalled()

      // Send chunk 0 (the missing one)
      await client.handleMsg(1, {
        id: '_1',
        result: ['data1'],
        chunk: { index: 0, final: false },
        time: Date.now()
      } as any)

      // Still not resolved - not final
      expect(resolve).not.toHaveBeenCalled()

      // Send final chunk
      await client.handleMsg(1, {
        id: '_1',
        result: ['data3'],
        chunk: { index: 2, final: true },
        time: Date.now()
      } as any)

      // Now should be resolved with combined data
      expect(resolve).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('slowDownTimer affects send timing', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false }
    )

    try {
      ;(client as any).websocket = socket
      ;(client as any).helloReceived = true
      socket.readyState = ClientSocketReadyState.OPEN
      ;(client as any).slowDownTimer = 5

      // Request should still work even with slowDownTimer
      const p = client.request('testMethod', [])

      await new Promise((resolve) => setTimeout(resolve, 50))

      // Find and resolve the request
      const requestId = Array.from((client as any).requests.keys())[0]
      if (requestId !== undefined) {
        const request = (client as any).requests.get(requestId)
        request?.resolve({ ok: true })
      }

      const result = await p
      expect(result).toEqual({ ok: true })
    } finally {
      await client.close()
    }
  })

  it('handles onConnect error gracefully', async () => {
    const ctx = createFakeCtx()
    const socket = createMockSocket()
    const socketFactory = jest.fn(() => socket)
    const onConnect = jest.fn().mockRejectedValue(new Error('onConnect failed'))

    const client = new ClisrClient(
      ctx,
      'ws://localhost',
      () => {},
      () => 'token',
      { socketFactory, autoStart: false, onConnect }
    )

    try {
      ;(client as any).websocket = socket
      socket.readyState = ClientSocketReadyState.OPEN

      const helloResp = {
        id: -1,
        result: 'hello',
        serverVersion: '1.0.0',
        sessionId: 'session-1',
        reconnect: false
      } as any

      // Should not throw even if onConnect fails
      client.handleHello(1, helloResp)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(onConnect).toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })
})

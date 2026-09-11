/* eslint-env jest */
// Binary request integration tests
//
// These tests verify binary request/response functionality between
// ClisrServer and ClisrClient using FRAME_BINARY and FRAME_BINARY_RESP.

import WebSocket from 'ws'
import { ClisrServer } from '../server'
import { ClisrClient } from '../client'
import { MeasureMetricsContext } from '@hcengineering/measurements'
import type { ClientSocketFactory } from '../types'
import { encodeBinaryRequest, decodeBinaryRequest, encodeBinaryResponse, decodeBinaryResponse } from '../types'

// Increase timeout for flaky network/integration scenarios
jest.setTimeout(30000)

describe('binary frame encoding/decoding', () => {
  it('encodes and decodes binary request correctly', () => {
    const id = 'test-id-123'
    const method = 'processData'
    const data = new Uint8Array([1, 2, 3, 4, 5, 0xff, 0xfe])

    const encoded = encodeBinaryRequest(id, method, data)

    // Skip first byte (frame type)
    const decoded = decodeBinaryRequest(encoded.subarray(1))

    expect(decoded.id).toBe(id)
    expect(decoded.method).toBe(method)
    expect(decoded.data).toEqual(data)
  })

  it('encodes and decodes binary response with data correctly', () => {
    const id = 'resp-id-456'
    const data = new Uint8Array([10, 20, 30, 40, 50])

    const encoded = encodeBinaryResponse(id, data)

    // Skip first byte (frame type)
    const decoded = decodeBinaryResponse(encoded.subarray(1))

    expect(decoded.id).toBe(id)
    expect(decoded.data).toEqual(data)
    expect(decoded.error).toBeUndefined()
  })

  it('encodes and decodes binary response with error correctly', () => {
    const id = 'err-id-789'
    const errorMessage = 'Something went wrong'

    const encoded = encodeBinaryResponse(id, undefined, errorMessage)

    // Skip first byte (frame type)
    const decoded = decodeBinaryResponse(encoded.subarray(1))

    expect(decoded.id).toBe(id)
    expect(decoded.error).toBe(errorMessage)
    expect(decoded.data).toBeUndefined()
  })

  it('handles empty binary data', () => {
    const id = 'empty-id'
    const method = 'emptyMethod'
    const data = new Uint8Array(0)

    const encoded = encodeBinaryRequest(id, method, data)
    const decoded = decodeBinaryRequest(encoded.subarray(1))

    expect(decoded.id).toBe(id)
    expect(decoded.method).toBe(method)
    expect(decoded.data.length).toBe(0)
  })

  it('handles unicode in method names', () => {
    const id = 'unicode-id'
    const method = 'процесс_данных_日本語'
    const data = new Uint8Array([1, 2, 3])

    const encoded = encodeBinaryRequest(id, method, data)
    const decoded = decodeBinaryRequest(encoded.subarray(1))

    expect(decoded.id).toBe(id)
    expect(decoded.method).toBe(method)
    expect(decoded.data).toEqual(data)
  })
})

describe('integration: binary requests over WebSocket', () => {
  // Helper to create socket factory for tests
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

  it('client sends binary request to server and receives response', async () => {
    const ctx = new MeasureMetricsContext('clisr-binary', {})
    const server = new ClisrServer(ctx, async (token: string) => token === 'token-ok', '1.0.0')

    await server.start(ctx, 0)
    const addr = server.httpServer?.address() as any
    const port = addr?.port ?? 0

    // Register binary handler on server
    server.binaryHandler = async (_session, method, data) => {
      expect(method).toBe('processBinary')
      // Echo the data back with each byte incremented
      const result = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i++) {
        result[i] = (data[i] + 1) & 0xff
      }
      return result
    }

    let onConnectResolve!: () => void
    const onConnectP = new Promise<void>((resolve) => {
      onConnectResolve = resolve
    })

    let client: ClisrClient | undefined
    try {
      client = new ClisrClient(
        ctx,
        `ws://127.0.0.1:${port}`,
        () => {},
        () => 'token-ok',
        {
          socketFactory: createSocketFactory(),
          onConnect: async () => {
            onConnectResolve()
          }
        }
      )

      await onConnectP

      // Send binary request
      const inputData = new Uint8Array([1, 2, 3, 4, 5, 0xfe])
      const result = await client.binaryRequest('processBinary', inputData)

      // Verify response - each byte should be incremented
      expect(result.length).toBe(inputData.length)
      for (let i = 0; i < inputData.length; i++) {
        expect(result[i]).toBe((inputData[i] + 1) & 0xff)
      }
    } finally {
      if (client !== undefined) {
        try {
          await client.close()
        } catch (_err) {
          /* ignore */
        }
      }
      try {
        await server.close()
      } catch (_err) {
        /* ignore */
      }
    }
  })

  it('server sends binary request to client and receives response', async () => {
    const ctx = new MeasureMetricsContext('clisr-binary-server', {})
    const server = new ClisrServer(ctx, async (token: string) => token === 'token-ok', '1.0.0')

    await server.start(ctx, 0)
    const addr = server.httpServer?.address() as any
    const port = addr?.port ?? 0

    let onConnectResolve!: () => void
    const onConnectP = new Promise<void>((resolve) => {
      onConnectResolve = resolve
    })

    let client: ClisrClient | undefined
    try {
      client = new ClisrClient(
        ctx,
        `ws://127.0.0.1:${port}`,
        () => {},
        () => 'token-ok',
        {
          socketFactory: createSocketFactory(),
          onConnect: async () => {
            onConnectResolve()
          }
        }
      )

      // Register binary handler on client
      client.binaryHandler = async (_ctx, method, data) => {
        expect(method).toBe('clientProcess')
        // Double each byte value
        const result = new Uint8Array(data.length)
        for (let i = 0; i < data.length; i++) {
          result[i] = (data[i] * 2) & 0xff
        }
        return result
      }

      await onConnectP

      // Wait a bit for session to be fully established
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Server sends binary request to client
      const inputData = new Uint8Array([10, 20, 30, 40, 50])
      const result = await server.binaryRequest(ctx, 'clientProcess', inputData)

      // Verify response - each byte should be doubled
      expect(result.length).toBe(inputData.length)
      for (let i = 0; i < inputData.length; i++) {
        expect(result[i]).toBe((inputData[i] * 2) & 0xff)
      }
    } finally {
      if (client !== undefined) {
        try {
          await client.close()
        } catch (_err) {
          /* ignore */
        }
      }
      try {
        await server.close()
      } catch (_err) {
        /* ignore */
      }
    }
  })

  // Mixed binary/JSON request-response tests

  it('client sends binary request and receives JSON response (e.g., file upload -> transcription)', async () => {
    const ctx = new MeasureMetricsContext('clisr-binary-to-json', {})
    const server = new ClisrServer(ctx, async (token: string) => token === 'token-ok', '1.0.0')

    await server.start(ctx, 0)
    const addr = server.httpServer?.address() as any
    const port = addr?.port ?? 0

    // Register binary handler that returns JSON (simulating transcription service)
    server.binaryHandler = async (_session, method, data) => {
      expect(method).toBe('transcribe')
      // Simulate processing binary audio data and returning transcription as JSON
      const audioSize = data.length
      return {
        text: 'Hello, this is a transcription',
        duration: audioSize / 1000,
        words: ['Hello', 'this', 'is', 'a', 'transcription'],
        confidence: 0.95
      }
    }

    let onConnectResolve!: () => void
    const onConnectP = new Promise<void>((resolve) => {
      onConnectResolve = resolve
    })

    let client: ClisrClient | undefined
    try {
      client = new ClisrClient(
        ctx,
        `ws://127.0.0.1:${port}`,
        () => {},
        () => 'token-ok',
        {
          socketFactory: createSocketFactory(),
          onConnect: async () => {
            onConnectResolve()
          }
        }
      )

      await onConnectP

      // Send binary "audio" data
      const audioData = new Uint8Array(5000) // 5KB of "audio"
      for (let i = 0; i < audioData.length; i++) {
        audioData[i] = Math.floor(Math.random() * 256)
      }

      const result = await client.binaryRequest<{
        text: string
        duration: number
        words: string[]
        confidence: number
      }>('transcribe', audioData)

      // Verify JSON response
      expect(result.text).toBe('Hello, this is a transcription')
      expect(result.duration).toBe(5) // 5000 / 1000
      expect(result.words).toEqual(['Hello', 'this', 'is', 'a', 'transcription'])
      expect(result.confidence).toBe(0.95)
    } finally {
      if (client !== undefined) {
        try {
          await client.close()
        } catch (_err) {
          /* ignore */
        }
      }
      try {
        await server.close()
      } catch (_err) {
        /* ignore */
      }
    }
  })

  it('server sends binary request to client and receives JSON response', async () => {
    const ctx = new MeasureMetricsContext('clisr-server-binary-to-json', {})
    const server = new ClisrServer(ctx, async (token: string) => token === 'token-ok', '1.0.0')

    await server.start(ctx, 0)
    const addr = server.httpServer?.address() as any
    const port = addr?.port ?? 0

    let onConnectResolve!: () => void
    const onConnectP = new Promise<void>((resolve) => {
      onConnectResolve = resolve
    })

    let client: ClisrClient | undefined
    try {
      client = new ClisrClient(
        ctx,
        `ws://127.0.0.1:${port}`,
        () => {},
        () => 'token-ok',
        {
          socketFactory: createSocketFactory(),
          onConnect: async () => {
            onConnectResolve()
          }
        }
      )

      // Register binary handler on client that returns JSON
      client.binaryHandler = async (_ctx, method, data) => {
        expect(method).toBe('analyzeImage')
        // Simulate image analysis returning JSON metadata
        return {
          width: 1920,
          height: 1080,
          format: 'png',
          size: data.length,
          hasAlpha: true,
          colors: ['#ff0000', '#00ff00', '#0000ff']
        }
      }

      await onConnectP
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Server sends binary "image" data to client
      const imageData = new Uint8Array(10000) // 10KB "image"
      const result = await server.binaryRequest(ctx, 'analyzeImage', imageData)

      // Result should be JSON
      expect(result).toEqual({
        width: 1920,
        height: 1080,
        format: 'png',
        size: 10000,
        hasAlpha: true,
        colors: ['#ff0000', '#00ff00', '#0000ff']
      })
    } finally {
      if (client !== undefined) {
        try {
          await client.close()
        } catch (_err) {
          /* ignore */
        }
      }
      try {
        await server.close()
      } catch (_err) {
        /* ignore */
      }
    }
  })

  it('client sends binary request, server returns binary or JSON based on method', async () => {
    const ctx = new MeasureMetricsContext('clisr-mixed-responses', {})
    const server = new ClisrServer(ctx, async (token: string) => token === 'token-ok', '1.0.0')

    await server.start(ctx, 0)
    const addr = server.httpServer?.address() as any
    const port = addr?.port ?? 0

    // Handler returns different types based on method
    server.binaryHandler = async (_session, method, data) => {
      if (method === 'compress') {
        // Return binary (compressed data)
        const compressed = new Uint8Array(Math.floor(data.length / 2))
        for (let i = 0; i < compressed.length; i++) {
          compressed[i] = data[i * 2] ^ data[i * 2 + 1]
        }
        return compressed
      } else if (method === 'analyze') {
        // Return JSON (analysis result)
        return {
          originalSize: data.length,
          checksum: data.reduce((a, b) => a + b, 0) % 256,
          isValid: true
        }
      }
      throw new Error('Unknown method')
    }

    let onConnectResolve!: () => void
    const onConnectP = new Promise<void>((resolve) => {
      onConnectResolve = resolve
    })

    let client: ClisrClient | undefined
    try {
      client = new ClisrClient(
        ctx,
        `ws://127.0.0.1:${port}`,
        () => {},
        () => 'token-ok',
        {
          socketFactory: createSocketFactory(),
          onConnect: async () => {
            onConnectResolve()
          }
        }
      )

      await onConnectP

      const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

      // Test binary response
      const compressed = await client.binaryRequest<Uint8Array>('compress', testData)
      expect(compressed).toBeInstanceOf(Uint8Array)
      expect(compressed.length).toBe(4)
      expect(compressed[0]).toBe(1 ^ 2)
      expect(compressed[1]).toBe(3 ^ 4)

      // Test JSON response
      const analysis = await client.binaryRequest<{ originalSize: number, checksum: number, isValid: boolean }>(
        'analyze',
        testData
      )
      expect(analysis.originalSize).toBe(8)
      expect(analysis.checksum).toBe((1 + 2 + 3 + 4 + 5 + 6 + 7 + 8) % 256)
      expect(analysis.isValid).toBe(true)
    } finally {
      if (client !== undefined) {
        try {
          await client.close()
        } catch (_err) {
          /* ignore */
        }
      }
      try {
        await server.close()
      } catch (_err) {
        /* ignore */
      }
    }
  })

  it('bidirectional mixed: client sends binary -> JSON, server sends binary -> JSON', async () => {
    const ctx = new MeasureMetricsContext('clisr-bidirectional-mixed', {})
    const server = new ClisrServer(ctx, async (token: string) => token === 'token-ok', '1.0.0')

    await server.start(ctx, 0)
    const addr = server.httpServer?.address() as any
    const port = addr?.port ?? 0

    // Server handler: binary -> JSON
    server.binaryHandler = async (_session, method, data) => {
      return { serverReceived: data.length, method }
    }

    let onConnectResolve!: () => void
    const onConnectP = new Promise<void>((resolve) => {
      onConnectResolve = resolve
    })

    let client: ClisrClient | undefined
    try {
      client = new ClisrClient(
        ctx,
        `ws://127.0.0.1:${port}`,
        () => {},
        () => 'token-ok',
        {
          socketFactory: createSocketFactory(),
          onConnect: async () => {
            onConnectResolve()
          }
        }
      )

      // Client handler: binary -> JSON
      client.binaryHandler = async (_ctx, method, data) => {
        return { clientReceived: data.length, method }
      }

      await onConnectP
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Client -> Server: binary request, JSON response
      const clientResult = await client.binaryRequest<{ serverReceived: number, method: string }>(
        'uploadFile',
        new Uint8Array(100)
      )
      expect(clientResult.serverReceived).toBe(100)
      expect(clientResult.method).toBe('uploadFile')

      // Server -> Client: binary request, JSON response
      const serverResult = await server.binaryRequest(ctx, 'processData', new Uint8Array(200))
      expect(serverResult).toEqual({ clientReceived: 200, method: 'processData' })
    } finally {
      if (client !== undefined) {
        try {
          await client.close()
        } catch (_err) {
          /* ignore */
        }
      }
      try {
        await server.close()
      } catch (_err) {
        /* ignore */
      }
    }
  })

  // Headers tests

  it('client sends binary request with headers to server', async () => {
    const ctx = new MeasureMetricsContext('clisr-binary-headers', {})
    const server = new ClisrServer(ctx, async (token: string) => token === 'token-ok', '1.0.0')

    await server.start(ctx, 0)
    const addr = server.httpServer?.address() as any
    const port = addr?.port ?? 0

    let receivedHeaders: Record<string, any> | undefined

    // Register binary handler that captures headers
    server.binaryHandler = async (_session, method, data, headers) => {
      receivedHeaders = headers
      return { method, dataSize: data.length, headersReceived: headers }
    }

    let onConnectResolve!: () => void
    const onConnectP = new Promise<void>((resolve) => {
      onConnectResolve = resolve
    })

    let client: ClisrClient | undefined
    try {
      client = new ClisrClient(
        ctx,
        `ws://127.0.0.1:${port}`,
        () => {},
        () => 'token-ok',
        {
          socketFactory: createSocketFactory(),
          onConnect: async () => {
            onConnectResolve()
          }
        }
      )

      await onConnectP

      // Send binary request with custom headers
      const customHeaders = {
        'x-request-id': 'req-123',
        'x-user-id': 'user-456',
        'x-custom-data': { nested: true, value: 42 }
      }

      const result = await client.binaryRequest<{
        method: string
        dataSize: number
        headersReceived: Record<string, any>
      }>('processWithHeaders', new Uint8Array([1, 2, 3]), customHeaders)

      expect(result.method).toBe('processWithHeaders')
      expect(result.dataSize).toBe(3)
      expect(receivedHeaders).toBeDefined()
      expect(receivedHeaders?.['x-request-id']).toBe('req-123')
      expect(receivedHeaders?.['x-user-id']).toBe('user-456')
      expect(receivedHeaders?.['x-custom-data']).toEqual({ nested: true, value: 42 })
    } finally {
      if (client !== undefined) {
        try {
          await client.close()
        } catch (_err) {
          /* ignore */
        }
      }
      try {
        await server.close()
      } catch (_err) {
        /* ignore */
      }
    }
  })

  it('server sends binary request with headers to client', async () => {
    const ctx = new MeasureMetricsContext('clisr-server-binary-headers', {})
    const server = new ClisrServer(ctx, async (token: string) => token === 'token-ok', '1.0.0')

    await server.start(ctx, 0)
    const addr = server.httpServer?.address() as any
    const port = addr?.port ?? 0

    let receivedHeaders: Record<string, any> | undefined

    let onConnectResolve!: () => void
    const onConnectP = new Promise<void>((resolve) => {
      onConnectResolve = resolve
    })

    let client: ClisrClient | undefined
    try {
      client = new ClisrClient(
        ctx,
        `ws://127.0.0.1:${port}`,
        () => {},
        () => 'token-ok',
        {
          socketFactory: createSocketFactory(),
          onConnect: async () => {
            onConnectResolve()
          }
        }
      )

      // Register binary handler on client that captures headers
      client.binaryHandler = async (_ctx, method, data, headers) => {
        receivedHeaders = headers
        return { method, dataSize: data.length, headersReceived: headers }
      }

      await onConnectP
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Server sends binary request with custom headers
      const customHeaders = {
        'x-server-request-id': 'srv-req-789',
        'x-priority': 'high',
        'x-metadata': { source: 'server', timestamp: 1234567890 }
      }

      const result = await server.binaryRequest<{
        method: string
        dataSize: number
        headersReceived: Record<string, any>
      }>(ctx, 'clientProcessWithHeaders', new Uint8Array([10, 20, 30, 40]), customHeaders)

      expect(result.method).toBe('clientProcessWithHeaders')
      expect(result.dataSize).toBe(4)
      expect(receivedHeaders).toBeDefined()
      expect(receivedHeaders?.['x-server-request-id']).toBe('srv-req-789')
      expect(receivedHeaders?.['x-priority']).toBe('high')
      expect(receivedHeaders?.['x-metadata']).toEqual({ source: 'server', timestamp: 1234567890 })
    } finally {
      if (client !== undefined) {
        try {
          await client.close()
        } catch (_err) {
          /* ignore */
        }
      }
      try {
        await server.close()
      } catch (_err) {
        /* ignore */
      }
    }
  })

  it('binary request works without headers (backward compatibility)', async () => {
    const ctx = new MeasureMetricsContext('clisr-binary-no-headers', {})
    const server = new ClisrServer(ctx, async (token: string) => token === 'token-ok', '1.0.0')

    await server.start(ctx, 0)
    const addr = server.httpServer?.address() as any
    const port = addr?.port ?? 0

    server.binaryHandler = async (_session, method, data, headers) => {
      return new Uint8Array([data[0] + 1])
    }

    let onConnectResolve!: () => void
    const onConnectP = new Promise<void>((resolve) => {
      onConnectResolve = resolve
    })

    let client: ClisrClient | undefined
    try {
      client = new ClisrClient(
        ctx,
        `ws://127.0.0.1:${port}`,
        () => {},
        () => 'token-ok',
        {
          socketFactory: createSocketFactory(),
          onConnect: async () => {
            onConnectResolve()
          }
        }
      )

      await onConnectP

      // Send binary request without explicit headers
      const result = await client.binaryRequest<Uint8Array>('noHeaders', new Uint8Array([5]))

      expect(result[0]).toBe(6)
      // Headers may be undefined when not explicitly provided (meta is passed separately now)
      // This is expected behavior - headers field is optional
    } finally {
      if (client !== undefined) {
        try {
          await client.close()
        } catch (_err) {
          /* ignore */
        }
      }
      try {
        await server.close()
      } catch (_err) {
        /* ignore */
      }
    }
  })

  it('handles binary request error from server handler', async () => {
    const ctx = new MeasureMetricsContext('clisr-binary-error', {})
    const server = new ClisrServer(ctx, async (token: string) => token === 'token-ok', '1.0.0')

    await server.start(ctx, 0)
    const addr = server.httpServer?.address() as any
    const port = addr?.port ?? 0

    // Register binary handler that throws an error
    server.binaryHandler = async (_session, method, _data) => {
      throw new Error('Processing failed: invalid data')
    }

    let onConnectResolve!: () => void
    const onConnectP = new Promise<void>((resolve) => {
      onConnectResolve = resolve
    })

    let client: ClisrClient | undefined
    try {
      client = new ClisrClient(
        ctx,
        `ws://127.0.0.1:${port}`,
        () => {},
        () => 'token-ok',
        {
          socketFactory: createSocketFactory(),
          onConnect: async () => {
            onConnectResolve()
          }
        }
      )

      await onConnectP

      // Send binary request that should fail
      const inputData = new Uint8Array([1, 2, 3])
      await expect(client.binaryRequest('failingMethod', inputData)).rejects.toThrow('Processing failed: invalid data')
    } finally {
      if (client !== undefined) {
        try {
          await client.close()
        } catch (_err) {
          /* ignore */
        }
      }
      try {
        await server.close()
      } catch (_err) {
        /* ignore */
      }
    }
  })

  it('handles large binary data', async () => {
    const ctx = new MeasureMetricsContext('clisr-binary-large', {})
    const server = new ClisrServer(ctx, async (token: string) => token === 'token-ok', '1.0.0')

    await server.start(ctx, 0)
    const addr = server.httpServer?.address() as any
    const port = addr?.port ?? 0

    // Register binary handler that echoes data
    server.binaryHandler = async (_session, _method, data) => {
      return data
    }

    let onConnectResolve!: () => void
    const onConnectP = new Promise<void>((resolve) => {
      onConnectResolve = resolve
    })

    let client: ClisrClient | undefined
    try {
      client = new ClisrClient(
        ctx,
        `ws://127.0.0.1:${port}`,
        () => {},
        () => 'token-ok',
        {
          socketFactory: createSocketFactory(),
          onConnect: async () => {
            onConnectResolve()
          }
        }
      )

      await onConnectP

      // Send large binary data (1MB)
      const size = 1024 * 1024
      const inputData = new Uint8Array(size)
      for (let i = 0; i < size; i++) {
        inputData[i] = i & 0xff
      }

      const result = await client.binaryRequest('echoLarge', inputData)

      expect(result.length).toBe(size)
      // Verify first and last bytes
      expect(result[0]).toBe(0)
      expect(result[size - 1]).toBe((size - 1) & 0xff)
    } finally {
      if (client !== undefined) {
        try {
          await client.close()
        } catch (_err) {
          /* ignore */
        }
      }
      try {
        await server.close()
      } catch (_err) {
        /* ignore */
      }
    }
  })

  it('handles no binary handler registered on server', async () => {
    const ctx = new MeasureMetricsContext('clisr-binary-no-handler', {})
    const server = new ClisrServer(ctx, async (token: string) => token === 'token-ok', '1.0.0')

    await server.start(ctx, 0)
    const addr = server.httpServer?.address() as any
    const port = addr?.port ?? 0

    // Do NOT register binary handler

    let onConnectResolve!: () => void
    const onConnectP = new Promise<void>((resolve) => {
      onConnectResolve = resolve
    })

    let client: ClisrClient | undefined
    try {
      client = new ClisrClient(
        ctx,
        `ws://127.0.0.1:${port}`,
        () => {},
        () => 'token-ok',
        {
          socketFactory: createSocketFactory(),
          onConnect: async () => {
            onConnectResolve()
          }
        }
      )

      await onConnectP

      const inputData = new Uint8Array([1, 2, 3])
      await expect(client.binaryRequest('anyMethod', inputData)).rejects.toThrow('No binary handler registered')
    } finally {
      if (client !== undefined) {
        try {
          await client.close()
        } catch (_err) {
          /* ignore */
        }
      }
      try {
        await server.close()
      } catch (_err) {
        /* ignore */
      }
    }
  })
})

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

// Tests for frame-utils.ts - sendFrame, sendHelloFrame, handleFrame
// and additional disconnect/reconnect scenarios for client and server

import { MeasureMetricsContext, type MeasureContext } from '@hcengineering/measurements'
import { RPCHandler, type Request, type Response } from '@hcengineering/rpc'
import { sendFrame, sendHelloFrame, handleFrame } from '../frame-utils'
import { FRAME_MSGPACK, FRAME_MSGPACK_SNAPPY, FRAME_PING, FRAME_PONG, FRAME_HELLO, FRAME_HELLO_RESP } from '../types'
import { Analytics } from '@hcengineering/analytics'

function createFakeCtx (): MeasureContext {
  return new MeasureMetricsContext('frame-utils-test', {})
}

describe('frame-utils', () => {
  describe('sendFrame', () => {
    it('sends small messages without compression using FRAME_MSGPACK', async () => {
      const ctx = createFakeCtx()
      const sentData: Uint8Array[] = []
      const sendFn = (data: Uint8Array): void => {
        sentData.push(data)
      }
      const compressFn = jest.fn()
      const msg: Response<any> = { id: 1, result: { small: 'data' }, time: Date.now() }

      await sendFrame(ctx, sendFn, msg, compressFn)

      expect(sentData.length).toBe(1)
      expect(sentData[0][0]).toBe(FRAME_MSGPACK)
      expect(compressFn).not.toHaveBeenCalled()
    })

    it('sends large messages with compression using FRAME_MSGPACK_SNAPPY', async () => {
      const ctx = createFakeCtx()
      const sentData: Uint8Array[] = []
      const sendFn = (data: Uint8Array): void => {
        sentData.push(data)
      }
      const compressedPayload = Buffer.from('compressed')
      const compressFn = jest.fn().mockResolvedValue(compressedPayload)

      // Create a large payload > 1024 bytes
      const largeData = 'x'.repeat(2000)
      const msg: Response<any> = { id: 1, result: { data: largeData }, time: Date.now() }

      await sendFrame(ctx, sendFn, msg, compressFn)

      expect(sentData.length).toBe(1)
      expect(sentData[0][0]).toBe(FRAME_MSGPACK_SNAPPY)
      expect(compressFn).toHaveBeenCalled()
      // The rest should be the compressed payload
      expect(sentData[0].slice(1)).toEqual(new Uint8Array(compressedPayload))
    })

    it('catches synchronous sendFn errors for small messages and logs without throwing (Send before connected)', async () => {
      const ctx = createFakeCtx()
      const errorSpy = jest.spyOn(ctx, 'error')
      const analyticsSpy = jest.spyOn(Analytics, 'handleError').mockImplementation(() => {})
      const sendFn = (data: Uint8Array): void => {
        throw new Error('Send before connected exception')
      }
      const compressFn = jest.fn()
      const msg: Response<any> = { id: 2, result: { test: 'data' }, time: Date.now() }

      await expect(sendFrame(ctx, sendFn, msg, compressFn)).resolves.toBeUndefined()
      expect(errorSpy).toHaveBeenCalled()
      expect(analyticsSpy).not.toHaveBeenCalled()
    })

    it('catches synchronous sendFn errors for small messages and reports unexpected errors', async () => {
      const ctx = createFakeCtx()
      const errorSpy = jest.spyOn(ctx, 'error')
      const analyticsSpy = jest.spyOn(Analytics, 'handleError').mockImplementation(() => {})
      const sendFn = (data: Uint8Array): void => {
        throw new Error('unexpected send failure')
      }
      const compressFn = jest.fn()
      const msg: Response<any> = { id: 3, result: { test: 'data' }, time: Date.now() }

      await expect(sendFrame(ctx, sendFn, msg, compressFn)).resolves.toBeUndefined()
      expect(errorSpy).toHaveBeenCalled()
      expect(analyticsSpy).toHaveBeenCalled()
    })
  })

  describe('sendHelloFrame', () => {
    it('sends a hello frame with JSON payload', () => {
      const sentData: Uint8Array[] = []
      const sendFn = (data: Uint8Array): void => {
        sentData.push(data)
      }
      const msg: Request<any> = { method: 'hello', params: [], id: -1, time: Date.now() }

      sendHelloFrame(sendFn, msg, FRAME_HELLO)

      expect(sentData.length).toBe(1)
      expect(sentData[0][0]).toBe(FRAME_HELLO)

      // Verify JSON payload
      const payload = new TextDecoder().decode(sentData[0].slice(1))
      const parsed = JSON.parse(payload)
      expect(parsed.method).toBe('hello')
    })

    it('sends a hello response frame', () => {
      const sentData: Uint8Array[] = []
      const sendFn = (data: Uint8Array): void => {
        sentData.push(data)
      }
      const msg: Response<any> = {
        id: -1,
        result: 'hello',
        serverVersion: '1.0.0',
        sessionId: 'test-session',
        time: Date.now()
      } as any

      sendHelloFrame(sendFn, msg, FRAME_HELLO_RESP)

      expect(sentData.length).toBe(1)
      expect(sentData[0][0]).toBe(FRAME_HELLO_RESP)
    })
  })

  describe('handleFrame', () => {
    it('returns early for FRAME_PING', async () => {
      const ctx = createFakeCtx()
      const handleMsg = jest.fn()
      const handleRequest = jest.fn()
      const uncompressFn = jest.fn()

      const frame = new Uint8Array([FRAME_PING])
      await handleFrame(ctx, frame, handleMsg, handleRequest, uncompressFn)

      expect(handleMsg).not.toHaveBeenCalled()
      expect(handleRequest).not.toHaveBeenCalled()
    })

    it('returns early for FRAME_PONG', async () => {
      const ctx = createFakeCtx()
      const handleMsg = jest.fn()
      const handleRequest = jest.fn()
      const uncompressFn = jest.fn()

      const frame = new Uint8Array([FRAME_PONG])
      await handleFrame(ctx, frame, handleMsg, handleRequest, uncompressFn)

      expect(handleMsg).not.toHaveBeenCalled()
      expect(handleRequest).not.toHaveBeenCalled()
    })

    it('handles FRAME_HELLO_RESP by calling handleMsg with parsed JSON', async () => {
      const ctx = createFakeCtx()
      const handleMsg = jest.fn()
      const handleRequest = jest.fn()
      const uncompressFn = jest.fn()

      const payload = { id: -1, result: 'hello', serverVersion: '1.0.0' }
      const jsonBytes = new TextEncoder().encode(JSON.stringify(payload))
      const frame = new Uint8Array(1 + jsonBytes.length)
      frame[0] = FRAME_HELLO_RESP
      frame.set(jsonBytes, 1)

      await handleFrame(ctx, frame, handleMsg, handleRequest, uncompressFn)

      expect(handleMsg).toHaveBeenCalledWith(payload)
      expect(handleRequest).not.toHaveBeenCalled()
    })

    it('handles FRAME_HELLO by calling handleRequest with parsed JSON', async () => {
      const ctx = createFakeCtx()
      const handleMsg = jest.fn()
      const handleRequest = jest.fn()
      const uncompressFn = jest.fn()

      const payload = { method: 'hello', params: [], id: -1, token: 'test-token' }
      const jsonBytes = new TextEncoder().encode(JSON.stringify(payload))
      const frame = new Uint8Array(1 + jsonBytes.length)
      frame[0] = FRAME_HELLO
      frame.set(jsonBytes, 1)

      await handleFrame(ctx, frame, handleMsg, handleRequest, uncompressFn)

      expect(handleRequest).toHaveBeenCalledWith(payload)
      expect(handleMsg).not.toHaveBeenCalled()
    })

    it('throws and logs error for malformed FRAME_HELLO JSON', async () => {
      const ctx = createFakeCtx()
      const errorSpy = jest.spyOn(ctx, 'error')
      const handleMsg = jest.fn()
      const handleRequest = jest.fn()
      const uncompressFn = jest.fn()

      // Invalid JSON
      const invalidJson = new TextEncoder().encode('{ invalid json }')
      const frame = new Uint8Array(1 + invalidJson.length)
      frame[0] = FRAME_HELLO
      frame.set(invalidJson, 1)

      await expect(handleFrame(ctx, frame, handleMsg, handleRequest, uncompressFn)).rejects.toThrow()

      expect(errorSpy).toHaveBeenCalled()
      expect(handleRequest).not.toHaveBeenCalled()
    })

    it('handles FRAME_MSGPACK by parsing and calling handleMsg', async () => {
      const ctx = createFakeCtx()
      const handleMsg = jest.fn()
      const handleRequest = jest.fn()
      const uncompressFn = jest.fn()

      // Create a valid msgpack frame
      const rpcHandler = new RPCHandler()
      const response: Response<any> = { id: 123, result: { foo: 'bar' }, time: Date.now() }
      const serialized = rpcHandler.serialize(response, true)

      const frame = new Uint8Array(1 + serialized.byteLength)
      frame[0] = FRAME_MSGPACK
      frame.set(new Uint8Array(serialized), 1)

      await handleFrame(ctx, frame, handleMsg, handleRequest, uncompressFn)

      expect(handleMsg).toHaveBeenCalled()
      const arg = handleMsg.mock.calls[0][0]
      expect(arg.id).toBe(123)
      expect(arg.result.foo).toBe('bar')
    })

    it('throws and logs error for malformed FRAME_MSGPACK', async () => {
      const ctx = createFakeCtx()
      const errorSpy = jest.spyOn(ctx, 'error')
      const handleMsg = jest.fn()
      const handleRequest = jest.fn()
      const uncompressFn = jest.fn()

      // Invalid msgpack data
      const frame = new Uint8Array([FRAME_MSGPACK, 0xff, 0xff, 0xff])

      await expect(handleFrame(ctx, frame, handleMsg, handleRequest, uncompressFn)).rejects.toThrow()

      expect(errorSpy).toHaveBeenCalled()
    })

    it('handles FRAME_MSGPACK_SNAPPY by decompressing and parsing', async () => {
      const ctx = createFakeCtx()
      const handleMsg = jest.fn()
      const handleRequest = jest.fn()

      // Create a valid msgpack payload
      const rpcHandler = new RPCHandler()
      const response: Response<any> = { id: 456, result: { compressed: true }, time: Date.now() }
      const serialized = rpcHandler.serialize(response, true)

      // Mock uncompress to return the serialized data
      const uncompressFn = jest.fn().mockResolvedValue(Buffer.from(serialized))

      // Compressed frame (fake compressed payload - will be "uncompressed" by mock)
      const fakeCompressed = new Uint8Array([1, 2, 3, 4])
      const frame = new Uint8Array(1 + fakeCompressed.length)
      frame[0] = FRAME_MSGPACK_SNAPPY
      frame.set(fakeCompressed, 1)

      await handleFrame(ctx, frame, handleMsg, handleRequest, uncompressFn)

      expect(uncompressFn).toHaveBeenCalled()
      expect(handleMsg).toHaveBeenCalled()
      const arg = handleMsg.mock.calls[0][0]
      expect(arg.id).toBe(456)
    })

    it('handles FRAME_MSGPACK_SNAPPY with Uint8Array uncompress result', async () => {
      const ctx = createFakeCtx()
      const handleMsg = jest.fn()
      const handleRequest = jest.fn()

      // Create a valid msgpack payload
      const rpcHandler = new RPCHandler()
      const response: Response<any> = { id: 789, result: { type: 'uint8' }, time: Date.now() }
      const serialized = rpcHandler.serialize(response, true)

      // Mock uncompress to return Uint8Array directly (not Buffer)
      const uncompressFn = jest.fn().mockResolvedValue(new Uint8Array(serialized))

      const fakeCompressed = new Uint8Array([5, 6, 7])
      const frame = new Uint8Array(1 + fakeCompressed.length)
      frame[0] = FRAME_MSGPACK_SNAPPY
      frame.set(fakeCompressed, 1)

      await handleFrame(ctx, frame, handleMsg, handleRequest, uncompressFn)

      expect(handleMsg).toHaveBeenCalled()
      const arg = handleMsg.mock.calls[0][0]
      expect(arg.id).toBe(789)
    })

    it('throws and logs error when FRAME_MSGPACK_SNAPPY decompression fails', async () => {
      const ctx = createFakeCtx()
      const errorSpy = jest.spyOn(ctx, 'error')
      const handleMsg = jest.fn()
      const handleRequest = jest.fn()
      const uncompressFn = jest.fn().mockRejectedValue(new Error('decompress failed'))

      const frame = new Uint8Array([FRAME_MSGPACK_SNAPPY, 1, 2, 3])

      await expect(handleFrame(ctx, frame, handleMsg, handleRequest, uncompressFn)).rejects.toThrow('decompress failed')

      expect(errorSpy).toHaveBeenCalled()
    })

    it('does nothing for unknown frame type', async () => {
      const ctx = createFakeCtx()
      const handleMsg = jest.fn()
      const handleRequest = jest.fn()
      const uncompressFn = jest.fn()

      // Unknown frame type (e.g., 99)
      const frame = new Uint8Array([99, 1, 2, 3])

      await handleFrame(ctx, frame, handleMsg, handleRequest, uncompressFn)

      expect(handleMsg).not.toHaveBeenCalled()
      expect(handleRequest).not.toHaveBeenCalled()
      expect(uncompressFn).not.toHaveBeenCalled()
    })
  })
})

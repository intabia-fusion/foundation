//
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

import { type MeasureContext } from '@hcengineering/measurements'
import { type Response, type Request, RPCHandler } from '@hcengineering/rpc'
import { Analytics } from '@hcengineering/analytics'
import {
  FRAME_DATA,
  FRAME_PING,
  FRAME_PONG,
  FRAME_HELLO,
  FRAME_HELLO_RESP,
  dataFrameType,
  isJsonBody,
  legacyWireFormat,
  readDataFrame,
  wireCodecs,
  type WireFormat
} from './types'

// Shared RPC handler for serialization/deserialization
const rpcHandler = new RPCHandler()

export function toU8 (data: any): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

export function codecFor (codec: string): (typeof wireCodecs)[string] {
  const impl = wireCodecs[codec]
  if (impl === undefined) {
    throw new Error(`unsupported wire codec: ${codec}`)
  }
  return impl
}

/** Decodes a data frame body, decompressing first when the frame says so. */
export async function decodeFrameBody (
  handler: RPCHandler,
  body: Uint8Array,
  codec: string,
  compressed: boolean,
  uncompressFn: (input: any) => Promise<any>
): Promise<Response<any>> {
  const raw = compressed ? toU8(await uncompressFn(body)) : body
  return codecFor(codec).decodeResponse(handler, raw)
}

/**
 * Send a frame in the connection's format - compressed when over 1024 bytes.
 */
export async function sendFrame (
  ctx: MeasureContext,
  sendFn: (data: Uint8Array) => void,
  msg: Response<any> | Request<any>,
  compressFn: (input: any) => Promise<any>,
  format: WireFormat = legacyWireFormat
): Promise<void> {
  const dta = codecFor(format.codec).encode(rpcHandler, msg)
  const compressed = format.compression !== 'none' && dta.byteLength > 1024
  const body = compressed ? toU8(await compressFn(dta)) : dta

  const ft = dataFrameType(format, compressed)
  // FRAME_DATA carries the compression flag; the msgpack frame codes encode it themselves.
  const prefix = ft === FRAME_DATA ? 2 : 1
  const out = new Uint8Array(prefix + body.length)
  out[0] = ft
  if (prefix === 2) {
    out[1] = compressed ? 1 : 0
  }
  out.set(body, prefix)

  // The transport may throw synchronously (socket not connected yet); a throw here used to
  // abort the caller's processing loop.
  try {
    sendFn(out)
  } catch (err: any) {
    ctx.error('send error', { err })
    const emsg = `${err?.message ?? ''}`
    if (!emsg.includes('WebSocket is not open') && !emsg.includes('Send before connected')) {
      Analytics.handleError(err)
    }
  }
}

/**
 * Send a hello frame using simple JSON serialization
 */
export function sendHelloFrame (
  sendFn: (data: Uint8Array) => void,
  msg: Response<any> | Request<any>,
  frameType: number
): void {
  // Serialize as simple JSON for hello frames
  const jsonStr = JSON.stringify(msg)
  const jsonBytes = new TextEncoder().encode(jsonStr)
  const out = new Uint8Array(1 + jsonBytes.length)
  out[0] = frameType
  out.set(jsonBytes, 1)

  // Guard against synchronous throws from the transport send function.
  try {
    sendFn(out)
  } catch (err: any) {
    const msg = `${err?.message ?? ''}`
    if (!msg.includes('WebSocket is not open') && !msg.includes('Send before connected')) {
      Analytics.handleError(err)
    }
  }
}

/**
 * Handle incoming frames based on frame type
 */
export async function handleFrame (
  ctx: MeasureContext,
  u8: Uint8Array,
  handleMsg: (resp: Response<any>) => Promise<void>,
  handleRequest: (req: Request<any>) => Promise<void>,
  uncompressFn: (input: any) => Promise<any>,
  format: WireFormat = legacyWireFormat
): Promise<void> {
  const ft = u8[0]

  if (ft === FRAME_PING || ft === FRAME_PONG) {
    // Handled by the caller.
    return
  }
  if (ft === FRAME_HELLO || ft === FRAME_HELLO_RESP) {
    // Hello is never compressed, and its encoding is sniffed - it predates the agreed format.
    const payload = u8.subarray(1)
    const codec = isJsonBody(payload) ? wireCodecs.json : wireCodecs.msgpack
    try {
      if (ft === FRAME_HELLO_RESP) {
        await handleMsg(codec.decodeResponse(rpcHandler, payload))
      } else {
        await handleRequest(codec.decodeRequest(rpcHandler, payload))
      }
    } catch (err: any) {
      ctx.error('failed to parse hello frame', { err })
      throw err
    }
    return
  }
  const frame = readDataFrame(u8, format)
  if (frame === undefined) {
    return
  }
  try {
    await handleMsg(await decodeFrameBody(rpcHandler, frame.body, frame.codec, frame.compressed, uncompressFn))
  } catch (err: any) {
    ctx.error('failed to parse data frame', { err, frame: ft })
    throw err
  }
}

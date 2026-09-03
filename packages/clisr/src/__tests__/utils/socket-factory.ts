//
// Copyright © 2026 Intabia Fusion.
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

import WebSocket from 'ws'
import type { ClientSocketFactory } from '../../types'

// Shared ws-based ClientSocketFactory used by spec/bench tests that need a real
// WebSocket transport with the small wrapper expected by ClisrClient.
export interface FrameObserver {
  sent?: (frame: Uint8Array) => void
  received?: (frame: Uint8Array) => void
}

export const createSocketFactory =
  (observer?: FrameObserver): ClientSocketFactory =>
    (url: string) => {
      const real = new WebSocket(url)
      let openEmitted = false
      let openHandler: any = null
      const msgQueue: any[] = []
      let msgHandler: any = null

      const wrapper: any = {
        send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          if (observer?.sent !== undefined && ArrayBuffer.isView(data)) {
            observer.sent(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
          }
          real.send(data as any)
        },
        close: (code?: number) => {
          try {
            real.close(code)
          } catch (_err) {}
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
          if (openEmitted && typeof openHandler === 'function') openHandler({} as any)
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
      real.on('message', (data: any, isBinary: boolean) => {
        if (observer?.received !== undefined && Buffer.isBuffer(data)) {
          observer.received(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        }
        const ev = { data: isBinary ? data : data.toString() }
        if (typeof msgHandler === 'function') msgHandler(ev)
        else msgQueue.push(ev)
      })
      real.on('close', (code: number, reason: Buffer) => {
        if (typeof wrapper.onclose === 'function') wrapper.onclose({ code, reason: reason?.toString() })
      })
      real.on('error', (err: Error) => {
        if (typeof wrapper.onerror === 'function') wrapper.onerror(err)
      })

      return wrapper
    }

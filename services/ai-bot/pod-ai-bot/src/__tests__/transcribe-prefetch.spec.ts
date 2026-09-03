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

// Does an ASR worker really get several chunks at once over clisr, and is that worth anything?
// Capacity 1 is the old behaviour: one chunk on the worker, so its batcher can never group.

// Stub config so importing the provider chain does not run the env-validating IIFE.
jest.mock('../config', () => ({ __esModule: true, default: {} }))

/* eslint-disable import/first */
import { MeasureMetricsContext, newMetrics, type MeasureContext } from '@hcengineering/core'
import { ClisrServer, createCallbackClient, type ClisrClient } from '@intabiafusion/clisr'
import { createServerProvider } from '../transcription/providers/server'
import type { TranscriptionOptions, TranscriptionResult } from '../transcription/types'
/* eslint-enable import/first */

jest.setTimeout(60000)

const TOKEN = 'prefetch-token'
const OPTIONS: TranscriptionOptions = { audioFormat: 'ogg' }

interface Worker {
  server: ClisrServer
  client: ClisrClient
  close: () => Promise<void>
}

/** Router plus one ASR worker that runs `asr` on every chunk it is handed. */
async function startWorker (
  ctx: MeasureContext,
  capacity: number,
  asr: (chunk: Uint8Array) => Promise<TranscriptionResult>
): Promise<Worker> {
  const server = new ClisrServer(
    ctx,
    async (token) => token === TOKEN,
    '1.0',
    undefined,
    async (_ctx, method, ops, session) => {
      if (method === 'transcription') {
        session.options.transcription = ops[0] as boolean
        session.options.capacity = ops[1] as number
      }
      return {}
    }
  )
  await server.start(ctx, 0)
  const port = (server.httpServer?.address() as any)?.port

  const client = await createCallbackClient(ctx, `ws://127.0.0.1:${port}`, TOKEN, {
    clientHost: 'asr-worker',
    binaryExecutor: async (_ctx, method, data) => {
      if (method !== 'transcribe') throw new Error(`unknown method ${method}`)
      return await asr(data)
    }
  })
  await client.request('transcription', [true, capacity])

  return {
    server,
    client,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

/** Distinct audio per chunk, so a mixed-up response cannot pass as the right one. */
const chunkFor = (i: number): Buffer => Buffer.from(`audio-${i}`, 'utf8')
const textFor = (chunk: Uint8Array): string => `text of ${Buffer.from(chunk).toString('utf8')}`

describe('transcription prefetch over clisr', () => {
  const ctx = new MeasureMetricsContext('prefetch', {}, {}, newMetrics())

  it('hands the worker `capacity` distinct files at once', async () => {
    let inFlight = 0
    let peak = 0
    const seen: string[] = []

    const worker = await startWorker(ctx, 3, async (chunk) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      seen.push(Buffer.from(chunk).toString('utf8'))
      await new Promise((resolve) => setTimeout(resolve, 40))
      inFlight--
      return { text: textFor(chunk) }
    })

    try {
      const provider = createServerProvider(ctx, worker.server)
      const results = await Promise.all(Array.from({ length: 9 }, (_, i) => provider.transcribe(chunkFor(i), OPTIONS)))

      // Every call got the transcript of its own audio, not of a neighbour's.
      expect(results.map((r) => r.text)).toEqual(Array.from({ length: 9 }, (_, i) => textFor(chunkFor(i))))
      expect(new Set(seen).size).toBe(9)
      expect(peak).toBe(3)
    } finally {
      await worker.close()
    }
  })

  it('lets the worker batch, which capacity 1 makes impossible', async () => {
    // ASR stub with the shape the GPU actually has: a fixed cost per run plus a small cost per
    // item, so grouping is what pays. Numbers are illustrative, not measured hardware.
    const RUN_MS = 40
    const ITEM_MS = 5
    const WINDOW_MS = 15
    const CHUNKS = 12

    const run = async (capacity: number): Promise<{ ms: number, maxBatch: number, texts: string[] }> => {
      let pending: Array<{ chunk: Uint8Array, resolve: (r: TranscriptionResult) => void }> = []
      let timer: NodeJS.Timeout | undefined
      let maxBatch = 0

      const flush = (): void => {
        const batch = pending
        pending = []
        timer = undefined
        maxBatch = Math.max(maxBatch, batch.length)
        setTimeout(
          () => {
            for (const it of batch) it.resolve({ text: textFor(it.chunk) })
          },
          RUN_MS + batch.length * ITEM_MS
        )
      }

      const worker = await startWorker(ctx, capacity, async (chunk) => {
        return await new Promise<TranscriptionResult>((resolve) => {
          pending.push({ chunk, resolve })
          timer = timer ?? setTimeout(flush, WINDOW_MS)
        })
      })

      try {
        const provider = createServerProvider(ctx, worker.server)
        const started = Date.now()
        const results = await Promise.all(
          Array.from({ length: CHUNKS }, (_, i) => provider.transcribe(chunkFor(i), OPTIONS))
        )
        return { ms: Date.now() - started, maxBatch, texts: results.map((r) => r.text) }
      } finally {
        await worker.close()
      }
    }

    const serial = await run(1)
    const prefetched = await run(4)

    const expected = Array.from({ length: CHUNKS }, (_, i) => textFor(chunkFor(i)))
    expect(serial.texts).toEqual(expected)
    expect(prefetched.texts).toEqual(expected)

    // The structural claim, and the only one that cannot flake: with one chunk in flight the
    // worker never has a second one to group with.
    expect(serial.maxBatch).toBe(1)
    expect(prefetched.maxBatch).toBeGreaterThan(1)

    // Wall clock is reported, not asserted - it depends on the machine, and the real ASR-side
    // number lives with the ASR service, not here.
    console.info('prefetch benefit', {
      chunks: CHUNKS,
      serialMs: serial.ms,
      prefetchedMs: prefetched.ms,
      speedup: Number((serial.ms / prefetched.ms).toFixed(2)),
      maxBatch: prefetched.maxBatch
    })
  })
})

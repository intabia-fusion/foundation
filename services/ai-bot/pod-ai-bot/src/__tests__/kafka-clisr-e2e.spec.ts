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

// The whole stt-worker path on a real broker: Kafka -> batch consumer -> ServerProvider ->
// clisr -> worker -> back. Own topic and group per run, so the stand's topics stay untouched.
//
//   AI_BOT_QUEUE_E2E=1 npx jest kafka-clisr-e2e    (env: QUEUE_CONFIG, default localhost:19093)

// Stub config so importing the provider chain does not run the env-validating IIFE.
jest.mock('../config', () => ({ __esModule: true, default: {} }))

/* eslint-disable import/first */
import { MeasureMetricsContext, newMetrics, type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import { createPlatformQueue, parseQueueConfig } from '@hcengineering/kafka'
import type { ConsumerHandle, PlatformQueue } from '@hcengineering/server-core'
import { ClisrServer, createCallbackClient, type ClisrClient } from '@intabiafusion/clisr'
import { randomUUID } from 'crypto'
import { createServerProvider } from '../transcription/providers/server'
import type { TranscriptionOptions } from '../transcription/types'
/* eslint-enable import/first */

const E2E = process.env.AI_BOT_QUEUE_E2E === '1'
const BROKERS = process.env.QUEUE_CONFIG ?? 'localhost:19093'
const TOKEN = 'queue-e2e-token'
const OPTIONS: TranscriptionOptions = { audioFormat: 'ogg' }
const WORKSPACE = 'e2e-workspace' as WorkspaceUuid

const d = E2E ? describe : describe.skip

interface Task {
  id: number
}

interface Run {
  batchSize: number
  capacity: number
  ms: number
  perTaskMs: number
  maxQueueBatch: number
  maxInFlight: number
}

/**
 * One full pass: produce `tasks` messages, consume them the way `startSttWorker` does, and send
 * each one through clisr to a worker that spends `workMs` on it.
 */
async function runScenario (
  ctx: MeasureContext,
  queue: PlatformQueue,
  opts: { tasks: number, batchSize: number, capacity: number, workMs: number }
): Promise<Run> {
  const topic = `clisr-e2e-${randomUUID()}`
  await queue.createTopic(topic, 1)

  let inFlight = 0
  let maxInFlight = 0
  let maxQueueBatch = 0

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

  const client: ClisrClient = await createCallbackClient(ctx, `ws://127.0.0.1:${port}`, TOKEN, {
    clientHost: 'asr-worker',
    binaryExecutor: async (_ctx, _method, data) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      // 1-2 ms of "recognition", jittered so batches do not finish in lockstep.
      await new Promise((resolve) => setTimeout(resolve, opts.workMs + Math.random()))
      inFlight--
      return { text: `text-${Buffer.from(data).toString('utf8')}` }
    }
  })
  await client.request('transcription', [true, opts.capacity])

  const provider = createServerProvider(ctx, server)
  // Kafka is at-least-once and a failed chunk is retried whole, so count ids, not calls.
  const done = new Set<number>()
  let finished!: () => void
  const allDone = new Promise<void>((resolve) => {
    finished = resolve
  })

  const handle = async (value: Task): Promise<void> => {
    const res = await provider.transcribe(Buffer.from(String(value.id), 'utf8'), OPTIONS)
    if (res.text !== `text-${value.id}`) {
      throw new Error(`wrong transcript for ${value.id}: ${res.text}`)
    }
    done.add(value.id)
    if (done.size === opts.tasks) finished()
  }

  const group = `clisr-e2e-${randomUUID()}`
  let consumer: ConsumerHandle
  if (opts.batchSize === 1) {
    // Mirrors startSttWorker: batch size 1 means the single-message consumer, one task at a time.
    consumer = queue.createConsumer<Task>(ctx, topic, group, async (_ctx, message) => {
      await handle(message.value)
    })
  } else {
    consumer = queue.createBatchConsumer<Task>(
      ctx,
      topic,
      group,
      async (_ctx, messages) => {
        maxQueueBatch = Math.max(maxQueueBatch, messages.length)
        await Promise.all(messages.map((m) => handle(m.value)))
      },
      { batchSize: opts.batchSize }
    )
  }
  // A brand new group skips whatever was produced before it settled its start offset.
  await consumer.waitReady?.()

  const producer = queue.getProducer<Task>(ctx, topic)
  try {
    const started = Date.now()
    await producer.send(
      ctx,
      WORKSPACE,
      Array.from({ length: opts.tasks }, (_, id) => ({ id }))
    )
    await allDone
    const ms = Date.now() - started
    return {
      batchSize: opts.batchSize,
      capacity: opts.capacity,
      ms,
      perTaskMs: Number((ms / opts.tasks).toFixed(2)),
      maxQueueBatch: opts.batchSize === 1 ? 1 : maxQueueBatch,
      maxInFlight
    }
  } finally {
    await consumer.close()
    await producer.close()
    await client.close()
    await server.close()
    await queue.deleteTopics([topic])
  }
}

d('e2e: kafka -> clisr -> worker', () => {
  const ctx = new MeasureMetricsContext('queue-e2e', {}, {}, newMetrics())
  const queue = createPlatformQueue(parseQueueConfig(BROKERS, 'clisr-e2e', ''))

  const TASKS = 200
  const WORK_MS = 1

  jest.setTimeout(600000)

  afterAll(async () => {
    await queue.shutdown()
  })

  it('carries every task through the whole chain', async () => {
    const run = await runScenario(ctx, queue, { tasks: TASKS, batchSize: 16, capacity: 4, workMs: WORK_MS })
    // runScenario only resolves once all `tasks` transcripts came back, and each one is checked
    // against its own id, so reaching here is the assertion. Depth is the interesting part.
    expect(run.maxQueueBatch).toBeGreaterThan(1)
    expect(run.maxInFlight).toBe(4)
  })

  it('shows what queue batch size and clisr capacity each buy', async () => {
    const runs: Run[] = []
    for (const batchSize of [1, 8, 32]) {
      for (const capacity of [1, 4]) {
        runs.push(await runScenario(ctx, queue, { tasks: TASKS, batchSize, capacity, workMs: WORK_MS }))
      }
    }

    // Batch size 1 uses the single-message consumer, so only one task is ever in the air and
    // clisr capacity has nothing to work with. That is the claim worth pinning.
    for (const run of runs.filter((r) => r.batchSize === 1)) {
      expect(run.maxInFlight).toBe(1)
    }
    for (const run of runs.filter((r) => r.batchSize > 1 && r.capacity === 1)) {
      expect(run.maxInFlight).toBe(1)
    }

    console.info(`\ntasks=${TASKS}, work=${WORK_MS}ms, brokers=${BROKERS}`)
    console.table(runs)
  })
})

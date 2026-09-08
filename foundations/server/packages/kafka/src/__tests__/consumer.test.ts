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
import { QueueTopic } from '@hcengineering/server-core'

// jest.mock factory may only reference vars prefixed with `mock`.
const mockState: any = { eachBatch: undefined, listeners: {} }
const mockConsumer = {
  connect: jest.fn(async () => {}),
  subscribe: jest.fn(async () => {}),
  disconnect: jest.fn(async () => {}),
  events: {
    FETCH: 'consumer.fetch',
    CRASH: 'consumer.crash',
    CONNECT: 'consumer.connect',
    DISCONNECT: 'consumer.disconnect'
  },
  // kafkajs `on` returns a remove-listener function
  on: jest.fn((event: string, cb: any) => {
    ;(mockState.listeners[event] ??= []).push(cb)
    return () => {
      mockState.listeners[event] = mockState.listeners[event].filter((l: any) => l !== cb)
    }
  }),
  run: jest.fn(async (opts: any) => {
    mockState.eachBatch = opts.eachBatch
    mockState.eachMessage = opts.eachMessage
  })
}

function emit (event: string, payload: any): void {
  for (const l of [...(mockState.listeners[event] ?? [])]) l({ payload })
}
jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    consumer: jest.fn(() => mockConsumer),
    producer: jest.fn(() => ({})),
    admin: jest.fn(() => ({}))
  })),
  CompressionTypes: { GZIP: 1 },
  Partitioners: { DefaultPartitioner: jest.fn() }
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createPlatformQueue, startHeartbeatPump } = require('../index')

const ctx: any = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  with: (_n: string, _p: any, fn: any) => fn(ctx)
}
const config: any = { postfix: '', brokers: ['localhost:9092'], clientId: 'test', region: '' }

function fakeBatch (n = 1): any {
  return {
    partition: 0,
    messages: Array.from({ length: n }, (_v, i) => ({
      offset: String(i),
      key: Buffer.from('ws'),
      value: Buffer.from(JSON.stringify({ i })),
      headers: {}
    }))
  }
}

function controls (over: any = {}): any {
  return {
    resolveOffset: jest.fn(),
    heartbeat: jest.fn(async () => {}),
    pause: jest.fn(),
    isRunning: () => true,
    isStale: () => false,
    ...over
  }
}

async function makeConsumer (kind: 'batch' | 'single', onMessage: any, options: any = {}): Promise<any> {
  mockState.eachBatch = undefined
  mockState.eachMessage = undefined
  mockState.listeners = {}
  const q = createPlatformQueue(config)
  const opts = { retryDelay: 0, maxRetryDelay: 1, deadTimeout: 0, ...options }
  const handle =
    kind === 'batch'
      ? q.createBatchConsumer(ctx, QueueTopic.Workspace, 'grp', onMessage, opts)
      : q.createConsumer(ctx, QueueTopic.Workspace, 'grp', onMessage, opts)
  // start() is fired async in the constructor; wait until run() captured the handler.
  const captured = (): any => (kind === 'batch' ? mockState.eachBatch : mockState.eachMessage)
  for (let i = 0; i < 50 && captured() === undefined; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  return handle
}

async function makeBatchConsumer (onMessage: any, options: any = {}): Promise<any> {
  await makeConsumer('batch', onMessage, options)
  return mockState.eachBatch
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('kafka client', () => {
  it('configures near-infinite retry with exponential backoff', () => {
    createPlatformQueue(config)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Kafka } = require('kafkajs')
    const cfg = (Kafka as jest.Mock).mock.calls.at(-1)?.[0]
    expect(cfg.retry.retries).toBe(Number.MAX_SAFE_INTEGER)
    expect(cfg.retry.maxRetryTime).toBeGreaterThan(0)
    expect(cfg.retry.initialRetryTime).toBeGreaterThan(0)
  })
})

describe('batch consumer', () => {
  it('bails when the post-work heartbeat reports a rebalance', async () => {
    const onMessage = jest.fn(async () => {})
    const eachBatch = await makeBatchConsumer(onMessage)
    const evicted = jest.fn(async () => {
      throw Object.assign(new Error('evicted'), { type: 'UNKNOWN_MEMBER_ID' })
    })
    await eachBatch({ batch: fakeBatch(1), ...controls({ heartbeat: evicted }) })
    expect(onMessage).toHaveBeenCalledTimes(1)
  })

  it('bails on a failing chunk once the partition goes stale (evicted), no spin', async () => {
    const onMessage = jest.fn(async () => {
      throw new Error('boom')
    })
    const eachBatch = await makeBatchConsumer(onMessage)
    // isStale: false at loop entry so the chunk runs, true after the failure so we bail (no spin).
    let staleCalls = 0
    await eachBatch({ batch: fakeBatch(1), ...controls({ isStale: () => staleCalls++ > 0 }) })
    expect(onMessage).toHaveBeenCalledTimes(1)
  })

  it('retries the chunk on handler error, then resolves offsets on success', async () => {
    let calls = 0
    const onMessage = jest.fn(async () => {
      if (++calls === 1) throw new Error('boom')
    })
    const c = controls()
    const eachBatch = await makeBatchConsumer(onMessage)
    await eachBatch({ batch: fakeBatch(1), ...c })
    expect(onMessage).toHaveBeenCalledTimes(2)
    expect(c.resolveOffset).toHaveBeenCalledWith('0')
  })

  it('stops the heartbeat pump once the batch completes (no leaked beats)', async () => {
    const onMessage = jest.fn(async () => {})
    const c = controls()
    const eachBatch = await makeBatchConsumer(onMessage)
    await eachBatch({ batch: fakeBatch(1), ...c })
    const after = c.heartbeat.mock.calls.length
    await sleep(1500) // longer than the pump interval; a leaked pump would beat again
    expect(c.heartbeat).toHaveBeenCalledTimes(after)
  })

  it('skips unparseable messages without desyncing offsets', async () => {
    const onMessage = jest.fn(async () => {})
    const c = controls()
    const eachBatch = await makeBatchConsumer(onMessage)
    const batch = fakeBatch(1)
    batch.messages[0].value = Buffer.from('not json{')
    await eachBatch({ batch, ...c })
    expect(onMessage).not.toHaveBeenCalled()
    expect(c.resolveOffset).toHaveBeenCalledWith('0')
  })
})

describe('heartbeat pump', () => {
  it('fires heartbeats until stopped', async () => {
    const hb = jest.fn(async () => {})
    const stop = startHeartbeatPump(ctx, hb, 5)
    await sleep(35)
    await stop()
    const n = hb.mock.calls.length
    expect(n).toBeGreaterThanOrEqual(2)
    await sleep(20)
    expect(hb).toHaveBeenCalledTimes(n) // stopped: no further beats
  })

  it('stops pumping once heartbeat reports a rebalance', async () => {
    const hb = jest.fn(async () => {
      throw Object.assign(new Error('evicted'), { type: 'UNKNOWN_MEMBER_ID' })
    })
    const stop = startHeartbeatPump(ctx, hb, 5)
    await sleep(30)
    const n = hb.mock.calls.length
    await stop()
    expect(n).toBe(1) // stopped after the first rebalance throw
  })

  it('keeps pumping through a transient heartbeat error', async () => {
    const hb = jest.fn(async () => {
      throw new Error('transient blip')
    })
    const stop = startHeartbeatPump(ctx, hb, 5)
    await sleep(30)
    await stop()
    expect(hb.mock.calls.length).toBeGreaterThan(1) // did not give up on a non-rebalance error
  })

  it('stop returns promptly without waiting a full interval', async () => {
    const hb = jest.fn(async () => {})
    const stop = startHeartbeatPump(ctx, hb, 10000)
    const t0 = Date.now()
    await stop()
    expect(Date.now() - t0).toBeLessThan(500)
  })
})

describe.each(['batch', 'single'] as const)('crash restart (%s consumer)', (kind) => {
  it('restarts the consumer when kafkajs gives up (restart: false)', async () => {
    await makeConsumer(
      kind,
      jest.fn(async () => {}),
      { crashRestartDelay: 5 }
    )
    const runs = mockConsumer.run.mock.calls.length
    emit('consumer.crash', { error: new Error('Broker not connected'), restart: false })
    await sleep(60)
    expect(mockConsumer.run.mock.calls.length).toBe(runs + 1)
    expect(mockConsumer.connect.mock.calls.length).toBeGreaterThan(1)
  })

  it('does not restart when kafkajs restarts on its own', async () => {
    await makeConsumer(
      kind,
      jest.fn(async () => {}),
      { crashRestartDelay: 5 }
    )
    const runs = mockConsumer.run.mock.calls.length
    emit('consumer.crash', { error: new Error('transient'), restart: true })
    await sleep(60)
    expect(mockConsumer.run.mock.calls.length).toBe(runs)
  })

  it('keeps retrying while restart fails', async () => {
    await makeConsumer(
      kind,
      jest.fn(async () => {}),
      { crashRestartDelay: 5 }
    )
    mockConsumer.connect.mockRejectedValueOnce(new Error('still down'))
    const runs = mockConsumer.run.mock.calls.length
    emit('consumer.crash', { error: new Error('Broker not connected'), restart: false })
    await sleep(120)
    expect(mockConsumer.run.mock.calls.length).toBe(runs + 1)
  })

  it('stops restarting after close', async () => {
    const handle = await makeConsumer(
      kind,
      jest.fn(async () => {}),
      { crashRestartDelay: 5 }
    )
    await handle.close()
    const runs = mockConsumer.run.mock.calls.length
    emit('consumer.crash', { error: new Error('Broker not connected'), restart: false })
    await sleep(60)
    expect(mockConsumer.run.mock.calls.length).toBe(runs)
  })

  it('disconnects again when close lands while the restart is in flight', async () => {
    const handle = await makeConsumer(
      kind,
      jest.fn(async () => {}),
      { crashRestartDelay: 5 }
    )
    emit('consumer.crash', { error: new Error('Broker not connected'), restart: false })
    await handle.close() // during the restart delay
    const disconnects = mockConsumer.disconnect.mock.calls.length
    await sleep(60)
    // either the loop bailed before restarting, or it restarted and disconnected right after
    if (mockConsumer.run.mock.calls.length > 1) {
      expect(mockConsumer.disconnect.mock.calls.length).toBeGreaterThan(disconnects)
    }
  })
})

describe('dead queue watchdog', () => {
  it('exits when the broker never connects', async () => {
    const onDead = jest.fn()
    await makeConsumer(
      'batch',
      jest.fn(async () => {}),
      { deadTimeout: 20, onDead }
    )
    await sleep(60)
    expect(onDead).toHaveBeenCalledTimes(1)
  })

  it('does not exit once the consumer connects', async () => {
    const onDead = jest.fn()
    await makeConsumer(
      'batch',
      jest.fn(async () => {}),
      { deadTimeout: 20, onDead }
    )
    emit('consumer.connect', {})
    await sleep(60)
    expect(onDead).not.toHaveBeenCalled()
  })

  it('re-arms on disconnect and exits if the queue stays down', async () => {
    const onDead = jest.fn()
    await makeConsumer(
      'batch',
      jest.fn(async () => {}),
      { deadTimeout: 20, onDead }
    )
    emit('consumer.connect', {})
    emit('consumer.disconnect', {})
    await sleep(60)
    expect(onDead).toHaveBeenCalledTimes(1)
  })

  it('does not exit after close', async () => {
    const onDead = jest.fn()
    const handle = await makeConsumer(
      'batch',
      jest.fn(async () => {}),
      { deadTimeout: 20, onDead }
    )
    await handle.close()
    await sleep(60)
    expect(onDead).not.toHaveBeenCalled()
  })

  it('is disabled with deadTimeout 0', async () => {
    const onDead = jest.fn()
    await makeConsumer(
      'batch',
      jest.fn(async () => {}),
      { deadTimeout: 0, onDead }
    )
    await sleep(40)
    expect(onDead).not.toHaveBeenCalled()
  })
})

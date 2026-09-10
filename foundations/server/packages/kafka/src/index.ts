//
// Copyright © 2025 Hardcore Engineering Inc.
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

import { type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import {
  type ConsumerControl,
  type ConsumerHandle,
  type ConsumerMessage,
  type PlatformQueue,
  type PlatformQueueProducer,
  QueueTopic
} from '@hcengineering/server-core'
import { type Admin, CompressionTypes, type Consumer, Kafka, Partitioners, type Producer } from 'kafkajs'
import type * as tls from 'tls'

// Member is out of the group: heartbeat/commit keep failing until kafkajs rejoins, so bail.
// Any other heartbeat error is transient and should be retried.
const REBALANCE_ERROR_TYPES = new Set(['UNKNOWN_MEMBER_ID', 'REBALANCE_IN_PROGRESS', 'ILLEGAL_GENERATION'])
function isRebalanceError (err: any): boolean {
  if (err == null) return false
  const type: string = typeof err.type === 'string' ? err.type : ''
  const name: string = typeof err.name === 'string' ? err.name : ''
  return (
    REBALANCE_ERROR_TYPES.has(type) ||
    name.includes('Rebalance') ||
    name.includes('IllegalGeneration') ||
    name.includes('UnknownMemberId')
  )
}

// A brand new group starts at the latest offset resolved on its first fetch, so anything produced
// before that fetch is never delivered. Resolve once the first fetch is done to close that window.
function firstFetchDone (cc: Consumer): Promise<void> {
  return new Promise<void>((resolve) => {
    const off = cc.on(cc.events.FETCH, () => {
      off()
      resolve()
    })
  })
}

// kafkajs restarts a crashed consumer only when the error is retriable. A plain Error - e.g.
// 'Broker not connected' after a broker/DNS outage - stops the consumer for good and the pod goes
// silent until restarted. Restart it ourselves in that case.
const CRASH_RESTART_DELAY = 5000
const MAX_CRASH_RESTART_DELAY = 60000

export function installCrashRestart (
  ctx: MeasureContext,
  cc: Consumer,
  restart: () => Promise<void>,
  isClosed: () => boolean,
  delayMs: number = CRASH_RESTART_DELAY
): void {
  // A caller-supplied 0/NaN would turn the loop into a tight spin
  const baseDelay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : CRASH_RESTART_DELAY
  let restarting = false
  cc.on(cc.events.CRASH, (event: any) => {
    if (event?.payload?.restart === true || restarting || isClosed()) return
    restarting = true
    ctx.warn('consumer crashed unrecoverably, restarting', { err: event?.payload?.error })
    void (async () => {
      let delay = baseDelay
      while (!isClosed()) {
        await new Promise((resolve) => {
          // unref: a pending restart delay must not hold the process up during shutdown
          setTimeout(resolve, delay).unref?.()
        })
        if (isClosed()) break
        try {
          await restart()
          // close() may have run while restart was in flight - undo it, or the pod keeps consuming.
          if (isClosed()) await cc.disconnect()
          break
        } catch (err: any) {
          ctx.error('failed to restart consumer', { err })
          delay = Math.min(delay * 2, MAX_CRASH_RESTART_DELAY)
        }
      }
      restarting = false
    })()
  })
}

// Kafka unreachable for this long (including the very first connect) means the pod is useless:
// exit and let the orchestrator restart it. 0 disables.
const QUEUE_DEAD_TIMEOUT = 60000

export function installDeadWatchdog (
  ctx: MeasureContext,
  cc: Consumer,
  isClosed: () => boolean,
  timeoutMs: number = intEnv('QUEUE_DEAD_TIMEOUT', QUEUE_DEAD_TIMEOUT),
  onDead: () => void = () => process.exit(1)
): void {
  if (timeoutMs <= 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (isClosed()) return
      ctx.error('queue unreachable for too long, exiting to be restarted', { timeoutMs })
      onDead()
    }, timeoutMs)
    timer.unref?.()
  }
  cc.on(cc.events.CONNECT, () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  })
  cc.on(cc.events.DISCONNECT, arm)
  arm() // not connected yet: cover a broker that is down at startup
}

// Pump heartbeats every second while a handler runs so a slow message/batch never trips
// sessionTimeout. kafkajs throttles internally, so frequent calls are safe.
const HEARTBEAT_PUMP_INTERVAL = 1000

export function startHeartbeatPump (
  ctx: MeasureContext,
  heartbeat: () => Promise<void>,
  intervalMs: number = HEARTBEAT_PUMP_INTERVAL
): () => Promise<void> {
  let running = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  const loop = (async () => {
    while (running) {
      await new Promise<void>((resolve) => {
        wake = resolve
        timer = setTimeout(resolve, intervalMs)
      })
      if (!running) break
      try {
        await heartbeat()
      } catch (err: any) {
        if (isRebalanceError(err)) {
          // Member gone: stop pumping. The handler loop's own checks bail and kafkajs rejoins.
          ctx.warn('heartbeat pump: member evicted, stopping', { err })
          running = false
        } else {
          // Transient (network blip): keep pumping, next beat likely recovers.
          ctx.warn('heartbeat pump: transient error, continuing', { err })
        }
      }
    }
  })()
  return async () => {
    running = false
    if (timer !== undefined) clearTimeout(timer)
    wake?.() // resolve the pending sleep immediately so shutdown does not wait a full interval
    await loop
  }
}

export interface QueueConfig {
  postfix: string // a topic prefix to be used do distinguish between staging and production topics in same broker
  brokers: string[]
  clientId: string
  region: string

  ssl?: tls.ConnectionOptions | boolean
}

/**
 * Query config parser in the form of 'brokers;clientId'
 * brokers are comma separated
 */
export function parseQueueConfig (config: string, serviceId: string, region: string): QueueConfig {
  const [brokers, postfix] = config.split(';')
  return {
    postfix: postfix ?? '', // Empty by default
    brokers: brokers.split(','),
    clientId: serviceId,
    region
  }
}

function getKafkaTopicId (topic: QueueTopic | string, config: QueueConfig): string {
  if (config.region !== '') {
    return `${config.region}.${topic}${config.postfix ?? ''}`
  }
  return `${topic}${config.postfix ?? ''}`
}

class PlatformQueueImpl implements PlatformQueue {
  consumers: ConsumerHandle[] = []
  producers = new Map<QueueTopic | string, PlatformQueueProducerImpl>()
  constructor (
    private readonly kafka: Kafka,
    readonly config: QueueConfig
  ) {}

  getClientId (): string {
    return this.config.clientId
  }

  async shutdown (): Promise<void> {
    for (const [, p] of this.producers) {
      try {
        await p.close()
      } catch (err: any) {
        console.error('failed to close producer', err)
      }
    }
    for (const c of this.consumers) {
      try {
        await c.close()
      } catch (err: any) {
        console.error('failed to close consumer', err)
      }
    }
  }

  getProducer<T>(ctx: MeasureContext, topic: QueueTopic | string): PlatformQueueProducer<T> {
    const producer = this.producers.get(topic)
    if (producer !== undefined && !producer.isClosed()) return producer

    const created = new PlatformQueueProducerImpl(ctx, this.kafka, getKafkaTopicId(topic, this.config), this)
    this.producers.set(topic, created)

    return created
  }

  createConsumer<T>(
    ctx: MeasureContext,
    topic: QueueTopic | string,
    groupId: string,
    onMessage: (ctx: MeasureContext, msg: ConsumerMessage<T>, queue: ConsumerControl) => Promise<void>,
    options?: {
      fromBegining?: boolean
      retryDelay?: number // Initial retry delay in milliseconds (default 1000)
      maxRetryDelay?: number // Maximum retry delay in seconds (default 10)
    }
  ): ConsumerHandle {
    const result = new PlatformQueueConsumerImpl(ctx, this.kafka, this.config, topic, groupId, onMessage, options)
    this.consumers.push(result)
    return result
  }

  /**
   * Create a consumer that processes messages in batches (per partition).
   * The handler receives an ordered array of messages and the whole batch
   * will be retried in case of failures.
   */
  createBatchConsumer<T>(
    ctx: MeasureContext,
    topic: QueueTopic | string,
    groupId: string,
    onMessage: (ctx: MeasureContext, msgs: ConsumerMessage<T>[], queue: ConsumerControl) => Promise<void>,
    options?: {
      fromBegining?: boolean
      retryDelay?: number
      maxRetryDelay?: number
      batchSize?: number
      batchTimeout?: number
    }
  ): ConsumerHandle {
    const result = new PlatformQueueBatchConsumerImpl(ctx, this.kafka, this.config, topic, groupId, onMessage, options)
    this.consumers.push(result)
    return result
  }

  async checkCreateTopic (
    admin: Admin,
    topic: QueueTopic | string,
    topics: Set<string>,
    numPartitions?: number
  ): Promise<void> {
    const kTopic = getKafkaTopicId(topic, this.config)
    if (!topics.has(kTopic)) {
      const partitions = numPartitions ?? 1
      console.info(`Creating topic ${kTopic} with ${partitions} partitions`)
      try {
        await admin.createTopics({ topics: [{ topic: kTopic, numPartitions: partitions }] })
        topics.add(kTopic)
        console.info(`Topic ${kTopic} created successfully`)
      } catch (err: any) {
        // Always check if topic exists after any error - another service may have created it
        const currentTopics = new Set(await admin.listTopics())
        if (currentTopics.has(kTopic)) {
          console.info(`Topic ${kTopic} already exists (created by another service), skipping`)
          topics.add(kTopic)
        } else {
          // Check if it's a fatal error or just "already exists" wrapped in different error type
          const errorType = err?.errors?.[0]?.type
          const errorCode = err?.errors?.[0]?.code
          if (errorType === 'TOPIC_ALREADY_EXISTS' || errorCode === 36) {
            console.info(`Topic ${kTopic} already exists (error code), skipping`)
            topics.add(kTopic)
          } else {
            // Only log real errors, not race conditions between services
            console.info(`Topic ${kTopic} creation failed (${errorType}:${errorCode}), will retry on next startup`)
          }
        }
      }
    }
  }

  async createTopic (topics: string | string[], partitions: number): Promise<void> {
    const admin = this.kafka.admin()
    try {
      await admin.connect()
      const existing = new Set(await admin.listTopics())
      topics = Array.isArray(topics) ? topics : [topics]
      for (const topic of topics) {
        await this.checkCreateTopic(admin, topic, existing, partitions)
      }
    } finally {
      await admin.disconnect()
    }
  }

  async createTopics (tx: number): Promise<void> {
    const admin = this.kafka.admin()
    try {
      await admin.connect()
      const topics = new Set(await admin.listTopics())
      await this.checkCreateTopic(admin, QueueTopic.Tx, topics, tx)
      await this.checkCreateTopic(admin, QueueTopic.OnlineUserTx, topics, tx)
      await this.checkCreateTopic(admin, QueueTopic.Fulltext, topics, 5)
      await this.checkCreateTopic(admin, QueueTopic.Workspace, topics, 1)
      await this.checkCreateTopic(admin, QueueTopic.Users, topics, 1)
      await this.checkCreateTopic(admin, QueueTopic.Process, topics, 1)
      await this.checkCreateTopic(admin, QueueTopic.AIQueue, topics, 10)
      await this.checkCreateTopic(admin, QueueTopic.TranscriptionQueue, topics, 10)
      await this.checkCreateTopic(admin, QueueTopic.NotificationQueue, topics, 2)
      await this.checkCreateTopic(admin, QueueTopic.LoveQueue, topics, 1)
      await this.checkCreateTopic(admin, QueueTopic.CrmQueue, topics, 1)
      await this.checkCreateTopic(admin, QueueTopic.BillingUsage, topics, 1)
    } finally {
      await admin.disconnect()
    }
  }

  async checkDeleteTopic (admin: any, topic: QueueTopic | string, topics: Set<string>): Promise<void> {
    const kTopic = getKafkaTopicId(topic, this.config)
    if (topics.has(kTopic)) {
      try {
        await admin.deleteTopics({ topics: [kTopic] })
      } catch (err: any) {
        console.error('Failed to delete topic', kTopic, err)
      }
    }
  }

  async deleteTopics (topics?: (QueueTopic | string)[]): Promise<void> {
    const admin = this.kafka.admin()
    try {
      await admin.connect()
      const existing = new Set(await admin.listTopics())
      if (topics !== undefined) {
        for (const t of topics) {
          await this.checkDeleteTopic(admin, t, existing)
        }
      } else {
        await this.checkDeleteTopic(admin, QueueTopic.Tx, existing)
        await this.checkDeleteTopic(admin, QueueTopic.OnlineUserTx, existing)
        await this.checkDeleteTopic(admin, QueueTopic.Fulltext, existing)
        await this.checkDeleteTopic(admin, QueueTopic.Workspace, existing)
        await this.checkDeleteTopic(admin, QueueTopic.Users, existing)
      }
    } finally {
      await admin.disconnect()
    }
  }
}

class PlatformQueueProducerImpl implements PlatformQueueProducer<any> {
  txProducer: Producer
  connected: Promise<void> | undefined
  private closed = false

  constructor (
    readonly ctx: MeasureContext,
    kafka: Kafka,
    private readonly topic: string,
    private readonly queue: PlatformQueue
  ) {
    this.txProducer = kafka.producer({
      allowAutoTopicCreation: true,
      createPartitioner: Partitioners.DefaultPartitioner
    })
    this.connected = this.ctx.with('connect-broker', {}, () => this.txProducer.connect())
  }

  getQueue (): PlatformQueue {
    return this.queue
  }

  async send (ctx: MeasureContext, workspace: WorkspaceUuid, msgs: any[], partitionKey?: string): Promise<void> {
    if (this.connected !== undefined) {
      await this.connected
      this.connected = undefined
    }
    await this.ctx.with('send', { topic: this.topic }, () =>
      this.txProducer.send({
        topic: this.topic,
        messages: msgs.map((m) => ({
          key: Buffer.from(`${partitionKey ?? workspace}`),
          value: Buffer.from(JSON.stringify(m)),
          headers: {
            workspace,
            meta: JSON.stringify(ctx.extractMeta())
          }
        })),
        compression: CompressionTypes.GZIP
      })
    )
  }

  isClosed (): boolean {
    return this.closed
  }

  async close (): Promise<void> {
    this.closed = true
    await this.ctx.with('disconnect', {}, () => this.txProducer.disconnect())
  }
}

class PlatformQueueConsumerImpl implements ConsumerHandle {
  connected = false
  private closed = false
  cc: Consumer
  private readonly ready: Promise<void>
  constructor (
    readonly ctx: MeasureContext,
    readonly kafka: Kafka,
    readonly config: QueueConfig,
    private readonly topic: QueueTopic | string,
    groupId: string,
    private readonly onMessage: (
      ctx: MeasureContext,
      msg: ConsumerMessage<any>,
      queue: ConsumerControl
    ) => Promise<void>,
    private readonly options?: {
      fromBegining?: boolean
      retryDelay?: number // Initial retry delay in milliseconds (default 1000)
      maxRetryDelay?: number // Maximum retry delay in seconds (default 10)
      sessionTimeout?: number // Optional session timeout in milliseconds
      // internal/test-only knobs, prod tunes deadTimeout via QUEUE_DEAD_TIMEOUT
      crashRestartDelay?: number
      deadTimeout?: number
      onDead?: () => void
    }
  ) {
    this.cc = this.kafka.consumer({
      groupId: `${getKafkaTopicId(this.topic, this.config)}-${groupId}`,
      sessionTimeout: this.options?.sessionTimeout,
      allowAutoTopicCreation: true
    })
    this.ready = firstFetchDone(this.cc)
    this.installListeners(this.options?.crashRestartDelay, this.options?.deadTimeout, this.options?.onDead)

    void this.start().catch((err) => {
      ctx.error('failed to consume', { err })
    })
  }

  async start (): Promise<void> {
    await this.doConnect()
    await this.doSubscribe()

    await this.cc.run({
      // eslint-disable-next-line @typescript-eslint/unbound-method -- kafkajs passes these as closures
      eachMessage: async ({ message, pause, heartbeat }) => {
        const msgKey = message.key?.toString() ?? ''
        const msgData = JSON.parse(message.value?.toString() ?? '{}')
        const meta = JSON.parse(message.headers?.meta?.toString() ?? '{}')
        const workspace = (message.headers?.workspace?.toString() ?? msgKey) as WorkspaceUuid

        const retryDelay = this.options?.retryDelay ?? 1000
        const maxRetryDelay = this.options?.maxRetryDelay ?? 10
        let to = 1
        // Keep group membership alive even if a single message handler runs long.
        const stopPump = startHeartbeatPump(this.ctx, heartbeat)
        try {
          while (true) {
            try {
              await this.ctx.with(
                'handle-msg',
                {},
                (ctx) => this.onMessage(ctx, { workspace, value: msgData }, { heartbeat, pause }),
                {},
                {
                  meta
                }
              )
              break
            } catch (err: any) {
              this.ctx.error('failed to process message', { err, msgKey, msgData, workspace })
              // Probe liveness: bail only on a rebalance (auto-commit fails there, so the message is
              // redelivered, not lost). Transient heartbeat errors are ignored and we retry.
              try {
                await heartbeat()
              } catch (hbErr) {
                if (isRebalanceError(hbErr)) {
                  this.ctx.warn('member evicted during message, bailing to rejoin', { err: hbErr })
                  return
                }
                this.ctx.warn('heartbeat failed during retry, ignoring transient error', { err: hbErr })
              }
              await new Promise((resolve) => setTimeout(resolve, to * retryDelay))
              if (to < maxRetryDelay) {
                to++
              }
            }
          }
        } finally {
          await stopPump()
        }
      }
    })
  }

  private installListeners (delayMs?: number, deadTimeout?: number, onDead?: () => void): void {
    this.cc.on(this.cc.events.CONNECT, () => {
      this.connected = true
      this.ctx.info('consumer connected to queue')
    })
    this.cc.on(this.cc.events.DISCONNECT, () => {
      this.connected = false
      this.ctx.warn('consumer disconnected from queue')
    })
    installCrashRestart(
      this.ctx,
      this.cc,
      () => this.start(),
      () => this.closed,
      delayMs
    )
    installDeadWatchdog(this.ctx, this.cc, () => this.closed, deadTimeout, onDead)
  }

  async doConnect (): Promise<void> {
    await this.cc.connect()
  }

  async doSubscribe (): Promise<void> {
    await this.cc.subscribe({
      topic: getKafkaTopicId(this.topic, this.config),
      fromBeginning: this.options?.fromBegining
    })
  }

  isConnected (): boolean {
    return this.connected
  }

  async waitReady (): Promise<void> {
    await this.ready
  }

  close (): Promise<void> {
    this.closed = true
    return this.cc.disconnect()
  }
}

/**
 * Batch consumer implementation.
 * Uses kafkajs eachBatch to receive native partition batches and slices them
 * into chunks of `batchSize`. The entire chunk is retried on error.
 *
 * `batchTimeout` (ms) maps to kafkajs `maxWaitTimeInMs` — how long broker
 * waits for `minBytes` before returning whatever is available. Lower = lower
 * latency, higher = better throughput.
 */
class PlatformQueueBatchConsumerImpl implements ConsumerHandle {
  connected = false
  private closed = false
  cc: Consumer
  private readonly ready: Promise<void>
  constructor (
    readonly ctx: MeasureContext,
    readonly kafka: Kafka,
    readonly config: QueueConfig,
    private readonly topic: QueueTopic | string,
    groupId: string,
    private readonly onMessage: (
      ctx: MeasureContext,
      msgs: ConsumerMessage<any>[],
      queue: ConsumerControl
    ) => Promise<void>,
    private readonly options?: {
      fromBegining?: boolean
      retryDelay?: number // Initial retry delay in milliseconds (default 1000)
      maxRetryDelay?: number // Maximum retry delay in seconds (default 10)
      batchSize?: number
      batchTimeout?: number
      sessionTimeout?: number // Optional session timeout in milliseconds
      // internal/test-only knobs, prod tunes deadTimeout via QUEUE_DEAD_TIMEOUT
      crashRestartDelay?: number
      deadTimeout?: number
      onDead?: () => void
    }
  ) {
    const rawMaxWait = this.options?.batchTimeout
    const sanitizedMaxWait =
      typeof rawMaxWait === 'number' && Number.isFinite(rawMaxWait) && rawMaxWait >= 0 ? rawMaxWait : undefined
    this.cc = this.kafka.consumer({
      groupId: `${getKafkaTopicId(this.topic, this.config)}-${groupId}`,
      sessionTimeout: this.options?.sessionTimeout,
      maxWaitTimeInMs: sanitizedMaxWait,
      allowAutoTopicCreation: true
    })
    this.ready = firstFetchDone(this.cc)
    this.installListeners(this.options?.crashRestartDelay, this.options?.deadTimeout, this.options?.onDead)

    void this.start().catch((err) => {
      ctx.error('failed to consume', { err })
    })
  }

  async start (): Promise<void> {
    await this.doConnect()
    await this.doSubscribe()

    // Clamp batchSize >= 1 to avoid zero/NaN producing an infinite chunk loop
    const rawBatchSize = this.options?.batchSize
    const batchSize =
      typeof rawBatchSize === 'number' && Number.isFinite(rawBatchSize) && rawBatchSize >= 1
        ? Math.floor(rawBatchSize)
        : 1
    const retryDelay = this.options?.retryDelay ?? 1000
    const maxRetryDelay = this.options?.maxRetryDelay ?? 10

    await this.cc.run({
      eachBatchAutoResolve: false,
      // eslint-disable-next-line @typescript-eslint/unbound-method -- kafkajs passes these as closures
      eachBatch: async ({ batch, resolveOffset, heartbeat, pause, isRunning, isStale }) => {
        const partitionNum = batch.partition
        // Parse all messages upfront so a parse error inside a chunk doesn't desync offsets
        const parsed: Array<{ offset: string, workspace: WorkspaceUuid, value: any, meta: any }> = []
        for (const message of batch.messages) {
          const msgKey = message.key?.toString() ?? ''
          let msgData: any
          let meta: any
          try {
            msgData = JSON.parse(message.value?.toString() ?? '{}')
            meta = JSON.parse(message.headers?.meta?.toString() ?? '{}')
          } catch (err: any) {
            this.ctx.error('failed to parse message, skipping', {
              err,
              partition: partitionNum,
              offset: message.offset
            })
            resolveOffset(message.offset)
            continue
          }
          const workspace = (message.headers?.workspace?.toString() ?? msgKey) as WorkspaceUuid
          parsed.push({ offset: message.offset, workspace, value: msgData, meta })
        }

        // Keep group membership alive for the whole batch, even if a single onMessage runs long.
        const stopPump = startHeartbeatPump(this.ctx, heartbeat)
        try {
          // Process in chunks of batchSize, retry whole chunk on error
          for (let i = 0; i < parsed.length; i += batchSize) {
            if (!isRunning() || isStale()) return
            const chunk = parsed.slice(i, i + batchSize)
            const msgs = chunk.map((m) => ({ workspace: m.workspace, value: m.value }))

            let to = 1
            while (true) {
              try {
                await this.ctx.with(
                  'handle-msg',
                  {},
                  (ctx) => this.onMessage(ctx, msgs, { heartbeat, pause }),
                  {},
                  { meta: { batchCount: chunk.length } }
                )
              } catch (err: any) {
                this.ctx.error('failed to process message batch', {
                  err,
                  partition: partitionNum,
                  size: chunk.length
                })
                // Bail if we were evicted/stopped - retrying with a dead member never commits and
                // reprocesses forever. Otherwise back off and retry (the pump keeps us alive).
                if (isStale() || !isRunning()) return
                await new Promise((resolve) => setTimeout(resolve, to * retryDelay))
                if (to < maxRetryDelay) to++
                if (!isRunning() || isStale()) return
                continue
              }
              // Commit offsets. A heartbeat throw here is a post-work eviction - bail to rejoin
              // (offsets recommit on redelivery; handlers are idempotent), not a processing failure.
              for (const m of chunk) resolveOffset(m.offset)
              try {
                await heartbeat()
              } catch (hbErr) {
                if (isRebalanceError(hbErr)) {
                  this.ctx.warn('member evicted after batch chunk, rejoining', {
                    err: hbErr,
                    partition: partitionNum
                  })
                  return
                }
              }
              break
            }
          }
        } finally {
          await stopPump()
        }
      }
    })
  }

  private installListeners (delayMs?: number, deadTimeout?: number, onDead?: () => void): void {
    this.cc.on(this.cc.events.CONNECT, () => {
      this.connected = true
      this.ctx.info('consumer connected to queue')
    })
    this.cc.on(this.cc.events.DISCONNECT, () => {
      this.connected = false
      this.ctx.warn('consumer disconnected from queue')
    })
    installCrashRestart(
      this.ctx,
      this.cc,
      () => this.start(),
      () => this.closed,
      delayMs
    )
    installDeadWatchdog(this.ctx, this.cc, () => this.closed, deadTimeout, onDead)
  }

  async doConnect (): Promise<void> {
    await this.cc.connect()
  }

  async doSubscribe (): Promise<void> {
    await this.cc.subscribe({
      topic: getKafkaTopicId(this.topic, this.config),
      fromBeginning: this.options?.fromBegining
    })
  }

  isConnected (): boolean {
    return this.connected
  }

  async waitReady (): Promise<void> {
    await this.ready
  }

  close (): Promise<void> {
    this.closed = true
    return this.cc.disconnect()
  }
}

/**
 * Constructs a platform queue.
 */
export function getPlatformQueue (serviceId: string, region?: string): PlatformQueue {
  const queueConfig = process.env.QUEUE_CONFIG ?? 'localhost:9092'
  if (queueConfig === undefined) {
    throw new Error('Please provide queue config')
  }
  const config = parseQueueConfig(
    queueConfig,
    serviceId,
    region ?? process.env.QUEUE_REGION ?? process.env.REGION ?? ''
  )
  return createPlatformQueue(config)
}

function intEnv (name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  const v = parseInt(raw, 10)
  return Number.isFinite(v) ? v : def
}

export function createPlatformQueue (config: QueueConfig): PlatformQueue {
  console.info({ message: 'Using queue', config })

  return new PlatformQueueImpl(
    new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      ssl: config.ssl,
      // Never give up on the broker by default: retries=5 gets exhausted during a redpanda
      // restart/rebalance and kills producers/consumers. Overridable via env (e.g. bound retries
      // in tests so a transient broker error fails fast instead of hanging).
      retry: {
        initialRetryTime: intEnv('QUEUE_INITIAL_RETRY_TIME', 300),
        maxRetryTime: intEnv('QUEUE_MAX_RETRY_TIME', 30000),
        factor: 0.2,
        multiplier: 2,
        retries: intEnv('QUEUE_RETRIES', Number.MAX_SAFE_INTEGER)
      }
    }),
    config
  )
}

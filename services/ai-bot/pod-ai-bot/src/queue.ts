//
// Copyright © 2024-2025 Hardcore Engineering Inc.
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
import cors from 'cors'
import express, { type Express } from 'express'
import { setMetadata } from '@hcengineering/platform'
import serverClient, { withRetry } from '@hcengineering/server-client'
import { withRetry as retryTransient, retryNetworkErrors } from '@hcengineering/retry'
import {
  ConsumerControl,
  ConsumerHandle,
  ConsumerMessage,
  getDeadletterTopic,
  initStatisticsContext,
  type PlatformQueueProducer,
  type PlatformQueue,
  QueueTopic,
  QueueWorkspaceEvent,
  type QueueWorkspaceLimitsMessage,
  type QueueWorkspacePurchaseMessage,
  QueueWorkspaceMessage
} from '@hcengineering/server-core'
import serverToken, { generateToken } from '@hcengineering/server-token'

import { getClient as getAccountClient } from '@hcengineering/account-client'
import { type AIEventRequest, type ChatVoiceTranscriptionTask } from '@hcengineering/ai-bot'
import { createOpenTelemetryMetricsContext, SplitLogger } from '@hcengineering/analytics-service'
import core, {
  type MeasureContext,
  newMetrics,
  RateLimiter,
  type Class,
  type Doc,
  type Ref,
  type SocialId,
  type Tx,
  type TxMixin,
  type WorkspaceUuid
} from '@hcengineering/core'
import contact, { type Employee, type Person } from '@hcengineering/contact'
import { getPlatformQueue } from '@hcengineering/kafka'
import { join } from 'path'
import {
  updateDeepgramBilling,
  PoolLimits,
  setPoolLimitsRef,
  invalidateWorkspaceWindows,
  applyPurchase
} from './billing'
import config from './config'
import { type BillingQueueMessage, setUsageProducer } from './billing'
import { AIControl } from './controller'
import { LimitsState } from './limits'
import { type AIPipelineMessage, dispatch, providerTopic, providerTopics } from './pipeline'
import { registryForFeature } from './llms/modelRegistry'
import { registerLoaders } from './loaders'
import { createServer } from './server/server'
import { TranscriptionQueueTask } from './transcription'
import { createTranscriptionsSupport } from './transcriptions'
import { type SummaryTask, TranscriptionTask } from './types'
import { getAccountUuid } from './utils/account'
import { ClisrServer } from '@intabiafusion/clisr'
import love, { type MeetingMinutes, QueueMeetingEvent, QueueMeetingMessage } from '@hcengineering/love'

// Consumer groups are per-role, never one shared 'ai-bot': a single group across topics makes one
// role's rebalance stall the others, and workspace events would land on a pod that does not serve
// the workspace.
// Keeps the historical name on purpose: a new group starts at `latest`, and a purchase left
// unconsumed at deploy time would be dropped — that one is money.
const GROUP_PURCHASE = 'ai-bot'
const GROUP_WELCOME = 'ai-bot-welcome'
const GROUP_EVENT_ROUTER = 'ai-bot-event-router'
const GROUP_STT_INGEST = 'ai-bot-stt-ingest'
const GROUP_TRANSCRIPTION = 'ai-bot-transcription'
const GROUP_SUMMARY = 'ai-bot-summary'
// Own topic, not AIQueue: a summary is not a chat event and must survive a pod restart.
const SUMMARY_TOPIC = 'ai-summary'
const providerGroup = (providerId: string): string => `ai-bot-llm-${providerId}`

// LimitsChanged/Up must reach EVERY pod (each keeps its own 30s window cache and limitsState), so
// the state consumer joins a group of its own instead of sharing one. Empty groups expire by the
// broker's offset retention.
const podGroupId = (): string => {
  const id = config.ClientId !== '' ? config.ClientId : (process.env.HOSTNAME ?? `${process.pid}`)
  return `ai-bot-state-${id}`
}

/** Shared startup context for every pod role. */
interface Boot {
  ctx: MeasureContext
  queue: PlatformQueue
  aiControl: AIControl
  app: Express
  clisrServer: ClisrServer
  limitsState: LimitsState
  onClose: Array<() => void>
}

/** The clisr handshake: clients announce their capabilities (llm / transcription). */
async function clisrHandshake (
  ctx: MeasureContext,
  method: string,
  ops: unknown[],
  session: { options: { transcription?: boolean, llm?: boolean, capacity?: number } }
): Promise<Record<string, never>> {
  if (method === 'transcription') {
    session.options.transcription = ops[0] as boolean
    // How many chunks the worker takes at once: the dispatcher keeps that many in flight so the
    // worker's own ASR batcher always has something to group.
    const capacity = ops[1]
    if (typeof capacity === 'number' && capacity > 0) {
      session.options.capacity = capacity
    }
  }
  if (method === 'llm') {
    session.options.llm = ops[0] as boolean
  }
  // The budget is per session, not per method: a worker serving both shares it, and busy LLM
  // calls would starve transcription. The shipped topology keeps them in separate pods.
  if (session.options.llm === true && session.options.transcription === true && session.options.capacity != null) {
    ctx.warn('worker serves both llm and transcription, they share one capacity budget', {
      capacity: session.options.capacity
    })
  }
  return {}
}

/** Common bootstrap: metadata, ctx, account identity, AIControl, Express + ClisrServer. */
async function bootstrap (role: string): Promise<Boot> {
  setMetadata(serverToken.metadata.Secret, config.ServerSecret)
  setMetadata(serverToken.metadata.Service, 'ai-bot-service')
  setMetadata(serverClient.metadata.UserAgent, config.ServiceID)
  setMetadata(serverClient.metadata.Endpoint, config.AccountsURL)

  registerLoaders()

  const queue = getPlatformQueue(QueueTopic.AIQueue)

  const ctx = initStatisticsContext('ai-bot-service', {
    factory: () =>
      createOpenTelemetryMetricsContext(
        'ai-bot-service',
        {},
        {},
        newMetrics(),
        new SplitLogger('ai-bot-service', {
          root: join(process.cwd(), 'logs'),
          enableConsole: (process.env.ENABLE_CONSOLE ?? 'true') === 'true'
        })
      )
  })
  ctx.info('AI Bot Service started', { role, firstName: config.FirstName, lastName: config.LastName })

  const personUuid = await withRetry(
    async () => await getAccountUuid(ctx),
    (_, attempt) => attempt >= 5,
    5000
  )()

  if (personUuid === undefined) {
    ctx.error('AI Bot Service failed to start. No person found.')
    process.exit()
  }
  ctx.info('AI person uuid', { personUuid })

  const socialIds: SocialId[] = await getAccountClient(
    config.AccountsURL,
    generateToken(personUuid, undefined, { service: 'aibot' })
  ).getSocialIds()

  const aiControl = new AIControl(personUuid, socialIds, ctx)

  // Limits: fail-open until first LimitsChanged event; producer for usage deltas
  const limitsState = new LimitsState()
  aiControl.setLimitsState(limitsState)

  const billingUsageProducer: PlatformQueueProducer<BillingQueueMessage> = queue.getProducer<BillingQueueMessage>(
    ctx,
    QueueTopic.BillingUsage
  )
  setUsageProducer(billingUsageProducer)

  // Global per-model pool guard: push our model catalog (via the producer set above),
  // then poll purchased pools.
  const poolLimits = new PoolLimits()
  aiControl.setPoolLimits(poolLimits)
  setPoolLimitsRef(poolLimits)
  const onClose: Array<() => void> = []
  if (config.BillingUrl !== '') {
    // Registry publish is handled by the pool poll's self-heal (syncModelRegistry),
    // which avoids racing billing's consumer join on startup.
    poolLimits.start(ctx, config.AIProviders, 60 * 1000, 15 * 1000)
    onClose.push(() => {
      poolLimits.close()
    })
  }

  const app = express()
  app.use(cors())

  const clisrServer = new ClisrServer(ctx, async (token) => token === config.ApiToken, '1.0', app, clisrHandshake)

  return { ctx, queue, aiControl, app, clisrServer, limitsState, onClose }
}

/**
 * Workspace events, split by delivery semantics:
 * - purchases must be applied exactly once -> one shared group across all pods;
 * - limits/up must reach every pod -> a per-pod group (broadcast).
 */
function startWorkspaceConsumer (boot: Boot): void {
  const { ctx, queue, aiControl, limitsState } = boot

  const purchases = queue.createConsumer<QueueWorkspaceMessage>(
    ctx,
    QueueTopic.Workspace,
    GROUP_PURCHASE,
    async (ctx, message) => {
      if (message.value.type !== QueueWorkspaceEvent.PurchaseActivated) return
      // A one-time purchase was paid: apply its effect (e.g. a token top-up) if aibot owns it.
      const msg = message.value as QueueWorkspacePurchaseMessage
      try {
        await applyPurchase(ctx, message.workspace, msg.purchaseId, msg.effect, msg.quantity)
      } catch (err: any) {
        ctx.error('failed to apply purchase', { error: err.message })
        throw err // rethrow so Kafka redelivers; applyPurchase is idempotent
      }
    }
  )

  const state = queue.createConsumer<QueueWorkspaceMessage>(
    ctx,
    QueueTopic.Workspace,
    podGroupId(),
    async (ctx, message) => {
      try {
        if (message.value.type === QueueWorkspaceEvent.Up) {
          await aiControl.connect(message.workspace)
        } else if (message.value.type === QueueWorkspaceEvent.LimitsChanged) {
          limitsState.applyEvent(message.value as QueueWorkspaceLimitsMessage, message.workspace)
          // Limits moved: drop the cached window so the next request re-reads it.
          invalidateWorkspaceWindows(message.workspace)
        }
      } catch (err: any) {
        ctx.error('failed to handle operation', { error: err.message })
      }
    }
  )

  // A member became active -> greet them in a Direct. Shared group: exactly one pod must send it.
  // Every tx of every workspace lands here, so filter before touching a workspace client.
  const employees = queue.createBatchConsumer<Tx>(
    ctx,
    QueueTopic.Tx,
    GROUP_WELCOME,
    async (ctx, messages) => {
      for (const message of messages) {
        const tx = message.value as TxMixin<Person, Employee>
        if (tx._class !== core.class.TxMixin) continue
        if (tx.mixin !== contact.mixin.Employee || tx.attributes?.active !== true) continue
        try {
          const wsClient = await aiControl.getWorkspaceClient(message.workspace)
          await wsClient?.sendWelcomeIfNeeded(tx.objectId)
        } catch (err: any) {
          ctx.error('failed to handle employee activation', { error: err.message })
        }
      }
    },
    { batchSize: 500, batchTimeout: 200 }
  )

  boot.onClose.push(() => {
    void purchases?.close()
    void state?.close()
    void employees?.close()
  })
}

/** event-router role: read ai-queue, route each event to the provider topic `llm-<id>`. */
async function startEventRouter (boot: Boot): Promise<void> {
  const { ctx, queue } = boot

  const topics = providerTopics(config.AIProviders)
  for (const topic of topics) {
    await queue.createTopic(topic, 1)
  }

  const producers = new Map<string, ReturnType<typeof queue.getProducer<AIPipelineMessage>>>()
  for (const topic of topics) {
    producers.set(topic, queue.getProducer<AIPipelineMessage>(ctx, topic))
  }

  const deadLetter = queue.getProducer<{ event: AIEventRequest, error: string }>(
    ctx,
    getDeadletterTopic(QueueTopic.AIQueue)
  )

  const consumer = queue.createConsumer<AIEventRequest>(
    ctx,
    QueueTopic.AIQueue,
    GROUP_EVENT_ROUTER,
    async (ctx, message) => {
      const event = message.value
      let target: { topic: string, level: string } | undefined
      try {
        // Narrow to levels the request's feature allows, so a denied level routes to a capable one.
        target = dispatch(event.level ?? config.DefaultLevel, registryForFeature(config.AIProviders, event.feature))
      } catch (err: any) {
        // No provider serves the requested level: redelivery cannot fix a config mismatch.
        ctx.error('failed to dispatch ai event', { error: err.message })
        await deadLetter?.send(ctx, message.workspace, [{ event, error: err.message }])
        return
      }
      const producer = producers.get(target.topic)
      if (producer === undefined) {
        ctx.error('No producer for resolved provider topic', { topic: target.topic })
        await deadLetter?.send(ctx, message.workspace, [{ event, error: `no producer for ${target.topic}` }])
        return
      }
      // Send failures are transient (broker down): rethrow so Kafka redelivers instead of dropping.
      await producer.send(ctx, message.workspace, [{ event, level: target.level }])
    }
  )

  boot.onClose.push(() => {
    void consumer?.close()
    void deadLetter?.close()
    for (const p of producers.values()) void p.close()
  })
}

/** llm-router role: batch consumer per provider topic `llm-<id>`, serving config.LLMProviderIds (empty = all). */
function startLlmRouter (boot: Boot): void {
  const { ctx, queue, aiControl } = boot

  const served = aiControl.getProviderIds()
  const wanted = config.LLMProviderIds.length > 0 ? config.LLMProviderIds : served
  const consumers: ConsumerHandle[] = []
  const deadLetter = queue.getProducer<{ event: AIEventRequest, error: string, provider: string }>(
    ctx,
    getDeadletterTopic(QueueTopic.AIQueue)
  )

  for (const cfg of config.AIProviders) {
    if (!served.includes(cfg.id) || !wanted.includes(cfg.id)) continue
    const topic = providerTopic(cfg.id)
    const limiter = new RateLimiter(Math.max(1, cfg.concurrency))
    // Per message: one failing request must not take the rest of the batch down with it, and it
    // must not vanish either — it goes to the dead letter topic.
    const handleOne = async (message: ConsumerMessage<AIPipelineMessage>, control?: ConsumerControl): Promise<void> => {
      const { event, level } = message.value
      try {
        // Network blips get a few attempts before the event is written off; anything else is a
        // real failure and goes to the dead letter topic straight away.
        await retryTransient(
          () => aiControl.processEvent(message.workspace, [event], control, cfg.id, level),
          { maxRetries: 3, isRetryable: retryNetworkErrors },
          'processEvent'
        )
      } catch (err: any) {
        ctx.error('failed to handle ai event', { error: err.message, provider: cfg.id })
        await deadLetter?.send(ctx, message.workspace, [{ event, error: err.message, provider: cfg.id }])
      }
    }
    consumers.push(
      queue.createBatchConsumer<AIPipelineMessage>(
        ctx,
        topic,
        providerGroup(cfg.id),
        async (ctx, messages, control) => {
          const hb = setInterval(() => {
            void control?.heartbeat()
          }, 1000)
          try {
            await Promise.all(
              messages.map((m) =>
                limiter.add(async () => {
                  await handleOne(m, control)
                })
              )
            )
            await limiter.waitProcessing()
          } finally {
            clearInterval(hb)
          }
        },
        { batchSize: Math.max(1, cfg.batch) }
      )
    )
  }
  ctx.info('llm-router serving providers', { providers: wanted })

  boot.onClose.push(() => {
    for (const c of consumers) void c.close()
  })
}

/** stt-ingest: runs in EVERY role; wires the TranscriptionQueue producer and love queue consumer. */
async function startSttIngest (boot: Boot): Promise<void> {
  const { ctx, queue, aiControl } = boot

  await queue.createTopic(SUMMARY_TOPIC, 1)
  const summaryProducer = queue.getProducer<SummaryTask>(ctx, SUMMARY_TOPIC)
  // The REST /summarize button publishes through the same topic.
  aiControl.setSummaryProducer(summaryProducer)

  const loveConsumer = queue.createConsumer<QueueMeetingMessage>(
    ctx,
    QueueTopic.LoveQueue,
    GROUP_STT_INGEST,
    async (ctx, msg) => {
      switch (msg.value.type) {
        case QueueMeetingEvent.started: {
          const wsClient = await aiControl.getWorkspaceClient(msg.workspace)
          await wsClient?.meetingStarted(msg.value.meetingId)
          break
        }
        case QueueMeetingEvent.finished: {
          const wsClient = await aiControl.getWorkspaceClient(msg.workspace)
          await wsClient?.meetingFinished(msg.value.meetingId)
          // Handed to a queue, not run here: the summary waits for the transcript tail and is
          // meant to grow into a multi-step job. Holding this consumer that long stalls other
          // meetings and risks a rebalance; a detached `void` call would be lost on restart.
          await summaryProducer?.send(ctx, msg.workspace, [
            { target: msg.value.meetingId, targetClass: love.class.MeetingMinutes }
          ])
          break
        }
      }
    }
  )

  const transcriptionProducer = queue.getProducer<TranscriptionTask>(ctx, QueueTopic.TranscriptionQueue)
  if (transcriptionProducer !== undefined) {
    aiControl.setTranscriptionProducer(transcriptionProducer)
  }

  boot.onClose.push(() => {
    void loveConsumer?.close()
    void transcriptionProducer?.close()
    void summaryProducer?.close()
  })
}

/** Summaries: own consumer so a slow multi-step summary never blocks the love queue or a REST call. */
function startSummary (boot: Boot): void {
  const { ctx, queue, aiControl } = boot

  const deadLetter = queue.getProducer<{ task: SummaryTask, error: string }>(
    ctx,
    // Cast: the helper only string-templates the name, but its param is typed as the enum.
    getDeadletterTopic(SUMMARY_TOPIC as QueueTopic)
  )

  const consumer = queue.createBatchConsumer<SummaryTask>(
    ctx,
    SUMMARY_TOPIC,
    GROUP_SUMMARY,
    async (ctx, messages, control) => {
      // Waiting for the transcript tail takes tens of seconds - keep the group alive meanwhile.
      const hb = setInterval(() => {
        void control?.heartbeat()
      }, 1000)
      try {
        await Promise.all(
          messages.map(async (message) => {
            const task = message.value
            try {
              await retryTransient(
                async () => {
                  // Manual runs are an explicit ask: no settings gate, no transcript-tail wait.
                  if (task.manual === true) {
                    await aiControl.summarizeMessages(message.workspace, {
                      lang: task.lang ?? '',
                      target: task.target as Ref<Doc>,
                      targetClass: task.targetClass as Ref<Class<Doc>>
                    })
                  } else {
                    await aiControl.autoSummarizeMeeting(message.workspace, task.target as Ref<MeetingMinutes>)
                  }
                },
                { maxRetries: 3, isRetryable: retryNetworkErrors },
                'summarize'
              )
            } catch (err: any) {
              ctx.error('failed to summarize', { error: err.message, workspace: message.workspace })
              await deadLetter?.send(ctx, message.workspace, [{ task, error: err.message }])
            }
          })
        )
      } finally {
        clearInterval(hb)
      }
    },
    { batchSize: 16 }
  )

  boot.onClose.push(() => {
    void consumer?.close()
    void deadLetter?.close()
  })
}

/** stt-worker: consume the TranscriptionQueue and transcribe; also runs the Deepgram billing poll. */
async function startSttWorker (boot: Boot): Promise<void> {
  const { ctx, queue, aiControl, clisrServer } = boot

  const transcriptionDeadLetterProducer = queue.getProducer<{
    task: TranscriptionQueueTask
    error: string
    errorType: string
  }>(ctx, getDeadletterTopic(QueueTopic.TranscriptionQueue))

  let transcriptionConsumer: ConsumerHandle | undefined
  const transcriptionHandler = await createTranscriptionsSupport(
    ctx,
    aiControl,
    transcriptionDeadLetterProducer,
    clisrServer
  )

  if (transcriptionHandler !== undefined) {
    const handleMsg = async (message: ConsumerMessage<TranscriptionTask>, control?: ConsumerControl): Promise<void> => {
      const raw = message.value as unknown as { kind?: string }
      const workspace = message.workspace
      try {
        if (raw.kind === 'chat-voice') {
          await transcriptionHandler.processChatVoice(ctx, workspace, raw as unknown as ChatVoiceTranscriptionTask)
          return
        }
        await transcriptionHandler.consumer.processTask(
          ctx,
          workspace,
          raw as unknown as TranscriptionQueueTask,
          control
        )
      } catch (err: any) {
        ctx.error('Failed to process transcription task', { error: err.message, workspace })
        // Keep the task: the consumer acks regardless, so without this it is simply gone.
        await transcriptionDeadLetterProducer?.send(ctx, workspace, [
          {
            task: raw as unknown as TranscriptionQueueTask,
            error: err.message,
            errorType: raw.kind ?? 'transcription'
          }
        ])
      }
    }
    if (config.SttProcessingBatch === 1) {
      transcriptionConsumer = queue.createConsumer<TranscriptionTask>(
        ctx,
        QueueTopic.TranscriptionQueue,
        GROUP_TRANSCRIPTION,
        async (ctx, message, control) => {
          await handleMsg(message, control)
        }
      )
    } else {
      transcriptionConsumer = queue.createBatchConsumer<TranscriptionTask>(
        ctx,
        QueueTopic.TranscriptionQueue,
        GROUP_TRANSCRIPTION,
        async (ctx, messages, control) => {
          const i1 = setInterval(() => {
            void control?.heartbeat()
          }, 1000)
          try {
            await Promise.all(messages.map((message) => handleMsg(message, control)))
          } finally {
            clearInterval(i1)
          }
        },
        { batchSize: config.SttProcessingBatch }
      )
    }
  }

  let billingIntervalId: any | undefined
  if (config.BillingUrl !== '') {
    billingIntervalId = setInterval(
      () => {
        try {
          void updateDeepgramBilling(ctx)
        } catch {}
      },
      config.DeepgramPollIntervalMinutes * 60 * 1000
    )
    try {
      void updateDeepgramBilling(ctx)
    } catch {}
  }

  boot.onClose.push(() => {
    void transcriptionConsumer?.close()
    void transcriptionDeadLetterProducer?.close()
    if (billingIntervalId !== undefined) clearInterval(billingIntervalId)
  })
}

/** Wire shutdown handlers and start the ClisrServer + storage bucket. */
async function finalize (boot: Boot): Promise<void> {
  const { ctx, aiControl, app, clisrServer } = boot

  createServer(aiControl, ctx, app)
  await clisrServer.start(ctx, config.Port)
  await aiControl.chunkStorageAdapter.make(ctx, { uuid: '' as WorkspaceUuid, url: '' })

  const onClose = (): void => {
    for (const fn of boot.onClose) fn()
    void aiControl.close()
    void clisrServer.close().then(() => process.exit())
  }
  process.on('SIGINT', onClose)
  process.on('SIGTERM', onClose)
  process.on('uncaughtException', (e: Error) => {
    console.error(e)
  })
  process.on('unhandledRejection', (e: Error) => {
    console.error(e)
  })
}

/** Whether this pod should attach the ClisrServer to its LLM providers. */
function llmNeedsClisr (): boolean {
  const wanted = config.LLMProviderIds
  return config.AIProviders.some((p) => p.provider === 'clisr' && (wanted.length === 0 || wanted.includes(p.id)))
}

/** all-in-one role: event-router + llm-router + stt-worker (+ ingest). */
export const startQueue = async (): Promise<void> => {
  const boot = await bootstrap('all')
  boot.aiControl.initLLM(boot.clisrServer)
  startWorkspaceConsumer(boot)
  await startSttIngest(boot)
  await startEventRouter(boot)
  startLlmRouter(boot)
  startSummary(boot)
  await startSttWorker(boot)
  await finalize(boot)
}

/** event-router role: routes ai-queue -> llm-<id> (+ stt ingest). */
export const startEventRouterMode = async (): Promise<void> => {
  const boot = await bootstrap('event-router')
  startWorkspaceConsumer(boot)
  await startSttIngest(boot)
  await startEventRouter(boot)
  await finalize(boot)
}

/** llm-router role: run the configured providers against their topics (+ stt ingest). */
export const startLlmRouterMode = async (): Promise<void> => {
  const boot = await bootstrap('llm-router')
  // Pass the ClisrServer only when a served clisr provider exists (API-only providers don't need it).
  const hasClisr = llmNeedsClisr()
  boot.ctx.info('llm-router clisr support', { hasClisr })
  boot.aiControl.initLLM(hasClisr ? boot.clisrServer : undefined)
  startWorkspaceConsumer(boot)
  await startSttIngest(boot)
  startLlmRouter(boot)
  startSummary(boot)
  await finalize(boot)
}

/** stt-worker role: transcription queue consumer + transcriber clisr server (+ ingest). */
export const startSttWorkerMode = async (): Promise<void> => {
  const boot = await bootstrap('stt-worker')
  startWorkspaceConsumer(boot)
  await startSttIngest(boot)
  await startSttWorker(boot)
  await finalize(boot)
}

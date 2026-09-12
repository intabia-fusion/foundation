import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'

export enum QueueTopic {
  // Topic with partitions to split workspace transactions into
  Tx = 'tx',

  // Topic for transactions to be processed by the transactor pipeline for online users
  OnlineUserTx = 'online-user-tx',

  // Topic to send workspace information into
  Workspace = 'workspace',

  // A fulltext topic to hold extra fulltext request, like re-indexing requests etc, private to fulltext service.
  Fulltext = 'fulltext',

  // A topic about user activity.
  Users = 'users',

  TelegramBot = 'telegramBot',

  // A topic about calendar events.
  CalendarEventCUD = 'calendarEventCUD',

  // A topic about process events
  Process = 'process',

  // Queue for AI requests
  AIQueue = 'ai-queue',

  // Queue for audio transcription tasks
  TranscriptionQueue = 'transcription-queue',

  // All OTP and notifications to mail/notify services are goes here first
  // And services will take them and send to a proper places.
  NotificationQueue = 'notifications',

  // Events about meetings and operations with meetings
  LoveQueue = 'love-queue',

  TimeMachine = 'timeMachine',

  CrmQueue = 'crm',

  // Single billing topic: usage deltas + LiveKit session/egress/participant records (discriminated union).
  BillingUsage = 'billing-usage',

  // Subscription lifecycle events from payment providers (stripe/polar/tbank). Providers verify and
  // publish here; pod-payment is the single consumer that bakes limits and writes to the account DB.
  Subscription = 'subscription',

  // Append-only payment audit events (init charge / webhook / recurrent charge / cancel / refund) from
  // any provider pod. The account service is the single consumer, writing the immutable ledger row.
  PaymentOperation = 'payment-operation',

  // Raw inbound TBank webhooks. The HTTP handler verifies the signature and enqueues here; the pod's
  // own consumer rechecks state via GetState and applies the effect. Decouples the bank's 200 from
  // downstream processing (reliability) and keeps unverified payloads out of the pipeline (security).
  TbankWebhook = 'tbank-webhook',

  // Incoming webhook jobs (API-key authenticated). pod-webhook's HTTP handler verifies the key and
  // enqueues here; the pod's own consumer resolves the space and runs the action.
  Webhook = 'webhook',

  // Outgoing webhook deliveries (to be produced once workspaces can register outbound webhooks).
  WebhookDelivery = 'webhook-delivery'
}

export interface ConsumerHandle {
  close: () => Promise<void>
  isConnected: () => boolean
  // Resolves once the consumer joined its group and performed the first fetch, so the group start
  // offset is settled. Until then messages produced may be skipped by a brand new group.
  waitReady?: () => Promise<void>
}

export interface ConsumerMessage<T> {
  workspace: WorkspaceUuid
  value: T
}

export interface ConsumerControl {
  pause: () => void
  heartbeat: () => Promise<void>
}

export interface PlatformQueue {
  getProducer: <T>(ctx: MeasureContext, topic: QueueTopic | string) => PlatformQueueProducer<T>

  /**
   * Create a consumer for a topic.
   * Return a function to close the receiver.
   *
   * This is the single-message consumer API (original behaviour).
   * For batch processing use `createBatchConsumer`.
   */
  createConsumer: <T>(
    ctx: MeasureContext,
    topic: QueueTopic | string,
    groupId: string,
    onMessage: (ctx: MeasureContext, msg: ConsumerMessage<T>, queue: ConsumerControl) => Promise<void>,
    options?: {
      fromBegining?: boolean
      retryDelay?: number // Initial retry delay in milliseconds (default 1000)
      maxRetryDelay?: number // Maximum retry delay in seconds (default 10)
      sessionTimeout?: number // Maximum time in milliseconds between heartbeats/processing (optional)
    }
  ) => ConsumerHandle

  /**
   * Create a consumer that receives batches of messages.
   * The handler gets an array of messages (in order for a partition).
   * The batch will be retried as a whole in case of processing failures.
   */
  createBatchConsumer: <T>(
    ctx: MeasureContext,
    topic: QueueTopic | string,
    groupId: string,
    onMessage: (ctx: MeasureContext, msgs: ConsumerMessage<T>[], queue: ConsumerControl) => Promise<void>,
    options?: {
      fromBegining?: boolean
      retryDelay?: number // Initial retry delay in milliseconds (default 1000)
      maxRetryDelay?: number // Maximum retry delay in seconds (default 10)
      batchSize?: number // Number of messages to accumulate before flushing
      batchTimeout?: number // Maximum time in milliseconds to wait for batch to fill before flushing
      sessionTimeout?: number // Maximum time in milliseconds between heartbeats/processing (optional)
    }
  ) => ConsumerHandle

  createTopic: (topics: string | string[], partitions: number) => Promise<void>

  createTopics: (tx: number) => Promise<void>

  // If not passed will delete all topica from QueueTopic enum
  deleteTopics: (topics?: (QueueTopic | string)[]) => Promise<void>

  getClientId: () => string

  // Will close all producers and consumers
  shutdown: () => Promise<void>
}

/**
 * Create a producer for a topic.
 */
export interface PlatformQueueProducer<T> {
  send: (ctx: MeasureContext, workspace: WorkspaceUuid, msgs: T[], partitionKey?: string) => Promise<void>
  close: () => Promise<void>

  getQueue: () => PlatformQueue
}

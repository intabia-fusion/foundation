import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import {
  type ConsumerHandle,
  type PlatformQueue,
  type PlatformQueueProducer,
  type QueueTopic,
  type ConsumerMessage,
  type ConsumerControl
} from './types'

/**
 * A stub PlatformQueueProducer for testing.
 */
class DummyQueueProducer<T> implements PlatformQueueProducer<T> {
  async send (ctx: MeasureContext, id: WorkspaceUuid | string, msgs: T[]): Promise<void> {
    await Promise.resolve()
  }

  async close (): Promise<void> {
    await Promise.resolve()
  }

  getQueue (): PlatformQueue {
    return new DummyQueue()
  }
}

/**
 * A stub PlatformQueue for testing.
 */
export class DummyQueue implements PlatformQueue {
  getProducer<T>(ctx: MeasureContext, topic: QueueTopic | string): PlatformQueueProducer<T> {
    return new DummyQueueProducer<T>()
  }

  getClientId (): string {
    return 'dummy'
  }

  async shutdown (): Promise<void> {}

  async createTopic (topics: string | string[], partitions: number): Promise<void> {}

  createConsumer<T>(
    ctx: MeasureContext,
    topic: QueueTopic | string,
    groupId: string,
    onMessage: (ctx: MeasureContext, msg: ConsumerMessage<T>, queue: ConsumerControl) => Promise<void>,
    options?: {
      fromBegining?: boolean
    }
  ): ConsumerHandle {
    return {
      close: async (): Promise<void> => {
        await Promise.resolve()
      },
      isConnected: (): boolean => {
        return false
      }
    }
  }

  createBatchConsumer<T>(
    ctx: MeasureContext,
    topic: QueueTopic | string,
    groupId: string,
    onMessage: (ctx: MeasureContext, msgs: ConsumerMessage<T>[], queue: ConsumerControl) => Promise<void>,
    options?: {
      batchSize?: number
      fromBegining?: boolean
      batchTimeout?: number
    }
  ): ConsumerHandle {
    return {
      close: async (): Promise<void> => {
        await Promise.resolve()
      },
      isConnected: (): boolean => {
        return false
      }
    }
  }

  async createTopics (tx: number): Promise<void> {
    await Promise.resolve()
  }

  async deleteTopics (topics?: (QueueTopic | string)[]): Promise<void> {}
}

/**
 * Creates a new instance of the dummy queue implementation
 */
export function createDummyQueue (): PlatformQueue {
  return new DummyQueue()
}

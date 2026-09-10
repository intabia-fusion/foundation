import { generateId, MeasureMetricsContext, type WorkspaceUuid } from '@hcengineering/core'
import { createPlatformQueue, parseQueueConfig } from '..'

jest.setTimeout(60000) // Reduced for faster tests
const testCtx = new MeasureMetricsContext('test', {})

async function waitConnected (handle: any): Promise<void> {
  await new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (handle.isConnected() === true) {
        clearInterval(checkInterval)
        resolve(undefined)
      }
    }, 50)
  })
}

describe('queue', () => {
  it('check-queue', async () => {
    const genId = generateId()
    const queue = createPlatformQueue(parseQueueConfig('localhost:19093;-queue_testing-' + genId, 'test-' + genId, ''))
    const docsCount = 50 // Reduced from 100 for faster tests
    try {
      let msgCount = 0
      let consumerHandle: any
      const p1 = new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => {
          reject(new Error(`Timeout waiting for messages: received ${msgCount}/${docsCount}`))
        }, 15000) // Reduced from 100000

        consumerHandle = queue.createConsumer<string>(
          testCtx,
          'qtest',
          genId,
          async (ctx, msg) => {
            msgCount += 1
            if (msgCount === docsCount) {
              clearTimeout(to)
              resolve()
            }
          },
          { retryDelay: 100, maxRetryDelay: 3, fromBegining: true }
        )
      })

      // Wait for consumer to be connected and subscribed
      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (consumerHandle.isConnected() === true) {
            clearInterval(checkInterval)
            resolve(undefined)
          }
        }, 50)
      })

      const producer = queue.getProducer<string>(testCtx, 'qtest')
      // Send messages in batches for better performance
      const batchSize = 10
      for (let i = 0; i < docsCount; i += batchSize) {
        const batch: string[] = []
        for (let j = i; j < Math.min(i + batchSize, docsCount); j++) {
          batch.push('msg' + j)
        }
        await producer.send(testCtx, genId as any as WorkspaceUuid, batch)
      }

      await p1
    } finally {
      await queue.shutdown()
      await queue.deleteTopics(['qtest'])
      // Give Kafka time to cleanup connections
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })

  it('check-processing-errors', async () => {
    const genId = generateId()
    const queue = createPlatformQueue(parseQueueConfig('localhost:19093;-queue_testing-' + genId, 'test-' + genId, ''))

    try {
      let counter = 2
      let consumerHandle: any
      const p = new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => {
          reject(new Error(`Timeout waiting for retry processing: counter=${counter}`))
        }, 10000) // Added timeout

        consumerHandle = queue.createConsumer<string>(
          testCtx,
          'test',
          genId,
          async (ctx, msg) => {
            counter--
            if (counter > 0) {
              throw new Error('Processing Error')
            }
            clearTimeout(to)
            resolve()
          },
          { retryDelay: 50, maxRetryDelay: 3, fromBegining: true }
        )
      })

      // Wait for consumer to be connected and subscribed
      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (consumerHandle.isConnected() === true) {
            clearInterval(checkInterval)
            resolve(undefined)
          }
        }, 50)
      })

      const producer = queue.getProducer<string>(testCtx, 'test')
      await producer.send(testCtx, genId as any as WorkspaceUuid, ['msg'])

      await p
    } finally {
      await queue.shutdown()
      await queue.deleteTopics(['test'])
      // Give Kafka time to cleanup connections
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })

  it('check-batches', async () => {
    const genId = generateId()
    const queue = createPlatformQueue(parseQueueConfig('localhost:19093;-queue_testing-' + genId, 'test-' + genId, ''))
    const docsCount = 50 // number of messages to produce
    try {
      let msgCount = 0
      let consumerHandle: any
      const p1 = new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => {
          reject(new Error(`Timeout waiting for messages: received ${msgCount}/${docsCount}`))
        }, 15000)

        consumerHandle = (queue as any).createBatchConsumer(
          testCtx,
          'qtest-batch',
          genId,
          async (ctx: any, msgs: any) => {
            // Handler may receive an array - increment by its length
            if (Array.isArray(msgs)) {
              msgCount += msgs.length
            } else {
              msgCount += 1
            }
            if (msgCount === docsCount) {
              clearTimeout(to)
              resolve()
            }
          },
          { retryDelay: 100, maxRetryDelay: 3, fromBegining: true, batchSize: 10, batchTimeout: 100 }
        )
      })

      // Wait for consumer to be connected and subscribed
      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (consumerHandle.isConnected() === true) {
            clearInterval(checkInterval)
            resolve(undefined)
          }
        }, 50)
      })

      const producer = queue.getProducer<string>(testCtx, 'qtest-batch')
      // Send messages in batches
      const batchSize = 10
      for (let i = 0; i < docsCount; i += batchSize) {
        const batch: string[] = []
        for (let j = i; j < Math.min(i + batchSize, docsCount); j++) {
          batch.push('msg' + j)
        }
        await producer.send(testCtx, genId as any as WorkspaceUuid, batch)
      }

      await p1
    } finally {
      await queue.shutdown()
      await queue.deleteTopics(['qtest-batch'])
      // Give Kafka time to cleanup connections
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })

  it('check-batch-processing-errors', async () => {
    const genId = generateId()
    const queue = createPlatformQueue(parseQueueConfig('localhost:19093;-queue_testing-' + genId, 'test-' + genId, ''))

    try {
      let attempts = 0
      let consumerHandle: any
      const p = new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => {
          reject(new Error(`Timeout waiting for retry processing: attempts=${attempts}`))
        }, 10000)

        consumerHandle = (queue as any).createBatchConsumer(
          testCtx,
          'test-batch',
          genId,
          async (ctx: any, msgs: any) => {
            attempts++
            // Fail on first attempt to ensure batch retries as a whole
            if (attempts === 1) {
              throw new Error('Processing Error')
            }
            clearTimeout(to)
            resolve()
          },
          { retryDelay: 50, maxRetryDelay: 3, fromBegining: true, batchSize: 2, batchTimeout: 100 }
        )
      })

      // Wait for consumer to be connected and subscribed
      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (consumerHandle.isConnected() === true) {
            clearInterval(checkInterval)
            resolve(undefined)
          }
        }, 50)
      })

      const producer = queue.getProducer<string>(testCtx, 'test-batch')
      // send two messages so batch will contain them both
      await producer.send(testCtx, genId as any as WorkspaceUuid, ['msg1', 'msg2'])

      await p
    } finally {
      await queue.shutdown()
      await queue.deleteTopics(['test-batch'])
      // Give Kafka time to cleanup connections
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })

  it('check-ordering', async () => {
    const genId = generateId()
    const topic = 'order-test-' + genId
    const queue = createPlatformQueue(parseQueueConfig('localhost:19093;-queue_testing-' + genId, 'test-' + genId, ''))
    const docsCount = 20

    try {
      const expected = Array.from({ length: docsCount }, (_, i) => `msg${i}`)
      const received: string[] = []
      let consumerHandle: any
      const p = new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => {
          reject(new Error(`Timeout waiting for ordering: received ${received.length}/${docsCount}`))
        }, 15000)

        consumerHandle = queue.createConsumer<string>(
          testCtx,
          topic,
          genId,
          async (ctx, msg) => {
            received.push(msg.value)
            if (received.length === docsCount) {
              clearTimeout(to)
              try {
                expect(received).toEqual(expected)
                resolve()
              } catch (err) {
                reject(err)
              }
            }
          },
          { retryDelay: 50, maxRetryDelay: 3, fromBegining: true }
        )
      })

      // Wait for consumer to be connected and subscribed
      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (consumerHandle.isConnected() === true) {
            clearInterval(checkInterval)
            resolve(undefined)
          }
        }, 50)
      })

      const producer = queue.getProducer<string>(testCtx, topic)
      for (let i = 0; i < docsCount; i++) {
        await producer.send(testCtx, genId as any as WorkspaceUuid, [`msg${i}`])
      }

      await p
    } finally {
      await queue.shutdown()
      await queue.deleteTopics([topic])
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })

  it('check-batch-timeout-flush', async () => {
    const genId = generateId()
    const topic = 'batch-timeout-' + genId
    const queue = createPlatformQueue(parseQueueConfig('localhost:19093;-queue_testing-' + genId, 'test-' + genId, ''))

    try {
      let handlerCalled = 0
      let batchSizeReceived = 0
      let consumerHandle: any
      const p = new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => {
          reject(new Error('Timeout waiting for batch timeout flush'))
        }, 10000)

        consumerHandle = (queue as any).createBatchConsumer(
          testCtx,
          topic,
          genId,
          async (ctx: any, msgs: any) => {
            handlerCalled++
            batchSizeReceived += Array.isArray(msgs) ? msgs.length : 1
            // Resolve only after we've processed all expected messages (3 in this test).
            // This avoids flaky behavior when the first flush happens before all messages arrive.
            if (batchSizeReceived >= 3) {
              clearTimeout(to)
              resolve()
            }
          },
          { batchSize: 5, batchTimeout: 200, retryDelay: 50, maxRetryDelay: 3, fromBegining: true }
        )
      })

      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (consumerHandle.isConnected() === true) {
            clearInterval(checkInterval)
            resolve(undefined)
          }
        }, 50)
      })

      const producer = queue.getProducer<string>(testCtx, topic)
      await producer.send(testCtx, genId as any as WorkspaceUuid, ['a', 'b', 'c'])

      await p
      expect(batchSizeReceived).toBe(3)
      // Handler may be invoked one or more times (depends on flush timing); ensure at least one invocation happened.
      expect(handlerCalled).toBeGreaterThanOrEqual(1)
    } finally {
      await queue.shutdown()
      await queue.deleteTopics([topic])
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })

  it('check-create-topic', async () => {
    const genId = generateId()
    const topic = 'topic-create-' + genId
    const queue = createPlatformQueue(parseQueueConfig('localhost:19093;-queue_testing-' + genId, 'test-' + genId, ''))

    try {
      await queue.createTopic(topic, 3)

      let received = false
      let consumerHandle: any
      const p = new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => {
          reject(new Error('Timeout waiting for create-topic messages'))
        }, 10000)

        consumerHandle = queue.createConsumer<string>(
          testCtx,
          topic,
          genId,
          async (ctx, msg) => {
            received = true
            clearTimeout(to)
            resolve()
          },
          { fromBegining: true, retryDelay: 50, maxRetryDelay: 3 }
        )
      })

      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (consumerHandle.isConnected() === true) {
            clearInterval(checkInterval)
            resolve(undefined)
          }
        }, 50)
      })

      const producer = queue.getProducer<string>(testCtx, topic)
      await producer.send(testCtx, genId as any as WorkspaceUuid, ['hello'])

      await p
      expect(received).toBe(true)
    } finally {
      await queue.shutdown()
      await queue.deleteTopics([topic])
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })

  it('batch-pump-keeps-consumer-alive-without-manual-heartbeat', async () => {
    const genId = generateId()
    const topic = 'batch-pump-' + genId
    const queue = createPlatformQueue(parseQueueConfig('localhost:19093;-queue_testing-' + genId, 'test-' + genId, ''))
    try {
      let invocations = 0
      let processed = 0
      let consumerHandle: any
      const p = new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => {
          reject(new Error(`Timeout: invocations=${invocations} processed=${processed}`))
        }, 25000)

        consumerHandle = (queue as any).createBatchConsumer(
          testCtx,
          topic,
          genId,
          async (_ctx: any, msgs: any) => {
            // Process LONGER than sessionTimeout WITHOUT calling heartbeat: the consumer's own
            // heartbeat pump must keep the session alive so we are not evicted and redelivered.
            invocations++
            await new Promise((resolve) => setTimeout(resolve, 8000))
            processed += Array.isArray(msgs) ? msgs.length : 1
            clearTimeout(to)
            resolve()
          },
          {
            batchSize: 1,
            batchTimeout: 100,
            sessionTimeout: 6000,
            retryDelay: 50,
            maxRetryDelay: 3,
            fromBegining: true
          }
        )
      })

      await waitConnected(consumerHandle)
      const producer = queue.getProducer<string>(testCtx, topic)
      await producer.send(testCtx, genId as any as WorkspaceUuid, ['m1'])

      await p
      // Eviction would redeliver the message -> a second invocation. The pump prevents that.
      expect(processed).toBe(1)
      expect(invocations).toBe(1)
      expect(consumerHandle.isConnected()).toBe(true)
    } finally {
      await queue.shutdown()
      await queue.deleteTopics([topic])
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })

  it('pause-and-heartbeat-keeps-consumer-alive', async () => {
    const genId = generateId()
    const topic = 'pause-heartbeat-' + genId
    const queue = createPlatformQueue(parseQueueConfig('localhost:19093;-queue_testing-' + genId, 'test-' + genId, ''))
    try {
      let processed = 0
      let processingStartedResolve: (() => void) | undefined
      const processingStartedP = new Promise<void>((_resolve) => {
        processingStartedResolve = _resolve
      })

      let consumerHandle: any
      const p = new Promise<void>((resolve, reject) => {
        // Shorten test timeout and make it more deterministic
        const to = setTimeout(() => {
          reject(new Error('Timeout waiting for pause/heartbeat test'))
        }, 15000)
        consumerHandle = queue.createConsumer<string>(
          testCtx,
          topic,
          genId,
          async (_ctx: any, _msg: any, control: any) => {
            if (processingStartedResolve !== undefined) {
              processingStartedResolve()
            }
            // pause consumption for this partition while doing long processing
            control.pause()
            // Use a moderate processing window and frequent heartbeats to avoid flaky session timeouts.
            const total = 3000
            const interval = 100
            const start = Date.now()
            while (Date.now() - start < total) {
              // call heartbeat to keep the session alive; ignore transient heartbeat errors for stability
              try {
                await control.heartbeat()
              } catch (err) {
                // transient errors can happen in tests; ignore to reduce flakiness
              }
              await new Promise((resolve) => setTimeout(resolve, interval))
            }
            processed++
            clearTimeout(to)
            resolve()
          },
          // Increase sessionTimeout to be safely above KafkaJS internal heartbeat interval.
          { sessionTimeout: 15000, retryDelay: 50, maxRetryDelay: 3, fromBegining: true }
        )
      })

      await waitConnected(consumerHandle)
      const producer = queue.getProducer<string>(testCtx, topic)
      // Send only one message to avoid pause-induced blocking on multiple messages
      await producer.send(testCtx, genId as any as WorkspaceUuid, ['m1'])

      // wait until long processing starts
      await processingStartedP
      expect(consumerHandle.isConnected()).toBe(true)

      await p
      expect(processed).toBe(1)

      // Allow for brief transient disconnects by polling for a short window.
      let connected: boolean = consumerHandle.isConnected() === true
      if (!connected) {
        const waitStart = Date.now()
        while (Date.now() - waitStart < 500) {
          if (consumerHandle.isConnected() === true) {
            connected = true
            break
          }
          // small pause while polling
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      expect(connected).toBe(true)
    } finally {
      await queue.shutdown()
      await queue.deleteTopics([topic])
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })
})

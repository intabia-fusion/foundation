//
// Copyright © 2025 Hardcore Engineering Inc.
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

import { MeasureMetricsContext, type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import { getPlatformQueue } from '@hcengineering/kafka'
import { QueueTopic, type PlatformQueue } from '@hcengineering/server-core'
import { TimeMachineMessage } from '@hcengineering/server-process'
import { TimeMachineDB, type DelayedEventRecord } from './db'
import { SendTimeEvent } from './activities'
import config from './config'

const SERVICE_NAME = 'time-machine'

export async function handleTimeMachineMessage (
  db: TimeMachineDB,
  workspace: WorkspaceUuid,
  msg: TimeMachineMessage
): Promise<void> {
  const { type, id, targetDate, topic, data } = msg
  if (type === 'schedule' && targetDate != null && topic != null && data !== undefined) {
    await db.upsertEvent({ id, workspace, target_date: targetDate, topic, data })
  } else if (type === 'cancel') {
    await db.removeEvents(workspace, id)
  }
}

/** One polling pass: send expired events and drop only the ones that actually made it out. */
export async function pollOnce (ctx: MeasureContext, db: TimeMachineDB, queue: PlatformQueue): Promise<void> {
  try {
    const expiredEvents = await db.getExpiredEvents()
    const sent: DelayedEventRecord[] = []
    for (const event of expiredEvents) {
      try {
        await SendTimeEvent(ctx, queue, event.workspace, event.topic, event.data)
        sent.push(event)
      } catch (err) {
        // Left in the table on failure: at-least-once, retried on the next poll. A send failure here
        // must not block the rest of the batch or cause an already-sent event to be resent.
        ctx.error('Time Machine: failed to send event', {
          err,
          id: event.id,
          workspace: event.workspace,
          topic: event.topic
        })
      }
    }
    if (sent.length > 0) {
      await db.deleteEvents(sent)
    }
  } catch (err) {
    ctx.error('Error in Time Machine polling loop:', { err })
  }
}

export interface PollingHandle {
  stop: () => void
}

export function startPolling (
  ctx: MeasureContext,
  db: TimeMachineDB,
  queue: PlatformQueue,
  intervalMs: number
): PollingHandle {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const tick = (): void => {
    void pollOnce(ctx, db, queue).finally(() => {
      if (!stopped) {
        timer = setTimeout(tick, intervalMs)
      }
    })
  }

  tick()

  return {
    stop: () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

export async function runWorker (): Promise<void> {
  const db = await TimeMachineDB.init(config.DbUrl)

  const ctx = new MeasureMetricsContext(SERVICE_NAME, {})
  const queue = getPlatformQueue(SERVICE_NAME, config.QueueRegion)

  const consumer = queue.createConsumer<TimeMachineMessage>(
    ctx,
    QueueTopic.TimeMachine,
    SERVICE_NAME,
    async (_ctx, msg) => {
      await handleTimeMachineMessage(db, msg.workspace, msg.value)
    }
  )

  const polling = startPolling(ctx, db, queue, config.PollInterval)

  const shutdown = (): void => {
    polling.stop()
    void Promise.allSettled([consumer.close(), queue.shutdown(), db.close()]).then(() => {
      process.exit()
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  ctx.info('Time Machine worker started')
}

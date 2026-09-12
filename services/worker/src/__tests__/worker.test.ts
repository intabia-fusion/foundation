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

jest.mock('../activities')

/* eslint-disable import/first */
import type { WorkspaceUuid } from '@hcengineering/core'
import type { TimeMachineMessage } from '@hcengineering/server-process'
import { SendTimeEvent } from '../activities'
import { TimeMachineDB, type DelayedEventRecord } from '../db'
import { createFakeClient } from './db.test'
import { handleTimeMachineMessage, pollOnce, startPolling } from '../worker'
/* eslint-enable import/first */

const sendTimeEvent = SendTimeEvent as jest.Mock

const newCtx = (): any => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })

const ws1 = 'ws-1' as WorkspaceUuid

function event (overrides: Partial<DelayedEventRecord> = {}): DelayedEventRecord {
  return { id: 'e1', workspace: ws1, target_date: 1000, topic: 'topic-a', data: { n: 1 }, ...overrides }
}

beforeEach(() => {
  sendTimeEvent.mockReset()
  sendTimeEvent.mockResolvedValue(undefined)
})

describe('handleTimeMachineMessage', () => {
  it('schedule with a complete message upserts a row', async () => {
    const db: any = { upsertEvent: jest.fn(), removeEvents: jest.fn() }
    const msg: TimeMachineMessage = { type: 'schedule', id: 'e1', targetDate: 1000, topic: 'topic-a', data: { n: 1 } }

    await handleTimeMachineMessage(db, ws1, msg)

    expect(db.upsertEvent).toHaveBeenCalledWith({
      id: 'e1',
      workspace: ws1,
      target_date: 1000,
      topic: 'topic-a',
      data: { n: 1 }
    })
  })

  it.each([
    ['targetDate', { type: 'schedule', id: 'e1', topic: 'topic-a', data: {} }],
    ['topic', { type: 'schedule', id: 'e1', targetDate: 1000, data: {} }],
    ['data', { type: 'schedule', id: 'e1', targetDate: 1000, topic: 'topic-a' }]
  ] as [string, TimeMachineMessage][])('schedule missing %s does not upsert and does not throw', async (_, msg) => {
    const db: any = { upsertEvent: jest.fn(), removeEvents: jest.fn() }

    await expect(handleTimeMachineMessage(db, ws1, msg)).resolves.toBeUndefined()

    expect(db.upsertEvent).not.toHaveBeenCalled()
  })

  it('cancel removes the event by id in the message workspace', async () => {
    const db: any = { upsertEvent: jest.fn(), removeEvents: jest.fn() }
    const msg: TimeMachineMessage = { type: 'cancel', id: 'e1' }

    await handleTimeMachineMessage(db, ws1, msg)

    expect(db.removeEvents).toHaveBeenCalledWith(ws1, 'e1')
  })

  it('an unknown type is ignored: no upsert, no remove, no throw', async () => {
    const db: any = { upsertEvent: jest.fn(), removeEvents: jest.fn() }
    const msg = { type: 'unknown', id: 'e1' } as unknown as TimeMachineMessage

    await expect(handleTimeMachineMessage(db, ws1, msg)).resolves.toBeUndefined()

    expect(db.upsertEvent).not.toHaveBeenCalled()
    expect(db.removeEvents).not.toHaveBeenCalled()
  })
})

describe('pollOnce', () => {
  it('sends each expired event to its own topic with its own data/workspace, then deletes it', async () => {
    const e1 = event({ id: 'e1', workspace: 'ws-1' as WorkspaceUuid, topic: 'topic-a', data: { n: 1 } })
    const e2 = event({ id: 'e2', workspace: 'ws-2' as WorkspaceUuid, topic: 'topic-b', data: { n: 2 } })
    const db: any = { getExpiredEvents: jest.fn().mockResolvedValue([e1, e2]), deleteEvents: jest.fn() }
    const ctx = newCtx()

    await pollOnce(ctx, db, {} as any)

    expect(sendTimeEvent).toHaveBeenNthCalledWith(1, ctx, {}, e1.workspace, e1.topic, e1.data)
    expect(sendTimeEvent).toHaveBeenNthCalledWith(2, ctx, {}, e2.workspace, e2.topic, e2.data)
    expect(db.deleteEvents).toHaveBeenCalledWith([e1, e2])
  })

  it('does not re-fetch-and-resend an event once its poll deleted it (checked against the db mock)', async () => {
    const e1 = event()
    const db: any = {
      getExpiredEvents: jest.fn().mockResolvedValueOnce([e1]).mockResolvedValueOnce([]),
      deleteEvents: jest.fn()
    }
    const ctx = newCtx()

    await pollOnce(ctx, db, {} as any)
    await pollOnce(ctx, db, {} as any)

    expect(sendTimeEvent).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed event for the next poll but still deletes the ones that succeeded', async () => {
    const ok = event({ id: 'ok' })
    const bad = event({ id: 'bad' })
    sendTimeEvent.mockImplementation(async (_ctx, _queue, _ws, _topic, data: any) => {
      if (data === bad.data) throw new Error('broker unavailable')
    })
    const db: any = { getExpiredEvents: jest.fn().mockResolvedValue([ok, bad]), deleteEvents: jest.fn() }
    const ctx = newCtx()

    await pollOnce(ctx, db, {} as any)

    expect(db.deleteEvents).toHaveBeenCalledWith([ok])
    expect(ctx.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ id: 'bad', err: expect.any(Error) })
    )
  })

  it('does not call deleteEvents at all when every send in the batch fails', async () => {
    sendTimeEvent.mockRejectedValue(new Error('broker unavailable'))
    const db: any = { getExpiredEvents: jest.fn().mockResolvedValue([event()]), deleteEvents: jest.fn() }

    await pollOnce(newCtx(), db, {} as any)

    expect(db.deleteEvents).not.toHaveBeenCalled()
  })

  it('logs a failure fetching expired events with the error object and does not throw', async () => {
    const db: any = { getExpiredEvents: jest.fn().mockRejectedValue(new Error('db down')), deleteEvents: jest.fn() }
    const ctx = newCtx()

    await expect(pollOnce(ctx, db, {} as any)).resolves.toBeUndefined()

    expect(ctx.error).toHaveBeenCalledWith(expect.any(String), { err: expect.any(Error) })
  })

  it('a nested payload with unicode/numbers/null reaches SendTimeEvent unchanged through a real schedule -> poll round trip', async () => {
    const { client } = createFakeClient()
    const realDb = new TimeMachineDB(client)
    const data = {
      text: 'Привет мир 🎉',
      count: 42,
      ratio: 0.5,
      missing: null,
      nested: { list: [1, 'two', null], flag: false }
    }
    await realDb.upsertEvent({ id: 'e1', workspace: ws1, target_date: Date.now() - 1000, topic: 'topic-a', data })

    await pollOnce(newCtx(), realDb, {} as any)

    expect(sendTimeEvent).toHaveBeenCalledWith(expect.anything(), {}, ws1, 'topic-a', data)
  })
})

describe('startPolling', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('schedules the next tick after a poll failure instead of stopping', async () => {
    const db: any = { getExpiredEvents: jest.fn().mockRejectedValue(new Error('boom')), deleteEvents: jest.fn() }
    const polling = startPolling(newCtx(), db, {} as any, 1000)

    await jest.advanceTimersByTimeAsync(0)
    expect(db.getExpiredEvents).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(1000)
    expect(db.getExpiredEvents).toHaveBeenCalledTimes(2)

    polling.stop()
    await jest.advanceTimersByTimeAsync(5000)
    expect(db.getExpiredEvents).toHaveBeenCalledTimes(2)
  })

  it('stop() called while a poll is still in flight prevents the next tick from being scheduled', async () => {
    let resolveGet: (v: DelayedEventRecord[]) => void = () => {}
    const db: any = {
      getExpiredEvents: jest.fn(
        async () =>
          await new Promise<DelayedEventRecord[]>((resolve) => {
            resolveGet = resolve
          })
      ),
      deleteEvents: jest.fn()
    }
    const polling = startPolling(newCtx(), db, {} as any, 1000)
    expect(db.getExpiredEvents).toHaveBeenCalledTimes(1)

    // stop() while the first pollOnce is still awaiting getExpiredEvents, then let it complete.
    polling.stop()
    resolveGet([])
    await jest.advanceTimersByTimeAsync(0)

    await jest.advanceTimersByTimeAsync(5000)
    expect(db.getExpiredEvents).toHaveBeenCalledTimes(1)
  })
})

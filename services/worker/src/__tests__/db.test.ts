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

import type { WorkspaceUuid } from '@hcengineering/core'
import { TimeMachineDB, type DelayedEventRecord } from '../db'

/**
 * A minimal in-memory stand-in for postgres.Sql, just enough to run the four fixed queries
 * TimeMachineDB issues. Dispatches on keywords in the query text rather than parsing SQL, so it
 * exercises the real upsert/ILIKE-scope/date-filter/limit behaviour instead of only recording calls.
 */
export function createFakeClient (): { client: any, rows: DelayedEventRecord[] } {
  const rows: DelayedEventRecord[] = []

  const run = async (strings: TemplateStringsArray, ...values: any[]): Promise<any> => {
    const text = strings.join(' ')
    if (text.includes('INSERT INTO')) {
      const [id, workspace, targetDate, topic, data] = values
      const idx = rows.findIndex((r) => r.id === id && r.workspace === workspace)
      // Round-trips data through JSON, like a real jsonb column would, so a serialization bug shows up here.
      const record: DelayedEventRecord = {
        id,
        workspace,
        target_date: targetDate,
        topic,
        data: JSON.parse(JSON.stringify(data))
      }
      if (idx >= 0) rows[idx] = record
      else rows.push(record)
      return []
    }
    if (text.includes('DELETE FROM') && text.includes('ILIKE')) {
      const [workspace, idPattern] = values
      const pattern = new RegExp(`^${String(idPattern).replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i')
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].workspace === workspace && pattern.test(rows[i].id)) rows.splice(i, 1)
      }
      return []
    }
    if (text.includes('SELECT')) {
      const [now, limit] = values
      return rows
        .filter((r) => r.target_date <= now)
        .sort((a, b) => a.target_date - b.target_date)
        .slice(0, limit)
        .map((r) => ({ ...r, target_date: String(r.target_date) })) // mimic int8 coming back as a string
    }
    if (text.includes('DELETE FROM')) {
      const [id, workspace] = values
      const idx = rows.findIndex((r) => r.id === id && r.workspace === workspace)
      if (idx >= 0) rows.splice(idx, 1)
      return []
    }
    throw new Error(`fake client: unexpected query: ${text}`)
  }

  const client: any = run
  client.begin = async (cb: (sql: any) => Promise<void>): Promise<void> => {
    await cb(client)
  }
  return { client, rows }
}

const ws1 = 'ws-1' as WorkspaceUuid
const ws2 = 'ws-2' as WorkspaceUuid

describe('TimeMachineDB', () => {
  let db: TimeMachineDB
  let rows: DelayedEventRecord[]

  beforeEach(() => {
    const fake = createFakeClient()
    rows = fake.rows
    db = new TimeMachineDB(fake.client)
  })

  describe('upsertEvent', () => {
    it('stores workspace/target_date/topic/data as given', async () => {
      await db.upsertEvent({ id: 'e1', workspace: ws1, target_date: 1000, topic: 'topic-a', data: { n: 1 } })

      expect(rows).toEqual([{ id: 'e1', workspace: ws1, target_date: 1000, topic: 'topic-a', data: { n: 1 } }])
    })

    it('updates the existing row instead of adding a second one on a repeated id', async () => {
      await db.upsertEvent({ id: 'e1', workspace: ws1, target_date: 1000, topic: 'topic-a', data: { n: 1 } })
      await db.upsertEvent({ id: 'e1', workspace: ws1, target_date: 2000, topic: 'topic-b', data: { n: 2 } })

      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({ id: 'e1', workspace: ws1, target_date: 2000, topic: 'topic-b', data: { n: 2 } })
    })

    it('upserts by (id, workspace) - the same id in another workspace is a separate row', async () => {
      await db.upsertEvent({ id: 'e1', workspace: ws1, target_date: 1000, topic: 'topic-a', data: {} })
      await db.upsertEvent({ id: 'e1', workspace: ws2, target_date: 1500, topic: 'topic-c', data: {} })

      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.workspace === ws1)?.target_date).toBe(1000)
      expect(rows.find((r) => r.workspace === ws2)?.target_date).toBe(1500)
    })
  })

  describe('removeEvents (cancel)', () => {
    it('removes the event in its own workspace and leaves the same id in another workspace alone', async () => {
      await db.upsertEvent({ id: 'e1', workspace: ws1, target_date: 1000, topic: 't', data: {} })
      await db.upsertEvent({ id: 'e1', workspace: ws2, target_date: 1000, topic: 't', data: {} })

      await db.removeEvents(ws1, 'e1')

      expect(rows).toHaveLength(1)
      expect(rows[0].workspace).toBe(ws2)
    })

    it('an exact id (no wildcard) cancels only that event and leaves a sibling id in the same workspace alone', async () => {
      await db.upsertEvent({ id: 'e1', workspace: ws1, target_date: 1000, topic: 't', data: {} })
      await db.upsertEvent({ id: 'e2', workspace: ws1, target_date: 1000, topic: 't', data: {} })

      await db.removeEvents(ws1, 'e1')

      expect(rows.map((r) => r.id)).toEqual(['e2'])
    })

    it('a %-suffix pattern cancels every event sharing the prefix - the contract services/process relies on for cleanTimers', async () => {
      await db.upsertEvent({ id: 'exec-a_t1', workspace: ws1, target_date: 1000, topic: 't', data: {} })
      await db.upsertEvent({ id: 'exec-a_t2', workspace: ws1, target_date: 1000, topic: 't', data: {} })
      await db.upsertEvent({ id: 'exec-b_t1', workspace: ws1, target_date: 1000, topic: 't', data: {} })

      await db.removeEvents(ws1, 'exec-a_%')

      expect(rows.map((r) => r.id)).toEqual(['exec-b_t1'])
    })

    // ILIKE treats '_' as "any single character", not a literal underscore. Webhook jobIds are
    // 'wh_<generateId()>', so cancelling by a raw exact id also removes an unrelated id that only
    // differs in that one position. This documents current behaviour, it is not a fix - a future
    // webhook cancel path must escape '_' (and '%') in the id before calling removeEvents.
    it('an unescaped underscore in an exact id also matches a sibling id differing in that one character', async () => {
      await db.upsertEvent({ id: 'wh_1', workspace: ws1, target_date: 1000, topic: 't', data: {} })
      await db.upsertEvent({ id: 'whX1', workspace: ws1, target_date: 1000, topic: 't', data: {} })

      await db.removeEvents(ws1, 'wh_1')

      expect(rows).toHaveLength(0)
    })
  })

  describe('getExpiredEvents', () => {
    it('excludes events whose target_date is in the future', async () => {
      const now = Date.now()
      await db.upsertEvent({ id: 'future', workspace: ws1, target_date: now + 60_000, topic: 't', data: {} })

      const expired = await db.getExpiredEvents()

      expect(expired).toHaveLength(0)
    })

    it('includes events whose target_date is in the past, mapping target_date back to a number', async () => {
      const now = Date.now()
      await db.upsertEvent({ id: 'past', workspace: ws1, target_date: now - 60_000, topic: 'topic-a', data: { x: 1 } })

      const expired = await db.getExpiredEvents()

      expect(expired).toHaveLength(1)
      expect(expired[0]).toEqual({
        id: 'past',
        workspace: ws1,
        target_date: now - 60_000,
        topic: 'topic-a',
        data: { x: 1 }
      })
    })

    it('caps the batch and returns the oldest events first when the backlog exceeds the limit', async () => {
      const now = Date.now()
      await db.upsertEvent({ id: 'e1', workspace: ws1, target_date: now - 3000, topic: 't', data: {} })
      await db.upsertEvent({ id: 'e2', workspace: ws1, target_date: now - 2000, topic: 't', data: {} })
      await db.upsertEvent({ id: 'e3', workspace: ws1, target_date: now - 1000, topic: 't', data: {} })

      const expired = await db.getExpiredEvents(2)

      expect(expired.map((e) => e.id)).toEqual(['e1', 'e2'])
    })
  })

  describe('deleteEvents', () => {
    it('removes exactly the given events', async () => {
      await db.upsertEvent({ id: 'e1', workspace: ws1, target_date: 1000, topic: 't', data: {} })
      await db.upsertEvent({ id: 'e2', workspace: ws1, target_date: 1000, topic: 't', data: {} })

      await db.deleteEvents([{ id: 'e1', workspace: ws1, target_date: 1000, topic: 't', data: {} }])

      expect(rows.map((r) => r.id)).toEqual(['e2'])
    })

    it('is a no-op on an empty list', async () => {
      await db.upsertEvent({ id: 'e1', workspace: ws1, target_date: 1000, topic: 't', data: {} })

      await db.deleteEvents([])

      expect(rows).toHaveLength(1)
    })

    it('a delivered event does not come back on the next poll', async () => {
      const now = Date.now()
      await db.upsertEvent({ id: 'e1', workspace: ws1, target_date: now - 1000, topic: 't', data: {} })

      const firstPoll = await db.getExpiredEvents()
      await db.deleteEvents(firstPoll)
      const secondPoll = await db.getExpiredEvents()

      expect(secondPoll).toHaveLength(0)
    })
  })

  describe('backlog larger than the limit', () => {
    it('drains across polls oldest-first, without losing or reordering anything', async () => {
      const now = Date.now()
      const ids = ['e1', 'e2', 'e3', 'e4', 'e5']
      for (let i = 0; i < ids.length; i++) {
        await db.upsertEvent({
          id: ids[i],
          workspace: ws1,
          target_date: now - (ids.length - i) * 1000,
          topic: 't',
          data: {}
        })
      }

      const firstPoll = await db.getExpiredEvents(2)
      expect(firstPoll.map((e) => e.id)).toEqual(['e1', 'e2'])
      await db.deleteEvents(firstPoll)

      const secondPoll = await db.getExpiredEvents(2)
      expect(secondPoll.map((e) => e.id)).toEqual(['e3', 'e4'])
      await db.deleteEvents(secondPoll)

      const thirdPoll = await db.getExpiredEvents(2)
      expect(thirdPoll.map((e) => e.id)).toEqual(['e5'])
      await db.deleteEvents(thirdPoll)

      expect(rows).toHaveLength(0)
    })
  })

  describe('reschedule (schedule again with the same id)', () => {
    it('a sooner target_date makes the event expire under the new date, as a single row', async () => {
      const now = Date.now()
      await db.upsertEvent({ id: 'e1', workspace: ws1, target_date: now + 3600_000, topic: 't', data: { v: 1 } })
      expect(await db.getExpiredEvents()).toHaveLength(0)

      await db.upsertEvent({ id: 'e1', workspace: ws1, target_date: now - 60_000, topic: 't2', data: { v: 2 } })

      const expired = await db.getExpiredEvents()
      expect(expired).toEqual([{ id: 'e1', workspace: ws1, target_date: now - 60_000, topic: 't2', data: { v: 2 } }])
    })
  })

  describe('data JSON round trip', () => {
    it('a nested payload with unicode, numbers and null comes back unchanged after insert + read', async () => {
      const data = {
        text: 'Привет мир 🎉',
        count: 42,
        ratio: 0.5,
        missing: null,
        nested: { list: [1, 'two', null], flag: false }
      }
      await db.upsertEvent({ id: 'e1', workspace: ws1, target_date: Date.now() - 1000, topic: 't', data })

      const [expired] = await db.getExpiredEvents()

      expect(expired.data).toEqual(data)
    })
  })
})

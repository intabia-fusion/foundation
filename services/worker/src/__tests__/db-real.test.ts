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

/**
 * Smoke test against a real Postgres/CockroachDB - catches SQL syntax mistakes the mocked
 * db.test.ts suite cannot (it fakes query execution). Opt-in via WORKER_TEST_DB_URL; skipped
 * entirely (not failed) when unset, so a plain `npx jest` run needs no database up.
 */

import { randomUUID } from 'node:crypto'
import type { WorkspaceUuid } from '@hcengineering/core'
import { TimeMachineDB } from '../db'

const dbUrl = process.env.WORKER_TEST_DB_URL

const maybeDescribe = dbUrl !== undefined ? describe : describe.skip

maybeDescribe('TimeMachineDB (real database)', () => {
  jest.setTimeout(30000)

  let db: TimeMachineDB
  const ws = randomUUID() as WorkspaceUuid

  beforeAll(async () => {
    db = await TimeMachineDB.init(dbUrl as string)
  })

  afterAll(async () => {
    // ILIKE '%' matches everything - reuses the same prefix-wildcard cancel API services/process relies on.
    await db.removeEvents(ws, '%')
    await db.close()
  })

  it('round-trips schedule -> expire -> delete', async () => {
    const id = randomUUID()
    await db.upsertEvent({ id, workspace: ws, target_date: Date.now() - 1000, topic: 'topic-a', data: { n: 1 } })

    const expired = (await db.getExpiredEvents()).filter((e) => e.workspace === ws)
    expect(expired).toEqual([{ id, workspace: ws, target_date: expect.any(Number), topic: 'topic-a', data: { n: 1 } }])

    await db.deleteEvents(expired)
    const afterDelete = (await db.getExpiredEvents()).filter((e) => e.workspace === ws)
    expect(afterDelete).toHaveLength(0)
  })

  it('upserts by (id, workspace) and cancel is scoped to a workspace', async () => {
    const id = randomUUID()
    const otherWs = randomUUID() as WorkspaceUuid
    await db.upsertEvent({ id, workspace: ws, target_date: Date.now() - 1000, topic: 't', data: {} })
    await db.upsertEvent({ id, workspace: otherWs, target_date: Date.now() - 1000, topic: 't', data: {} })
    await db.upsertEvent({ id, workspace: ws, target_date: Date.now() - 500, topic: 't2', data: {} })

    await db.removeEvents(ws, id)

    const mine = (await db.getExpiredEvents()).filter((e) => e.workspace === ws && e.id === id)
    const theirs = (await db.getExpiredEvents()).filter((e) => e.workspace === otherWs && e.id === id)
    expect(mine).toHaveLength(0)
    expect(theirs).toHaveLength(1)

    await db.removeEvents(otherWs, id)
  })

  it('ILIKE cancel: a %-suffix removes every event sharing the prefix, an exact id removes only that one', async () => {
    const prefix = randomUUID()
    const t1 = `${prefix}_t1`
    const t2 = `${prefix}_t2`
    const other = randomUUID()
    await db.upsertEvent({ id: t1, workspace: ws, target_date: Date.now() - 1000, topic: 't', data: {} })
    await db.upsertEvent({ id: t2, workspace: ws, target_date: Date.now() - 1000, topic: 't', data: {} })
    await db.upsertEvent({ id: other, workspace: ws, target_date: Date.now() - 1000, topic: 't', data: {} })

    await db.removeEvents(ws, `${prefix}_%`)

    const remaining = (await db.getExpiredEvents())
      .filter((e) => e.workspace === ws && [t1, t2, other].includes(e.id))
      .map((e) => e.id)
    expect(remaining).toEqual([other])

    await db.removeEvents(ws, other)
  })

  // ILIKE '_' matches any single character - documents current behaviour (see docs/memory notes),
  // it is not fixed here: a future caller cancelling by a raw exact id must escape '_' first.
  it('ILIKE underscore matches any single character, so cancelling by a raw id also hits a sibling id', async () => {
    const base = randomUUID().replace(/-/g, '')
    const withUnderscore = `${base}_1`
    const withOtherChar = `${base}X1`
    await db.upsertEvent({ id: withUnderscore, workspace: ws, target_date: Date.now() - 1000, topic: 't', data: {} })
    await db.upsertEvent({ id: withOtherChar, workspace: ws, target_date: Date.now() - 1000, topic: 't', data: {} })

    await db.removeEvents(ws, withUnderscore)

    const remaining = (await db.getExpiredEvents()).filter(
      (e) => e.workspace === ws && [withUnderscore, withOtherChar].includes(e.id)
    )
    expect(remaining).toHaveLength(0)
  })

  it('drains a backlog larger than the limit across two polls without loss or reordering', async () => {
    await db.removeEvents(ws, '%') // isolate from any state left by the tests above
    const prefix = randomUUID()
    const ids = [0, 1, 2, 3, 4].map((i) => `${prefix}_${i}`)
    const base = Date.now() - 10_000
    for (let i = 0; i < ids.length; i++) {
      await db.upsertEvent({ id: ids[i], workspace: ws, target_date: base + i, topic: 't', data: {} })
    }

    const firstPoll = await db.getExpiredEvents(2)
    expect(firstPoll.map((e) => e.id)).toEqual([ids[0], ids[1]])
    await db.deleteEvents(firstPoll)

    const secondPoll = await db.getExpiredEvents(2)
    expect(secondPoll.map((e) => e.id)).toEqual([ids[2], ids[3]])
    await db.deleteEvents(secondPoll)

    const thirdPoll = (await db.getExpiredEvents()).filter((e) => e.workspace === ws)
    expect(thirdPoll.map((e) => e.id)).toEqual([ids[4]])
    await db.deleteEvents(thirdPoll)
  })

  it('rescheduling to a sooner date makes the event expire under the new date, as a single row', async () => {
    const id = randomUUID()
    const farFuture = Date.now() + 3600_000
    await db.upsertEvent({ id, workspace: ws, target_date: farFuture, topic: 't', data: { v: 1 } })
    const notYetExpired = (await db.getExpiredEvents()).filter((e) => e.workspace === ws && e.id === id)
    expect(notYetExpired).toHaveLength(0)

    const soon = Date.now() - 1000
    await db.upsertEvent({ id, workspace: ws, target_date: soon, topic: 't2', data: { v: 2 } })

    const expired = (await db.getExpiredEvents()).filter((e) => e.workspace === ws && e.id === id)
    expect(expired).toEqual([{ id, workspace: ws, target_date: soon, topic: 't2', data: { v: 2 } }])

    await db.deleteEvents(expired)
  })
})

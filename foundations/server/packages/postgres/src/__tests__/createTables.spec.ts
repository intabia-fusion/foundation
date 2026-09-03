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

import { DOMAIN_MODEL_TX, DOMAIN_SPACE, DOMAIN_TX, MeasureMetricsContext } from '@hcengineering/core'
import type postgres from 'postgres'
import { createTables } from '../utils'

interface FakeDb {
  client: postgres.Sql
  created: string[]
  tableQueries: number
}

/** In-memory stand-in for one database: knows its tables and records the ones created in it. */
function fakeDb (existing: string[]): FakeDb {
  const tables = new Set(existing)
  const db: FakeDb = { client: undefined as any, created: [], tableQueries: 0 }

  const client: any = async () => []
  client.unsafe = async (sql: string): Promise<any[]> => {
    if (sql.includes('information_schema.tables')) {
      db.tableQueries++
      return [...tables].map((name) => ({ table_name: name }))
    }
    if (sql.includes('information_schema.columns')) {
      return []
    }
    const created = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql)
    if (created != null) {
      db.created.push(created[1])
      tables.add(created[1])
    }
    return []
  }
  client.begin = async (op: (c: any) => Promise<any>): Promise<any> => await op(client)

  db.client = client
  return db
}

describe('createTables', () => {
  const ctx = new MeasureMetricsContext('test', {})

  it('creates the schema per database, not once per process', async () => {
    const main = fakeDb([DOMAIN_MODEL_TX])
    const europe = fakeDb([])

    await createTables(ctx, main.client, 'postgres://main-1', [DOMAIN_MODEL_TX])
    expect(main.created).toEqual([])

    // A different database with the same domain: its own tables must be created even though the
    // first one already had them.
    await createTables(ctx, europe.client, 'postgres://europe-1', [DOMAIN_MODEL_TX])
    expect(europe.created).toEqual([DOMAIN_MODEL_TX])
  })

  it('creates only the domains a database is missing', async () => {
    const main = fakeDb([DOMAIN_TX])
    const europe = fakeDb([DOMAIN_SPACE])

    await createTables(ctx, main.client, 'postgres://main-2', [DOMAIN_TX, DOMAIN_SPACE])
    expect(main.created).toEqual([DOMAIN_SPACE])

    await createTables(ctx, europe.client, 'postgres://europe-2', [DOMAIN_TX, DOMAIN_SPACE])
    expect(europe.created).toEqual([DOMAIN_TX])
  })

  it('reads the table list of a database once', async () => {
    const main = fakeDb([DOMAIN_TX])

    await createTables(ctx, main.client, 'postgres://main-3', [DOMAIN_TX])
    await createTables(ctx, main.client, 'postgres://main-3', [DOMAIN_SPACE])

    expect(main.tableQueries).toBe(1)
    expect(main.created).toEqual([DOMAIN_SPACE])
  })
})

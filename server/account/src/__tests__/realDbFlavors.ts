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

import { getDBClient, type PostgresClientReference } from '@hcengineering/postgres'
import { PostgresAccountDB } from '../collections/postgres/postgres'
import { type DBFlavor } from '../types'

/** A real database the migration suite runs against. */
export interface RealDbFlavor {
  flavor: DBFlavor
  /** Admin connection string (points at the server's default database). */
  adminUri: string
  /** Build the connection string of a freshly created test database. */
  dbUri: (adminUri: string, dbUuid: string) => string
}

function withDatabase (adminUri: string, dbUuid: string): string {
  const parts = adminUri.split('/')
  parts[parts.length - 1] = dbUuid
  return parts.join('/')
}

// Postgres is the default stand database, so it always runs. CockroachDB is an opt-in overlay
// (ws-tests/docker-compose.cockroach.yaml): its suite runs only when its url is given.
const postgresAdminUri = process.env.ACCOUNT_TEST_PG_URL ?? 'postgresql://postgres:postgres@localhost:5433/postgres'
const cockroachAdminUri = process.env.ACCOUNT_TEST_CR_URL

export const realDbFlavors: RealDbFlavor[] = [
  {
    flavor: 'postgres',
    adminUri: postgresAdminUri,
    dbUri: withDatabase
  },
  ...(cockroachAdminUri !== undefined
    ? [
        {
          flavor: 'cockroach' as DBFlavor,
          adminUri: cockroachAdminUri,
          dbUri: (adminUri: string, dbUuid: string) => adminUri.replace('/defaultdb', '/' + dbUuid)
        }
      ]
    : [])
]

/**
 * Open a migrated test database, creating it on first use and reusing it afterwards.
 *
 * The name is fixed per (suite, flavor) instead of timestamped, and the database is never dropped:
 * on CockroachDB every DROP DATABASE queues a GC job that holds resources for gc.ttlseconds (300s by
 * default), and a suite that drops per test buries the node under them. Reusing costs nothing —
 * migrations are recorded in _account_applied_migrations, so a second run skips straight past them.
 * Tests clear the rows they dirty instead.
 */
export async function openRealDb (
  suite: string,
  { flavor, adminUri, dbUri }: RealDbFlavor
): Promise<{ dbUuid: string, dbRef: PostgresClientReference, account: PostgresAccountDB, close: () => void }> {
  const dbUuid = `${suite}_${flavor}`
  const adminRef = getDBClient(adminUri)
  try {
    const admin = await adminRef.getClient()
    // Postgres has no IF NOT EXISTS for CREATE DATABASE; a duplicate is the normal reuse path.
    try {
      await admin`CREATE DATABASE ${admin(dbUuid)}`
    } catch (err: any) {
      if (err?.code !== '42P04') throw err
    }
  } finally {
    adminRef.close()
  }

  const uri = dbUri(adminUri, dbUuid)
  const dbRef = getDBClient(uri)
  const account = new PostgresAccountDB(await dbRef.getClient(), dbUuid, flavor)
  await migrateRealDb(account, uri)

  return {
    dbUuid,
    dbRef,
    account,
    close: () => {
      dbRef.close()
    }
  }
}

/** Delete rows from the given tables (children first) so the next test starts clean. */
export async function clearTables (dbRef: PostgresClientReference, dbUuid: string, tables: string[]): Promise<void> {
  const client = await dbRef.getClient()
  for (const table of tables) {
    await client.unsafe(`DELETE FROM ${dbUuid}.${table}`)
  }
}

/**
 * Run migrations, retrying only transient connection failures. A DDL the flavor rejects fails fast
 * with its own error instead of spinning until the jest hook times out.
 */
export async function migrateRealDb (account: PostgresAccountDB, dbUri: string, attempts = 5): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await account.init()
      return
    } catch (err: any) {
      if (i >= attempts) {
        console.error(`Failed to migrate ${dbUri} after ${attempts} attempts`, err)
        throw err
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}

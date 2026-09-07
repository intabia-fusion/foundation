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

import { type MeasureContext } from '@hcengineering/core'
import { withRetry, DelayStrategyFactory } from '@hcengineering/retry'
import * as fs from 'fs'
import { type Sql, type TransactionSql } from 'postgres'
import * as path from 'path'

export type { DBFlavor } from '@hcengineering/postgres'
export { getDBFlavor as getDbFlavor } from '@hcengineering/postgres'

export async function ensureSystemSchema (sql: Sql): Promise<void> {
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS system;')
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS system._migrations (
      name text PRIMARY KEY,
      applied_at timestamp with time zone DEFAULT now()
    );
  `)
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS system._version (
      version integer PRIMARY KEY,
      applied_at timestamp with time zone DEFAULT now()
    );
  `)
}

export async function isUpToDate (sql: Sql, expectedVersion: number): Promise<boolean> {
  const res = await sql.unsafe(`
    SELECT MAX(version) as version 
    FROM system._version
  `)
  const currentVersion = res[0]?.version
  return currentVersion !== undefined && typeof currentVersion === 'number' && currentVersion >= expectedVersion
}

export async function isDatabaseEmpty (sql: Sql): Promise<boolean> {
  const res = await sql.unsafe(`
    SELECT count(*)::int as count 
    FROM information_schema.tables 
    WHERE table_schema = 'public'
  `)
  return (res[0]?.count ?? 0) === 0
}

export async function getAppliedMigrations (sql: Sql): Promise<Set<string>> {
  const res = await sql.unsafe(`
    SELECT name 
    FROM system._migrations
  `)
  return new Set(res.map((r: any) => r.name))
}

export async function markAllAsApplied (sql: Sql, files: string[]): Promise<void> {
  if (files.length === 0) return
  await sql.begin(async (txn: TransactionSql) => {
    for (const file of files) {
      await txn.unsafe(
        `
        INSERT INTO system._migrations (name) 
        VALUES ($1)
        ON CONFLICT (name) DO NOTHING
      `,
        [file]
      )
    }
  })
}

export async function applyMigration (sql: Sql, fileName: string, dir: string, ctx: MeasureContext): Promise<void> {
  try {
    const sqlContent = fs.readFileSync(path.join(dir, fileName), 'utf8')
    await withRetry(
      async () => {
        await sql.begin(async (txn: TransactionSql) => {
          await txn.unsafe(sqlContent)
          await txn.unsafe(
            `
          INSERT INTO system._migrations (name) 
          VALUES ($1)
          ON CONFLICT (name) DO NOTHING
        `,
            [fileName]
          )
        })
      },
      {
        maxRetries: 5,
        delayStrategy: DelayStrategyFactory.exponentialBackoff({
          initialDelayMs: 2000,
          maxDelayMs: 10000,
          backoffFactor: 2.0,
          jitter: 0.2
        })
      }
    )
    ctx.info(`Successfully applied migration ${fileName}`)
  } catch (err: any) {
    ctx.error(`Failed to apply migration ${fileName}, marking as applied anyway`, {
      error: err.message,
      code: err.code
    })
    await sql.unsafe(
      `
      INSERT INTO system._migrations (name) 
      VALUES ($1)
      ON CONFLICT (name) DO NOTHING
    `,
      [fileName]
    )
  }
}

export async function updateSchemaVersion (sql: Sql, version: number, ctx: MeasureContext): Promise<void> {
  ctx.info(`Updating database schema version to ${version}...`)
  await sql.unsafe(
    `
    INSERT INTO system._version (version) 
    VALUES ($1)
    ON CONFLICT (version) DO UPDATE SET applied_at = now()
  `,
    [version]
  )
  ctx.info(`Successfully updated database schema version to ${version}`)
}

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

import { getMigrations } from '../collections/postgres/migrations'

const ns = 'global_account'

describe('getMigrations - v40/v41 workspace_purchase dedup + unique index', () => {
  const migrations = getMigrations(ns, 'cockroach')
  const ids = migrations.map(([id]) => id)

  it('registers v40 and v41 identifiers', () => {
    expect(ids).toContain('account_db_v40_workspace_purchase_dedup')
    expect(ids).toContain('account_db_v41_workspace_purchase_unique')
  })

  it('has no duplicate migration identifiers', () => {
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('orders v39 (create table) before v40 (dedup) before v41 (unique index)', () => {
    const v39CreateIdx = ids.indexOf('account_db_v39_workspace_purchase')
    const v40Idx = ids.indexOf('account_db_v40_workspace_purchase_dedup')
    const v41Idx = ids.indexOf('account_db_v41_workspace_purchase_unique')

    expect(v39CreateIdx).toBeGreaterThanOrEqual(0)
    expect(v40Idx).toBeGreaterThan(v39CreateIdx)
    expect(v41Idx).toBeGreaterThan(v40Idx)
  })

  it('v40 is DML-only (dedup) - CockroachDB cannot mix it with the DDL from v41 in one transaction', () => {
    const [, ddl] = migrations.find(([id]) => id === 'account_db_v40_workspace_purchase_dedup') ?? []
    expect(ddl).toBeDefined()
    expect(ddl).toMatch(/DELETE FROM/i)
    expect(ddl).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i)
    expect(ddl).not.toMatch(/ALTER TABLE/i)
  })

  it('v40 dedups by (payment_id, provider), keeping the oldest row', () => {
    const [, ddl] = migrations.find(([id]) => id === 'account_db_v40_workspace_purchase_dedup') ?? []
    expect(ddl).toMatch(/payment_id IS NOT NULL/)
    expect(ddl).toMatch(/DISTINCT ON \(payment_id, provider\)/)
    expect(ddl).toMatch(/ORDER BY payment_id, provider, created_on ASC/)
  })

  it('v41 is DDL-only (unique index) - split from v40 to keep DML/DDL out of the same transaction', () => {
    const [, ddl] = migrations.find(([id]) => id === 'account_db_v41_workspace_purchase_unique') ?? []
    expect(ddl).toBeDefined()
    expect(ddl).toMatch(/CREATE UNIQUE INDEX/i)
    expect(ddl).not.toMatch(/DELETE FROM/i)
    expect(ddl).not.toMatch(/UPDATE /i)
    expect(ddl).not.toMatch(/INSERT INTO/i)
  })

  it('v41 unique index is partial on payment_id IS NOT NULL (non-payment purchases stay unconstrained)', () => {
    const [, ddl] = migrations.find(([id]) => id === 'account_db_v41_workspace_purchase_unique') ?? []
    expect(ddl).toMatch(
      new RegExp(`ON ${ns}\\.workspace_purchase \\(payment_id, provider\\) WHERE payment_id IS NOT NULL`)
    )
  })
})

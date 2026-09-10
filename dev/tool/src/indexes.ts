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

import { type MeasureContext, type Tx } from '@hcengineering/core'
import {
  customIndexes,
  domainSchemas,
  getDBClient,
  getIndex,
  getSchema,
  translateDomain
} from '@hcengineering/postgres'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import * as yaml from 'js-yaml'
import type postgres from 'postgres'
import { buildModel } from './mdiff'

export interface IndexRecord {
  name: string
  definition: string
}

export interface IndexesFile {
  version: 1
  generatedAt: string
  domains: Record<string, IndexRecord[]>
}

interface ExpectedIndex {
  name: string
  table: string
  sql: string
}

async function collectDomains (txes: Tx[]): Promise<string[]> {
  const set = new Set<string>()
  const { hierarchy } = await buildModel(txes)
  for (const d of hierarchy.domains()) set.add(translateDomain(d))
  for (const d of Object.keys(domainSchemas)) set.add(translateDomain(d))
  for (const d of Object.keys(customIndexes)) set.add(translateDomain(d))
  return Array.from(set).sort()
}

async function filterPhysicalTables (client: postgres.Sql, domains: string[]): Promise<string[]> {
  if (domains.length === 0) return []
  const rows = await client<Array<{ name: string }>>`
    SELECT table_name::text AS name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${domains})
  `
  const existing = new Set<string>(rows.map((r) => r.name))
  return domains.filter((d) => existing.has(d))
}

function buildExpectedIndexes (domains: string[]): Map<string, ExpectedIndex[]> {
  const result = new Map<string, ExpectedIndex[]>()
  const push = (table: string, idx: ExpectedIndex): void => {
    const list = result.get(table) ?? []
    list.push(idx)
    result.set(table, list)
  }
  for (const domain of domains) {
    const schema = getSchema(domain)
    for (const key of Object.keys(schema)) {
      const val = schema[key]
      if (!val.index) continue
      const name = `${domain}_${key}__index`
      const sql = `CREATE INDEX IF NOT EXISTS ${name} ON ${domain}${getIndex(val)} ("${key}")`
      push(domain, { name, table: domain, sql })
    }
    const customs = customIndexes[domain]
    if (customs !== undefined) {
      for (const entry of customs) {
        if (entry.unique.length > 0) {
          const uniqueFields = ['workspaceId', ...entry.unique]
          const indexName = `${domain}_unique_${uniqueFields.join('_')}__index`
          const cols = uniqueFields.map((f) => `"${f}"`).join(', ')
          const sql = `CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${domain} (${cols})`
          push(domain, { name: indexName, table: domain, sql })
        }
        for (const custom of entry.custom) {
          const match =
            /CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)\s+ON\s+([A-Za-z0-9_]+)/i.exec(custom)
          if (match == null) {
            throw new Error(`cannot parse custom index name from: ${custom}`)
          }
          push(match[4], { name: match[3], table: match[4], sql: custom })
        }
      }
    }
  }
  return result
}

export async function dumpIndexes (ctx: MeasureContext, dbUrl: string, txes: Tx[], outFile: string): Promise<void> {
  const dbRef = getDBClient(dbUrl, undefined, 'tool')
  try {
    const client = await dbRef.getClient()
    const allDomains = await collectDomains(txes)
    const tables = await filterPhysicalTables(client, allDomains)
    if (tables.length === 0) {
      ctx.warn('no physical domain tables found')
      return
    }
    ctx.info('domains', { discovered: allDomains.length, physical: tables.length })
    const rows = await client<Array<{ table: string, name: string, definition: string }>>`
      SELECT tablename::text AS table, indexname::text AS name, indexdef::text AS definition
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ANY(${tables})
      ORDER BY tablename, indexname
    `
    const domains: Record<string, IndexRecord[]> = {}
    for (const t of tables) domains[t] = []
    for (const r of rows) {
      const list = domains[r.table] ?? []
      list.push({ name: r.name, definition: r.definition })
      domains[r.table] = list
    }
    const out: IndexesFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      domains
    }
    await writeFile(outFile, yaml.dump(out, { lineWidth: 200, noRefs: true, sortKeys: false }))
    const total = Object.values(domains).reduce((s, l) => s + l.length, 0)
    ctx.info('dumped indexes', { file: outFile, tables: tables.length, indexes: total })
  } finally {
    dbRef.close()
  }
}

export async function syncIndexes (
  ctx: MeasureContext,
  dbUrl: string,
  txes: Tx[],
  inFile: string,
  apply: boolean
): Promise<void> {
  if (!existsSync(inFile)) {
    throw new Error(`file not found: ${inFile}`)
  }
  let parsed: IndexesFile | undefined
  try {
    parsed = yaml.load(readFileSync(inFile, 'utf8')) as IndexesFile | undefined
  } catch (err) {
    throw new Error(`invalid YAML in ${inFile}`)
  }
  if (parsed == null || typeof parsed !== 'object') {
    throw new Error(`invalid YAML in ${inFile}`)
  }
  if (parsed.version !== 1) {
    throw new Error(`unsupported file version: ${parsed.version as unknown as string}`)
  }
  const fromFiles = new Map<string, IndexRecord[]>(Object.entries(parsed.domains ?? {}))

  const domains = await collectDomains(txes)
  const expected = buildExpectedIndexes(domains)
  const expectedNames = new Set<string>()
  for (const list of expected.values()) for (const e of list) expectedNames.add(e.name.toLowerCase().slice(0, 63))

  const dbRef = getDBClient(dbUrl, undefined, 'tool')
  try {
    const client = await dbRef.getClient()
    const candidate = Array.from(new Set([...expected.keys(), ...fromFiles.keys()]))
    const tables = await filterPhysicalTables(client, candidate)
    if (tables.length === 0) {
      ctx.info('nothing to sync')
      return
    }
    const physical = new Set(tables)
    const rows = await client<Array<{ name: string }>>`
      SELECT indexname::text AS name
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ANY(${tables})
    `
    const norm = (s: string): string => s.toLowerCase().slice(0, 63)
    const existing = new Set<string>(rows.map((r) => norm(r.name)))
    const isExisting = (name: string): boolean => existing.has(norm(name))

    const toCreate: { domain: string, name: string, sql: string, source: 'schema' | 'file' }[] = []
    for (const [domain, list] of expected) {
      if (!physical.has(domain)) continue
      for (const e of list) {
        if (!isExisting(e.name)) {
          toCreate.push({ domain, name: e.name, sql: e.sql, source: 'schema' })
        }
      }
    }
    const safeIndexRe =
      /^CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)\s+ON\s+(?:public\.)?([A-Za-z0-9_]+)\s*(?:USING\s+[A-Za-z0-9_]+\s*)?\([^();]*\)(?:\s+WHERE\s+[^;]+)?\s*;?\s*$/i
    for (const [domain, list] of fromFiles) {
      if (!physical.has(domain)) continue
      for (const r of list) {
        if (isExisting(r.name)) continue
        if (expectedNames.has(r.name.toLowerCase().slice(0, 63))) continue
        const def = r.definition.trim().replace(/;\s*$/, '')
        const match = safeIndexRe.exec(def)
        if (match == null) {
          ctx.warn('skip unsafe index definition', { domain, name: r.name, definition: r.definition })
          continue
        }
        if (match[4].toLowerCase() !== domain.toLowerCase()) {
          ctx.warn('skip index targeting different table', { domain, name: r.name, table: match[4] })
          continue
        }
        if (match[3].toLowerCase() !== r.name.toLowerCase()) {
          ctx.warn('skip index with mismatched name', { domain, declared: r.name, parsed: match[3] })
          continue
        }
        const sql = def.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (m) =>
          /IF\s+NOT\s+EXISTS/i.test(m) ? m : m.replace(/INDEX\s+/i, 'INDEX IF NOT EXISTS ')
        )
        toCreate.push({ domain, name: r.name, sql, source: 'file' })
      }
    }

    if (toCreate.length === 0) {
      ctx.info('all indexes present, nothing to do')
      return
    }

    ctx.info(apply ? 'applying missing indexes' : 'DRY RUN — missing indexes (use --apply to create)', {
      count: toCreate.length
    })
    for (const item of toCreate) {
      console.log(`-- [${item.domain}] ${item.source}: ${item.name}`)
      console.log(item.sql.endsWith(';') ? item.sql : item.sql + ';')
    }

    if (!apply) {
      ctx.info('dry run, no changes')
      return
    }

    let created = 0
    let failed = 0
    for (const item of toCreate) {
      try {
        await client.unsafe(item.sql)
        created++
        ctx.info('created index', { domain: item.domain, name: item.name })
      } catch (err: any) {
        failed++
        ctx.error('failed to create index', {
          domain: item.domain,
          name: item.name,
          err: err?.message ?? String(err)
        })
      }
    }
    ctx.info('sync complete', { created, failed })
  } finally {
    dbRef.close()
  }
}

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

import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'

const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY
const wrap = (code: string) => (s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  gray: wrap('90')
}
// Color a duration by severity threshold (ms).
const colorMs = (ms: number, text: string): string =>
  ms >= 5000 ? c.red(text) : ms >= 1000 ? c.yellow(text) : c.green(text)

// Minimal shape of a metrics tree node as returned by /api/v1/statistics.
interface MetricsNode {
  operations?: number
  value?: number
  measurements?: Record<string, MetricsNode>
  params?: Record<string, Record<string, MetricsNode>>
  topResult?: Array<{ value: number, time?: number, params?: Record<string, any> }>
}

interface ServiceStats {
  serviceName?: string
  stats?: MetricsNode
}

export interface SqlSample {
  service: string
  ms: number
  sql: string
  table: string
  query?: unknown
}

export interface IndexInfo {
  name: string
  columns: string[]
}

export interface IndexCoverage {
  filterColumns: string[]
  tableIndexes: IndexInfo[]
  covered: boolean
}

export interface SqlGroup {
  normalized: string
  table: string
  count: number
  maxMs: number
  avgMs: number
  sumMs: number
  sample: string
  query?: unknown
  services: string[]
  index?: IndexCoverage
}

interface IndexesFile {
  version: number
  domains: Record<string, Array<{ name: string, definition: string }>>
}

// Columns from the primary table referenced in WHERE (and JSON path expressions).
// Skips the correlated security sub-select (sec.*) and other table aliases.
export function extractFilterColumns (sql: string, table: string): string[] {
  const cols = new Set<string>()
  const whereIdx = sql.search(/\bWHERE\b/i)
  if (whereIdx < 0) return []
  // Cut off the security EXISTS sub-select to avoid sec.* columns.
  let where = sql.slice(whereIdx + 5)
  const existsIdx = where.search(/\bAND\s*\(\s*EXISTS\b/i)
  if (existsIdx >= 0) where = where.slice(0, existsIdx)
  const t = table.replace(/[^A-Za-z0-9_]/g, '')
  // table."col"
  const reCol = new RegExp(`${t}\\."([A-Za-z0-9_]+)"`, 'gi')
  let m: RegExpExecArray | null
  while ((m = reCol.exec(where)) != null) cols.add(m[1])
  // table.data#>>'{path}'  ->  data:path
  const reJson = new RegExp(`${t}\\.data#>>'\\{([^}]+)\\}'`, 'gi')
  while ((m = reJson.exec(where)) != null) cols.add(`data:${m[1]}`)
  return Array.from(cols)
}

function indexColumns (definition: string): string[] {
  const m = /\(([^)]*)\)/.exec(definition)
  if (m == null) return []
  return m[1]
    .split(',')
    .map((c) =>
      c
        .trim()
        .replace(/^"|"$/g, '')
        .replace(/\s+(ASC|DESC)$/i, '')
    )
    .filter((c) => c.length > 0)
}

// A query column is "covered" if some index has it as a leading column
// (or the 2nd column in a workspaceId-leading composite).
function analyzeCoverage (table: string, filterCols: string[], indexes: IndexesFile | undefined): IndexCoverage {
  const defs = indexes?.domains?.[table] ?? []
  const tableIndexes: IndexInfo[] = defs.map((d) => ({ name: d.name, columns: indexColumns(d.definition) }))
  // Non-workspace discriminating columns - workspaceId is on every row, weak alone.
  const discriminating = filterCols.filter((c) => c !== 'workspaceId' && !c.startsWith('data:'))
  const leadingCols = new Set<string>()
  for (const idx of tableIndexes) {
    const ic = idx.columns
    if (ic.length > 0) leadingCols.add(ic[0].toLowerCase())
    if (ic.length > 1 && ic[0].toLowerCase() === 'workspaceid') leadingCols.add(ic[1].toLowerCase())
  }
  const uncovered = discriminating.filter((c) => !leadingCols.has(c.toLowerCase()))
  const covered = discriminating.length > 0 && uncovered.length === 0
  return { filterColumns: filterCols, tableIndexes, covered }
}

// Replace literals so structurally identical queries collapse into one group.
export function normalizeSql (sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'(::uuid)?/gi, '?')
    .replace(/ARRAY\[[^\]]*\]/gi, 'ARRAY[?]')
    .replace(/'(?:[^']|'')*'(::[a-z]+)?/gi, '?')
    .replace(/\b\d+\b/g, '?')
    .trim()
}

function extractTable (sql: string): string {
  const m = /\bFROM\s+([A-Za-z0-9_]+)/i.exec(sql)
  return m != null ? m[1] : 'unknown'
}

// Walk the metrics tree and collect every topResult entry that carries a SQL string.
function collectSamples (service: string, node: MetricsNode | undefined, out: SqlSample[]): void {
  if (node == null) return
  if (node.topResult != null) {
    for (const t of node.topResult) {
      const sql = t.params?.sql
      if (typeof sql === 'string' && sql.length > 0) {
        out.push({ service, ms: t.value, sql, table: extractTable(sql), query: t.params?.query })
      }
    }
  }
  if (node.measurements != null) {
    for (const child of Object.values(node.measurements)) collectSamples(service, child, out)
  }
  if (node.params != null) {
    for (const pv of Object.values(node.params)) {
      for (const child of Object.values(pv)) collectSamples(service, child, out)
    }
  }
}

export function groupSamples (samples: SqlSample[]): SqlGroup[] {
  const groups = new Map<string, SqlGroup>()
  for (const s of samples) {
    const norm = normalizeSql(s.sql)
    let g = groups.get(norm)
    if (g === undefined) {
      g = {
        normalized: norm,
        table: s.table,
        count: 0,
        maxMs: 0,
        avgMs: 0,
        sumMs: 0,
        sample: s.sql,
        query: s.query,
        services: []
      }
      groups.set(norm, g)
    }
    g.count++
    g.sumMs += s.ms
    if (s.ms > g.maxMs) {
      g.maxMs = s.ms
      g.sample = s.sql
      g.query = s.query
    }
    if (!g.services.includes(s.service)) g.services.push(s.service)
  }
  for (const g of groups.values()) g.avgMs = g.sumMs / g.count
  return Array.from(groups.values())
}

function statsFromService (svc: ServiceStats): MetricsNode | undefined {
  return svc.stats
}

async function fetchLive (statsUrl: string, token: string, filter: string): Promise<SqlSample[]> {
  const overviewResp = await fetch(`${statsUrl}/api/v1/overview`, { headers: { Authorization: `Bearer ${token}` } })
  if (!overviewResp.ok) {
    throw new Error(`failed to fetch overview: ${overviewResp.status} ${overviewResp.statusText}`)
  }
  const overview = (await overviewResp.json()) as { data?: Record<string, unknown> }
  const all = Object.keys(overview.data ?? {})
  const services = filter === '' ? all : all.filter((s) => s.includes(filter))
  const samples: SqlSample[] = []
  for (const service of services) {
    const resp = await fetch(`${statsUrl}/api/v1/statistics?name=${encodeURIComponent(service)}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!resp.ok) {
      console.error(`  ${service}: ${resp.status} ${resp.statusText}`)
      continue
    }
    const svc = (await resp.json()) as ServiceStats
    collectSamples(service, statsFromService(svc), samples)
  }
  return samples
}

async function fetchFromDir (dir: string, filter: string): Promise<SqlSample[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'overview.json')
  const samples: SqlSample[] = []
  for (const file of files) {
    const svc = JSON.parse(await readFile(join(dir, file), 'utf8')) as ServiceStats
    const service = svc.serviceName ?? file.replace(/\.json$/, '')
    if (filter !== '' && !service.includes(filter)) continue
    collectSamples(service, statsFromService(svc), samples)
  }
  return samples
}

export interface SlowSqlOptions {
  url?: string
  from?: string
  filter: string
  limit: number
  sort: 'max' | 'sum' | 'count' | 'avg'
  json?: string
  indexes?: string
  missingOnly: boolean
  serverSecret?: string
  makeToken: () => string
}

function loadIndexes (file: string): IndexesFile {
  if (!existsSync(file)) throw new Error(`indexes file not found: ${file}`)
  const parsed = yaml.load(readFileSync(file, 'utf8')) as IndexesFile | undefined
  if (parsed?.domains == null) throw new Error(`invalid indexes file: ${file}`)
  return parsed
}

export async function reportSlowSql (opt: SlowSqlOptions): Promise<void> {
  let samples: SqlSample[]
  if (opt.from !== undefined) {
    console.log(`reading dumps from ${opt.from}`)
    samples = await fetchFromDir(opt.from, opt.filter)
  } else {
    const base = (opt.url ?? '').replace('ws:/', 'http:/').replace(/\/+$/, '')
    if (base === '') throw new Error('provide --url or --from')
    let statsUrl = base
    try {
      const cfgResp = await fetch(`${base}/config.json`)
      if (cfgResp.ok) {
        const cfg = (await cfgResp.json()) as { STATS_URL?: string }
        if (cfg.STATS_URL !== undefined && cfg.STATS_URL !== '') {
          statsUrl = cfg.STATS_URL.replace(/\/+$/, '')
          console.log(`resolved STATS_URL from config.json: ${statsUrl}`)
        }
      }
    } catch {
      // direct stats endpoint
    }
    if (opt.serverSecret === undefined) throw new Error('please provide server secret')
    samples = await fetchLive(statsUrl, opt.makeToken(), opt.filter)
  }

  let groups = groupSamples(samples)

  const indexes = opt.indexes !== undefined ? loadIndexes(opt.indexes) : undefined
  if (indexes !== undefined) {
    for (const g of groups) {
      const cols = extractFilterColumns(g.sample, g.table)
      g.index = analyzeCoverage(g.table, cols, indexes)
    }
    if (opt.missingOnly) groups = groups.filter((g) => g.index?.covered === false)
  }

  groups.sort((a, b) => {
    if (opt.sort === 'sum') return b.sumMs - a.sumMs
    if (opt.sort === 'count') return b.count - a.count
    if (opt.sort === 'avg') return b.avgMs - a.avgMs
    return b.maxMs - a.maxMs
  })

  console.log(
    c.dim(`collected ${samples.length} SQL samples, ${groups.length} distinct shapes, sorted by ${opt.sort}\n`)
  )

  if (opt.json !== undefined) {
    await writeFile(opt.json, JSON.stringify(groups, null, 2))
    console.log(`wrote ${groups.length} groups to ${opt.json}`)
    return
  }

  const top = groups.slice(0, opt.limit)

  // Compact summary table on top.
  const hdr = indexes !== undefined ? '  index' : ''
  console.log(c.bold(`  #   max(ms)   avg(ms)    count   sum(ms)  table${hdr}`))
  console.log(c.gray('---  --------  --------  -------  --------  ------------------------'))
  top.forEach((g, i) => {
    const rank = c.gray(String(i + 1).padStart(3))
    const max = colorMs(g.maxMs, g.maxMs.toFixed(2).padStart(8))
    const avg = colorMs(g.avgMs, g.avgMs.toFixed(2).padStart(8))
    const count = c.dim(String(g.count).padStart(7))
    const sum = colorMs(g.sumMs, g.sumMs.toFixed(0).padStart(8))
    const flag = g.index === undefined ? '' : g.index.covered ? '  ' + c.green('COVERED') : '  ' + c.red('MISSING')
    console.log(`${rank}  ${max}  ${avg}  ${count}  ${sum}  ${c.cyan(g.table)}${flag}`)
  })

  // Detailed card per query: the SQL, its filter columns, and current indexes
  // on that table so the operator can decide what (if anything) to add.
  top.forEach((g, i) => {
    console.log('')
    const flag = g.index === undefined ? '' : g.index.covered ? c.green(' [COVERED]') : c.red(' [MISSING]')
    console.log(
      c.bold(`[${i + 1}] ${c.cyan(g.table)}`) +
        `  ${colorMs(g.maxMs, 'max ' + g.maxMs.toFixed(0) + 'ms')}  ${c.dim('avg ' + g.avgMs.toFixed(0) + 'ms')}  ${c.dim('x' + g.count)}${flag}`
    )
    console.log(c.dim(`    SQL:    ${g.normalized}`))
    if (g.index !== undefined) {
      const covSet = new Set<string>()
      for (const idx of g.index.tableIndexes) {
        if (idx.columns.length > 0) covSet.add(idx.columns[0].toLowerCase())
        if (idx.columns.length > 1 && idx.columns[0].toLowerCase() === 'workspaceid') {
          covSet.add(idx.columns[1].toLowerCase())
        }
      }
      const filterStr = g.index.filterColumns
        .map((col) => {
          const disc = col !== 'workspaceId' && !col.startsWith('data:')
          if (!disc) return c.gray(col)
          return covSet.has(col.toLowerCase()) ? c.green(col) : c.red(col)
        })
        .join(', ')
      console.log(`    filter: ${filterStr}`)
      if (g.index.tableIndexes.length === 0) {
        console.log(c.red(`    indexes on ${g.table}: NONE`))
      } else {
        console.log(c.gray(`    indexes on ${g.table}:`))
        for (const idx of g.index.tableIndexes) {
          console.log(`      ${c.yellow(idx.name)}  ${c.dim('(' + idx.columns.join(', ') + ')')}`)
        }
      }
    }
  })

  if (indexes !== undefined) {
    const missing = groups.filter((g) => g.index?.covered === false).length
    const covered = groups.filter((g) => g.index?.covered === true).length
    console.log(
      c.bold(
        `\n=== ${c.red(String(missing) + ' MISSING')} / ${c.green(String(covered) + ' COVERED')} of ${groups.length} shapes ===`
      )
    )
  }
}

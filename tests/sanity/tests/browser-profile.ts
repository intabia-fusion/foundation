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

import { type CDPSession, type Page, test } from '@playwright/test'
import { appendFile, mkdir, writeFile } from 'fs/promises'
import path from 'path'

// Opt-in, same switch style as STATS: BROWSER_PROFILE=1 rushx uitest
const enabled = process.env.BROWSER_PROFILE === '1' || process.env.BROWSER_PROFILE === 'true'
const outDir = process.env.BROWSER_PROFILE_DIR ?? 'browser-profiles'

const sessions = new WeakMap<Page, CDPSession>()

/** Chrome renderer metrics, in milliseconds of work since the page opened. */
interface FrameMetrics {
  ScriptDuration: number
  LayoutDuration: number
  RecalcStyleDuration: number
  TaskDuration: number
  JSHeapUsedSize: number
  LayoutCount: number
  RecalcStyleCount: number
}

function readMetrics (metrics: Array<{ name: string, value: number }>): FrameMetrics {
  const get = (name: string): number => metrics.find((m) => m.name === name)?.value ?? 0
  return {
    ScriptDuration: get('ScriptDuration') * 1000,
    LayoutDuration: get('LayoutDuration') * 1000,
    RecalcStyleDuration: get('RecalcStyleDuration') * 1000,
    TaskDuration: get('TaskDuration') * 1000,
    JSHeapUsedSize: get('JSHeapUsedSize'),
    LayoutCount: get('LayoutCount'),
    RecalcStyleCount: get('RecalcStyleCount')
  }
}

function slug (value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

async function startProfile (page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page)
  sessions.set(page, session)
  await session.send('Performance.enable')
  await session.send('Profiler.enable')
  // 1ms is the DevTools default; finer sampling distorts the very work we measure.
  await session.send('Profiler.setSamplingInterval', { interval: 1000 })
  await session.send('Profiler.start')
}

interface NetworkStat {
  count: number
  totalMs: number
}

const network = new WeakMap<Page, Map<string, NetworkStat>>()

/** Collapses ids and query strings so the same endpoint aggregates into one row. */
function endpointKey (url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname
      .replace(/\/[0-9a-f-]{16,}/gi, '/:id')
      .replace(/\/\d+/g, '/:n')
      .replace(/\.[a-z0-9]{2,5}$/i, '')
    return `${u.host}${path}`
  } catch {
    return url.slice(0, 80)
  }
}

function payloadKb (payload: string | Buffer): number {
  return (typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length) / 1024
}

function watchNetwork (page: Page): void {
  const stats = new Map<string, NetworkStat>()
  network.set(page, stats)

  const add = (key: string, ms: number): void => {
    const e = stats.get(key) ?? { count: 0, totalMs: 0 }
    e.count++
    e.totalMs += ms
    stats.set(key, e)
  }

  page.on('requestfinished', (request) => {
    const timing = request.timing()
    const ms = timing.responseEnd > 0 ? timing.responseEnd : 0
    add(`http ${request.method()} ${endpointKey(request.url())}`, ms)
  })

  page.on('websocket', (ws) => {
    // The transactor protocol is binary, so only volume is meaningful here - use the server-side
    // STATS report to see which operations that traffic actually is.
    ws.on('framesent', (frame) => {
      add('ws sent (totalMs holds KB)', payloadKb(frame.payload))
    })
    ws.on('framereceived', (frame) => {
      add('ws received (totalMs holds KB)', payloadKb(frame.payload))
    })
  })
}

// Playwright runs workers as separate processes, so a shared append target would interleave lines
// and produce invalid JSONL. Each process writes its own file; concatenate them when reading.
function reportFile (kind: string): string {
  return path.join(outDir, `${kind}.${process.pid}.jsonl`)
}

async function stopProfile (page: Page, name: string): Promise<void> {
  const session = sessions.get(page)
  if (session === undefined) return
  sessions.delete(page)

  const { profile } = await session.send('Profiler.stop')
  const { metrics } = await session.send('Performance.getMetrics')
  await session.detach().catch(() => {})

  await mkdir(outDir, { recursive: true })
  const file = path.join(outDir, `${slug(name)}.cpuprofile`)
  await writeFile(file, JSON.stringify(profile))

  const frame = readMetrics(metrics)
  await appendFile(reportFile('metrics'), JSON.stringify({ test: name, ...frame }) + '\n')

  const stats = network.get(page)
  if (stats !== undefined) {
    network.delete(page)
    const rows = [...stats.entries()]
      .map(([key, v]) => ({ key, count: v.count, totalMs: Math.round(v.totalMs) }))
      .sort((a, b) => b.count - a.count)
    await appendFile(reportFile('network'), JSON.stringify({ test: name, rows }) + '\n')
  }
}

/**
 * Records a CPU profile, renderer metrics and a per-endpoint network summary of the page for
 * every test in the current file. Call once at the top level of a describe block.
 * Does nothing unless BROWSER_PROFILE is set.
 */
export function profileBrowser (): void {
  if (!enabled) return

  test.beforeEach(async ({ page }) => {
    watchNetwork(page)
    await startProfile(page)
  })

  test.afterEach(async ({ page }, testInfo) => {
    await stopProfile(page, `${path.basename(testInfo.file)}-${testInfo.title}`)
  })
}

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

/* eslint-disable no-console */

//
// What a preview render costs in CPU and in RSS, and whether the sharp defaults are the right
// ones for a pod that already limits its own concurrency. Each config runs in a fresh process -
// see workload.ts for why. BENCH=1 to run.
//
// Run it on an idle machine. Anything else competing for cores - a local model, a docker stand -
// moves throughput by tens of percent between identical runs, which is more than the differences
// being measured. Peak RSS and large ratios (avif vs webp) survive that; 10-20% deltas do not.
//
// Env: BENCH_REPEATS, BENCH_ROUNDS, BENCH_PARALLEL (RateLimiter width), BENCH_FORMAT,
// BENCH_SHARP_CONCURRENCY, BENCH_SHARP_CACHE=off, BENCH_SOURCES_DIR (real uploads).
//

import { spawnSync } from 'child_process'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ensureFixtures, RESULT_PREFIX, type WorkloadMetrics } from './workload'

const describeBench: jest.Describe =
  process.env.BENCH === '1' || process.env.BENCH === 'true' ? describe : describe.skip

const POD_ROOT = join(__dirname, '..', '..', '..')
const WORKLOAD = join(__dirname, 'workload.ts')
const FIXTURES = join(tmpdir(), 'preview-bench-fixtures')

interface Config {
  label: string
  env: Record<string, string>
}

function run (cfg: Config): WorkloadMetrics {
  const res = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', WORKLOAD], {
    cwd: POD_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      TS_NODE_TRANSPILE_ONLY: 'true',
      BENCH_FIXTURES: FIXTURES,
      BENCH_LABEL: cfg.label,
      ...cfg.env
    }
  })

  if (res.status !== 0) {
    throw new Error(`${cfg.label} failed (${String(res.status)}):\n${res.stderr ?? ''}\n${res.stdout ?? ''}`)
  }

  const line = res.stdout.split('\n').find((l) => l.startsWith(RESULT_PREFIX))
  if (line === undefined) {
    throw new Error(`${cfg.label} produced no result:\n${res.stdout}\n${res.stderr}`)
  }
  return JSON.parse(line.slice(RESULT_PREFIX.length))
}

/**
 * Round-robin over the configs, not one config's runs back to back. Run in blocks, the first
 * config eats the cold start and produces a monotone ramp - 40 to 116 renders/s across five runs
 * of one config, once - which then reads as a difference between configs. Interleaved on an idle
 * machine the spread is 1-4%.
 */
function runInterleaved (configs: Config[], rounds: number): WorkloadMetrics[] {
  const runs = new Map<string, WorkloadMetrics[]>(configs.map((c) => [c.label, []]))
  for (let r = 0; r < rounds; r++) {
    for (const cfg of configs) {
      runs.get(cfg.label)?.push(run(cfg))
    }
  }

  return configs.map((cfg) => {
    const got = runs.get(cfg.label) ?? []
    const median = (pick: (m: WorkloadMetrics) => number): number => {
      const v = got.map(pick).sort((a, b) => a - b)
      return v[Math.floor(v.length / 2)]
    }
    const spread = got.map((m) => m.rendersPerSec).sort((a, b) => a - b)
    return {
      ...got[0],
      rendersPerSec: median((m) => m.rendersPerSec),
      spreadPct: (spread[spread.length - 1] / spread[0] - 1) * 100,
      p50Ms: median((m) => m.p50Ms),
      p95Ms: median((m) => m.p95Ms),
      peakRssMB: median((m) => m.peakRssMB),
      endRssMB: median((m) => m.endRssMB),
      metadataP50Ms: median((m) => m.metadataP50Ms)
    }
  })
}

function printTable (title: string, rows: WorkloadMetrics[]): void {
  const n = (v: number, w = 8, d = 1): string => v.toFixed(d).padStart(w)
  console.log(`\n${title}`)
  console.log(
    [
      'config'.padEnd(18),
      'conc',
      'cacheMB',
      'rend/s',
      'spread',
      'p50ms',
      'p95ms',
      'peakRSS',
      'endRSS',
      'meta p50'
    ].join(' | ')
  )
  for (const r of rows) {
    console.log(
      [
        r.label.padEnd(18),
        String(r.concurrency).padStart(4),
        n(r.cacheMemMB, 7, 0),
        n(r.rendersPerSec, 6, 2),
        n(r.spreadPct ?? 0, 5, 0) + '%',
        n(r.p50Ms, 5),
        n(r.p95Ms, 5),
        n(r.peakRssMB, 7),
        n(r.endRssMB, 6),
        n(r.metadataP50Ms, 8)
      ].join(' | ')
    )
  }
}

function printSizes (rows: WorkloadMetrics[]): void {
  console.log('\nper requested size (what one <img> costs the pod)')
  console.log(['format'.padEnd(6), 'size', '   n', ' p50ms', 'meanms', '   KB'].join(' | '))
  for (const r of rows) {
    for (const s of r.bySize) {
      console.log(
        [
          r.format.padEnd(6),
          String(s.size).padStart(4),
          String(s.n).padStart(4),
          s.p50Ms.toFixed(1).padStart(6),
          s.meanMs.toFixed(1).padStart(6),
          s.avgKB.toFixed(1).padStart(5)
        ].join(' | ')
      )
    }
  }
}

describeBench('preview sharp bench', () => {
  beforeAll(async () => {
    // Built once here so no child pays for it, and every config sees byte-identical input.
    await ensureFixtures(FIXTURES)
  }, 300_000)

  afterAll(() => {
    rmSync(FIXTURES, { force: true, recursive: true })
  })

  it('sharp settings: what concurrency and the libvips cache cost', () => {
    const configs: Config[] = [
      { label: 'prod-default', env: {} },
      { label: 'conc=4', env: { BENCH_SHARP_CONCURRENCY: '4' } },
      { label: 'conc=1', env: { BENCH_SHARP_CONCURRENCY: '1' } },
      { label: 'conc=1 nocache', env: { BENCH_SHARP_CONCURRENCY: '1', BENCH_SHARP_CACHE: 'off' } },
      { label: 'nocache', env: { BENCH_SHARP_CACHE: 'off' } }
    ]

    const rounds = parseInt(process.env.BENCH_REPEATS ?? '5')
    const rows = runInterleaved(configs, rounds)
    printTable(`sharp settings (webp, 60 renders, RateLimiter(10) as in service.ts, median of ${rounds})`, rows)

    const base = rows[0]
    for (const r of rows.slice(1)) {
      const rss = ((r.peakRssMB / base.peakRssMB - 1) * 100).toFixed(0)
      const thr = ((r.rendersPerSec / base.rendersPerSec - 1) * 100).toFixed(0)
      console.log(`${r.label.padEnd(18)} vs prod-default: peak RSS ${rss}%, throughput ${thr}%`)
    }

    expect(rows.every((r) => r.renders === base.renders)).toBe(true)
  }, 900_000)

  it('output format: what the encoder costs per thumbnail', () => {
    const formats = ['webp', 'avif', 'jpeg', 'png']
    const rounds = parseInt(process.env.BENCH_REPEATS ?? '5')
    const rows = runInterleaved(
      formats.map((f) => ({ label: f, env: { BENCH_FORMAT: f, BENCH_ROUNDS: '2' } })),
      rounds
    )
    printTable(`encoders (prod sharp settings, median of ${rounds})`, rows)

    printSizes(rows)

    expect(rows.length).toBe(formats.length)
  }, 900_000)
})

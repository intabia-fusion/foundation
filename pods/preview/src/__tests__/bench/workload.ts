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
// The measured half of the preview bench. Runs in its own process because sharp.concurrency and
// sharp.cache are process-global and libvips never gives thread stacks back - comparing two
// settings inside one process measures the first setting twice.
//

import { MeasureMetricsContext, RateLimiter } from '@hcengineering/core'
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { performance } from 'perf_hooks'
import sharp from 'sharp'

import { getImageMetadata } from '../../metadata'
import { transformImage } from '../../utils/sharp'

export interface SourceSpec {
  name: string
  width: number
  height: number
  encode: 'jpeg' | 'png'
  seed: number
}

/** What users actually upload: a camera photo, a screenshot, an avatar. */
export const SOURCES: SourceSpec[] = [
  { name: 'photo-4000x3000.jpg', width: 4000, height: 3000, encode: 'jpeg', seed: 1 },
  { name: 'screenshot-2560x1440.png', width: 2560, height: 1440, encode: 'png', seed: 2 },
  { name: 'avatar-512.png', width: 512, height: 512, encode: 'png', seed: 3 }
]

/**
 * The sizes one <img> actually asks for: the 64x64 placeholder from FilePreview, then the
 * srcset triple - width 300 at dpr 1/2/3, which the server turns into 300/600/900.
 */
export const SIZES = [64, 300, 600, 900]

export interface SizeMetrics {
  size: number
  n: number
  p50Ms: number
  meanMs: number
  avgKB: number
}

export interface WorkloadMetrics {
  label: string
  concurrency: number
  cacheMemMB: number
  format: string
  renders: number
  renderMs: number
  rendersPerSec: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  metadataCalls: number
  metadataMs: number
  metadataP50Ms: number
  peakRssMB: number
  endRssMB: number
  externalMB: number
  heapMB: number
  cacheHighMB: number
  bytesOut: number
  bySize: SizeMetrics[]
  /** Filled in by the caller when a config is run more than once. */
  spreadPct?: number
}

function mulberry32 (seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Photo-like content: smooth blobs from 8x-upscaled noise, plus fine grain on top. Flat colour
 * flatters every encoder and raw noise punishes them all - both would make the format comparison
 * meaningless, since what separates webp from avif is exactly how they handle fine detail.
 */
export async function makeSource (spec: SourceSpec, path: string): Promise<void> {
  const rnd = mulberry32(spec.seed)

  const w = Math.max(8, Math.round(spec.width / 8))
  const h = Math.max(8, Math.round(spec.height / 8))
  const low = Buffer.allocUnsafe(w * h * 3)
  for (let i = 0; i < low.length; i++) {
    low[i] = (rnd() * 256) | 0
  }

  const base = await sharp(low, { raw: { width: w, height: h, channels: 3 } })
    .resize(spec.width, spec.height, { kernel: 'cubic' })
    .raw()
    .toBuffer()

  // Grain, +-20 levels. Enough detail that an encoder has to work for its bitrate.
  for (let i = 0; i < base.length; i++) {
    const v = base[i] + (rnd() - 0.5) * 40
    base[i] = v < 0 ? 0 : v > 255 ? 255 : v
  }

  const pipeline = sharp(base, { raw: { width: spec.width, height: spec.height, channels: 3 } })
  await (spec.encode === 'jpeg' ? pipeline.jpeg({ quality: 85 }) : pipeline.png()).toFile(path)
}

/** BENCH_SOURCES_DIR points the bench at real uploads instead of the generated ones. */
export async function ensureFixtures (dir: string): Promise<string[]> {
  const real = process.env.BENCH_SOURCES_DIR
  if (real !== undefined && real !== '') {
    return readdirSync(real)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .map((f) => join(real, f))
  }

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const paths: string[] = []
  for (const spec of SOURCES) {
    const path = join(dir, spec.name)
    if (!existsSync(path)) {
      await makeSource(spec, path)
    }
    paths.push(path)
  }
  return paths
}

function pct (sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

export interface WorkloadOptions {
  label: string
  fixtures: string
  outDir: string
  format: 'webp' | 'avif' | 'jpeg' | 'png'
  rounds: number
  parallel: number
}

export async function runWorkload (opts: WorkloadOptions): Promise<WorkloadMetrics> {
  const ctx = new MeasureMetricsContext('bench', {})
  const sources = await ensureFixtures(opts.fixtures)

  if (!existsSync(opts.outDir)) {
    mkdirSync(opts.outDir, { recursive: true })
  }

  const plan: Array<{ src: string, size: number }> = []
  for (let r = 0; r < opts.rounds; r++) {
    for (const src of sources) {
      for (const size of SIZES) {
        plan.push({ src, size })
      }
    }
  }

  // Warm the page cache and the JIT, and let libvips spin up its pool, before anything is recorded.
  for (const src of sources) {
    await transformImage(src, join(opts.outDir, 'warmup'), {
      format: opts.format,
      width: 300,
      height: 300,
      fit: 'cover'
    })
  }

  let peakRss = process.memoryUsage.rss()
  const sampler = setInterval(() => {
    const v = process.memoryUsage.rss()
    if (v > peakRss) peakRss = v
  }, 25)

  const limiter = new RateLimiter(opts.parallel)
  const samples: number[] = []
  const perSize = new Map<number, { ms: number[], bytes: number }>()
  for (const size of SIZES) {
    perSize.set(size, { ms: [], bytes: 0 })
  }
  let bytesOut = 0

  const renderStart = performance.now()
  await Promise.all(
    plan.map(async (item, i) => {
      await limiter.exec(async () => {
        const dst = join(opts.outDir, `t${i}`)
        const t0 = performance.now()
        const { size } = await transformImage(item.src, dst, {
          format: opts.format,
          width: item.size,
          height: item.size,
          fit: 'cover'
        })
        const dt = performance.now() - t0
        samples.push(dt)
        const bucket = perSize.get(item.size)
        if (bucket !== undefined) {
          bucket.ms.push(dt)
          bucket.bytes += size
        }
        bytesOut += size
        await rm(dst, { force: true })
      })
    })
  )
  const renderMs = performance.now() - renderStart

  // The /metadata route: a full decode of the original just to produce a 32x32 blurhash.
  const metaSamples: number[] = []
  const metaStart = performance.now()
  for (let r = 0; r < opts.rounds; r++) {
    for (const src of sources) {
      const t0 = performance.now()
      await getImageMetadata(ctx, src)
      metaSamples.push(performance.now() - t0)
    }
  }
  const metadataMs = performance.now() - metaStart

  clearInterval(sampler)

  const mem = process.memoryUsage()
  const cache = sharp.cache()
  samples.sort((a, b) => a - b)
  metaSamples.sort((a, b) => a - b)

  return {
    label: opts.label,
    concurrency: sharp.concurrency(),
    cacheMemMB: cache.memory.max,
    format: opts.format,
    renders: samples.length,
    renderMs,
    rendersPerSec: (samples.length / renderMs) * 1000,
    p50Ms: pct(samples, 0.5),
    p95Ms: pct(samples, 0.95),
    maxMs: samples[samples.length - 1] ?? 0,
    metadataCalls: metaSamples.length,
    metadataMs,
    metadataP50Ms: pct(metaSamples, 0.5),
    peakRssMB: peakRss / 1048576,
    endRssMB: mem.rss / 1048576,
    externalMB: mem.external / 1048576,
    heapMB: mem.heapUsed / 1048576,
    cacheHighMB: cache.memory.high,
    bytesOut,
    bySize: SIZES.map((size) => {
      const b = perSize.get(size) ?? { ms: [], bytes: 0 }
      const ms = [...b.ms].sort((a, c) => a - c)
      return {
        size,
        n: ms.length,
        p50Ms: pct(ms, 0.5),
        meanMs: ms.reduce((s, v) => s + v, 0) / Math.max(1, ms.length),
        avgKB: b.bytes / Math.max(1, ms.length) / 1024
      }
    })
  }
}

export const RESULT_PREFIX = '##BENCH##'

async function main (): Promise<void> {
  const conc = process.env.BENCH_SHARP_CONCURRENCY
  if (conc !== undefined && conc !== '') {
    sharp.concurrency(parseInt(conc))
  }
  if (process.env.BENCH_SHARP_CACHE === 'off') {
    sharp.cache(false)
  }

  const outDir = join(tmpdir(), `preview-bench-${process.pid}`)
  try {
    const metrics = await runWorkload({
      label: process.env.BENCH_LABEL ?? 'default',
      fixtures: process.env.BENCH_FIXTURES ?? join(tmpdir(), 'preview-bench-fixtures'),
      outDir,
      format: (process.env.BENCH_FORMAT as WorkloadOptions['format']) ?? 'webp',
      rounds: parseInt(process.env.BENCH_ROUNDS ?? '5'),
      parallel: parseInt(process.env.BENCH_PARALLEL ?? '10')
    })
    console.log(RESULT_PREFIX + JSON.stringify(metrics))
  } finally {
    await rm(outDir, { force: true, recursive: true })
  }
}

if (require.main === module) {
  void main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

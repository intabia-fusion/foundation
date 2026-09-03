//
// Copyright © 2025 Andrey Sobolev (haiodo@gmail.com)
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

/**
 * Offline chunking: run an audio file through the same VAD pipeline the agent
 * uses on a live meeting, and write the resulting chunks to disk.
 *
 *   rushx split-audio <input> [--out <dir>] [--frame-ms 10] [--keep-ogg]
 *
 * The point is to measure the chunker against a reference transcript without a
 * LiveKit room: STT.streamToFiles() is fed a synthetic AudioStream and
 * STT.chunkSink diverts finalized chunks away from the platform.
 */

import ffmpegPath from '@ffmpeg-installer/ffmpeg'
import type { Room } from '@livekit/rtc-node'
import { spawn } from 'child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'

import { STT } from '../stream/stt.js'
import type { ChunkMetadata } from '../stream/types.js'

const SAMPLE_RATE = 16000

interface Args {
  input: string
  outDir: string
  frameMs: number
  keepOgg: boolean
}

function usage (message: string): never {
  console.error(`${message}\nusage: rushx split-audio <input> [--out <dir>] [--frame-ms 10] [--keep-ogg]`)
  process.exit(1)
}

function parseArgs (argv: string[]): Args {
  const positional: string[] = []
  const opts = new Map<string, string>()

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      if (key === 'keep-ogg') {
        opts.set(key, 'true')
      } else {
        const value = argv[++i]
        if (value === undefined) {
          usage(`--${key} requires a value`)
        }
        opts.set(key, value)
      }
    } else {
      positional.push(arg)
    }
  }

  const input = positional[0]
  if (input === undefined) {
    usage('input file is required')
  }

  return {
    input,
    outDir: opts.get('out') ?? join('dumps', 'split', basename(input).replace(/\.[^.]+$/, '')),
    frameMs: Number(opts.get('frame-ms') ?? 10),
    keepOgg: opts.get('keep-ogg') === 'true'
  }
}

/** Decode anything ffmpeg understands into 16 kHz mono PCM16. */
async function decodePcm (path: string): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath.path, [
      '-nostdin',
      '-v',
      'error',
      '-i',
      path,
      '-f',
      's16le',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-'
    ])
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    proc.stdout.on('data', (d: Buffer) => chunks.push(d))
    proc.stderr.on('data', (d: Buffer) => errors.push(d))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks))
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errors).toString().slice(0, 300)}`))
      }
    })
  })
}

/**
 * Minimal stand-in for LiveKit's AudioStream: streamToFiles only reads
 * `frame.samplesPerChannel` and `frame.data.buffer`.
 */
async function * framesOf (
  pcm: Buffer,
  frameMs: number
): AsyncGenerator<{ data: Int16Array, samplesPerChannel: number }> {
  const samplesPerFrame = Math.round((SAMPLE_RATE * frameMs) / 1000)
  const bytesPerFrame = samplesPerFrame * 2

  for (let offset = 0; offset + bytesPerFrame <= pcm.length; offset += bytesPerFrame) {
    // Copy: streamToFiles keeps a reference to the underlying buffer.
    const data = new Int16Array(samplesPerFrame)
    Buffer.from(data.buffer).set(pcm.subarray(offset, offset + bytesPerFrame))
    yield { data, samplesPerChannel: samplesPerFrame }
  }
}

async function main (): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const pcm = await decodePcm(args.input)
  const durationSec = pcm.length / 2 / SAMPLE_RATE
  console.info(`input ${args.input}: ${durationSec.toFixed(1)}s, frame ${args.frameMs}ms`)

  // Drop only what a previous run of this tool wrote - --out may point anywhere.
  mkdirSync(args.outDir, { recursive: true })
  for (const name of readdirSync(args.outDir)) {
    if (name === 'manifest.json' || /^chunk-\d+\.(wav|ogg)$/.test(name)) {
      rmSync(join(args.outDir, name))
    }
  }

  const stt = new STT({ name: 'split-audio' } as unknown as Room, 'offline', 'offline-token')
  const chunks: Array<ChunkMetadata & { file: string }> = []

  stt.chunkSink = async (wav, ogg, metadata) => {
    const index = chunks.length
    const name = `chunk-${String(index).padStart(4, '0')}`
    writeFileSync(join(args.outDir, `${name}.wav`), wav)
    if (args.keepOgg) {
      writeFileSync(join(args.outDir, `${name}.ogg`), ogg)
    }
    chunks.push({ ...metadata, file: `${name}.wav` })
  }

  stt.start()
  await stt.streamToFiles('offline-sid', framesOf(pcm, args.frameMs) as any)
  await stt.close()

  chunks.sort((a, b) => a.startTimeSec - b.startTimeSec)
  writeFileSync(
    join(args.outDir, 'manifest.json'),
    JSON.stringify({ input: args.input, durationSec, frameMs: args.frameMs, chunks }, null, 2)
  )

  const covered = chunks.reduce((sum, c) => sum + c.durationSec, 0)
  const byReason = chunks.reduce<Record<string, number>>((acc, c) => {
    acc[c.endReason] = (acc[c.endReason] ?? 0) + 1
    return acc
  }, {})
  const durations = chunks.map((c) => c.durationSec).sort((a, b) => a - b)
  const median = durations.length > 0 ? durations[Math.floor(durations.length / 2)] : 0

  console.info(
    `${chunks.length} chunks -> ${args.outDir}\n` +
      `  covered ${covered.toFixed(1)}s of ${durationSec.toFixed(1)}s (${((covered / durationSec) * 100).toFixed(0)}%)\n` +
      `  median ${median.toFixed(1)}s, max ${(durations[durations.length - 1] ?? 0).toFixed(1)}s\n` +
      `  end reasons: ${JSON.stringify(byReason)}`
  )
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})

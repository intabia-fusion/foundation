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

/**
 * The pre-buffer must land in the chunk: VAD only fires once a phrase is already
 * loud enough, so the audio kept before that point is the head of the phrase.
 */

import type { AudioStream, Room } from '@livekit/rtc-node'
import { rmSync } from 'fs'
import { join } from 'path'

import { STT } from '../stream/stt.js'
import { PRE_BUFFER_MS, SPEECH_START_THRESHOLD_MS, type ChunkMetadata } from '../stream/types.js'

jest.mock('@livekit/rtc-node', () => ({
  AudioStream: jest.fn(),
  RemoteParticipant: jest.fn(),
  RemoteTrack: jest.fn(),
  RemoteTrackPublication: jest.fn(),
  Room: jest.fn()
}))

jest.mock('../config.js', () => ({
  default: {
    PlatformUrl: 'http://localhost:3000',
    LiveKitApiUrl: 'ws://localhost:7880',
    Debug: false,
    RecordFullAudio: false
  }
}))

const SAMPLE_RATE = 16000
const FRAME_SAMPLES = 160 // 10 ms, same as LiveKit
const WORKSPACE = 'stt-prebuffer-test'
const LEAD_MS = 2000
const SPEECH_MS = 1200

/** Room tone, then a 500 Hz tone loud enough for isFrameSpeech. */
function buildSignal (): Int16Array {
  const total = ((LEAD_MS + SPEECH_MS) / 1000) * SAMPLE_RATE
  const pcm = new Int16Array(total)
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE
    const value = t < LEAD_MS / 1000 ? 0.0005 * (Math.random() * 2 - 1) : 0.3 * Math.sin(2 * Math.PI * 500 * t)
    pcm[i] = Math.round(value * 32767)
  }
  return pcm
}

async function * framesOf (pcm: Int16Array): AsyncGenerator<{ data: Int16Array, samplesPerChannel: number }> {
  for (let offset = 0; offset + FRAME_SAMPLES <= pcm.length; offset += FRAME_SAMPLES) {
    yield { data: pcm.slice(offset, offset + FRAME_SAMPLES), samplesPerChannel: FRAME_SAMPLES }
  }
}

describe('STT pre-buffer', () => {
  afterAll(() => {
    rmSync(join('dumps', WORKSPACE), { recursive: true, force: true })
  })

  it('writes the whole pre-buffer into the chunk, not just the last 100 ms', async () => {
    const stt = new STT({ name: 'prebuffer' } as unknown as Room, WORKSPACE, 'test-token')
    const chunks: Array<{ wav: Buffer, metadata: ChunkMetadata }> = []
    stt.chunkSink = async (wav, _ogg, metadata) => {
      chunks.push({ wav, metadata })
    }

    stt.start()
    await stt.streamToFiles('sid-1', framesOf(buildSignal()) as unknown as AudioStream)
    await stt.close()

    expect(chunks).toHaveLength(1)

    const wavMs = ((chunks[0].wav.length - 44) / 2 / SAMPLE_RATE) * 1000
    const leadInMs = wavMs - SPEECH_MS

    // Буфер зажат PRE_BUFFER_MS, из него SPEECH_START_THRESHOLD_MS - уже речь.
    const expected = PRE_BUFFER_MS - SPEECH_START_THRESHOLD_MS
    expect(leadInMs).toBeGreaterThanOrEqual(expected - 50)
    expect(leadInMs).toBeLessThanOrEqual(expected + 50)
  }, 60000)
})

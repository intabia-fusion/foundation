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

/** Result of a finished voice recording. */
export interface VoiceRecording {
  blob: Blob
  type: string
  durationSec: number
}

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']

function pickMime (): string {
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

/** Audio-only recorder for chat voice-notes: getUserMedia(audio) -> one Blob, with live amplitude for the HUD waveform. */
export class VoiceRecorder {
  private stream?: MediaStream
  private recorder?: MediaRecorder
  private audioCtx?: AudioContext
  private analyser?: AnalyserNode
  private readonly chunks: Blob[] = []
  private startMs = 0
  private mime = ''

  async start (): Promise<void> {
    // Browser-side cleanup (WebRTC AEC3/NS) - asked for explicitly, not left to UA defaults.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true }
    })
    this.mime = pickMime()
    this.recorder = new MediaRecorder(this.stream, this.mime !== '' ? { mimeType: this.mime } : undefined)
    this.chunks.length = 0
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }

    this.audioCtx = new AudioContext()
    this.analyser = this.audioCtx.createAnalyser()
    this.analyser.fftSize = 256
    this.audioCtx.createMediaStreamSource(this.stream).connect(this.analyser)

    this.startMs = performance.now()
    this.recorder.start(1000)
  }

  /** Current input level 0..1 (RMS), for the waveform. Zero when not recording. */
  getLevel (): number {
    if (this.analyser === undefined) return 0
    const buf = new Uint8Array(this.analyser.frequencyBinCount)
    this.analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (const v of buf) {
      const x = (v - 128) / 128
      sum += x * x
    }
    return Math.min(1, Math.sqrt(sum / buf.length) * 3)
  }

  /** Stop recording and return the final blob (webm/opus - the ASR side decodes it). */
  async stop (): Promise<VoiceRecording> {
    const rec = this.recorder
    if (rec === undefined) throw new Error('not recording')
    const durationSec = (performance.now() - this.startMs) / 1000
    const type = this.mime !== '' ? this.mime.split(';')[0] : 'audio/webm'
    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => {
        resolve(new Blob(this.chunks, { type }))
      }
      rec.stop()
    })
    this.release()
    return { blob, type, durationSec }
  }

  /** Discard the recording without producing a blob. */
  cancel (): void {
    try {
      this.recorder?.stop()
    } catch {}
    this.release()
  }

  private release (): void {
    this.stream?.getTracks().forEach((t) => {
      t.stop()
    })
    void this.audioCtx?.close()
    this.stream = undefined
    this.recorder = undefined
    this.audioCtx = undefined
    this.analyser = undefined
  }
}

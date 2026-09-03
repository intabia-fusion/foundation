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

import { AUDIO_FORMAT_INFO, type AudioFormat } from '../transcription/types'

// The MIME the browser records with, as OnAudioTranscribe reads it off the attachment.
const fromMime = (type: string): AudioFormat => (['ogg', 'mp4', 'wav'] as const).find((f) => type.includes(f)) ?? 'webm'

describe('audio format', () => {
  it('maps a recorded MIME to the format the trigger queues', () => {
    expect(fromMime('audio/webm;codecs=opus')).toBe('webm')
    expect(fromMime('audio/ogg;codecs=opus')).toBe('ogg')
    expect(fromMime('audio/mp4')).toBe('mp4')
    expect(fromMime('audio/wav')).toBe('wav')
  })

  it('names every format after itself, so nothing travels as ogg', () => {
    expect(AUDIO_FORMAT_INFO.webm).toEqual({ extension: 'webm', contentType: 'audio/webm' })
    expect(AUDIO_FORMAT_INFO.mp4).toEqual({ extension: 'mp4', contentType: 'audio/mp4' })
    expect(AUDIO_FORMAT_INFO.ogg).toEqual({ extension: 'ogg', contentType: 'audio/ogg' })
    expect(AUDIO_FORMAT_INFO.wav).toEqual({ extension: 'wav', contentType: 'audio/wav' })
  })

  it('carries the browser container end to end', () => {
    for (const [mime, ext] of [
      ['audio/webm;codecs=opus', 'webm'],
      ['audio/mp4', 'mp4']
    ]) {
      expect(AUDIO_FORMAT_INFO[fromMime(mime)].extension).toBe(ext)
    }
  })
})

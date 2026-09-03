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

// controller.ts pulls in config.ts, which throws without these.
process.env.ACCOUNTS_URL = 'http://account:3000'
process.env.SERVER_SECRET = 'secret'
process.env.FIRST_NAME = 'Julia'
process.env.LAST_NAME = 'AI'
process.env.STORAGE_CONFIG = 'minio'
process.env.CHUNK_STORAGE_CONFIG = 'minio'
/* eslint-disable @typescript-eslint/no-var-requires */
const { shouldAutoSummarize } = require('../controller') as typeof import('../controller')
/* eslint-enable @typescript-eslint/no-var-requires */

const transcribed: any = { summary: null, transcription: 12 }

describe('shouldAutoSummarize', () => {
  it('summarizes by default: no settings document at all', () => {
    expect(shouldAutoSummarize(transcribed)).toBe(true)
  })

  it('summarizes when settings exist but the flag was never touched', () => {
    expect(shouldAutoSummarize(transcribed, undefined, { meetingSummary: undefined })).toBe(true)
  })

  it('skips a meeting with no transcript: nothing to summarize', () => {
    expect(shouldAutoSummarize({ summary: null, transcription: 0 } as any)).toBe(false)
    expect(shouldAutoSummarize({ summary: null } as any)).toBe(false)
  })

  it('skips a meeting that already has a summary (redelivered finished event)', () => {
    expect(shouldAutoSummarize({ summary: 'blob-1', transcription: 12 } as any)).toBe(false)
  })

  it('honours the workspace-wide off switch', () => {
    expect(shouldAutoSummarize(transcribed, undefined, { meetingSummary: false })).toBe(false)
  })

  it('space setting wins over the workspace default, both ways', () => {
    expect(shouldAutoSummarize(transcribed, { meetingSummary: false }, { meetingSummary: true })).toBe(false)
    expect(shouldAutoSummarize(transcribed, { meetingSummary: true }, { meetingSummary: false })).toBe(true)
  })
})

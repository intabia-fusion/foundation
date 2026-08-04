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

import { donePatch, failedPatch, queuedRequest } from '../workspace/aiRequest'

describe('queuedRequest', () => {
  it('seeds a queued request with zero tokens', () => {
    expect(queuedRequest('high', 'gpt-4o', 'chat')).toEqual({
      status: 'queued',
      level: 'high',
      modelId: 'gpt-4o',
      kind: 'chat',
      promptTokens: 0,
      completionTokens: 0,
      billedTokens: 0
    })
  })
})

describe('donePatch', () => {
  it('records token split and billed tokens with the multiplier', () => {
    expect(donePatch({ promptTokens: 100, completionTokens: 50 }, 0.1)).toEqual({
      status: 'done',
      promptTokens: 100,
      completionTokens: 50,
      billedTokens: 15
    })
  })

  it('handles missing usage as zero', () => {
    expect(donePatch(undefined, 1)).toEqual({
      status: 'done',
      promptTokens: 0,
      completionTokens: 0,
      billedTokens: 0
    })
  })
})

describe('failedPatch', () => {
  it('sets failed status with the error', () => {
    expect(failedPatch('boom')).toEqual({ status: 'failed', error: 'boom' })
  })
})

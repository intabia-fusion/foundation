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

import { totalTokens, usageFromApi } from '../llms/types'

describe('usageFromApi', () => {
  it('maps prompt/completion tokens from API usage', () => {
    expect(usageFromApi({ prompt_tokens: 12, completion_tokens: 8 })).toEqual({
      promptTokens: 12,
      completionTokens: 8
    })
  })

  it('defaults missing fields to 0', () => {
    expect(usageFromApi({ prompt_tokens: 5 })).toEqual({ promptTokens: 5, completionTokens: 0 })
    expect(usageFromApi({ completion_tokens: 7 })).toEqual({ promptTokens: 0, completionTokens: 7 })
    expect(usageFromApi({})).toEqual({ promptTokens: 0, completionTokens: 0 })
  })

  it('returns undefined when no usage present', () => {
    expect(usageFromApi(undefined)).toBeUndefined()
  })

  it('ignores extra provider fields (total_tokens etc.)', () => {
    expect(usageFromApi({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } as any)).toEqual({
      promptTokens: 3,
      completionTokens: 4
    })
  })
})

describe('totalTokens', () => {
  it('sums prompt and completion tokens', () => {
    expect(totalTokens({ promptTokens: 12, completionTokens: 8 })).toBe(20)
  })

  it('returns 0 for undefined usage', () => {
    expect(totalTokens(undefined)).toBe(0)
  })

  it('returns 0 for empty usage', () => {
    expect(totalTokens({ promptTokens: 0, completionTokens: 0 })).toBe(0)
  })

  it('round-trips API usage to a total', () => {
    expect(totalTokens(usageFromApi({ prompt_tokens: 100, completion_tokens: 50 }))).toBe(150)
  })
})

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

import { resolveMemory } from '../workspace/memory'

describe('resolveMemory', () => {
  it('uses the Preference when present and does not migrate', () => {
    const { memory, migrate } = resolveMemory(
      { personalContext: 'likes tea' },
      { assistantMemory: 'old', userMemory: 'old' },
      'Alice'
    )
    expect(migrate).toBe(false)
    expect(memory).toEqual({ sharedPrompt: '', personalContext: 'likes tea' })
  })

  it('fills missing Preference fields with empty strings', () => {
    const { memory } = resolveMemory({ personalContext: 'x' }, undefined, undefined)
    expect(memory).toEqual({ sharedPrompt: '', personalContext: 'x' })
  })

  it('migrates from blob memory when no Preference exists', () => {
    const { memory, migrate } = resolveMemory(undefined, { assistantMemory: 'a', userMemory: 'u' }, 'Alice')
    expect(migrate).toBe(true)
    expect(memory).toEqual({ sharedPrompt: '', personalContext: 'u' })
  })

  it('seeds empty memory with the employee name when nothing exists', () => {
    const { memory, migrate } = resolveMemory(undefined, undefined, 'Alice')
    expect(migrate).toBe(false)
    expect(memory).toEqual({ sharedPrompt: '', personalContext: 'User name: Alice' })
  })

  it('leaves personalContext empty when there is no employee name', () => {
    const { memory } = resolveMemory(undefined, undefined, undefined)
    expect(memory).toEqual({ sharedPrompt: '', personalContext: '' })
    const { memory: m2 } = resolveMemory(undefined, undefined, '')
    expect(m2.personalContext).toBe('')
  })
})

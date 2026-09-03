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
    const { personalContext, migrate } = resolveMemory(
      { personalContext: 'likes tea' },
      { assistantMemory: 'old', userMemory: 'old' },
      'Alice'
    )
    expect(migrate).toBe(false)
    expect(personalContext).toBe('likes tea')
  })

  it('fills missing Preference fields with empty strings', () => {
    const { personalContext } = resolveMemory({ personalContext: 'x' }, undefined, undefined)
    expect(personalContext).toBe('x')
  })

  it('migrates from blob memory when no Preference exists', () => {
    const { personalContext, migrate } = resolveMemory(undefined, { assistantMemory: 'a', userMemory: 'u' }, 'Alice')
    expect(migrate).toBe(true)
    expect(personalContext).toBe('u')
  })

  it('seeds empty memory with the employee name when nothing exists', () => {
    const { personalContext, migrate } = resolveMemory(undefined, undefined, 'Alice')
    expect(migrate).toBe(false)
    expect(personalContext).toBe('User name: Alice')
  })

  it('leaves personalContext empty when there is no employee name', () => {
    const { personalContext } = resolveMemory(undefined, undefined, undefined)
    expect(personalContext).toBe('')
    const { personalContext: p2 } = resolveMemory(undefined, undefined, '')
    expect(p2).toBe('')
  })
})

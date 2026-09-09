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

import { describe, expect, it } from 'vitest'
import { ROOT_SIZE, installFakeLayout } from './fakeLayout'

describe('fake layout', () => {
  it('restores the native getBoundingClientRect', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- identity check, never called
    const native = Element.prototype.getBoundingClientRect
    const root = document.createElement('div')
    document.body.appendChild(root)

    const restore = installFakeLayout(root)
    // eslint-disable-next-line @typescript-eslint/unbound-method -- identity check, never called
    expect(Element.prototype.getBoundingClientRect).not.toBe(native)
    restore()

    // eslint-disable-next-line @typescript-eslint/unbound-method -- identity check, never called
    expect(Element.prototype.getBoundingClientRect).toBe(native)
  })

  it('refuses a second install so the fake never becomes the restore target', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const restore = installFakeLayout(root)
    try {
      expect(() => installFakeLayout(root)).toThrow()
    } finally {
      restore()
    }
  })

  it('hands the leftover space to the unsized children', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const fixed = document.createElement('div')
    fixed.style.width = '200px'
    const auto1 = document.createElement('div')
    const auto2 = document.createElement('div')
    root.append(fixed, auto1, auto2)

    const restore = installFakeLayout(root)
    try {
      expect(fixed.getBoundingClientRect().width).toBe(200)
      expect(auto1.getBoundingClientRect().width).toBe((ROOT_SIZE - 200) / 2)
      expect(auto2.getBoundingClientRect().left).toBe(200 + (ROOT_SIZE - 200) / 2)
    } finally {
      restore()
    }
  })
})

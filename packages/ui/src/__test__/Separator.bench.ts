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

import { bench, describe } from 'vitest'
import Separator from '../components/Separator.svelte'
import { deviceOptionsStore } from '../index'
import { defineSeparators } from '../resize'
import type { SeparatedItem } from '../types'
import { installFakeLayout } from './fakeLayout'

const FS = 16
const navigator: SeparatedItem = { minSize: 10, size: 15, maxSize: 25, float: 'navigator' }
const auto: SeparatedItem = { size: 'auto', minSize: 20, maxSize: 'auto' }

const pointer = (type: string, clientX: number): PointerEvent =>
  new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 10, pointerId: 1 })

let restoreLayout: (() => void) | undefined

async function mounted (name: string): Promise<HTMLElement> {
  restoreLayout?.()
  document.body.innerHTML = ''
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  restoreLayout = installFakeLayout(parent)
  deviceOptionsStore.update((d) => ({ ...d, fontSize: FS }))

  const left = document.createElement('div')
  left.setAttribute('data-float', 'navigator')
  parent.appendChild(left)
  const right = document.createElement('div')
  parent.appendChild(right)

  defineSeparators(name, [navigator, auto])
  // eslint-disable-next-line no-new
  new Separator({ target: parent, anchor: right, props: { name, index: 0, color: 'transparent' } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  return parent.querySelector('.antiSeparator') as HTMLElement
}

describe('Separator drag', () => {
  let separator: HTMLElement

  bench(
    '60 pointermove events',
    () => {
      separator.dispatchEvent(pointer('pointerdown', 15 * FS))
      for (let i = 0; i < 60; i++) {
        document.dispatchEvent(pointer('pointermove', 15 * FS + (i % 30)))
      }
      document.dispatchEvent(pointer('pointerup', 15 * FS))
    },
    {
      setup: async () => {
        separator = await mounted('bench-drag')
      }
    }
  )
})

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
import { buildLayout, distribute, toSeparators, type LayoutChild } from '../separatorLayout'
import type { SeparatedItem } from '../types'

const FS = 16
const remToPx = (rem: number): number => rem * FS
const pxToRem = (px: number): number => px / FS

function scenario (panels: number): { children: LayoutChild[], separators: SeparatedItem[] } {
  const separators: SeparatedItem[] = []
  const children: LayoutChild[] = []
  for (let i = 0; i < panels; i++) {
    separators.push(
      i % 3 === 1 ? { size: 'auto', minSize: 10, maxSize: 'auto' } : { minSize: 10, size: 20, maxSize: 40 }
    )
    if (i > 0) children.push({ isSeparator: true, sized: false, size: 1 })
    children.push({ isSeparator: false, sized: true, size: 320 })
  }
  return { children, separators }
}

for (const panels of [3, 10, 50]) {
  describe(`${panels} panels`, () => {
    const { children, separators } = scenario(panels)

    bench('buildLayout', () => {
      buildLayout(children, separators, 0, remToPx)
    })

    bench('distribute', () => {
      const layout = buildLayout(children, separators, 0, remToPx)
      distribute(layout.boxes, layout.realIndex, 37)
    })

    bench('full drag step', () => {
      // What one pointermove costs: rebuild nothing, move pixels, persist the result.
      const layout = buildLayout(children, separators, 0, remToPx)
      distribute(layout.boxes, layout.realIndex, 37)
      toSeparators(
        layout.boxes.filter((b) => b.id !== -1),
        separators,
        layout.excludedIndexes,
        pxToRem
      )
    })
  })
}

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
import { buildLayout, distribute, toSeparators, type LayoutChild } from '../separatorLayout'
import type { SeparatedItem } from '../types'

const FS = 16
const remToPx = (rem: number): number => rem * FS
const pxToRem = (px: number): number => px / FS

const navigator: SeparatedItem = { minSize: 18, size: 18, maxSize: 22.5, float: 'navigator' }
const auto: SeparatedItem = { size: 'auto', minSize: 20, maxSize: 'auto' }
const calendar: SeparatedItem = { minSize: 25, size: 41.25, maxSize: 90 }

const panel = (size: number, float?: string): LayoutChild => ({ isSeparator: false, sized: true, float, size })
const foreign = (size: number): LayoutChild => ({ isSeparator: false, sized: false, size })
const sep = (): LayoutChild => ({ isSeparator: true, sized: false, size: 1 })

describe('buildLayout', () => {
  it('maps every configured panel to a box', () => {
    const layout = buildLayout(
      [panel(288, 'navigator'), sep(), panel(500), sep(), panel(660)],
      [navigator, auto, calendar],
      0,
      remToPx
    )
    expect(layout.boxes.map((b) => b.id)).toEqual([0, 1, 2])
    expect(layout.boxes.map((b) => b.size)).toEqual([288, 500, 660])
    expect(layout.boxes[1].maxSize).toBe(-1) // auto
    expect(layout.excludedIndexes).toEqual([])
    expect(layout.realIndex).toBe(0)
  })

  it('excludes a configured panel that is missing from the DOM', () => {
    const layout = buildLayout([panel(500), sep(), panel(660)], [navigator, auto, calendar], 1, remToPx)
    expect(layout.excludedIndexes).toEqual([0])
    expect(layout.correctedIndex).toBe(0)
    expect(layout.boxes.map((b) => b.id)).toEqual([1, 2])
  })

  it('marks a child without data-size/data-auto as foreign', () => {
    const layout = buildLayout([panel(288, 'navigator'), sep(), foreign(1160)], [navigator, auto], 0, remToPx)
    expect(layout.boxes.map((b) => b.id)).toEqual([0, -1])
  })

  it('splits containers at the separator', () => {
    const layout = buildLayout(
      [panel(288, 'navigator'), sep(), panel(500), sep(), panel(660)],
      [navigator, auto, calendar],
      0,
      remToPx
    )
    expect(layout.containers.minStart).toBe(remToPx(18))
    expect(layout.containers.maxStart).toBe(remToPx(22.5))
    expect(layout.containers.maxEnd).toBe(-1) // the auto panel makes the end unbounded
  })
})

describe('distribute', () => {
  const boxes = (): ReturnType<typeof buildLayout>['boxes'] =>
    buildLayout(
      [panel(288, 'navigator'), sep(), panel(500), sep(), panel(660)],
      [navigator, auto, calendar],
      0,
      remToPx
    ).boxes

  it('does nothing for a zero diff', () => {
    const b = boxes()
    distribute(b, 0, 0)
    expect(b.map((x) => x.size)).toEqual([288, 500, 660])
  })

  it('shrinks the panel before the separator and grows the one after', () => {
    // navigator starts at 320px, between its 288px minimum and its 360px maximum
    const b = buildLayout(
      [panel(320, 'navigator'), sep(), panel(500), sep(), panel(660)],
      [navigator, auto, calendar],
      0,
      remToPx
    ).boxes
    distribute(b, 0, 20)
    expect(b[0].size).toBe(300)
    expect(b[1].size).toBe(520)
  })

  it('stops at minSize when dragged past it', () => {
    const b = boxes()
    distribute(b, 0, 10000)
    expect(b[0].size).toBeGreaterThanOrEqual(b[0].minSize)
  })

  it('stops at maxSize when dragged past it', () => {
    const b = boxes()
    distribute(b, 0, -10000)
    expect(b[0].size).toBeLessThanOrEqual(b[0].maxSize)
  })

  it('gives the whole growth to the auto panel next to the separator', () => {
    const fixed: SeparatedItem = { minSize: 10, size: 20, maxSize: 40 }
    const b = buildLayout([panel(320), sep(), panel(400), sep(), panel(400)], [fixed, auto, auto], 0, remToPx).boxes
    distribute(b, 0, 64)
    expect(b[0].size).toBe(256)
    expect(b[1].size).toBe(464)
    expect(b[2].size).toBe(400)
  })

  it('splits the growth between the auto panels further out', () => {
    // With a sized panel right after the separator the growth skips it and is shared by the auto
    // panels beyond. `stretch` zeroes `needAdd` on the first of them, so the later `crop` calls are
    // skipped - pinned because that reads like a bug at the call site.
    const fixed: SeparatedItem = { minSize: 10, size: 20, maxSize: 40 }
    const b = buildLayout(
      [panel(320), sep(), panel(320), sep(), panel(400), sep(), panel(400)],
      [fixed, fixed, auto, auto],
      0,
      remToPx
    ).boxes
    distribute(b, 0, 64)
    expect(b[0].size).toBe(256)
    expect(b[1].size).toBe(320)
    expect(b[2].size).toBe(432)
    expect(b[3].size).toBe(432)
  })

  it('leaves sizes untouched when the separator index is out of range', () => {
    const b = boxes()
    distribute(b, 5, 40)
    expect(b.map((x) => x.size)).toEqual([288, 500, 660])
  })
})

describe('toSeparators', () => {
  it('round-trips an untouched layout', () => {
    const layout = buildLayout(
      [panel(288, 'navigator'), sep(), panel(500), sep(), panel(660)],
      [navigator, auto, calendar],
      0,
      remToPx
    )
    expect(toSeparators(layout.boxes, [navigator, auto, calendar], layout.excludedIndexes, pxToRem)).toEqual([
      { size: 18, minSize: 18, maxSize: 22.5, float: 'navigator' },
      { size: 'auto', minSize: 20, maxSize: 'auto', float: undefined },
      { size: 41.25, minSize: 25, maxSize: 90, float: undefined }
    ])
  })

  it('keeps the stored config of an excluded panel', () => {
    const layout = buildLayout([panel(500), sep(), panel(660)], [navigator, auto, calendar], 1, remToPx)
    const result = toSeparators(layout.boxes, [navigator, auto, calendar], layout.excludedIndexes, pxToRem)
    expect(result).toHaveLength(3)
    expect(result[0]).toBe(navigator)
  })

  it('keeps the stored config when the DOM has fewer panels than the config', () => {
    // Regression: a foreign child used to shift the mapping and throw on the missing entry.
    const layout = buildLayout([panel(288, 'navigator'), sep(), foreign(1160)], [navigator, auto], 0, remToPx)
    const result = toSeparators(
      layout.boxes.filter((b) => b.id !== -1),
      [navigator, auto],
      layout.excludedIndexes,
      pxToRem
    )
    expect(result).toHaveLength(2)
    expect(result[1]).toBe(auto)
  })
})

describe('invariants across layout combinations', () => {
  const configs: Array<{ name: string, separators: SeparatedItem[] }> = [
    { name: '3 panels', separators: [navigator, auto, calendar] },
    { name: '2 panels', separators: [navigator, auto] },
    { name: 'no auto', separators: [navigator, calendar] }
  ]
  const diffs = [-10000, -137, -1, 0, 1, 137, 10000]

  for (const config of configs) {
    for (const withNavigator of [true, false]) {
      for (const withForeign of [true, false]) {
        for (const index of [0, 1]) {
          if (index >= config.separators.length - 1) continue
          for (const diff of diffs) {
            const title = `${config.name}, navigator=${String(withNavigator)}, foreign=${String(
              withForeign
            )}, index=${index}, diff=${diff}`
            it(title, () => {
              const children: LayoutChild[] = []
              config.separators.forEach((s, i) => {
                if (s.float === 'navigator' && !withNavigator) return
                if (children.length > 0) children.push(sep())
                // Start from a size the config actually allows, otherwise the invariant fails before any drag.
                children.push(panel(typeof s.minSize === 'number' ? remToPx(s.minSize) + 60 : 300, s.float))
              })
              if (withForeign) children.push(foreign(120))

              const layout = buildLayout(children, config.separators, index, remToPx)
              distribute(layout.boxes, layout.realIndex, diff)
              const owned = layout.boxes.filter((b) => b.id !== -1)
              const result = toSeparators(owned, config.separators, layout.excludedIndexes, pxToRem)

              expect(result).toHaveLength(config.separators.length)
              for (const item of result) {
                for (const value of [item.size, item.minSize, item.maxSize]) {
                  expect(value === 'auto' || (typeof value === 'number' && !isNaN(value))).toBe(true)
                }
              }
              for (const box of owned) {
                expect(box.size).toBeGreaterThanOrEqual(box.minSize)
                if (box.maxSize !== -1) expect(box.size).toBeLessThanOrEqual(box.maxSize)
              }
            })
          }
        }
      }
    }
  }
})

describe('performance', () => {
  // Coarse guard against an accidental O(n^2); `pnpm bench` has the real numbers.
  it('stays linear enough for a wide layout', () => {
    const separators: SeparatedItem[] = []
    const children: LayoutChild[] = []
    for (let i = 0; i < 50; i++) {
      separators.push(i % 3 === 1 ? auto : { minSize: 10, size: 20, maxSize: 40 })
      if (i > 0) children.push(sep())
      children.push(panel(320))
    }

    const started = performance.now()
    for (let run = 0; run < 5000; run++) {
      const layout = buildLayout(children, separators, 0, remToPx)
      distribute(layout.boxes, layout.realIndex, 37)
      toSeparators(layout.boxes, separators, layout.excludedIndexes, pxToRem)
    }
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

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

import type { SeparatedItem } from './types'

/** One child of the separator's parent, as read from the DOM. */
export interface LayoutChild {
  isSeparator: boolean
  /** Carries data-size or data-auto, i.e. this panel takes part in the layout. */
  sized: boolean
  float?: string | undefined
  size: number
}

/** A panel taking part in the layout. `id` is -1 for a child no separator config owns. */
export interface LayoutBox {
  id: number
  childIndex: number
  minSize: number
  maxSize: number
  size: number
  begin: boolean
  resize: boolean
  float?: string | undefined
}

export interface LayoutContainers {
  minStart: number
  minEnd: number
  maxStart: number
  maxEnd: number
}

export interface Layout {
  boxes: LayoutBox[]
  excludedIndexes: number[]
  correctedIndex: number
  realIndex: number
  containers: LayoutContainers
}

/**
 * Map the parent's children onto the separator config. Panels whose `float` is configured but
 * absent from the DOM are excluded, which shifts the separator's own index.
 */
export function buildLayout (
  children: LayoutChild[],
  separators: SeparatedItem[],
  index: number,
  remToPx: (rem: number) => number
): Layout {
  const hasSep = children.filter((c) => c.float !== undefined).map((c) => c.float)
  const excluded = separators
    .filter((separ) => separ.float !== undefined && !hasSep.includes(separ.float))
    .map((separ) => separ.float)
  const excludedIndexes: number[] = []
  separators.forEach((separ, i) => {
    if (excluded.includes(separ.float)) excludedIndexes.push(i)
  })
  const correctedIndex = index - excludedIndexes.filter((i) => i < index).length
  let realIndex = correctedIndex

  const boxes: LayoutBox[] = []
  let ind: number = 0
  let drop: number = 0
  children.forEach((child, childIndex) => {
    if (separators[ind]?.float !== undefined && excluded.includes(separators[ind].float)) {
      ind++
      drop++
    }
    const extra = !(child.isSeparator || child.sized)
    if (extra) realIndex++
    if (child.isSeparator) return
    const config = separators[ind]
    boxes.push({
      id: extra ? -1 : ind,
      childIndex,
      minSize: extra || config === undefined ? child.size : sizeOf(config.minSize, remToPx, remToPx(20)),
      maxSize: extra || config === undefined ? child.size : sizeOf(config.maxSize, remToPx, -1),
      size: child.size,
      begin: ind - drop <= correctedIndex,
      resize: false,
      float: extra ? undefined : config?.float
    })
    if (!extra) ind++
  })

  const startBoxes = boxes.filter((b) => b.begin)
  const endBoxes = boxes.filter((b) => !b.begin)
  return {
    boxes,
    excludedIndexes,
    correctedIndex,
    realIndex,
    containers: {
      minStart: sum(startBoxes.map((b) => b.minSize)),
      minEnd: sum(endBoxes.map((b) => b.minSize)),
      maxStart: startBoxes.some((b) => b.maxSize === -1) ? -1 : sum(startBoxes.map((b) => b.maxSize)),
      maxEnd: endBoxes.some((b) => b.maxSize === -1) ? -1 : sum(endBoxes.map((b) => b.maxSize))
    }
  }
}

/**
 * Move `diff` pixels across the separator at `realIndex`: crop the panels on one side down to their
 * minimum, stretch the other side up to its maximum. Auto-sized panels give and take first.
 */
export function distribute<T extends LayoutBox> (boxes: T[], realIndex: number, diff: number): void {
  if (diff === 0) return
  const reverse = diff < 0
  let remains = Math.abs(diff)
  const minusId = realIndex + (reverse ? 1 : 0)
  const plusId = realIndex + (reverse ? 0 : 1)
  const minusBox = boxes[minusId]
  const plusBox = boxes[plusId]
  if (minusBox === undefined || plusBox === undefined) return

  const before = (i: number): boolean => (!reverse && i < realIndex) || (reverse && i > realIndex + 1)
  const after = (i: number): boolean => (!reverse && i > realIndex + 1) || (reverse && i < realIndex)
  const minusAutoBoxes = boxes.filter((s, i) => s.maxSize === -1 && before(i))
  const minusBoxes = boxes.filter((s, i) => s.maxSize !== -1 && before(i))
  const plusAutoBoxes = boxes.filter((s, i) => s.maxSize === -1 && after(i))
  const plusBoxes = boxes.filter((s, i) => s.maxSize !== -1 && after(i))
  const startMinus = minusBox.maxSize === -1
  const startPlus = plusBox.maxSize === -1

  // Find for crop
  if (startMinus && minusBox.size - minusBox.minSize > 0) {
    remains = crop(minusBox, minusBox.minSize, minusBox.size, remains)
  }
  if (remains > 0) {
    minusAutoBoxes.forEach((box) => {
      if (remains > 0) remains = crop(box, box.minSize, box.size, remains)
    })
  }
  if (remains > 0 && !startMinus && minusBox.size - minusBox.minSize > 0) {
    remains = crop(minusBox, minusBox.minSize, minusBox.size, remains)
  }
  if (remains > 0) {
    minusBoxes.forEach((box) => {
      if (remains > 0) remains = crop(box, box.minSize, box.size, remains)
    })
  }

  let needAdd: number = Math.abs(diff) - remains
  // Find for stretch
  if (needAdd > 0 && startPlus) needAdd = stretch(plusBox, plusBox.size + needAdd)
  if (needAdd > 0 && plusAutoBoxes.length > 0) {
    const div = needAdd / plusAutoBoxes.length
    plusAutoBoxes.forEach((box) => (needAdd = stretch(box, box.size + div)))
  }
  if (needAdd > 0 && plusBox.maxSize - plusBox.size > 0) {
    needAdd = crop(plusBox, plusBox.size, plusBox.maxSize, needAdd, true)
  }
  if (needAdd > 0) {
    plusBoxes.forEach((box) => {
      if (needAdd > 0) needAdd = crop(box, box.size, box.maxSize, needAdd, true)
    })
  }
}

/**
 * Convert the laid out boxes back into the config that gets persisted. Panels excluded from the DOM
 * keep their stored config, so hiding a panel never drops its size.
 */
export function toSeparators (
  boxes: LayoutBox[],
  separators: SeparatedItem[],
  excludedIndexes: number[],
  pxToRem: (px: number) => number
): SeparatedItem[] {
  const owned = boxes.filter((b) => b.id !== -1)
  const result: SeparatedItem[] = []
  let ind: number = 0
  separators.forEach((separ, i) => {
    if (excludedIndexes.includes(i)) {
      ind++
      result.push(separ)
      return
    }
    const box = owned[i - ind]
    // The DOM can hold fewer panels than the config knows about; keep what was stored for those.
    if (box === undefined) {
      result.push(separ)
      return
    }
    result.push({
      size: box.maxSize === -1 ? 'auto' : pxToRem(box.size),
      minSize: pxToRem(box.minSize),
      maxSize: box.maxSize === -1 ? 'auto' : pxToRem(box.maxSize),
      float: box.float
    })
  })
  return result
}

function sizeOf (value: SeparatedItem['minSize'], remToPx: (rem: number) => number, fallback: number): number {
  return typeof value === 'number' ? remToPx(value) : fallback
}

function sum (values: number[]): number {
  return values.reduce((prev, a) => prev + a, 0)
}

function crop (box: LayoutBox, min: number, max: number, count: number, stretching: boolean = false): number {
  const diff = max - min
  if (diff !== 0) {
    box.size = min + (count >= diff ? (stretching ? diff : 0) : stretching ? count : diff - count)
    box.resize = true
    count = count - diff <= 0 ? 0 : count - diff
  }
  return count
}

function stretch (box: LayoutBox, size: number): number {
  box.size = size
  box.resize = true
  return 0
}

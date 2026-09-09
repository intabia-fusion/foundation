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

/**
 * jsdom does no layout, so every rect is zero and the separator has nothing to measure.
 * This stands in for flexbox: a box takes the pixel size its inline style declares, an
 * unsized one shares whatever the parent has left, and offsets accumulate along the axis.
 */

export const ROOT_SIZE = 1000

let axis: 'horizontal' | 'vertical' = 'horizontal'
let root: Element | undefined

function declared (el: Element): number {
  // Stands in for a CSS rule with !important: the element keeps this size whatever is set inline.
  const pinned = el.getAttribute('data-pinned')
  if (pinned !== null) return parseFloat(pinned)
  const style = (el as HTMLElement).style
  const value = axis === 'horizontal' ? style.width : style.height
  if (value.endsWith('px')) return parseFloat(value)
  if (el.classList.contains('antiSeparator')) return parseFloat(el.getAttribute('data-size') ?? '1')
  return NaN
}

function sizeOf (el: Element): number {
  const own = declared(el)
  if (!isNaN(own)) return own
  const parent = el.parentElement
  if (parent === null || el === root) return ROOT_SIZE
  const siblings = Array.from(parent.children).map(declared)
  const fixed = siblings.filter((s) => !isNaN(s)).reduce((a, b) => a + b, 0)
  const autos = siblings.filter((s) => isNaN(s)).length
  return autos > 0 ? Math.max(0, (sizeOf(parent) - fixed) / autos) : 0
}

function offsetOf (el: Element): number {
  const parent = el.parentElement
  if (parent === null || el === root) return 0
  const kids = Array.from(parent.children)
  const index = kids.indexOf(el)
  return (
    offsetOf(parent) +
    kids
      .slice(0, index)
      .map(sizeOf)
      .reduce((a, b) => a + b, 0)
  )
}

/** Captured once: a second install must never store the fake as the thing to restore. */
// eslint-disable-next-line @typescript-eslint/unbound-method -- restored onto the prototype as is
const nativeRect = Element.prototype.getBoundingClientRect
let installed = false

/** Replaces getBoundingClientRect for the whole document; call the returned restore() from afterEach. */
export function installFakeLayout (
  rootElement: Element,
  direction: 'horizontal' | 'vertical' = 'horizontal'
): () => void {
  if (installed) throw new Error('fake layout already installed; restore it before installing again')
  installed = true
  axis = direction
  root = rootElement

  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const size = sizeOf(this)
    const offset = offsetOf(this)
    const horizontal = axis === 'horizontal'
    const left = horizontal ? offset : 0
    const top = horizontal ? 0 : offset
    const width = horizontal ? size : ROOT_SIZE
    const height = horizontal ? ROOT_SIZE : size
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({})
    } as unknown as DOMRect
  }

  return () => {
    Element.prototype.getBoundingClientRect = nativeRect
    root = undefined
    installed = false
  }
}

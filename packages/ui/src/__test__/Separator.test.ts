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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Separator from '../components/Separator.svelte'
import { defineSeparators } from '../resize'
import { deviceOptionsStore } from '../index'
import type { DefSeparators, SeparatedItem } from '../types'
import { ROOT_SIZE, installFakeLayout } from './fakeLayout'

const FS = 16

const navigator: SeparatedItem = { minSize: 10, size: 15, maxSize: 25, float: 'navigator' }
const auto: SeparatedItem = { size: 'auto', minSize: 20, maxSize: 'auto' }
const aside: SeparatedItem = { minSize: 10, size: 20, maxSize: 30 }

let parent: HTMLElement

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function addPanel (id: string): HTMLElement {
  const panel = document.createElement('div')
  panel.setAttribute('data-test', id)
  parent.appendChild(panel)
  return panel
}

function drag (separator: HTMLElement, from: number, to: number, axis: 'horizontal' | 'vertical' = 'horizontal'): void {
  const event = (type: string, at: number): PointerEvent =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: axis === 'horizontal' ? at : 10,
      clientY: axis === 'horizontal' ? 10 : at,
      pointerId: 1
    })
  separator.dispatchEvent(event('pointerdown', from))
  document.dispatchEvent(event('pointermove', to))
  document.dispatchEvent(event('pointerup', to))
}

async function mount (
  name: string,
  defs: DefSeparators,
  index: number,
  extra: Record<string, unknown> = {},
  target: HTMLElement = parent,
  anchorIndex: number = index + 1
): Promise<{ separator: HTMLElement, component: Separator }> {
  defineSeparators(name, defs)
  const anchor = target.children[anchorIndex]
  const component = new Separator({
    target,
    anchor,
    props: { name, index, color: 'transparent', ...extra }
  })
  await settle()
  const separator = target.querySelector('.antiSeparator') as HTMLElement
  return { separator, component }
}

describe('Separator', () => {
  let restoreLayout: () => void

  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
    parent = document.createElement('div')
    document.body.appendChild(parent)
    restoreLayout = installFakeLayout(parent)
    deviceOptionsStore.update((d) => ({ ...d, fontSize: FS }))
  })

  afterEach(() => {
    restoreLayout()
  })

  it('sizes both siblings on mount', async () => {
    const left = addPanel('left')
    left.setAttribute('data-float', 'navigator')
    const right = addPanel('right')
    await mount('two-panels', [navigator, auto], 0)

    expect(left.getAttribute('data-size')).toBe(String(15 * FS))
    expect(right.hasAttribute('data-auto')).toBe(true)
  })

  it('persists the dragged sizes', async () => {
    const left = addPanel('left')
    left.setAttribute('data-float', 'navigator')
    addPanel('right')
    const { separator } = await mount('drag', [navigator, auto], 0)

    drag(separator, 15 * FS, 18 * FS)

    const saved = JSON.parse(localStorage.getItem('separators_drag') as string)
    expect(saved).toHaveLength(2)
    expect(saved[0].size).toBeCloseTo(18, 1)
    expect(saved[1].size).toBe('auto')
  })

  it('keeps the dragged size within min and max', async () => {
    const left = addPanel('left')
    left.setAttribute('data-float', 'navigator')
    addPanel('right')
    const { separator } = await mount('bounds', [navigator, auto], 0)

    drag(separator, 15 * FS, 5000)
    let saved = JSON.parse(localStorage.getItem('separators_bounds') as string)
    expect(saved[0].size).toBeLessThanOrEqual(25)

    drag(separator, saved[0].size * FS, -5000)
    saved = JSON.parse(localStorage.getItem('separators_bounds') as string)
    expect(saved[0].size).toBeGreaterThanOrEqual(10)
  })

  it('sizes the replacement panel after the layout switches', async () => {
    // Regression: switching the planner between Schedule and Team swaps the panel next to the
    // separator. The new panel used to stay unsized, which made the drag throw on pointerup.
    const left = addPanel('left')
    left.setAttribute('data-float', 'navigator')
    const right = addPanel('right')
    const { separator, component } = await mount('switch', [navigator, auto, aside], 0)

    parent.removeChild(right)
    const replacement = addPanel('replacement')
    defineSeparators('switch-no-aside', [navigator, auto])
    component.$set({ name: 'switch-no-aside' })
    await settle()

    expect(replacement.hasAttribute('data-size') || replacement.hasAttribute('data-auto')).toBe(true)

    const errors: string[] = []
    const onError = (e: ErrorEvent): void => {
      errors.push(e.message)
    }
    window.addEventListener('error', onError)
    drag(separator, 15 * FS, 18 * FS)
    window.removeEventListener('error', onError)

    expect(errors).toEqual([])
    const saved = JSON.parse(localStorage.getItem('separators_switch-no-aside') as string)
    expect(saved).toHaveLength(2)
  })

  it('sizes a panel swapped in without a config change', async () => {
    // Regression: the planner swaps the panel next to the separator when switching Schedule <-> Team
    // while the separator config stays the same. The new node used to keep no sizes and collapsed.
    const left = addPanel('left')
    left.setAttribute('data-float', 'navigator')
    const right = addPanel('right')
    const { component } = await mount('swap', [navigator, auto], 0)
    expect(right.hasAttribute('data-auto')).toBe(true)

    parent.removeChild(right)
    const replacement = addPanel('replacement')
    // Nudge svelte into an update without touching name/float, as the planner does.
    component.$set({ color: 'red' })
    await settle()

    expect(replacement.hasAttribute('data-size') || replacement.hasAttribute('data-auto')).toBe(true)
    expect(replacement.getBoundingClientRect().width).toBeGreaterThan(100)
  })

  it('applies the dragged size to a panel swapped in afterwards', async () => {
    // Regression: the drag persisted its result to the store but left the component's own copy of
    // the config untouched, so the next panel swap resized back to the pre-drag size.
    addPanel('left')
    const right = addPanel('right')
    const { separator, component } = await mount('swap-after-drag', [auto, aside], 0)
    expect(parseFloat(right.style.width)).toBe(20 * FS)

    // The separator sits where the auto panel ends; drag it left to widen the sized panel.
    drag(separator, ROOT_SIZE - 20 * FS - 1, ROOT_SIZE - 26 * FS - 1)
    const dragged = parseFloat(right.style.width)
    expect(dragged).toBeCloseTo(26 * FS, 0)

    parent.removeChild(right)
    const replacement = addPanel('replacement')
    component.$set({ color: 'red' })
    await settle()

    expect(parseFloat(replacement.style.width)).toBeCloseTo(dragged, 0)
  })

  it('picks up sizes saved by another separator on the same config', async () => {
    // Two gaps share one config: dragging one used to leave the other with its copy from mount time.
    addPanel('left')
    const middle = addPanel('middle')
    const right = addPanel('right')
    defineSeparators('shared', [aside, auto, aside])
    const first = new Separator({
      target: parent,
      anchor: middle,
      props: { name: 'shared', index: 0, color: 'transparent' }
    })
    const second = new Separator({
      target: parent,
      anchor: right,
      props: { name: 'shared', index: 1, color: 'transparent' }
    })
    await settle()
    expect(first).toBeDefined()

    const separators = parent.querySelectorAll('.antiSeparator')
    drag(separators[0] as HTMLElement, 20 * FS, 26 * FS)
    await settle()

    // The second separator has to resize its own panels from the config the first one just saved.
    parent.removeChild(right)
    const replacement = addPanel('replacement')
    second.$set({ color: 'red' })
    await settle()

    const saved = JSON.parse(localStorage.getItem('separators_shared') as string)
    expect(saved[0].size).toBeCloseTo(26, 1)
    expect(parseFloat(replacement.style.width)).toBeCloseTo(saved[2].size * FS, 0)
  })

  it('moves the sizes to the other axis when direction changes', async () => {
    const left = addPanel('left')
    left.setAttribute('data-float', 'navigator')
    addPanel('right')
    const { component } = await mount('axis-switch', [navigator, auto], 0)
    expect(left.style.width).toBe(`${15 * FS}px`)

    component.$set({ direction: 'vertical' })
    await settle()

    expect(left.style.width).toBe('')
    expect(left.style.height).toBe(`${15 * FS}px`)
  })

  it('leaves an already sized panel alone when its neighbour is swapped', async () => {
    // The workbench sidebar sizes itself; re-applying the separator config to it collapsed the panel.
    const left = addPanel('left')
    left.setAttribute('data-float', 'navigator')
    const right = addPanel('right')
    const { component } = await mount('sized-neighbour', [navigator, aside], 0)

    right.style.width = '512px'
    right.setAttribute('data-size', '512')
    parent.removeChild(left)
    const replacement = document.createElement('div')
    replacement.setAttribute('data-float', 'navigator')
    parent.insertBefore(replacement, parent.firstChild)
    component.$set({ color: 'red' })
    await settle()

    expect(replacement.style.width).toBe(`${15 * FS}px`)
    expect(right.style.width).toBe('512px')
  })

  it('does not store the size of a panel pinned by CSS', async () => {
    // Regression: the workbench sidebar is 3.5rem !important while collapsed. Measuring it back into
    // the config made that width the stored size, so the sidebar stayed collapsed once reopened.
    const left = addPanel('left')
    left.setAttribute('data-float', 'navigator')
    const right = addPanel('right')
    right.setAttribute('data-pinned', '57')
    const { component } = await mount('pinned', [navigator, aside], 0)

    parent.removeChild(left)
    const replacement = addPanel('replacement')
    replacement.setAttribute('data-float', 'navigator')
    parent.insertBefore(replacement, parent.firstChild)
    component.$set({ color: 'red' })
    await settle()

    // The pin wins on screen, but the config still holds the size the panel is meant to have.
    right.removeAttribute('data-pinned')
    right.removeAttribute('data-size')
    component.$set({ color: 'blue' })
    await settle()

    expect(parseFloat(right.style.width)).toBe(20 * FS)
  })

  it('keeps the config of a panel that is not in the DOM', async () => {
    // The navigator is hidden, so only two of the three configured panels are present.
    addPanel('main')
    addPanel('aside')
    const { separator } = await mount('hidden-navigator', [navigator, auto, aside], 1)

    drag(separator, 500, 560)

    const saved = JSON.parse(localStorage.getItem('separators_hidden-navigator') as string)
    expect(saved).toHaveLength(3)
    expect(saved[0]).toEqual(navigator)
  })
  it('drags along the vertical axis', async () => {
    restoreLayout()
    restoreLayout = installFakeLayout(parent, 'vertical')
    const top = addPanel('top')
    top.setAttribute('data-float', 'navigator')
    addPanel('bottom')
    const { separator } = await mount('vertical', [navigator, auto], 0, { direction: 'vertical' })

    expect(top.style.height).toBe(`${15 * FS}px`)

    drag(separator, 15 * FS, 18 * FS, 'vertical')

    const saved = JSON.parse(localStorage.getItem('separators_vertical') as string)
    expect(saved[0].size).toBeCloseTo(18, 1)
    expect(saved[1].size).toBe('auto')
  })
})

describe('Separator in float mode', () => {
  let restoreLayout: () => void
  let floatPanel: HTMLElement

  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
    parent = document.createElement('div')
    document.body.appendChild(parent)
    floatPanel = document.createElement('div')
    parent.appendChild(floatPanel)
    restoreLayout = installFakeLayout(parent)
    deviceOptionsStore.update((d) => ({ ...d, fontSize: FS }))
  })

  afterEach(() => {
    restoreLayout()
  })

  const mountFloat = async (name: string, atStart: boolean): Promise<HTMLElement> => {
    const content = document.createElement('div')
    floatPanel.appendChild(content)
    const { separator } = await mount(name, [navigator], 0, { float: 'navigator' }, floatPanel, atStart ? 0 : 1)
    return separator
  }

  it('sizes the floating panel from its stored config', async () => {
    await mountFloat('float-init', true)
    expect(floatPanel.style.width).toBe(`${15 * FS}px`)
    expect(floatPanel.getAttribute('data-float')).toBe('navigator')
  })

  it('shrinks the panel as the leading edge is dragged inwards', async () => {
    const separator = await mountFloat('float-start', true)
    drag(separator, 0, 3 * FS)

    const saved = JSON.parse(localStorage.getItem('separators_float-start-float-navigator') as string)
    expect(saved.size).toBe(12)
  })

  it('cannot grow the panel past its current width', async () => {
    // Pinned behaviour, not a desired one: floatMouseMove clamps the pointer to the panel it is
    // resizing, so a floating panel only ever shrinks. Revisit this test if that gets fixed.
    const separator = await mountFloat('float-max', true)
    drag(separator, 0, -5000)

    const saved = JSON.parse(localStorage.getItem('separators_float-max-float-navigator') as string)
    expect(saved.size).toBe(15)
  })

  it('clamps the floating panel to its minimum', async () => {
    const separator = await mountFloat('float-min', true)
    drag(separator, 0, 5000)

    const saved = JSON.parse(localStorage.getItem('separators_float-min-float-navigator') as string)
    expect(saved.size).toBe(10)
  })

  it('restores pointer events after the drag', async () => {
    const separator = await mountFloat('float-events', true)
    drag(separator, 0, -50)
    expect(floatPanel.style.pointerEvents).toBe('all')
  })
})

describe('Separator on window resize', () => {
  let restoreLayout: () => void

  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
    parent = document.createElement('div')
    document.body.appendChild(parent)
    restoreLayout = installFakeLayout(parent)
    deviceOptionsStore.update((d) => ({ ...d, fontSize: FS }))
  })

  afterEach(() => {
    restoreLayout()
  })

  it('crops panels that no longer fit the container', async () => {
    const left = addPanel('left')
    left.setAttribute('data-float', 'navigator')
    const right = addPanel('right')
    await mount('resize', [navigator, aside], 0)

    // The window shrank under the panels: both keep sizes that add up past the container.
    left.style.width = '700px'
    right.style.width = '700px'

    window.dispatchEvent(new Event('resize'))
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(parseFloat(right.style.width)).toBeLessThan(700)
    expect(parseFloat(right.style.width)).toBeGreaterThanOrEqual(10 * FS)
  })
})

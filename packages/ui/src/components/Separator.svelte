<!--
// Copyright © 2023 Hardcore Engineering Inc.
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
-->
<script lang="ts">
  import { afterUpdate, onDestroy, onMount } from 'svelte'
  import type { TSeparatedItem, SeparatedItem } from '..'
  import {
    nullSeparatedItem,
    deviceOptionsStore as deviceInfo,
    getSeparators,
    saveSeparator,
    separatorsRevision,
    separatorsStore,
    SeparatorState
  } from '..'
  import { panelstore } from '../panelup'
  import { buildLayout, distribute, toSeparators, type LayoutBox } from '../separatorLayout'

  export let prevElementSize: SeparatedItem | undefined = undefined
  export let nextElementSize: SeparatedItem | undefined = undefined
  export let separatorSize: number = 1
  export let color: string = 'var(--theme-divider-color)'
  export let name: string
  export let disabledWhen: string[] = []
  export let index: number // index = -1 ; for custom sizes without saving to a localStorage
  export let float: string | boolean = false // false - default state, true - hidden state for float, name - panel name for resize (float state)
  export let short: boolean = false

  let sState: SeparatorState
  $: sState = typeof float === 'string' ? SeparatorState.FLOAT : float ? SeparatorState.HIDDEN : SeparatorState.NORMAL
  const checkFullWidth = (): boolean =>
    sState === SeparatorState.FLOAT && $deviceInfo.isMobile && $deviceInfo.isPortrait

  export let direction: 'horizontal' | 'vertical' = 'horizontal'
  let separators: SeparatedItem[] | null = null
  // The layout boxes carry the index of the DOM child they came from; the public SeparatedElement does not.
  let separatorMap: Array<LayoutBox & { element: Element, styles: Map<string, string> | null }>
  let prevElSize: SeparatedItem
  let nextElSize: SeparatedItem
  let panel: SeparatedItem
  let separator: HTMLElement
  let prevElement: HTMLElement | null
  let nextElement: HTMLElement | null
  let parentElement: HTMLElement | null
  let mounted: boolean = false
  let isSeparate: boolean = false
  let excludedIndexes: number[] = []
  let correctedIndex: number = index
  let revision: number = 0
  let appliedDirection: 'horizontal' | 'vertical' = direction
  let realIndex: number = index
  let offset: number = 0
  let separatorsSizes: number[] | null = null
  const separatorsWide: { before: number, after: number, total: number } = { before: 0, after: 0, total: 0 }
  const containers: { minStart: number, minEnd: number, maxStart: number, maxEnd: number } = {
    minStart: -1,
    minEnd: -1,
    maxStart: -1,
    maxEnd: -1
  }
  let parentSize: { start: number, end: number, size: number } | null = null
  let disabled: boolean = false
  let side: 'start' | 'end' | undefined = undefined

  $: fs = $deviceInfo.fontSize
  const remToPx = (rem: number): number => rem * fs
  const pxToRem = (px: number): number => px / fs

  const disableUserSelect = (): void => {
    document.body.style.userSelect = 'none'
    document.body.style.webkitUserSelect = 'none'
    document.body.style.pointerEvents = 'none'
  }
  const enableUserSelect = (): void => {
    document.body.style.userSelect = ''
    document.body.style.webkitUserSelect = ''
    document.body.style.pointerEvents = ''
  }

  const fetchSeparators = (): void => {
    const res = getSeparators(name, float)
    if (res !== null && !Array.isArray(res)) panel = res
    else if (Array.isArray(res)) {
      separators = res
      prevElSize = separators !== null ? separators[index] : nullSeparatedItem
      nextElSize = separators !== null ? separators[index + 1] : nullSeparatedItem
    }
  }
  $: if (name || float) {
    fetchSeparators()
    if (sState === SeparatorState.NORMAL) {
      if (prevElementSize !== undefined) prevElSize = prevElementSize
      if (nextElementSize !== undefined) nextElSize = nextElementSize
      setTimeout(() => {
        if (parentElement === null && separator != null) parentElement = separator.parentElement
        checkSibling(true)
        calculateSeparators()
        // Siblings may have been replaced by the layout switch: size the new ones, not the detached nodes.
        checkSizes()
      })
    } else checkSizes()
  }

  const convertSize = (prop: TSeparatedItem): string => (typeof prop === 'number' ? `${prop}px` : '')

  const setSize = (element: HTMLElement, size: TSeparatedItem, next: boolean = false): void => {
    const s = convertSize(size)
    if (direction === 'horizontal') {
      element.style.minWidth = size === 'auto' ? '0' : s
      element.style.maxWidth = s
      element.style.width = s
    } else {
      element.style.minHeight = size === 'auto' ? '0' : s
      element.style.maxHeight = s
      element.style.height = s
    }
    const rect = element.getBoundingClientRect()
    const sizePx = direction === 'horizontal' ? rect.width : rect.height
    element.setAttribute('data-size', `${sizePx}`)
    // A panel pinned by CSS keeps its own width (the mini sidebar is 3.5rem !important). Writing the
    // measured size back would turn that pin into the stored size and collapse the panel for good.
    const pinned = typeof size === 'number' && Math.abs(size - sizePx) >= 1
    if (sState === SeparatorState.NORMAL && !pinned) {
      if (separators != null) separators[index + (next ? 1 : 0)].size = pxToRem(sizePx)
      if (next) nextElSize.size = typeof size === 'number' ? pxToRem(sizePx) : size
      else prevElSize.size = typeof size === 'number' ? pxToRem(sizePx) : size
    }
  }

  const getStyles = (
    element: Element | null,
    dropStyles: string[] = ['min-width', 'max-width', 'width']
  ): Map<string, string> => {
    const result = new Map<string, string>()
    const style = element != null ? element.getAttribute('style') : null
    if (style !== null) {
      style
        .replace(/ /g, '')
        .split(';')
        .filter((f) => f !== '')
        .forEach((st) => result.set(st.split(':')[0], st.split(':')[1]))
      dropStyles.forEach((key) => result.delete(key))
    }
    return result
  }

  const generateMap = (): void => {
    if (parentElement == null || separators === null || separatorsSizes === null) return
    const children: Element[] = Array.from(parentElement.children)
    if (children.length > 1) {
      const layout = buildLayout(
        children.map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            isSeparator: element.classList.contains('antiSeparator'),
            sized: element.hasAttribute('data-size') || element.hasAttribute('data-auto'),
            float: element.getAttribute('data-float') ?? undefined,
            size: direction === 'horizontal' ? rect.width : rect.height
          }
        }),
        separators,
        index,
        remToPx
      )
      excludedIndexes = layout.excludedIndexes
      correctedIndex = layout.correctedIndex
      realIndex = layout.realIndex
      separatorMap = layout.boxes.map((box) => ({
        ...box,
        element: children[box.childIndex],
        styles: getStyles(children[box.childIndex])
      }))
      containers.minStart = layout.containers.minStart
      containers.minEnd = layout.containers.minEnd
      containers.maxStart = layout.containers.maxStart
      containers.maxEnd = layout.containers.maxEnd
    }
    isSeparate = true
  }

  const initSize = (element: HTMLElement, props: SeparatedItem, next: boolean = false): void => {
    const minSizePx = props.minSize === 'auto' ? '0' : convertSize(remToPx(props.minSize))
    const maxSizePx = convertSize(props.maxSize === 'auto' ? 'auto' : remToPx(props.maxSize))
    const sizePx = convertSize(props.size === 'auto' ? 'auto' : remToPx(props.size))

    if (props.size !== 'auto') {
      setSize(element, remToPx(props.size), next)
      return
    }
    const rect = element.getBoundingClientRect()
    if (direction === 'horizontal') {
      element.style.minWidth = minSizePx
      element.style.maxWidth = maxSizePx
      element.style.width = sizePx
      element.setAttribute('data-auto', `${rect.width}`)
    } else {
      element.style.minHeight = minSizePx
      element.style.maxHeight = maxSizePx
      element.style.height = sizePx
      element.setAttribute('data-auto', `${rect.height}`)
    }
  }

  const isSized = (element: HTMLElement): boolean =>
    element.hasAttribute('data-size') || element.hasAttribute('data-auto')

  /** Only panels that carry no sizes yet, i.e. the ones that just replaced a sibling. */
  const sizeNewSiblings = (): void => {
    if (sState !== SeparatorState.NORMAL) return
    if (prevElement != null && prevElSize != null && !isSized(prevElement)) initSize(prevElement, prevElSize)
    if (nextElement != null && nextElSize != null && !isSized(nextElement)) initSize(nextElement, nextElSize, true)
  }

  const checkSizes = (): void => {
    if (sState === SeparatorState.FLOAT) {
      if (checkFullWidth() && panel != null) {
        const s = pxToRem(window.innerWidth)
        panel.size = s
        panel.maxSize = s
        panel.minSize = s
      }
      if (parentElement != null && panel != null) initSize(parentElement, panel)
    } else if (sState === SeparatorState.NORMAL) {
      if (prevElement != null && prevElSize != null) initSize(prevElement, prevElSize)
      if (nextElement != null && nextElSize != null) initSize(nextElement, nextElSize, true)
    }
  }

  const applyStyles = (final: boolean = false): void => {
    if (separatorMap == null) return
    const side = direction === 'horizontal' ? 'width' : 'height'
    separatorMap.forEach((item) => {
      if (item.resize || final) {
        let style: string = `min-${side}:${
          item.maxSize !== -1 ? item.size + 'px' : item.minSize === -1 ? '0' : item.minSize + 'px'
        };`
        style += item.maxSize === -1 ? '' : `max-${side}:${item.size + 'px'};`
        style += item.maxSize !== -1 ? `${side}:${item.size}px;` : ''
        if (item.styles !== null) {
          item.styles.forEach((value, key) => {
            if (key !== 'pointer-events' || final) style += `${key}:${value};`
          })
        }
        if (isSeparate) style += 'pointer-events:none;'
        item.element.setAttribute('style', style)
        if (final && item.id !== -1) {
          const rect = item.element.getBoundingClientRect()
          item.element.setAttribute(
            item.maxSize === -1 ? 'data-auto' : 'data-size',
            `${direction === 'horizontal' ? rect.width : rect.height}`
          )
        }
        item.resize = false
      }
    })
  }

  function pointerMove (event: PointerEvent): void {
    if (sState === SeparatorState.NORMAL) normalMouseMove(event)
    else if (sState === SeparatorState.FLOAT) floatMouseMove(event)
  }

  const preparePanel = (): void => {
    if (parentElement === null || parentSize === null) return
    setSize(parentElement, panel.size === 'auto' ? 'auto' : remToPx(panel.size))
    const s = separator.getBoundingClientRect()
    if (s) {
      const currentPoint = direction === 'horizontal' ? s.x : s.y
      side =
        parentSize.end - separatorSize === currentPoint
          ? 'end'
          : parentSize.start === currentPoint
            ? 'start'
            : undefined
    }
    if (side !== undefined) isSeparate = true
    parentElement.style.pointerEvents = 'none'
  }

  function floatMouseMove (event: PointerEvent): void {
    if (!isSeparate || parentSize === null || parentElement === null) return
    const coord: number = Math.round(direction === 'horizontal' ? event.clientX - offset : event.clientY - offset)
    let parentCoord: number = coord - parentSize.start
    const min = remToPx(panel.minSize === 'auto' ? 10 : panel.minSize)
    const max = remToPx(panel.maxSize === 'auto' ? 30 : panel.maxSize)
    // Clamp parentCoord to valid range to prevent panel from going off-screen
    if (parentCoord < 0) parentCoord = 0
    if (parentCoord > parentSize.size - separatorSize) parentCoord = parentSize.size - separatorSize
    const newCoord =
      side === 'start'
        ? parentSize.size - parentCoord < min
          ? min
          : parentSize.size - parentCoord > max
            ? max
            : parentSize.size - parentCoord
        : parentCoord < min
          ? min
          : parentCoord > max
            ? max
            : parentCoord
    panel.size = pxToRem(newCoord)
    setSize(parentElement, newCoord)
  }

  function normalMouseMove (event: PointerEvent): void {
    if (!isSeparate || separatorMap === undefined || parentSize === null || separatorsSizes === null) return
    const coord: number = Math.round(direction === 'horizontal' ? event.clientX - offset : event.clientY - offset)
    let parentCoord: number = coord - parentSize.start
    let prevCoord: number = separatorMap
      .filter((f) => f.begin)
      .map((m) => m.size)
      .reduce((prev, a) => prev + a, 0)
    prevCoord += separatorsWide.before
    const startSizeMin = containers.minStart + separatorsWide.before
    const startSizeMax = containers.maxStart === -1 ? -1 : containers.maxStart + separatorsWide.before
    if (parentCoord <= startSizeMin) parentCoord = startSizeMin + 1
    if (startSizeMax !== -1 && parentCoord > startSizeMax) parentCoord = startSizeMax
    const endSizeMin = containers.minEnd + separatorsWide.after
    const endSizeMax = containers.maxEnd === -1 ? -1 : containers.maxEnd + separatorsWide.after
    if (parentCoord > parentSize.size - endSizeMin - separatorSize) {
      parentCoord = parentSize.size - endSizeMin - separatorSize
    }
    if (endSizeMax !== -1 && parentCoord < parentSize.size - endSizeMax - separatorSize) {
      parentCoord = parentSize.size - endSizeMax - separatorSize
    }
    distribute(separatorMap, realIndex, prevCoord - parentCoord) // + <-  - ->
    applyStyles()
    if ($panelstore.panel?.refit !== undefined) $panelstore.panel.refit()
  }

  function pointerUp (): void {
    finalSeparation()
    enableUserSelect()
    document.removeEventListener('pointermove', pointerMove)
    document.removeEventListener('pointerup', pointerUp)
  }
  function finalSeparation (): void {
    isSeparate = false
    if (sState === SeparatorState.NORMAL) {
      applyStyles(true)
      if (index !== -1 && separators != null && separatorMap != null) {
        const sep = toSeparators(separatorMap, separators, excludedIndexes, pxToRem)
        // Keep the in-memory config in step with the store, or a later panel swap resizes to the
        // sizes the panels had before this drag. saveSeparator bumps separatorsRevision, which is
        // how the other separators sharing this config pick the change up.
        separators = sep
        if (prevElementSize === undefined) prevElSize = sep[index] ?? prevElSize
        if (nextElementSize === undefined) nextElSize = sep[index + 1] ?? nextElSize
        revision = ($separatorsRevision[name] ?? 0) + 1
        saveSeparator(name, false, sep)
      }
    } else if (sState === SeparatorState.FLOAT && parentElement != null) {
      parentElement.style.pointerEvents = 'all'
      if (!checkFullWidth()) saveSeparator(name, float, panel)
    }
    document.body.style.cursor = ''
  }

  function pointerDown (event: PointerEvent): void {
    if (checkFullWidth()) return
    event.preventDefault()
    disableUserSelect()
    prepareSeparation(event)
    document.addEventListener('pointermove', pointerMove)
    document.addEventListener('pointerup', pointerUp)
  }
  function prepareSeparation (event: PointerEvent): void {
    if (parentElement == null) return
    if (sState === SeparatorState.FLOAT && parentElement === null) {
      checkParent()
      return
    } else if (sState === SeparatorState.NORMAL && (prevElement === null || nextElement === null)) {
      checkSibling()
      return
    }
    const p = parentElement.getBoundingClientRect()
    parentSize =
      direction === 'horizontal'
        ? { start: p.left, end: p.right, size: p.width }
        : { start: p.top, end: p.bottom, size: p.height }
    if (sState === SeparatorState.NORMAL) {
      calculateSeparators()
      generateMap()
      applyStyles(true)
      // Calculate offset based on separator's actual position after generateMap
      // prevCoord is the sum of all elements before separator + separators before
      const prevCoord: number =
        separatorMap
          .filter((f) => f.begin)
          .map((m) => m.size)
          .reduce((prev, a) => prev + a, 0) + separatorsWide.before
      const mousePos = direction === 'horizontal' ? event.clientX : event.clientY
      // offset = mouse position relative to where separator should be
      offset = mousePos - parentSize.start - prevCoord
    } else if (sState === SeparatorState.FLOAT) {
      offset = Math.round(direction === 'horizontal' ? event.offsetX : event.offsetY)
      preparePanel()
    }
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
  }

  /** Returns true when the siblings changed, i.e. the panels around the separator were replaced. */
  const checkSibling = (start: boolean = false): boolean => {
    if (separator == null) return false
    const prev = separator.previousElementSibling as HTMLElement | null
    const next = separator.nextElementSibling as HTMLElement | null
    const changed = prev !== prevElement || next !== nextElement
    if (start || changed) {
      prevElement = prev
      nextElement = next
    }
    if (separators != null && prevElement != null && separators[index]?.float !== undefined) {
      prevElement.setAttribute('data-float', separators[index].float ?? '')
    }
    if (separators != null && nextElement != null && separators[index + 1]?.float !== undefined) {
      nextElement.setAttribute('data-float', separators[index + 1].float ?? '')
    }
    return changed
  }
  const checkParent = (): void => {
    if (parentElement === null && separator != null) parentElement = separator.parentElement
    if (parentElement != null && typeof float === 'string') parentElement.setAttribute('data-float', float)
  }

  const clearContainer = (container: HTMLElement): void => {
    if (container === null) return
    if (container.hasAttribute('data-float')) container.removeAttribute('data-float')
    if (container.hasAttribute('data-size')) container.removeAttribute('data-size')
    if (container.hasAttribute('data-auto')) container.removeAttribute('data-auto')
    // Both axes: a direction switch has to drop the sizes the previous axis left behind.
    container.style.width = ''
    container.style.minWidth = ''
    container.style.maxWidth = ''
    container.style.height = ''
    container.style.minHeight = ''
    container.style.maxHeight = ''
  }
  const clearSibling = (): void => {
    if (separators != null && prevElement != null && separators[index].float !== undefined) {
      clearContainer(prevElement)
    }
    if (separators != null && nextElement != null && separators[index + 1].float !== undefined) {
      clearContainer(nextElement)
    }
  }
  const clearParent = (): void => {
    if (parentElement === null && separator != null) parentElement = separator.parentElement
    if (parentElement != null && typeof float === 'string') clearContainer(parentElement)
  }

  const calculateSeparators = (): void => {
    if (parentElement != null) {
      const elements: Element[] = Array.from(parentElement.children)
      separatorsSizes = elements
        .filter((el) => el.classList.contains('antiSeparator'))
        .map((el) => parseInt(el.getAttribute('data-size') ?? '0', 10))
      separatorsWide.total = separatorsSizes.reduce((prev, a) => prev + a, 0)
      separatorsWide.before = separatorsSizes.slice(0, index).reduce((prev, a) => prev + a, 0)
      separatorsWide.after = separatorsSizes.slice(index + 1, separatorsSizes.length).reduce((prev, a) => prev + a, 0)
    }
  }

  let checkElements: boolean = false
  const resizeDocument = (): void => {
    if (checkFullWidth()) checkSizes()
    if (parentElement == null || checkElements || sState !== SeparatorState.NORMAL) return
    checkElements = true
    setTimeout(() => {
      if (parentElement != null && separators != null) {
        const children: Element[] = Array.from(parentElement.children)
        let totalSize: number = 0
        let ind: number = 0
        const rects = new Map<number, { size: number, element: HTMLElement }>()
        const hasSep: string[] = []
        children.forEach((ch) => {
          const rect = ch.getBoundingClientRect()
          if (
            !ch.classList.contains('antiSeparator') &&
            (ch.hasAttribute('data-size') || ch.hasAttribute('data-auto'))
          ) {
            rects.set(ind++, {
              size: direction === 'horizontal' ? rect.width : rect.height,
              element: ch as HTMLElement
            })
          }
          if (ch.hasAttribute('data-float')) hasSep.push(ch.getAttribute('data-float') ?? '')
          totalSize += direction === 'horizontal' ? rect.width : rect.height
        })
        const parentRect = parentElement.getBoundingClientRect()
        let diff = totalSize - (direction === 'horizontal' ? parentRect.width : parentRect.height)
        if (diff > 0) {
          const excluded = separators
            .filter((separ) => separ.float !== undefined && !hasSep.includes(separ.float))
            .map((separ) => separ.float)
          const reverseSep = [...separators].reverse()
          reverseSep.forEach((separ, i) => {
            const pass = excluded.includes(separ.float)
            if (diff > 0 && !pass && separators != null) {
              const originalIndex = separators.length - 1 - i
              const box = rects.get(originalIndex - excluded.filter((_, idx) => idx <= originalIndex).length)
              if (box != null) {
                const minSize: number = remToPx(separ.minSize === 'auto' ? 20 : separ.minSize)
                const availableForCrop = box.size - minSize
                if (availableForCrop > 0) {
                  const actualCrop = Math.min(diff, availableForCrop)
                  const newSize = box.size - actualCrop
                  diff -= actualCrop
                  if (separ.maxSize !== 'auto') {
                    if (direction === 'horizontal') {
                      box.element.style.width = `${newSize}px`
                      box.element.style.minWidth = `${newSize}px`
                      box.element.style.maxWidth = `${newSize}px`
                    } else {
                      box.element.style.height = `${newSize}px`
                      box.element.style.minHeight = `${newSize}px`
                      box.element.style.maxHeight = `${newSize}px`
                    }
                  }
                  separators[originalIndex].size = pxToRem(newSize)
                }
              }
            }
          })
        }
      }
      checkElements = false
    }, 100)
  }

  onMount(() => {
    if (separator != null) {
      parentElement = separator.parentElement
      if (sState === SeparatorState.FLOAT) checkParent()
      else if (sState === SeparatorState.NORMAL) {
        checkSibling(true)
        calculateSeparators()
      }
      checkSizes()
      mounted = true
    }
    window.addEventListener('resize', resizeDocument)
    if (sState !== SeparatorState.FLOAT && $separatorsStore.filter((f) => f === name).length === 0) {
      $separatorsStore = [...$separatorsStore, name]
    }
  })
  onDestroy(() => {
    if (mounted) {
      if (sState === SeparatorState.FLOAT) clearParent()
      else if (sState === SeparatorState.NORMAL) clearSibling()
    }
    window.removeEventListener('resize', resizeDocument)
    if (sState !== SeparatorState.FLOAT && $separatorsStore.filter((f) => f === name).length > 0) {
      $separatorsStore = $separatorsStore.filter((f) => f !== name)
    }
  })
  afterUpdate(() => {
    if (mounted) {
      if (sState === SeparatorState.FLOAT) checkParent()
      // A swapped panel is a new DOM node with no sizes on it yet. Panels that already carry sizes
      // are left alone: re-applying the config to them fights whoever set those sizes.
      else if (sState === SeparatorState.NORMAL && checkSibling()) sizeNewSiblings()
    }
  })
  $: disabled = $separatorsStore.filter((f) => disabledWhen.findIndex((d) => d === f) !== -1).length > 0
  // Another separator on the same config saved new sizes: re-read them instead of keeping our copy.
  $: if (mounted && sState === SeparatorState.NORMAL && ($separatorsRevision[name] ?? 0) !== revision) {
    revision = $separatorsRevision[name] ?? 0
    fetchSeparators()
    checkSizes()
  }
  // The axis decides which CSS properties carry the sizes, so a switch has to redo them.
  $: if (mounted && direction !== appliedDirection) {
    appliedDirection = direction
    if (prevElement != null) clearContainer(prevElement)
    if (nextElement != null) clearContainer(nextElement)
    checkSizes()
  }
</script>

{#if sState !== SeparatorState.HIDDEN}
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    bind:this={separator}
    style:--separator-size={`${separatorSize}px`}
    style:background-color={color}
    style:pointer-events={disabled ? 'none' : 'all'}
    class="antiSeparator {direction}"
    class:short
    class:hovered={isSeparate}
    data-size={separatorSize}
    on:pointerdown|stopPropagation={pointerDown}
  />
{/if}

<style lang="scss">
  .antiSeparator {
    position: relative;
    flex-shrink: 0;
    touch-action: none;

    &::after,
    &::before {
      position: absolute;
      content: '';
      z-index: 402;
    }
    &::after {
      background-color: var(--primary-button-default);
      transform-origin: center;
      transition-property: transform;
      transition-timing-function: ease-in-out;
      transition-duration: 0.1s;
      transition-delay: 0s;
    }
    &.hovered::after,
    &:hover::after {
      transition-duration: 0.15s;
      transition-delay: 0.25s;
    }
    &.horizontal {
      width: var(--separator-size, 1px);
      max-width: var(--separator-size, 1px);
      cursor: col-resize;

      &:not(.short) {
        height: 100%;
      }
      &.short {
        height: calc(100% - 1rem);
        margin-top: 0.5rem;
      }
      &::after,
      &::before {
        top: 0;
        left: -2px;
        width: calc(4px + var(--separator-size, 1px));
        height: 100%;
      }
      &::after {
        transform: scaleX(0);
      }
      &.hovered::after,
      &:hover::after {
        transform: scaleX(1);
      }
    }
    &.vertical {
      height: var(--separator-size, 1px);
      max-height: var(--separator-size, 1px);
      cursor: row-resize;

      &:not(.short) {
        width: 100%;
      }
      &.short {
        width: calc(100% - 1rem);
        margin-left: 0.5rem;
      }
      &::after,
      &::before {
        top: -2px;
        left: 0;
        width: 100%;
        height: calc(4px + var(--separator-size, 1px));
      }
      &::after {
        transform: scaleY(0);
      }
      &.hovered::after,
      &:hover::after {
        transform: scaleY(1);
      }
    }
  }
</style>

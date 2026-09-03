<!--
// Copyright © 2022 Hardcore Engineering Inc.
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
-->
<script lang="ts">
  import {
    CategoryType,
    Class,
    Doc,
    DocumentQuery,
    DocumentUpdate,
    FindOptions,
    type Rank,
    RateLimiter,
    Ref,
    Space
  } from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import { makeRank } from '@hcengineering/rank'
  import { IconChevronDown, IconChevronRight, Scroller, themeStore, defaultBackground } from '@hcengineering/ui'
  import { createEventDispatcher, onDestroy, tick } from 'svelte'
  import { CardDragEvent, DocWithRank, Item, SwimLane } from '../types'
  import KanbanRow from './KanbanRow.svelte'

  export let categories: CategoryType[] = []

  export let _class: Ref<Class<DocWithRank>>
  export let space: Ref<Space> | undefined = undefined
  export let query: DocumentQuery<DocWithRank> = {}
  export let options: FindOptions<DocWithRank> | undefined = undefined
  export let objects: DocWithRank[] = []
  export let groupByKey: any

  export let groupByDocs: Record<string | number, Item[]>
  export let getGroupByValues: (groupByDocs: Record<string | number, Item[]>, category: CategoryType) => Item[]
  export let setGroupByValues: (
    groupByDocs: Record<string | number, Item[]>,
    category: CategoryType,
    docs: Item[]
  ) => void

  export let selection: number | undefined = undefined
  export let checked: Doc[] = []
  export let dontUpdateRank: boolean = false
  export let orderBy: [string, 1 | -1] | undefined = undefined
  export let onMoveCommit: ((id: string, fields: Record<string, unknown>) => void) | undefined = undefined
  export let onMoveRollback: ((id: string) => void) | undefined = undefined

  export let getUpdateProps: (doc: Doc, state: CategoryType) => DocumentUpdate<Item> | undefined
  export let getAvailableCategories: ((doc: Doc) => Promise<CategoryType[]>) | undefined = undefined

  // SwimLane support. When empty - classic kanban layout (legacy).
  export let swimLanes: SwimLane[] = []
  export let swimLaneKey: string | undefined = undefined
  export let getSwimLaneUpdateProps: ((doc: Doc, swimLane: SwimLane) => DocumentUpdate<Item> | undefined) | undefined =
    undefined
  export let getSwimLaneQuery: ((swimLane: SwimLane) => DocumentQuery<DocWithRank>) | undefined = undefined
  export let getSwimLaneOfDoc: ((doc: Doc) => string | undefined) | undefined = undefined
  export let storageKey: string | undefined = undefined
  export let controlKey: string | undefined = undefined
  export let getSwimLaneHeaderStyle:
  | ((swimLane: SwimLane) => { background?: string, color?: string } | undefined)
  | undefined = undefined
  export let compact: boolean = false

  import { registerSwimLaneControls } from '../swimlane'

  let unregisterControls: (() => void) | undefined

  $: if (swimLaneMode && controlKey !== undefined) {
    if (unregisterControls !== undefined) unregisterControls()
    unregisterControls = registerSwimLaneControls(controlKey, { collapseAll, expandAll })
  } else {
    if (unregisterControls !== undefined) {
      unregisterControls()
      unregisterControls = undefined
    }
  }

  onDestroy(() => {
    if (unregisterControls !== undefined) {
      unregisterControls()
      unregisterControls = undefined
    }
  })

  const dispatch = createEventDispatcher()

  const limiter = new RateLimiter(10)

  $: swimLaneMode = swimLanes.length > 0 && swimLaneKey !== undefined

  // Collapse state persisted in localStorage.
  let collapsed = new Set<string>()

  function loadCollapsed (key: string | undefined): Set<string> {
    if (key === undefined || typeof localStorage === 'undefined') return new Set()
    try {
      const raw = localStorage.getItem(`kanban-swimlane-collapsed-${key}`)
      if (raw == null) return new Set()
      const arr: string[] = JSON.parse(raw)
      return new Set(arr)
    } catch {
      return new Set()
    }
  }

  function saveCollapsed (key: string | undefined, set: Set<string>): void {
    if (key === undefined || typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(`kanban-swimlane-collapsed-${key}`, JSON.stringify([...set]))
    } catch {
      // ignore
    }
  }

  $: collapsed = loadCollapsed(storageKey)

  function toggleSwimLane (id: string): void {
    if (collapsed.has(id)) collapsed.delete(id)
    else collapsed.add(id)
    collapsed = new Set(collapsed)
    saveCollapsed(storageKey, collapsed)
  }

  function collapseAll (): void {
    collapsed = new Set(swimLanes.map((s) => s._id))
    saveCollapsed(storageKey, collapsed)
  }

  function expandAll (): void {
    collapsed = new Set()
    saveCollapsed(storageKey, collapsed)
  }

  // Filter docs of a category that belong to a given swim lane.
  function getSwimLaneCategoryValues (
    swimLane: SwimLane,
    category: CategoryType,
    _groupByDocs: typeof groupByDocs,
    _dragCard: Item | undefined,
    _dragCardCurrentSwimLane: SwimLane | undefined,
    _dragCardState: CategoryType | undefined,
    _dragCardTargetIndex: number | undefined
  ): Item[] {
    const raw = getGroupByValues(_groupByDocs, category) ?? []
    const ofDoc = getSwimLaneOfDoc
    const inThisLane =
      _dragCard !== undefined &&
      _dragCardCurrentSwimLane !== undefined &&
      _dragCardCurrentSwimLane._id === swimLane._id &&
      _dragCardState === category
    const isOriginal =
      _dragCard !== undefined &&
      dragCardInitialSwimLane !== undefined &&
      dragCardInitialSwimLane._id === swimLane._id &&
      dragCardInitialState === category
    if (inThisLane && isOriginal && _dragCardTargetIndex === undefined) {
      // Card stays at its original position in the original cell — no filtering of dragCard.
      return ofDoc === undefined ? raw : raw.filter((doc) => doc._id === _dragCard?._id || ofDoc(doc) === swimLane._id)
    }
    const arr = raw.filter((doc) => doc._id !== _dragCard?._id)
    const filtered = ofDoc === undefined ? arr : arr.filter((doc) => ofDoc(doc) === swimLane._id)
    if (inThisLane && _dragCard !== undefined) {
      const idx = _dragCardTargetIndex
      if (idx !== undefined && idx >= 0 && idx <= filtered.length) {
        return [...filtered.slice(0, idx), _dragCard, ...filtered.slice(idx)]
      }
      return [...filtered, _dragCard]
    }
    return filtered
  }

  // Legacy (non-swimlane) cell values. Returns raw cell content unchanged during
  // drag — drag preview is shown via a CSS drop-zone highlight on the target
  // column, not by relocating the card in the DOM. This avoids a Svelte reactivity
  // cascade across every column on every dragover and keeps drag interaction smooth.
  function getLegacyCategoryValues (category: CategoryType, _groupByDocs: typeof groupByDocs): Item[] {
    return getGroupByValues(_groupByDocs, category) ?? []
  }

  function countSwimLane (swimLane: SwimLane): number {
    let total = 0
    for (const cat of categories) {
      total += getSwimLaneCategoryValues(
        swimLane,
        cat,
        groupByDocs,
        dragCard,
        dragCardCurrentSwimLane,
        dragCardState,
        dragCardTargetIndex
      ).length
    }
    return total
  }

  async function move (state: CategoryType, targetSwimLane?: SwimLane): Promise<void> {
    if (dragCard === undefined) {
      return
    }

    const canDrop = dragCardAvailableCategories === undefined || dragCardAvailableCategories.includes(state)

    if (!canDrop) {
      dragCard = undefined
      dragCardAvailableCategories = undefined
      return
    }

    let updates = getUpdateProps(dragCard, state)

    if (updates === undefined) {
      panelDragLeave(undefined, dragCardState)
      dragCard = undefined
      dragCardAvailableCategories = undefined
      return
    }

    // Apply swim lane field update via plain update — diffUpdate ignores attachedTo/space.
    let swimUpdates: DocumentUpdate<Item> | undefined
    if (
      swimLaneMode &&
      targetSwimLane !== undefined &&
      getSwimLaneUpdateProps !== undefined &&
      (dragCardInitialSwimLane === undefined || dragCardInitialSwimLane._id !== targetSwimLane._id)
    ) {
      swimUpdates = getSwimLaneUpdateProps(dragCard, targetSwimLane)
    }

    if (!dontUpdateRank) {
      // Compute target rank from neighbours of the target cell (lane+state).
      let prevRank: Rank | undefined
      let nextRank: Rank | undefined
      if (swimLaneMode && targetSwimLane !== undefined) {
        const visible = getSwimLaneCategoryValues(
          targetSwimLane,
          state,
          groupByDocs,
          dragCard,
          targetSwimLane,
          state,
          dragCardTargetIndex
        )
        const idx = visible.findIndex((p) => p._id === dragCard?._id)
        if (idx !== -1) {
          prevRank = visible[idx - 1]?.rank
          nextRank = visible[idx + 1]?.rank
        } else if (dragCardTargetIndex !== undefined) {
          const without = visible.filter((p) => p._id !== dragCard?._id)
          prevRank = without[dragCardTargetIndex - 1]?.rank
          nextRank = without[dragCardTargetIndex]?.rank
        }
      } else {
        const arr = getGroupByValues(groupByDocs, state) ?? []
        const filtered = arr.filter((d) => d._id !== dragCard?._id)
        const originalIdx = arr.findIndex((d) => d._id === dragCard?._id)
        const fallback = originalIdx === -1 ? filtered.length : originalIdx
        const idx = dragCardTargetIndex ?? fallback
        prevRank = filtered[idx - 1]?.rank
        nextRank = filtered[idx]?.rank
      }
      if (prevRank !== undefined || nextRank !== undefined) {
        const newRank = makeRank(prevRank, nextRank)
        if (newRank !== dragCardInitialRank && newRank !== dragCard.rank) {
          updates = { ...updates, rank: newRank }
        }
      } else if (dragCardInitialRank !== dragCard.rank && dragCardInitialRank !== undefined) {
        updates = { ...updates, rank: dragCard.rank }
      }
    }
    // Build the diff against current card values. Do NOT mutate the card —
    // optimistic positioning is handled via onMoveCommit (pendingMoves overlay
    // in the host component), which keeps live-query in charge of the actual
    // card state until the server confirms.
    const movedCard = dragCard
    const rawMerged: DocumentUpdate<Item> = { ...updates, ...(swimUpdates ?? {}) }
    const cardValues = movedCard as unknown as Record<string, unknown>
    const merged = Object.fromEntries(
      Object.entries(rawMerged).filter(([key, value]) => cardValues[key] !== value)
    ) as DocumentUpdate<Item>

    if (Object.keys(merged).length > 0) {
      // Optimistic overlay in the host (KanbanView) keeps the moved card in
      // its new column/rank until the live-query roundtrip lands; the actual
      // card data stays under live-query control.
      onMoveCommit?.(movedCard._id, merged as Record<string, unknown>)
    }
    // Restore focus on the just-moved card so keyboard navigation continues
    // from there, mirroring the mouse-hover focus path.
    dispatch('obj-focus', { ...movedCard, ...merged })
    if (Object.keys(merged).length > 0) {
      try {
        await client.update(dragCard, merged)
      } catch (err) {
        onMoveRollback?.(movedCard._id)
      }
    }
    dragCard = undefined
    dragCardAvailableCategories = undefined
    dragCardCurrentSwimLane = undefined
    dragCardTargetIndex = undefined
  }

  const client = getClient()

  let dragCard: Item | undefined
  let dragCardInitialRank: Rank | undefined
  let dragCardInitialState: CategoryType
  let dragCardState: CategoryType | undefined
  let dragCardAvailableCategories: CategoryType[] | undefined
  let dragCardInitialSwimLane: SwimLane | undefined
  let dragCardCurrentSwimLane: SwimLane | undefined
  // Insertion index of dragCard within target lane cell (swimlane mode). Undefined = append at end.
  let dragCardTargetIndex: number | undefined

  let isDragging = false

  // Auto-scroll on edge during drag.
  let scrollerEl: HTMLElement | undefined
  let autoScrollRaf: number | undefined
  let lastDragX = 0
  let lastDragY = 0
  const EDGE_PX = 60
  const MAX_STEP = 24

  function autoScrollTick (): void {
    autoScrollRaf = undefined
    if (!isDragging || scrollerEl === undefined) return
    const r = scrollerEl.getBoundingClientRect()
    let dx = 0
    let dy = 0
    if (lastDragX - r.left < EDGE_PX) {
      dx = -Math.ceil(((EDGE_PX - (lastDragX - r.left)) / EDGE_PX) * MAX_STEP)
    } else if (r.right - lastDragX < EDGE_PX) {
      dx = Math.ceil(((EDGE_PX - (r.right - lastDragX)) / EDGE_PX) * MAX_STEP)
    }
    if (lastDragY - r.top < EDGE_PX) {
      dy = -Math.ceil(((EDGE_PX - (lastDragY - r.top)) / EDGE_PX) * MAX_STEP)
    } else if (r.bottom - lastDragY < EDGE_PX) {
      dy = Math.ceil(((EDGE_PX - (r.bottom - lastDragY)) / EDGE_PX) * MAX_STEP)
    }
    if (dx !== 0) scrollerEl.scrollLeft += dx
    if (dy !== 0) scrollerEl.scrollTop += dy
    if (isDragging && (dx !== 0 || dy !== 0)) autoScrollRaf = requestAnimationFrame(autoScrollTick)
  }

  function handleDragMove (e: DragEvent): void {
    if (!isDragging) return
    lastDragX = e.clientX
    lastDragY = e.clientY
    if (autoScrollRaf === undefined) autoScrollRaf = requestAnimationFrame(autoScrollTick)
  }

  function stopAutoScroll (): void {
    if (autoScrollRaf !== undefined) {
      cancelAnimationFrame(autoScrollRaf)
      autoScrollRaf = undefined
    }
  }

  async function updateDone (updateValue: DocumentUpdate<Item>): Promise<void> {
    isDragging = false
    if (dragCard === undefined) {
      return
    }
    await client.update(dragCard, updateValue)
  }

  function panelDragOver (event: Event | undefined, state: CategoryType, swimLane?: SwimLane): void {
    event?.preventDefault()
    if (dragCard === undefined) return

    const swimLaneChanged =
      swimLane !== undefined && (dragCardCurrentSwimLane === undefined || dragCardCurrentSwimLane._id !== swimLane._id)

    if (dragCardState !== state || swimLaneChanged) {
      const canDrop = dragCardAvailableCategories === undefined || dragCardAvailableCategories.includes(state)

      if (!canDrop) {
        return
      }

      const updates = getUpdateProps(dragCard, state)
      if (updates === undefined) {
        return
      }

      if (dragCardState !== state) {
        if (!swimLaneMode) {
          // Move dragCard into the target column synchronously via groupByDocs
          // mutation so Svelte renders it in its new column on the next tick.
          // Strip dragCard from EVERY category first to prevent duplicate-key
          // errors if a transient parent rebuild re-injected it elsewhere.
          for (const cat of categories) {
            const a = getGroupByValues(groupByDocs, cat) ?? []
            const i = a.findIndex((p) => p._id === dragCard?._id)
            if (i !== -1) {
              a.splice(i, 1)
              setGroupByValues(groupByDocs, cat, a)
            }
          }
          const arr = getGroupByValues(groupByDocs, state) ?? []
          arr.push(dragCard)
          setGroupByValues(groupByDocs, state, arr)
        }
        dragCardState = state
        dragCardTargetIndex = dontUpdateRank && orderBy?.[1] === -1 ? 0 : undefined
      }

      if (swimLaneChanged) {
        dragCardCurrentSwimLane = swimLane
        dragCardTargetIndex = dontUpdateRank && orderBy?.[1] === -1 ? 0 : undefined
      }
      groupByDocs = groupByDocs
    }
  }
  function panelDragLeave (event: Event | undefined, state: CategoryType): void {
    event?.preventDefault()
    // Legacy preview is render-only via getLegacyCategoryValues — no restore needed.
  }

  function dragswap (ev: MouseEvent, i: number, s: number): boolean {
    if (s === -1) return false
    if (i < s) {
      return ev.offsetY < (ev.target as HTMLElement).offsetHeight / 2
    } else if (i > s) {
      return ev.offsetY > (ev.target as HTMLElement).offsetHeight / 2
    }
    return false
  }

  function cardDragOver (evt: CardDragEvent, object: Item, state: CategoryType): void {
    if (dragCardAvailableCategories !== undefined && !dragCardAvailableCategories.includes(state)) {
      return
    }
    if (swimLaneMode) {
      if (dragCard === undefined) return
      if (object._id === dragCard._id) return
      const lane = dragCardCurrentSwimLane
      if (lane === undefined) return
      const visible = getSwimLaneCategoryValues(lane, state, groupByDocs, dragCard, lane, state, dragCardTargetIndex)
      const targetIdx = visible.findIndex((p) => p._id === object._id)
      const dragIdx = visible.findIndex((p) => p._id === dragCard?._id)
      if (targetIdx === -1) return
      const insertAfter = dragswap(evt, targetIdx, dragIdx)
      if (!insertAfter) return
      const desired = dragIdx === -1 || dragIdx > targetIdx ? targetIdx : targetIdx + 1
      const without = visible.filter((p) => p._id !== dragCard?._id)
      let mapped = desired
      if (dragIdx !== -1 && dragIdx < desired) mapped = desired - 1
      if (mapped < 0) mapped = 0
      if (mapped > without.length) mapped = without.length
      if (dragCardTargetIndex !== mapped) {
        dragCardTargetIndex = mapped
        groupByDocs = groupByDocs
      }
      return
    }
    if (dragCard !== undefined) {
      const updates = getUpdateProps(dragCard, state)
      if (updates === undefined) {
        return
      }
      if (object._id === dragCard._id) return
      const arr = getGroupByValues(groupByDocs, state) ?? []
      const targetIdx = arr.findIndex((p) => p._id === object._id)
      const dragIdx = arr.findIndex((p) => p._id === dragCard?._id)
      if (targetIdx === -1) return
      const targetEl: HTMLElement | null = (evt.target as HTMLElement).closest('[data-card-id]')
      const beforeTarget = (() => {
        const h = (evt.target as HTMLElement)?.offsetHeight ?? targetEl?.offsetHeight ?? 0
        return evt.offsetY < h / 2
      })()
      const desired = beforeTarget ? targetIdx : targetIdx + 1
      const withoutLen = arr.length - (dragIdx !== -1 ? 1 : 0)
      let mapped = desired
      if (dragIdx !== -1 && dragIdx < desired) mapped = desired - 1
      if (mapped < 0) mapped = 0
      if (mapped > withoutLen) mapped = withoutLen
      // Reorder dragCard inside the column array so Svelte can render the
      // preview without any imperative DOM placeholder. Strip ALL occurrences
      // of dragCard before insertion to defend against any transient parent
      // rebuild that may have re-added it.
      if (mapped !== dragIdx) {
        const next = arr.filter((p) => p._id !== dragCard?._id)
        const insertAt = Math.max(0, Math.min(mapped, next.length))
        next.splice(insertAt, 0, dragCard)
        setGroupByValues(groupByDocs, state, next)
        groupByDocs = groupByDocs
        dragCardTargetIndex = mapped
      }
    }
  }

  async function cardDrop (evt: CardDragEvent, object: Item, state: CategoryType, swimLane?: SwimLane): Promise<void> {
    if (dragCard !== undefined) {
      const canDrop = dragCardAvailableCategories === undefined || dragCardAvailableCategories.includes(state)
      if (!canDrop) {
        dragCard = undefined
        dragCardAvailableCategories = undefined
        isDragging = false
        return
      }
      let updates: DocumentUpdate<Item> | undefined
      // Drop on the source card itself with no movement: skip rank update entirely.
      const droppedOnSelf = object._id === dragCard._id && dragCardTargetIndex === undefined
      const stateChanged = dragCardInitialState !== state
      // Always pick up state-mapped fields (status, space) when the column or
      // anything else changed — even if rank can't be derived (empty cell).
      if (stateChanged || !droppedOnSelf) {
        const stateUpdates = getUpdateProps(dragCard, state)
        if (stateUpdates !== undefined) updates = stateUpdates
      }
      if (!dontUpdateRank && !droppedOnSelf) {
        let prevRank: Rank | undefined
        let nextRank: Rank | undefined
        if (swimLaneMode && swimLane !== undefined) {
          const visible = getSwimLaneCategoryValues(
            swimLane,
            state,
            groupByDocs,
            dragCard,
            swimLane,
            state,
            dragCardTargetIndex
          )
          const idx = visible.findIndex((p) => p._id === dragCard?._id)
          if (idx !== -1) {
            prevRank = visible[idx - 1]?.rank
            nextRank = visible[idx + 1]?.rank
          }
        } else {
          const arr = getGroupByValues(groupByDocs, state) ?? []
          const filtered = arr.filter((d) => d._id !== dragCard?._id)
          const originalIdx = arr.findIndex((d) => d._id === dragCard?._id)
          const fallback = originalIdx === -1 ? filtered.length : originalIdx
          const idx = dragCardTargetIndex ?? fallback
          prevRank = filtered[idx - 1]?.rank
          nextRank = filtered[idx]?.rank
        }
        if (prevRank !== undefined || nextRank !== undefined) {
          const newRank = makeRank(prevRank, nextRank)
          updates = { ...(updates ?? {}), rank: newRank }
        }
      }
      let swimUpdates: DocumentUpdate<Item> | undefined
      if (
        swimLaneMode &&
        swimLane !== undefined &&
        getSwimLaneUpdateProps !== undefined &&
        (dragCardInitialSwimLane === undefined || dragCardInitialSwimLane._id !== swimLane._id)
      ) {
        swimUpdates = getSwimLaneUpdateProps(dragCard, swimLane)
      }
      // Register optimistic overlay BEFORE awaiting server — so the live-query
      // snapshot doesn't snap the card back to its old position while the update
      // is in flight.
      const overlay: Record<string, unknown> = { ...(updates ?? {}), ...(swimUpdates ?? {}) }
      if (Object.keys(overlay).length > 0) {
        onMoveCommit?.(dragCard._id, overlay)
      }
      // Restore focus on the just-moved card so keyboard navigation continues
      // from there, mirroring the mouse-hover focus path.
      dispatch('obj-focus', { ...dragCard, ...overlay })
      try {
        if (updates !== undefined && Object.keys(updates).length > 0) {
          await client.diffUpdate(dragCard, updates)
        }
        if (swimUpdates !== undefined && Object.keys(swimUpdates).length > 0) {
          await client.update(dragCard, swimUpdates)
        }
      } catch (err) {
        onMoveRollback?.(dragCard._id)
      }
    }
    isDragging = false
  }

  async function onDragStart (object: Item, state: CategoryType, swimLane?: SwimLane): Promise<void> {
    dragCardInitialState = state
    dragCardState = state
    dragCardInitialRank = object.rank
    dragCardInitialSwimLane = swimLane
    dragCardCurrentSwimLane = swimLane
    dragCard = object
    isDragging = true
    dragCardTargetIndex = undefined
    const available = await getAvailableCategories?.(object)
    if (isDragging) {
      dragCardAvailableCategories = available
    }
  }

  function onDragEnd (): void {
    isDragging = false
    dragCard = undefined
    dragCardAvailableCategories = undefined
    stopAutoScroll()
  }
  // eslint-disable-next-line
  let dragged: boolean = false

  function toAny (object: any): any {
    return object
  }

  const stateRefs: HTMLElement[] = []
  const stateRows: KanbanRow[] = []
  const swimRowBindings: Record<string, KanbanRow> = {}

  $: stateRefs.length = categories.length
  $: stateRows.length = categories.length

  function swimCellKey (laneId: string, stateIdx: number): string {
    return `${laneId}::${stateIdx}`
  }

  function scrollInto (statePos: number, obj: Item, lane?: SwimLane): void {
    if (swimLaneMode && lane !== undefined) {
      swimRowBindings[swimCellKey(lane._id, statePos)]?.scroll(obj)
      return
    }
    stateRefs[statePos]?.scrollIntoView({ behavior: 'auto', block: 'nearest' })
    stateRows[statePos]?.scroll(obj)
  }

  function getState (doc: Item): number {
    let pos = 0
    for (const st of categories) {
      const stateObjs = getGroupByValues(groupByDocs, st) ?? []
      if (stateObjs.findIndex((it) => it._id === doc._id) !== -1) {
        return pos
      }
      pos++
    }
    return -1
  }

  function findSwimLaneOfDoc (doc: Doc): SwimLane | undefined {
    if (!swimLaneMode || getSwimLaneOfDoc === undefined) return undefined
    const id = getSwimLaneOfDoc(doc)
    if (id === undefined) return undefined
    return swimLanes.find((s) => s._id === id)
  }

  function visibleSwimLanes (): SwimLane[] {
    return swimLanes.filter((s) => !collapsed.has(s._id))
  }

  function getCellObjects (st: CategoryType, lane?: SwimLane): Item[] {
    if (swimLaneMode && lane !== undefined) {
      return getSwimLaneCategoryValues(
        lane,
        st,
        groupByDocs,
        dragCard,
        dragCardCurrentSwimLane,
        dragCardState,
        dragCardTargetIndex
      )
    }
    return getGroupByValues(groupByDocs, st) ?? []
  }

  export function select (offset: 1 | -1 | 0, of?: Doc, dir?: 'vertical' | 'horizontal'): void {
    let pos = (of != null ? objects.findIndex((it) => it._id === of._id) : selection) ?? -1
    if (pos === -1) {
      const lanes = swimLaneMode ? visibleSwimLanes() : [undefined as SwimLane | undefined]
      for (const lane of lanes) {
        let found = false
        for (const st of categories) {
          const stateObjs = getCellObjects(st, lane)
          if (stateObjs.length > 0) {
            pos = objects.findIndex((it) => it._id === stateObjs[0]._id)
            found = true
            break
          }
        }
        if (found) break
      }
    }

    if (pos < 0) {
      pos = 0
    }
    if (pos >= objects.length) {
      pos = objects.length - 1
    }

    const obj = objects[pos]
    if (obj === undefined) {
      return
    }

    let objState = getState(obj)
    if (objState === -1) {
      return
    }

    const currentLane: SwimLane | undefined = swimLaneMode ? findSwimLaneOfDoc(obj) : undefined
    const stateObjs = getCellObjects(categories[objState], currentLane)
    const statePos = stateObjs.findIndex((it) => it._id === obj._id)
    if (statePos === undefined) {
      return
    }

    const lanes = swimLaneMode ? visibleSwimLanes() : []
    const laneIdx = currentLane !== undefined ? lanes.findIndex((l) => l._id === currentLane?._id) : -1

    if (offset === -1) {
      if (dir === undefined || dir === 'vertical') {
        if (statePos > 0) {
          const next = stateObjs[statePos - 1]
          scrollInto(objState, next, currentLane)
          dispatch('obj-focus', next)
          return
        }
        // cross lanes upward in same column
        if (swimLaneMode && laneIdx > 0) {
          for (let i = laneIdx - 1; i >= 0; i--) {
            const arr = getCellObjects(categories[objState], lanes[i])
            if (arr.length > 0) {
              const next = arr[arr.length - 1]
              scrollInto(objState, next, lanes[i])
              dispatch('obj-focus', next)
              return
            }
          }
        }
        const next = stateObjs[0]
        if (next !== undefined) {
          scrollInto(objState, next, currentLane)
          dispatch('obj-focus', next)
        }
        return
      } else {
        while (objState > 0) {
          objState--
          const nstateObjs = getCellObjects(categories[objState], currentLane)
          if (nstateObjs.length > 0) {
            const next = nstateObjs[statePos] ?? nstateObjs[nstateObjs.length - 1]
            scrollInto(objState, next, currentLane)
            dispatch('obj-focus', next)
            break
          }
        }
      }
    }
    if (offset === 1) {
      if (dir === undefined || dir === 'vertical') {
        if (statePos < stateObjs.length - 1) {
          const next = stateObjs[statePos + 1]
          scrollInto(objState, next, currentLane)
          dispatch('obj-focus', next)
          return
        }
        if (swimLaneMode && laneIdx !== -1 && laneIdx < lanes.length - 1) {
          for (let i = laneIdx + 1; i < lanes.length; i++) {
            const arr = getCellObjects(categories[objState], lanes[i])
            if (arr.length > 0) {
              const next = arr[0]
              scrollInto(objState, next, lanes[i])
              dispatch('obj-focus', next)
              return
            }
          }
        }
        const next = stateObjs[stateObjs.length - 1]
        if (next !== undefined) {
          scrollInto(objState, next, currentLane)
          dispatch('obj-focus', next)
        }
        return
      } else {
        while (objState < categories.length - 1) {
          objState++
          const nstateObjs = getCellObjects(categories[objState], currentLane)
          if (nstateObjs.length > 0) {
            const next = nstateObjs[statePos] ?? nstateObjs[nstateObjs.length - 1]
            scrollInto(objState, next, currentLane)
            dispatch('obj-focus', next)
            break
          }
        }
      }
    }
    if (offset === 0) {
      // scrollInto(objState, obj)
      dispatch('obj-focus', obj)
    }
  }

  $: checkedSet = new Set<Ref<Doc>>(checked.map((it) => it._id))

  export function check (docs: Doc[], value: boolean): void {
    dispatch('check', { docs, value })
  }
  function stateKey (state: CategoryType): string {
    return String(typeof state === 'object' ? state.name : state)
  }
  const showMenu = async (evt: MouseEvent, object: Item): Promise<void> => {
    selection = objects.findIndex((p) => p._id === object._id)
    if (!checkedSet.has(object._id)) {
      check(objects, false)
      checked = []
    }
    dispatch('contextmenu', { evt, objects: checked.length > 0 ? checked : object })
  }
</script>

<div
  class="kanban-container"
  class:swimlane-mode={swimLaneMode}
  class:compact
  on:dragover={handleDragMove}
  on:dragend={onDragEnd}
  on:drop={onDragEnd}
>
  {#if swimLaneMode}
    <Scroller horizontal bind:divScroll={scrollerEl}>
      <div class="kanban-swimlane-root">
        <!-- sticky column headers row -->
        <div
          class="swimlane-header-row"
          style:--kanban-col-count={categories.length}
          style:--swimlane-row-bg={defaultBackground($themeStore.dark)}
        >
          {#each categories as state, si (typeof state === 'object' ? state.name : state)}
            {@const stateObjects = getGroupByValues(groupByDocs, state)}
            <div
              class="swimlane-col-header"
              class:drop-allowed={isDragging &&
                (dragCardAvailableCategories === undefined || dragCardAvailableCategories.includes(state))}
              class:drop-disabled={isDragging &&
                dragCardAvailableCategories !== undefined &&
                !dragCardAvailableCategories.includes(state)}
            >
              {#if $$slots.header !== undefined}
                {#key si}
                  <slot name="header" state={toAny(state)} count={stateObjects.length} index={si} />
                {/key}
              {/if}
            </div>
          {/each}
        </div>

        {#each swimLanes as swimLane (swimLane._id)}
          {@const isCollapsed = collapsed.has(swimLane._id)}
          {@const laneCount = countSwimLane(swimLane)}
          {@const laneStyle = getSwimLaneHeaderStyle?.(swimLane)}
          <div class="swimlane-block" data-id="kanban-swimlane" data-swimlane-id={swimLane._id}>
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div
              class="swimlane-header"
              data-id="kanban-swimlane-header"
              data-swimlane-collapsed={isCollapsed ? 'true' : 'false'}
              style:--swimlane-header-bg={laneStyle?.background ?? defaultBackground($themeStore.dark)}
              style:color={laneStyle?.color ?? 'var(--theme-caption-color)'}
              style:--swimlane-title-color={laneStyle?.color}
              on:click={() => {
                toggleSwimLane(swimLane._id)
              }}
            >
              <div class="swimlane-toggle">
                <svelte:component this={isCollapsed ? IconChevronRight : IconChevronDown} size={'small'} />
              </div>
              {#if $$slots.swimLaneHeader !== undefined}
                <slot
                  name="swimLaneHeader"
                  {swimLane}
                  count={laneCount}
                  collapsed={isCollapsed}
                  toggle={() => {
                    toggleSwimLane(swimLane._id)
                  }}
                />
              {:else}
                <span class="swimlane-title">{swimLane.title}</span>
                <span class="swimlane-count">{laneCount}</span>
              {/if}
            </div>

            {#if !isCollapsed}
              <div class="swimlane-grid" style:--kanban-col-count={categories.length}>
                {#each categories as state, si (typeof state === 'object' ? state.name : state)}
                  {@const laneStateObjects = getSwimLaneCategoryValues(
                    swimLane,
                    state,
                    groupByDocs,
                    dragCard,
                    dragCardCurrentSwimLane,
                    dragCardState,
                    dragCardTargetIndex
                  )}
                  <!-- svelte-ignore a11y-no-static-element-interactions -->
                  <div
                    class="swimlane-cell"
                    class:drop-target={isDragging}
                    class:drop-allowed={isDragging &&
                      (dragCardAvailableCategories === undefined || dragCardAvailableCategories.includes(state))}
                    class:drop-disabled={isDragging &&
                      dragCardAvailableCategories !== undefined &&
                      !dragCardAvailableCategories.includes(state)}
                    data-id="kanban-swimlane-cell"
                    data-swimlane-id={swimLane._id}
                    data-state={stateKey(state)}
                    on:dragover={(event) => {
                      panelDragOver(event, state, swimLane)
                    }}
                    on:drop={() => {
                      void move(state, swimLane).then(() => {
                        isDragging = false
                      })
                    }}
                  >
                    <slot name="beforeCard" {state} {swimLane} />
                    <KanbanRow
                      bind:this={swimRowBindings[swimCellKey(swimLane._id, si)]}
                      on:obj-focus
                      stateObjects={laneStateObjects}
                      {isDragging}
                      {dragCard}
                      {objects}
                      {selection}
                      {checkedSet}
                      {state}
                      {limiter}
                      cardDragOver={(evt, obj) => {
                        cardDragOver(evt, obj, state)
                      }}
                      cardDrop={(evt, obj) => {
                        void cardDrop(evt, obj, state, swimLane)
                      }}
                      onDragStart={(obj, st) => {
                        void onDragStart(obj, st, swimLane)
                      }}
                      {showMenu}
                      {_class}
                      {query}
                      {options}
                      {groupByKey}
                      swimLaneQuery={getSwimLaneQuery?.(swimLane)}
                      initialLimit={3}
                      limitStep={10}
                    >
                      <svelte:fragment slot="card" let:object let:dragged>
                        <slot name="card" {object} {dragged} {swimLane} />
                      </svelte:fragment>
                    </KanbanRow>

                    <slot name="afterCard" {state} {swimLane} />
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </Scroller>
  {:else}
    <Scroller horizontal contentDirection="horizontal" align="stretch" noStretch={false} bind:divScroll={scrollerEl}>
      <div class="kanban-content">
        {#each categories as state, si (typeof state === 'object' ? state.name : state)}
          {@const stateObjects = getLegacyCategoryValues(state, groupByDocs)}

          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div
            class="panel-container"
            class:drop-allowed={isDragging &&
              (dragCardAvailableCategories === undefined || dragCardAvailableCategories.includes(state))}
            class:drop-disabled={isDragging &&
              dragCardAvailableCategories !== undefined &&
              !dragCardAvailableCategories.includes(state)}
            data-id="kanban-column"
            data-state={stateKey(state)}
            bind:this={stateRefs[si]}
            on:dragover={(event) => {
              panelDragOver(event, state)
            }}
            on:drop={() => {
              void move(state).then(() => {
                isDragging = false
              })
            }}
          >
            {#if $$slots.header !== undefined}
              {#key si}
                <slot name="header" state={toAny(state)} count={stateObjects.length} index={si} />
              {/key}
            {/if}
            <Scroller padding={'.25rem .5rem'} on:dragover on:drop>
              <slot name="beforeCard" {state} />
              <KanbanRow
                bind:this={stateRows[si]}
                on:obj-focus
                {stateObjects}
                {isDragging}
                {dragCard}
                {objects}
                {selection}
                {checkedSet}
                {state}
                {limiter}
                initialLimit={10}
                limitStep={20}
                cardDragOver={(evt, obj) => {
                  cardDragOver(evt, obj, state)
                }}
                cardDrop={(evt, obj) => {
                  void cardDrop(evt, obj, state)
                }}
                {onDragStart}
                {showMenu}
                {_class}
                {query}
                {options}
                {groupByKey}
              >
                <svelte:fragment slot="card" let:object let:dragged>
                  <slot name="card" {object} {dragged} />
                </svelte:fragment>
              </KanbanRow>

              <slot name="afterCard" {state} />
            </Scroller>
          </div>
        {/each}
        <slot name="afterPanel" />
      </div>
    </Scroller>
  {/if}
  {#if isDragging}
    <slot name="doneBar" onDone={updateDone} />
  {/if}
</div>

<style lang="scss">
  :global(.kanban-drop-placeholder) {
    pointer-events: none;
    outline: 2px dashed var(--theme-divider-color);
    outline-offset: -2px;
    border-radius: 0.25rem;
  }

  .kanban-container {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;

    --kanban-col-width: 20rem;
    --kanban-col-gap: 0.5rem;

    &.compact {
      --kanban-col-width: 14rem;
      --kanban-col-gap: 0.375rem;
    }
  }
  .kanban-content {
    display: flex;
    padding: 1.5rem 1.5rem 0.5rem;
    min-width: 0;
    height: 100%;
  }

  .panel-container {
    display: flex;
    flex-direction: column;
    width: var(--kanban-col-width);
    min-width: var(--kanban-col-width);
    height: 100%;
    min-height: 0;
    background-color: transparent;
    border: 1px solid transparent;
    border-radius: 0.25rem;
  }

  // SwimLane layout
  .kanban-swimlane-root {
    display: flex;
    flex-direction: column;
    padding: 0 1.5rem 0.5rem;
    width: max-content;
    min-width: 100%;
  }
  .swimlane-header-row {
    position: sticky;
    top: 0;
    z-index: 5;
    display: grid;
    grid-template-columns: repeat(var(--kanban-col-count), var(--kanban-col-width));
    gap: var(--kanban-col-gap);
    padding: 1rem 0 0.5rem;
    background: var(--swimlane-row-bg);
    border-bottom: 1px solid var(--theme-divider-color);
  }
  .swimlane-col-header {
    width: var(--kanban-col-width);

    :global(> *) {
      margin: 0 !important;
    }
  }

  .swimlane-block {
    display: flex;
    flex-direction: column;
    margin-bottom: 1rem;
    border-radius: 0.375rem;
    background-color: var(--theme-list-row-color, var(--theme-bg-color));
  }
  .swimlane-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    border-bottom: 1px solid var(--theme-divider-color);
    user-select: none;
    position: sticky;
    top: 4rem;
    left: 0;
    z-index: 4;
    width: max-content;
    min-width: 100%;
    box-shadow: 0 1px 0 var(--theme-divider-color);
    background: var(--swimlane-header-bg);
  }
  .swimlane-toggle {
    display: inline-flex;
    width: 1rem;
    height: 1rem;
  }
  .swimlane-grid {
    display: grid;
    grid-template-columns: repeat(var(--kanban-col-count), var(--kanban-col-width));
    gap: var(--kanban-col-gap);
    padding: 0.5rem 0;
  }
  .swimlane-cell {
    display: flex;
    flex-direction: column;
    width: var(--kanban-col-width);
    min-height: 4rem;
    background-color: transparent;
    border: 1px solid transparent;
    border-radius: 0.25rem;
    padding: 0.25rem 0;
    transition:
      background-color 0.12s ease,
      border-color 0.12s ease;

    &.drop-target {
      background-color: var(--theme-drop-zone-bg-color, var(--theme-button-hovered));
      border: 1px dashed var(--theme-divider-color);
    }
  }

  .panel-container,
  .swimlane-cell,
  .swimlane-col-header {
    transition:
      opacity 0.15s ease,
      filter 0.15s ease;

    &.drop-disabled {
      opacity: 0.45;
      filter: grayscale(0.6);
      pointer-events: none;
      cursor: not-allowed;
    }
  }
  .swimlane-title {
    font-weight: 600;
    color: var(--swimlane-title-color, var(--theme-caption-color));
  }
  .swimlane-count {
    color: var(--theme-dark-color);
    font-size: 0.8125rem;
    padding: 0 0.375rem;
    background: var(--theme-button-hovered);
    border-radius: 0.5rem;
    line-height: 1.25rem;
  }
</style>

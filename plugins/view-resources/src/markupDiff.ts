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

import { type MarkupNode, MarkupNodeType } from '@hcengineering/text'
import { deepEqual } from 'fast-equals'

function emptyParagraph (): MarkupNode {
  const node: MarkupNode = { type: MarkupNodeType.paragraph }
  return node
}

// containers worth descending into: keeping a whole list or table for a one-row change is too noisy
const prunable = new Set<string>([
  MarkupNodeType.ordered_list,
  MarkupNodeType.bullet_list,
  MarkupNodeType.list_item,
  MarkupNodeType.taskList,
  MarkupNodeType.blockquote,
  // rows can be dropped, cells cannot: removing one shifts the rest into the wrong columns
  MarkupNodeType.table,
  MarkupNodeType.table_row
])

// unchanged blocks kept around each change so the reader sees where it happened
const contextBlocks = 1

/**
 * @public
 * Strips everything both documents share, keeping a little context around each change.
 */
export function cleanupDiff (node1: MarkupNode, node2: MarkupNode): MarkupNode[] {
  if (node1.type !== MarkupNodeType.doc || node2.type !== MarkupNodeType.doc) {
    return [node1, node2]
  }

  // an empty doc is not valid content, the diff transform refuses to work with it
  return prune(node1, node2).map((node) =>
    (node.content ?? []).length === 0 ? { ...node, content: [emptyParagraph()] } : node
  )
}

function prune (node1: MarkupNode, node2: MarkupNode): MarkupNode[] {
  const content1 = node1.content ?? []
  const content2 = node2.content ?? []

  // align by content, not by index: one inserted block must not mark the whole tail as changed
  const pairs = align(content1, content2)

  // a pair is interesting when it differs; unchanged pairs survive only as context
  const changed = pairs.map(([a, b]) => !same(a, b))
  const keep = pairs.map((_, i) => changed.slice(Math.max(0, i - contextBlocks), i + contextBlocks + 1).some((c) => c))

  const newContent1: MarkupNode[] = []
  const newContent2: MarkupNode[] = []

  // position of each side's first surviving child, so ordered lists keep their original numbering
  let firstKept1: number | undefined
  let firstKept2: number | undefined
  let index1 = 0
  let index2 = 0

  for (let i = 0; i < pairs.length; i++) {
    const [child1, child2] = pairs[i]
    const at1 = child1 !== undefined ? index1++ : undefined
    const at2 = child2 !== undefined ? index2++ : undefined

    if (!keep[i]) continue

    if (at1 !== undefined && firstKept1 === undefined) {
      firstKept1 = at1
    }
    if (at2 !== undefined && firstKept2 === undefined) {
      firstKept2 = at2
    }

    // unchanged context: keep it identical on both sides so it is not highlighted
    if (!changed[i]) {
      // a whole list as context is noise: keep only the items closest to the change
      const trimmed =
        child1 !== undefined && prunable.has(child1.type)
          ? trimContext(child1, changed[i - 1] ?? false, changed[i + 1] ?? false)
          : child1

      if (trimmed !== undefined) {
        newContent1.push(trimmed)
      }
      if (trimmed !== undefined && child2 !== undefined) {
        newContent2.push(trimmed)
      }
      continue
    }

    // both sides are the same kind of container: keep only the children that differ
    // (table rows excluded: dropping cells would shift the rest into the wrong columns)
    if (
      child1 !== undefined &&
      child1.type === child2?.type &&
      prunable.has(child1.type) &&
      child1.type !== MarkupNodeType.table_row
    ) {
      const [pruned1, pruned2] = prune(child1, child2)
      const empty1 = (pruned1.content ?? []).length === 0
      const empty2 = (pruned2.content ?? []).length === 0
      // an emptied container is not valid content, drop it so the diff reads as a plain insert/delete
      if (!empty1) {
        newContent1.push(pruned1)
      }
      if (!empty2) {
        newContent2.push(pruned2)
      }
      continue
    }

    if (child1 !== undefined) {
      newContent1.push(child1)
    }
    if (child2 !== undefined) {
      newContent2.push(child2)
    }
  }

  return [repair(withStart(node1, newContent1, firstKept1)), repair(withStart(node2, newContent2, firstKept2))]
}

// a list item must start with a block: pruning may leave it holding only a nested list,
// which the schema rejects and which makes the diff transform bail out
function repair (node: MarkupNode): MarkupNode {
  if (node.type !== MarkupNodeType.list_item) {
    return node
  }

  const content = node.content ?? []
  const first = content[0]
  if (first === undefined || !prunable.has(first.type)) {
    return node
  }

  return { ...node, content: [emptyParagraph(), ...content] }
}

// keep only the container items adjacent to the change, not the whole list
function trimContext (node: MarkupNode, changeBefore: boolean, changeAfter: boolean): MarkupNode {
  if (!prunable.has(node.type)) {
    return node
  }

  // tables must keep their shape: a header row is needed to read them, and dropping
  // cells from a row shifts the remaining ones into the wrong columns
  if (node.type === MarkupNodeType.table || node.type === MarkupNodeType.table_row) {
    return node
  }

  const items = node.content ?? []
  // a single wrapper (list item holding a nested list) hides the real length, descend into it
  if (items.length === 1) {
    return { ...node, content: [trimContext(items[0], changeBefore, changeAfter)] }
  }

  if (items.length <= contextBlocks) {
    return node
  }

  // change is above: show the first items; below: show the last ones
  if (changeBefore && !changeAfter) {
    return repair(
      withStart(
        node,
        items.slice(0, contextBlocks).map((it) => trimContext(it, true, false)),
        0
      )
    )
  }
  if (changeAfter && !changeBefore) {
    return repair(
      withStart(
        node,
        items.slice(-contextBlocks).map((it) => trimContext(it, false, true)),
        items.length - contextBlocks
      )
    )
  }

  return node
}

// shift an ordered list's `start` so kept items keep the numbers they had in the full document
function withStart (node: MarkupNode, content: MarkupNode[], firstKept: number | undefined): MarkupNode {
  if (node.type !== MarkupNodeType.ordered_list || firstKept === undefined || firstKept === 0) {
    return { ...node, content }
  }

  const start = typeof node.attrs?.start === 'number' ? node.attrs.start : 1
  return { ...node, content, attrs: { ...node.attrs, start: start + firstKept } }
}

// equal nodes, or same-kind containers worth recursing into
function pairable (node1: MarkupNode | undefined, node2: MarkupNode | undefined): boolean {
  if (node1 === undefined || node2 === undefined) return false
  return same(node1, node2) || (node1.type === node2.type && prunable.has(node1.type))
}

// pairs children so that matching ones line up; unmatched ones pair with undefined
function align (a: MarkupNode[], b: MarkupNode[]): Array<[MarkupNode | undefined, MarkupNode | undefined]> {
  const n = a.length
  const m = b.length

  // O(n*m) LCS, fall back to positional pairing on huge documents
  if (n * m > 250000) {
    const pairs: Array<[MarkupNode | undefined, MarkupNode | undefined]> = []
    for (let i = 0; i < Math.max(n, m); i++) {
      pairs.push([a[i], b[i]])
    }
    return pairs
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = pairable(a[i], b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const pairs: Array<[MarkupNode | undefined, MarkupNode | undefined]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (pairable(a[i], b[j])) {
      pairs.push([a[i], b[j]])
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      pairs.push([a[i], undefined])
      i++
    } else {
      pairs.push([undefined, b[j]])
      j++
    }
  }
  while (i < n) pairs.push([a[i++], undefined])
  while (j < m) pairs.push([undefined, b[j++]])

  return pairs
}

function same (node1: MarkupNode | undefined, node2: MarkupNode | undefined): boolean {
  if (node1 === undefined && node2 === undefined) return true
  if (node1 === undefined || node2 === undefined) return false

  if (
    node1.type !== node2.type ||
    node1.text !== node2.text ||
    !deepEqual(node1.marks ?? [], node2.marks ?? []) ||
    !deepEqual(node1.attrs ?? {}, node2.attrs ?? {})
  ) {
    return false
  }

  const content1 = node1.content ?? []
  const content2 = node2.content ?? []
  if (content1.length !== content2.length) return false

  for (let i = 0; i < content1.length; i++) {
    if (!same(content1[i], content2[i])) return false
  }

  return true
}

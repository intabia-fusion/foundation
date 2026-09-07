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

import type { Ref } from '@hcengineering/core'

import type { TaskType } from '../index'
import type { TaskTypeDependencyItem, TaskTypeDependencyReason } from './types'

/**
 * Builds an undirected adjacency map of relations between task types.
 */
function buildAdjacencyMap (
  allTypes: TaskType[],
  typeMap: Map<Ref<TaskType>, TaskType>
): Map<Ref<TaskType>, Set<Ref<TaskType>>> {
  const adj = new Map<Ref<TaskType>, Set<Ref<TaskType>>>()
  for (const t of allTypes) {
    adj.set(t._id, new Set())
  }

  for (const t of allTypes) {
    for (const parentId of (t.allowedAsChildOf ?? []).filter((id) => id !== t._id)) {
      if (typeMap.has(parentId)) {
        adj.get(t._id)?.add(parentId)
        adj.get(parentId)?.add(t._id)
      }
    }
    if (t.allowAnyParent === true) {
      for (const other of allTypes) {
        if (other._id !== t._id) {
          adj.get(t._id)?.add(other._id)
          adj.get(other._id)?.add(t._id)
        }
      }
    }
  }

  return adj
}

/**
 * Finds all task type IDs in the connected component containing the target task type.
 */
function getConnectedComponentIds (
  targetId: Ref<TaskType>,
  adj: Map<Ref<TaskType>, Set<Ref<TaskType>>>
): Set<Ref<TaskType>> {
  const componentIds = new Set<Ref<TaskType>>([targetId])
  const queue: Array<Ref<TaskType>> = [targetId]

  while (queue.length > 0) {
    const curr = queue.shift()
    if (curr === undefined) continue
    const neighbors = adj.get(curr) ?? new Set()
    for (const neighbor of neighbors) {
      if (!componentIds.has(neighbor)) {
        componentIds.add(neighbor)
        queue.push(neighbor)
      }
    }
  }

  return componentIds
}

/**
 * Determines ancestors of the target type (reachable by moving strictly upwards along allowedAsChildOf).
 */
function getAncestorIds (
  target: TaskType,
  componentIds: Set<Ref<TaskType>>,
  typeMap: Map<Ref<TaskType>, TaskType>
): Set<Ref<TaskType>> {
  const ancestorIds = new Set<Ref<TaskType>>()
  const upQueue: Array<Ref<TaskType>> = (target.allowedAsChildOf ?? []).filter(
    (p) => p !== target._id && componentIds.has(p)
  )

  for (const p of upQueue) {
    ancestorIds.add(p)
  }

  while (upQueue.length > 0) {
    const curr = upQueue.shift()
    if (curr === undefined) continue
    const tt = typeMap.get(curr)
    if (tt === undefined) continue
    for (const p of (tt.allowedAsChildOf ?? []).filter((id) => id !== tt._id && componentIds.has(id))) {
      if (!ancestorIds.has(p)) {
        ancestorIds.add(p)
        upQueue.push(p)
      }
    }
  }

  return ancestorIds
}

/**
 * Finds root nodes in the component (types that have no parents inside the component).
 */
function findComponentRoots (
  target: TaskType,
  componentIds: Set<Ref<TaskType>>,
  ancestorIds: Set<Ref<TaskType>>,
  typeMap: Map<Ref<TaskType>, TaskType>
): TaskType[] {
  const roots: TaskType[] = []
  for (const id of componentIds) {
    const t = typeMap.get(id)
    if (t === undefined) continue
    const parentCount = (t.allowedAsChildOf ?? []).filter((p) => p !== t._id && componentIds.has(p)).length
    if (parentCount === 0) {
      roots.push(t)
    }
  }

  if (roots.length === 0) {
    const topAncestor = Array.from(ancestorIds).find((aId) => {
      const a = typeMap.get(aId)
      return (
        a !== undefined && (a.allowedAsChildOf ?? []).filter((p) => p !== a._id && componentIds.has(p)).length === 0
      )
    })
    roots.push(topAncestor !== undefined ? (typeMap.get(topAncestor) ?? target) : target)
  }

  roots.sort((a, b) => {
    const aAnc = ancestorIds.has(a._id) || a._id === target._id ? 1 : 0
    const bAnc = ancestorIds.has(b._id) || b._id === target._id ? 1 : 0
    return bAnc - aAnc
  })

  return roots
}

/**
 * Computes reasons why a node is included in the hierarchy of the target task type.
 */
function computeDependencyReasons (
  node: TaskType,
  target: TaskType,
  componentIds: Set<Ref<TaskType>>,
  typeMap: Map<Ref<TaskType>, TaskType>
): TaskTypeDependencyReason[] {
  if (node._id === target._id) return []

  const reasons: TaskTypeDependencyReason[] = []
  const seenReasons = new Set<string>()

  // 1. Is node an allowed parent of other types in component?
  for (const otherId of componentIds) {
    if (otherId === node._id) continue
    const other = typeMap.get(otherId)
    if (other === undefined) continue
    if ((other.allowedAsChildOf ?? []).includes(node._id)) {
      const key = `parent:${other._id}`
      if (!seenReasons.has(key)) {
        seenReasons.add(key)
        if (other._id === target._id) {
          reasons.unshift({ role: 'parent', id: other._id, name: other.name })
        } else {
          reasons.push({ role: 'parent', id: other._id, name: other.name })
        }
      }
    }
  }

  // 2. Is node an allowed child of other types in component?
  for (const parentId of node.allowedAsChildOf ?? []) {
    if (parentId === node._id || !componentIds.has(parentId)) continue
    const parent = typeMap.get(parentId)
    if (parent === undefined) continue
    const key = `child:${parent._id}`
    if (!seenReasons.has(key)) {
      seenReasons.add(key)
      if (parent._id === target._id) {
        reasons.unshift({ role: 'child', id: parent._id, name: parent.name })
      } else {
        reasons.push({ role: 'child', id: parent._id, name: parent.name })
      }
    }
  }

  // 3. Is node allowed as child of any parent?
  if (node.allowAnyParent === true) {
    reasons.push({ role: 'child', id: node._id, universal: true })
  }

  return reasons
}

/**
 * Traverses upstream (parents) and downstream (children) relations for a target TaskType
 * across the entire connected hierarchy component and returns all types in hierarchical tree order.
 *
 * @public
 */
export function getConnectedTaskTypesWithDependencies (
  target: TaskType,
  allTypes: TaskType[]
): TaskTypeDependencyItem[] {
  const typeMap = new Map<Ref<TaskType>, TaskType>(allTypes.map((t) => [t._id, t]))
  const adj = buildAdjacencyMap(allTypes, typeMap)
  const componentIds = getConnectedComponentIds(target._id, adj)
  const ancestorIds = getAncestorIds(target, componentIds, typeMap)
  const roots = findComponentRoots(target, componentIds, ancestorIds, typeMap)

  const visited = new Set<Ref<TaskType>>()
  const result: TaskTypeDependencyItem[] = []

  function traverseNode (node: TaskType, depth: number, parentName?: string): void {
    if (visited.has(node._id)) return
    visited.add(node._id)

    const isTarget = node._id === target._id
    const isAncestor = ancestorIds.has(node._id)
    const role: 'target' | 'parent' | 'child' = isTarget ? 'target' : isAncestor ? 'parent' : 'child'

    result.push({
      taskType: node,
      role,
      sourceName: isTarget ? undefined : (parentName ?? (isAncestor ? target.name : '')),
      depth,
      reasons: computeDependencyReasons(node, target, componentIds, typeMap)
    })

    // Find children in component
    const children: TaskType[] = []
    for (const id of componentIds) {
      if (visited.has(id)) continue
      const candidate = typeMap.get(id)
      if (candidate === undefined) continue

      const isExplicitChild = (candidate.allowedAsChildOf ?? []).includes(node._id)
      const isUniversalChild =
        candidate.allowAnyParent === true && (node._id === target._id || roots.some((r) => r._id === node._id))

      if (isExplicitChild || isUniversalChild) {
        children.push(candidate)
      }
    }

    for (const child of children) {
      traverseNode(child, depth + 1, node.name)
    }
  }

  // Traverse all roots first
  for (const root of roots) {
    traverseNode(root, 0)
  }

  // Traverse any remaining unvisited nodes in component
  for (const id of componentIds) {
    if (!visited.has(id)) {
      const node = typeMap.get(id)
      if (node !== undefined) {
        traverseNode(node, 1, target.name)
      }
    }
  }

  return result
}

/**
 * Returns all connected task types in the hierarchy of the target task type.
 *
 * @public
 */
export function getConnectedTaskTypes (target: TaskType, allTypes: TaskType[]): TaskType[] {
  return getConnectedTaskTypesWithDependencies(target, allTypes).map((d) => d.taskType)
}

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
import {
  ProjectType,
  TaskType,
  getAllowedChildTaskTypes,
  getAllowedParentTaskTypes,
  getRootTaskTypes,
  getConnectedTaskTypesWithDependencies,
  getConnectedTaskTypes
} from '../../index'

describe('Hierarchy transfer helpers (hierarchy.ts)', () => {
  const projectType1 = 'proj-1' as Ref<ProjectType>
  const projectType2 = 'proj-2' as Ref<ProjectType>

  const epic = {
    _id: 'epic' as Ref<TaskType>,
    parent: projectType1,
    name: 'Epic',
    isRootTaskType: true,
    allowedAsChildOf: []
  } as any as TaskType

  const issue = {
    _id: 'issue' as Ref<TaskType>,
    parent: projectType1,
    name: 'Issue',
    isRootTaskType: true,
    allowedAsChildOf: ['epic' as Ref<TaskType>, 'issue' as Ref<TaskType>]
  } as any as TaskType

  const subtask = {
    _id: 'subtask' as Ref<TaskType>,
    parent: projectType1,
    name: 'Subtask',
    isRootTaskType: false,
    allowedAsChildOf: ['issue' as Ref<TaskType>]
  } as any as TaskType

  const otherProjectTask = {
    _id: 'other-task' as Ref<TaskType>,
    parent: projectType2,
    name: 'Other Task',
    isRootTaskType: true,
    allowedAsChildOf: []
  } as any as TaskType

  const bug = {
    _id: 'bug' as Ref<TaskType>,
    parent: projectType1,
    name: 'Bug',
    isRootTaskType: true,
    allowAnyParent: true
  } as any as TaskType

  const allTaskTypes = [epic, issue, subtask, bug, otherProjectTask]

  describe('getAllowedChildTaskTypes', () => {
    it('returns allowed child task types for an epic', () => {
      const allowed = getAllowedChildTaskTypes(projectType1, epic._id, allTaskTypes)
      expect(allowed).toEqual([issue, bug])
    })

    it('returns allowed child task types for an issue', () => {
      const allowed = getAllowedChildTaskTypes(projectType1, issue._id, allTaskTypes)
      expect(allowed).toEqual([issue, subtask, bug])
    })

    it('returns types with allowAnyParent for subtask', () => {
      const allowed = getAllowedChildTaskTypes(projectType1, subtask._id, allTaskTypes)
      expect(allowed).toEqual([bug])
    })
  })

  describe('getAllowedParentTaskTypes', () => {
    it('returns allowed parent task types for a subtask type', () => {
      const parents = getAllowedParentTaskTypes(projectType1, subtask._id, allTaskTypes)
      expect(parents).toEqual([issue])
    })

    it('returns allowed parent task types for a standard task type', () => {
      const parents = getAllowedParentTaskTypes(projectType1, issue._id, allTaskTypes)
      expect(parents).toEqual([epic, issue])
    })

    it('returns all scoped types for allowAnyParent type', () => {
      const parents = getAllowedParentTaskTypes(projectType1, bug._id, allTaskTypes)
      expect(parents).toEqual([epic, issue, subtask, bug])
    })

    it('returns empty array for root-only task type', () => {
      const parents = getAllowedParentTaskTypes(projectType1, epic._id, allTaskTypes)
      expect(parents).toEqual([])
    })
  })

  describe('getRootTaskTypes', () => {
    it('returns task types allowed at root level', () => {
      const roots = getRootTaskTypes(projectType1, allTaskTypes)
      expect(roots).toEqual([epic, issue, bug])
    })
  })

  describe('getConnectedTaskTypesWithDependencies', () => {
    it('returns parent and child dependencies for Issue', () => {
      const deps = getConnectedTaskTypesWithDependencies(issue, [epic, issue, subtask, bug])
      const names = deps.map((d) => ({ name: d.taskType.name, role: d.role, source: d.sourceName, depth: d.depth }))
      expect(names).toEqual([
        { name: 'Epic', role: 'parent', source: 'Issue', depth: 0 },
        { name: 'Issue', role: 'target', source: undefined, depth: 1 },
        { name: 'Subtask', role: 'child', source: 'Issue', depth: 2 },
        { name: 'Bug', role: 'child', source: 'Issue', depth: 2 }
      ])
    })

    it('returns top-to-bottom parent dependencies for Subtask', () => {
      const deps = getConnectedTaskTypesWithDependencies(subtask, [epic, issue, subtask, bug])
      const names = deps.map((d) => ({ name: d.taskType.name, role: d.role, source: d.sourceName, depth: d.depth }))
      expect(names).toEqual([
        { name: 'Epic', role: 'parent', source: 'Subtask', depth: 0 },
        { name: 'Issue', role: 'parent', source: 'Epic', depth: 1 },
        { name: 'Subtask', role: 'target', source: undefined, depth: 2 },
        { name: 'Bug', role: 'child', source: 'Subtask', depth: 3 }
      ])
    })

    it('recursively discovers subtasks of a child type that has allowAnyParent', () => {
      const feature = {
        _id: 'feature' as Ref<TaskType>,
        parent: projectType1,
        name: 'Feature',
        allowAnyParent: true
      } as any as TaskType

      const subFeature = {
        _id: 'sub-feature' as Ref<TaskType>,
        parent: projectType1,
        name: 'SubFeature',
        allowedAsChildOf: ['feature' as Ref<TaskType>]
      } as any as TaskType

      const classicIssue = {
        _id: 'classic-issue' as Ref<TaskType>,
        parent: projectType1,
        name: 'Classic Issue',
        isRootTaskType: true
      } as any as TaskType

      const deps = getConnectedTaskTypesWithDependencies(classicIssue, [classicIssue, feature, subFeature])
      const names = deps.map((d) => ({ name: d.taskType.name, role: d.role, source: d.sourceName, depth: d.depth }))

      expect(names).toEqual([
        { name: 'Classic Issue', role: 'target', source: undefined, depth: 0 },
        { name: 'Feature', role: 'child', source: 'Classic Issue', depth: 1 },
        { name: 'SubFeature', role: 'child', source: 'Feature', depth: 2 }
      ])
    })

    it('returns all dependency reasons for a task type with multiple relations', () => {
      const parentA = {
        _id: 'parent-a' as Ref<TaskType>,
        parent: projectType1,
        name: 'Parent A'
      } as any as TaskType

      const parentB = {
        _id: 'parent-b' as Ref<TaskType>,
        parent: projectType1,
        name: 'Parent B'
      } as any as TaskType

      const child = {
        _id: 'child' as Ref<TaskType>,
        parent: projectType1,
        name: 'Multi Child',
        allowedAsChildOf: ['parent-a' as Ref<TaskType>, 'parent-b' as Ref<TaskType>]
      } as any as TaskType

      const deps = getConnectedTaskTypesWithDependencies(parentA, [parentA, parentB, child])
      const childItem = deps.find((d) => d.taskType._id === 'child')
      expect(childItem?.reasons).toEqual([
        { role: 'child', id: 'parent-a', name: 'Parent A' },
        { role: 'child', id: 'parent-b', name: 'Parent B' }
      ])
    })

    it('handles standalone task type with no relations', () => {
      const standalone = {
        _id: 'standalone' as Ref<TaskType>,
        parent: projectType1,
        name: 'Standalone',
        isRootTaskType: true
      } as any as TaskType

      const deps = getConnectedTaskTypesWithDependencies(standalone, [standalone])
      expect(deps).toHaveLength(1)
      expect(deps[0]).toEqual({
        taskType: standalone,
        role: 'target',
        sourceName: undefined,
        depth: 0,
        reasons: []
      })
    })

    it('handles cyclic parent-child dependencies and fallback root selection', () => {
      const typeA = {
        _id: 'type-a' as Ref<TaskType>,
        parent: projectType1,
        name: 'Type A',
        allowedAsChildOf: ['type-b' as Ref<TaskType>]
      } as any as TaskType

      const typeB = {
        _id: 'type-b' as Ref<TaskType>,
        parent: projectType1,
        name: 'Type B',
        allowedAsChildOf: ['type-a' as Ref<TaskType>]
      } as any as TaskType

      const deps = getConnectedTaskTypesWithDependencies(typeA, [typeA, typeB])
      expect(deps).toHaveLength(2)
      const ids = deps.map((d) => d.taskType._id)
      expect(ids).toContain('type-a')
      expect(ids).toContain('type-b')
    })

    it('handles deep multi-level hierarchy chain correctly', () => {
      const t1 = { _id: 't1' as Ref<TaskType>, parent: projectType1, name: 'Tier 1', allowedAsChildOf: [] } as any
      const t2 = {
        _id: 't2' as Ref<TaskType>,
        parent: projectType1,
        name: 'Tier 2',
        allowedAsChildOf: ['t1' as any]
      } as any
      const t3 = {
        _id: 't3' as Ref<TaskType>,
        parent: projectType1,
        name: 'Tier 3',
        allowedAsChildOf: ['t2' as any]
      } as any
      const t4 = {
        _id: 't4' as Ref<TaskType>,
        parent: projectType1,
        name: 'Tier 4',
        allowedAsChildOf: ['t3' as any]
      } as any

      const deps = getConnectedTaskTypesWithDependencies(t3, [t1, t2, t3, t4])
      const tiers = deps.map((d) => ({ name: d.taskType.name, role: d.role, depth: d.depth }))

      expect(tiers).toEqual([
        { name: 'Tier 1', role: 'parent', depth: 0 },
        { name: 'Tier 2', role: 'parent', depth: 1 },
        { name: 'Tier 3', role: 'target', depth: 2 },
        { name: 'Tier 4', role: 'child', depth: 3 }
      ])
    })
  })

  describe('getConnectedTaskTypes', () => {
    it('returns connected task types list for Issue', () => {
      const connected = getConnectedTaskTypes(issue, [epic, issue, subtask, bug])
      expect(connected.map((t) => t.name)).toEqual(['Epic', 'Issue', 'Subtask', 'Bug'])
    })
  })
})

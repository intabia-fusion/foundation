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

/* eslint-disable @typescript-eslint/unbound-method */

import core, { type Doc, type Ref, type Status } from '@hcengineering/core'
import task, { type Project } from '@hcengineering/task'

import workflow from '../../plugin'
import type { Screen } from '../../schema'
import {
  buildResolver,
  identifierOf,
  NameResolver,
  remap,
  requireRef,
  ScreenToken,
  StatusToken,
  TaskTypeToken
} from '../../transfer/resolver'
import { createMockTx, projectTypeId, statusDoneId, statusOpenId, taskTypeId } from './fixtures'

describe('NameResolver', () => {
  it('adds and retrieves mappings correctly', () => {
    const resolver = new NameResolver()
    resolver.add(StatusToken, statusOpenId, 'Open')
    resolver.add(TaskTypeToken, taskTypeId, 'Bug')

    expect(resolver.hasRef(statusOpenId)).toBe(true)
    expect(resolver.hasRef('non-existent' as Ref<Doc>)).toBe(false)

    expect(resolver.getName(statusOpenId, StatusToken)).toBe('Open')
    expect(resolver.getName(taskTypeId, TaskTypeToken)).toBe('Bug')

    expect(resolver.getRef(StatusToken, 'Open')).toBe(statusOpenId)
    expect(resolver.getRef(TaskTypeToken, 'Bug')).toBe(taskTypeId)
    expect(resolver.getRef(StatusToken, 'NonExistent')).toBeUndefined()
  })

  it('handles name collisions by picking the smallest ref deterministically', () => {
    const resolver = new NameResolver()
    const idA = 'ref-aaa' as Ref<Status>
    const idB = 'ref-bbb' as Ref<Status>

    resolver.add(StatusToken, idB, 'Duplicate')
    resolver.add(StatusToken, idA, 'Duplicate')

    expect(resolver.getRef(StatusToken, 'Duplicate')).toBe(idA)
  })

  it('allows manual override via setRef', () => {
    const resolver = new NameResolver()
    const customStatusId = 'custom-status' as Ref<Status>

    resolver.setRef(StatusToken, 'Custom', customStatusId)
    expect(resolver.getRef(StatusToken, 'Custom')).toBe(customStatusId)
    expect(resolver.hasRef(customStatusId)).toBe(true)
    expect(resolver.getName(customStatusId, StatusToken)).toBe('Custom')
  })

  it('returns raw ref string if getName has no matching prefix', () => {
    const resolver = new NameResolver()
    resolver.add(StatusToken, statusOpenId, 'Open')

    // Requesting with wrong prefix
    expect(resolver.getName(statusOpenId, TaskTypeToken)).toBe(statusOpenId)
  })
})

describe('remap', () => {
  it('remaps strings present in dictionary', () => {
    const dict = new Map<string, string>([
      ['$status:Open', statusOpenId],
      ['$taskType:Bug', taskTypeId]
    ])

    expect(remap('$status:Open', dict)).toBe(statusOpenId)
    expect(remap('$taskType:Bug', dict)).toBe(taskTypeId)
    expect(remap('plain-text', dict)).toBe('plain-text')
  })

  it('collects unresolved token strings into unresolved array', () => {
    const dict = new Map<string, string>([['$status:Open', statusOpenId]])
    const unresolved: string[] = []

    const result = remap(
      {
        status: '$status:Unknown',
        taskType: '$taskType:Missing',
        screen: '$screen:Unresolved',
        normal: 'regular text'
      },
      dict,
      unresolved
    )

    expect(result).toEqual({
      status: '$status:Unknown',
      taskType: '$taskType:Missing',
      screen: '$screen:Unresolved',
      normal: 'regular text'
    })
    expect(unresolved).toEqual(['$status:Unknown', '$taskType:Missing', '$screen:Unresolved'])
  })

  it('recursively remaps arrays and nested objects including keys', () => {
    const dict = new Map<string, string>([
      ['$taskType:Bug', taskTypeId],
      ['$status:Open', statusOpenId],
      ['$status:Done', statusDoneId]
    ])

    const input = {
      statuses: {
        '$taskType:Bug': ['$status:Open', '$status:Done']
      },
      nested: {
        list: ['$status:Open']
      }
    }

    const remapped = remap(input, dict)
    expect(remapped).toEqual({
      statuses: {
        [taskTypeId]: [statusOpenId, statusDoneId]
      },
      nested: {
        list: [statusOpenId]
      }
    })
  })

  it('returns primitives and null as is', () => {
    const dict = new Map<string, string>()
    expect(remap(null, dict)).toBeNull()
    expect(remap(123, dict)).toBe(123)
    expect(remap(true, dict)).toBe(true)
  })
})

describe('buildResolver', () => {
  it('populates resolver with task types, statuses, and screens', async () => {
    const screenDoc: Screen = {
      _id: 'screen-1' as Ref<Screen>,
      _class: workflow.class.Screen,
      name: 'Resolve Screen',
      projectType: projectTypeId,
      targetClass: task.class.Task,
      space: core.space.Workspace,
      modifiedOn: 0,
      modifiedBy: '' as any
    }

    const client = createMockTx({ docs: [screenDoc] })
    const resolver = await buildResolver(client, projectTypeId)

    expect(resolver.getRef(TaskTypeToken, 'Bug')).toBe(taskTypeId)
    expect(resolver.getRef(StatusToken, 'Open')).toBe(statusOpenId)
    expect(resolver.getRef(StatusToken, 'Done')).toBe(statusDoneId)
    expect(resolver.getRef(ScreenToken, 'Resolve Screen')).toBe('screen-1' as Ref<Screen>)
  })
})

describe('identifierOf', () => {
  it('returns project identifier if present', () => {
    const proj: Project & { identifier?: string } = {
      _id: 'proj-1' as Ref<Project>,
      _class: task.class.Project,
      name: 'Mobile App',
      identifier: 'MOB',
      type: projectTypeId,
      space: core.space.Workspace,
      modifiedOn: 0,
      modifiedBy: '' as any,
      description: '',
      private: false,
      members: [],
      archived: false
    }
    expect(identifierOf(proj)).toBe('MOB')
  })

  it('falls back to project name if identifier is not present', () => {
    const proj: Project = {
      _id: 'proj-2' as Ref<Project>,
      _class: task.class.Project,
      name: 'Backend Core',
      type: projectTypeId,
      space: core.space.Workspace,
      modifiedOn: 0,
      modifiedBy: '' as any,
      description: '',
      private: false,
      members: [],
      archived: false
    }
    expect(identifierOf(proj)).toBe('Backend Core')
  })
})

describe('requireRef', () => {
  it('returns ref when found in resolver', () => {
    const resolver = new NameResolver()
    resolver.add(StatusToken, statusOpenId, 'Open')

    expect(requireRef(resolver, StatusToken, 'Open')).toBe(statusOpenId)
  })

  it('throws error with entity kind when not found', () => {
    const resolver = new NameResolver()

    expect(() => requireRef(resolver, StatusToken, 'MissingStatus')).toThrow(
      'Workflow import: unknown status "MissingStatus"'
    )
    expect(() => requireRef(resolver, TaskTypeToken, 'MissingType')).toThrow(
      'Workflow import: unknown task type "MissingType"'
    )
    expect(() => requireRef(resolver, ScreenToken, 'MissingScreen')).toThrow(
      'Workflow import: unknown screen "MissingScreen"'
    )
    expect(() => requireRef(resolver, StatusToken, 'CustomEntity', 'custom entity')).toThrow(
      'Workflow import: unknown custom entity "CustomEntity"'
    )
  })
})

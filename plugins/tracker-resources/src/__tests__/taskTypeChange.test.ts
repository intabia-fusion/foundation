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

import { type AnyAttribute, type Class, type Doc, type Hierarchy, type Ref, type Status } from '@hcengineering/core'
import { type TaskType } from '@hcengineering/task'
import { type Issue } from '@hcengineering/tracker'

import {
  buildTaskTypeChangePlan,
  buildTaskTypeChangeUpdate,
  changeIssueTaskType,
  getReportableLostAttributes,
  isCompatibleAttribute
} from '../taskTypeChange'

const issueClass = 'tracker:class:Issue' as Ref<Class<Doc>>
const bugClass = 'class:Bug' as Ref<Class<Doc>>
const taskClass = 'class:Task' as Ref<Class<Doc>>

function attr (name: string, typeClass: string, extra: Record<string, any> = {}): AnyAttribute {
  return {
    name,
    label: name,
    type: { _class: typeClass, ...extra }
  } as any as AnyAttribute
}

/**
 * Minimal hierarchy stand-in: only the two calls the plan builder makes.
 */
function makeHierarchy (attrs: Record<string, Map<string, AnyAttribute>>): Hierarchy {
  return {
    hasClass: (c: Ref<Class<Doc>>) => attrs[c] !== undefined || c === issueClass,
    getAllAttributes: (c: Ref<Class<Doc>>) => attrs[c] ?? new Map(),
    // No mixins in these fixtures: the class-chain attributes are what is under test here.
    getDescendants: () => [],
    findClass: () => undefined,
    hasMixin: () => false,
    getOwnAttributes: () => new Map(),
    as: (doc: any) => doc
  } as any as Hierarchy
}

function makeIssue (over: Record<string, any>): Issue {
  return {
    _id: 'issue-1',
    _class: bugClass,
    space: 'project-1',
    kind: 'bug' as Ref<TaskType>,
    status: 'status:Backlog' as Ref<Status>,
    ...over
  } as any as Issue
}

function makeTaskType (over: Record<string, any>): TaskType {
  return {
    _id: 'task' as Ref<TaskType>,
    targetClass: taskClass,
    ofClass: issueClass,
    statuses: ['status:Backlog', 'status:Done'] as Array<Ref<Status>>,
    ...over
  } as any as TaskType
}

describe('isCompatibleAttribute', () => {
  it('accepts identical primitive types', () => {
    expect(isCompatibleAttribute(attr('a', 'core:class:TypeString'), attr('a', 'core:class:TypeString'))).toBe(true)
  })

  it('rejects different type classes', () => {
    expect(isCompatibleAttribute(attr('a', 'core:class:TypeString'), attr('a', 'core:class:TypeNumber'))).toBe(false)
  })

  it('rejects references pointing at different classes', () => {
    const a = attr('a', 'core:class:RefTo', { to: 'class:Person' })
    const b = attr('a', 'core:class:RefTo', { to: 'class:Company' })
    expect(isCompatibleAttribute(a, b)).toBe(false)
  })

  it('compares the element type of an array, not the wrapper object', () => {
    const strings = (): AnyAttribute => attr('a', 'core:class:ArrOf', { of: { _class: 'core:class:TypeString' } })
    const numbers = attr('a', 'core:class:ArrOf', { of: { _class: 'core:class:TypeNumber' } })

    // Two separately built arrays of strings are the same type, even though their `of` objects
    // are different instances.
    expect(isCompatibleAttribute(strings(), strings())).toBe(true)
    expect(isCompatibleAttribute(strings(), numbers)).toBe(false)
  })

  it('compares the enum an attribute points at', () => {
    const a = attr('a', 'core:class:EnumOf', { of: 'enum:Colors' })
    const b = attr('a', 'core:class:EnumOf', { of: 'enum:Sizes' })

    expect(isCompatibleAttribute(a, b)).toBe(false)
    expect(isCompatibleAttribute(a, attr('a', 'core:class:EnumOf', { of: 'enum:Colors' }))).toBe(true)
  })

  it('accepts references pointing at the same class', () => {
    const a = attr('a', 'core:class:RefTo', { to: 'class:Person' })
    const b = attr('a', 'core:class:RefTo', { to: 'class:Person' })
    expect(isCompatibleAttribute(a, b)).toBe(true)
  })
})

describe('buildTaskTypeChangePlan', () => {
  it('carries over an attribute present in both types', () => {
    const hierarchy = makeHierarchy({
      [bugClass]: new Map([['severity', attr('severity', 'core:class:TypeString')]]),
      [taskClass]: new Map([['severity', attr('severity', 'core:class:TypeString')]])
    })
    const plan = buildTaskTypeChangePlan(hierarchy, makeIssue({ severity: 'Critical' }), makeTaskType({}))

    expect(plan.lost).toEqual([])
  })

  it('drops an attribute the target type does not declare', () => {
    const hierarchy = makeHierarchy({
      [bugClass]: new Map([['severity', attr('severity', 'core:class:TypeString')]]),
      [taskClass]: new Map()
    })
    const plan = buildTaskTypeChangePlan(hierarchy, makeIssue({ severity: 'Critical' }), makeTaskType({}))

    expect(plan.lost).toHaveLength(1)
    expect(plan.lost[0]).toMatchObject({ key: 'severity', value: 'Critical' })
  })

  it('drops an attribute whose type is incompatible', () => {
    const hierarchy = makeHierarchy({
      [bugClass]: new Map([['points', attr('points', 'core:class:TypeString')]]),
      [taskClass]: new Map([['points', attr('points', 'core:class:TypeNumber')]])
    })
    const plan = buildTaskTypeChangePlan(hierarchy, makeIssue({ points: 'five' }), makeTaskType({}))

    expect(plan.lost.map((it) => it.key)).toEqual(['points'])
  })

  it('fills in defaults for attributes only the target type declares', () => {
    const hierarchy = makeHierarchy({
      [bugClass]: new Map(),
      [taskClass]: new Map([['storyPoints', { ...attr('storyPoints', 'core:class:TypeNumber'), defaultValue: 3 }]])
    })
    const plan = buildTaskTypeChangePlan(hierarchy, makeIssue({}), makeTaskType({}))

    expect(plan.defaults).toEqual({ storyPoints: 3 })
  })

  it('leaves attributes without a default alone', () => {
    const hierarchy = makeHierarchy({
      [bugClass]: new Map(),
      [taskClass]: new Map([['storyPoints', attr('storyPoints', 'core:class:TypeNumber')]])
    })
    const plan = buildTaskTypeChangePlan(hierarchy, makeIssue({}), makeTaskType({}))

    expect(plan.defaults).toEqual({})
  })

  it('treats a base class with no own attributes as having none', () => {
    const hierarchy = makeHierarchy({ [taskClass]: new Map() })
    const plan = buildTaskTypeChangePlan(hierarchy, makeIssue({ _class: issueClass }), makeTaskType({}))

    expect(plan.lost).toEqual([])
  })
})

describe('getReportableLostAttributes', () => {
  it('reports only attributes that actually hold a value', () => {
    const hierarchy = makeHierarchy({
      [bugClass]: new Map([
        ['severity', attr('severity', 'core:class:TypeString')],
        ['steps', attr('steps', 'core:class:TypeString')]
      ]),
      [taskClass]: new Map()
    })
    const plan = buildTaskTypeChangePlan(hierarchy, makeIssue({ severity: 'Critical' }), makeTaskType({}))

    expect(plan.lost).toHaveLength(2)
    expect(getReportableLostAttributes(plan).map((it) => it.key)).toEqual(['severity'])
  })
})

describe('buildTaskTypeChangeUpdate', () => {
  it('sets kind and status and leaves dropped values on the document', () => {
    const hierarchy = makeHierarchy({
      [bugClass]: new Map([['severity', attr('severity', 'core:class:TypeString')]]),
      [taskClass]: new Map([['storyPoints', { ...attr('storyPoints', 'core:class:TypeNumber'), defaultValue: 3 }]])
    })
    const targetType = makeTaskType({})
    const plan = buildTaskTypeChangePlan(hierarchy, makeIssue({ severity: 'Critical' }), targetType)
    const update = buildTaskTypeChangeUpdate(
      plan,
      targetType,
      'status:Done' as Ref<Status>,
      'status:Backlog' as Ref<Status>
    ) as any

    expect(update.kind).toBe('task')
    expect(update.status).toBe('status:Done')
    expect(update.storyPoints).toBe(3)
    // The value stays put, so switching the type back brings it into view again.
    expect(update.$unset).toBeUndefined()
  })

  it('never sends _class — the server derives it from kind', () => {
    const hierarchy = makeHierarchy({ [bugClass]: new Map(), [taskClass]: new Map() })
    const targetType = makeTaskType({})
    const plan = buildTaskTypeChangePlan(hierarchy, makeIssue({}), targetType)
    const update = buildTaskTypeChangeUpdate(
      plan,
      targetType,
      'status:Backlog' as Ref<Status>,
      'status:Todo' as Ref<Status>
    ) as any

    expect(update._class).toBeUndefined()
  })

  it('never sends kind when the type is unchanged, so it cannot wave a transition through', async () => {
    const targetType = makeTaskType({ _id: 'bug' as Ref<TaskType> })
    const issue = makeIssue({ kind: 'bug' as Ref<TaskType> })
    const updateDoc = jest.fn()
    const client = { getHierarchy: () => makeHierarchy({}), updateDoc } as any

    await changeIssueTaskType(client, issue, targetType, 'status:Done' as Ref<Status>)

    expect(updateDoc).not.toHaveBeenCalled()
  })

  it('omits the status when it stays on the very one the issue is already in', () => {
    const hierarchy = makeHierarchy({ [bugClass]: new Map(), [taskClass]: new Map() })
    const targetType = makeTaskType({})
    const plan = buildTaskTypeChangePlan(hierarchy, makeIssue({}), targetType)
    const update = buildTaskTypeChangeUpdate(
      plan,
      targetType,
      'status:Backlog' as Ref<Status>,
      'status:Backlog' as Ref<Status>
    ) as any

    expect(update.kind).toBe('task')
    expect('status' in update).toBe(false)
  })

  it('sends the status when it moves', () => {
    const hierarchy = makeHierarchy({ [bugClass]: new Map(), [taskClass]: new Map() })
    const targetType = makeTaskType({})
    const plan = buildTaskTypeChangePlan(hierarchy, makeIssue({}), targetType)
    const update = buildTaskTypeChangeUpdate(
      plan,
      targetType,
      'status:Done' as Ref<Status>,
      'status:Backlog' as Ref<Status>
    ) as any

    expect(update.status).toBe('status:Done')
  })

  it('never unsets anything', () => {
    const hierarchy = makeHierarchy({ [bugClass]: new Map(), [taskClass]: new Map() })
    const targetType = makeTaskType({})
    const plan = buildTaskTypeChangePlan(hierarchy, makeIssue({}), targetType)
    const update = buildTaskTypeChangeUpdate(
      plan,
      targetType,
      'status:Backlog' as Ref<Status>,
      'status:Todo' as Ref<Status>
    ) as any

    expect(update.$unset).toBeUndefined()
  })
})

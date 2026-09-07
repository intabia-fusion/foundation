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

import core, {
  type AnyAttribute,
  type Class,
  type Doc,
  type Hierarchy,
  type Ref,
  type Status,
  type TxOperations,
  type WorkspaceUuid
} from '@hcengineering/core'
import task, { type ProjectType, type TaskType } from '@hcengineering/task'

import workflow from '../../plugin'
import type { Workflow, WorkflowTransition } from '../../schema'

export const ws1 = 'test-workspace-uuid' as WorkspaceUuid
export const projectTypeId = 'proj-type-1' as Ref<ProjectType>
export const targetProjectTypeId = 'proj-type-2' as Ref<ProjectType>
export const taskTypeId = 'task-type-1' as Ref<TaskType>
export const targetTaskTypeId = 'task-type-2' as Ref<TaskType>
export const workflowId = 'wf-1' as Ref<Workflow>
export const statusOpenId = 'status-open-id' as Ref<Status>
export const statusDoneId = 'status-done-id' as Ref<Status>
export const statusResolvedId = 'status-resolved-id' as Ref<Status>

export const taskTypeDoc: TaskType = {
  _id: taskTypeId,
  _class: task.class.TaskType,
  name: 'Bug',
  parent: projectTypeId,
  statuses: [statusOpenId, statusDoneId]
} as unknown as TaskType

export const targetTaskTypeDoc: TaskType = {
  _id: targetTaskTypeId,
  _class: task.class.TaskType,
  name: 'Feature',
  parent: targetProjectTypeId,
  targetClass: 'tracker:class:Issue' as any,
  statuses: [statusOpenId, statusResolvedId]
} as unknown as TaskType

export const statusOpen: Status = {
  _id: statusOpenId,
  _class: core.class.Status,
  name: 'Open',
  color: 1 as any,
  category: 'active'
} as unknown as Status

export const statusDone: Status = {
  _id: statusDoneId,
  _class: core.class.Status,
  name: 'Done',
  color: 2 as any,
  category: 'completed'
} as unknown as Status

export const statusResolved: Status = {
  _id: statusResolvedId,
  _class: core.class.Status,
  name: 'Resolved',
  color: 3 as any,
  category: 'completed'
} as unknown as Status

export const workflowDoc: Workflow = {
  _id: workflowId,
  _class: workflow.class.Workflow,
  name: 'Bug Workflow',
  projectType: projectTypeId,
  taskType: taskTypeId,
  initialStatuses: [statusOpenId]
} as unknown as Workflow

export const transitionDoc: WorkflowTransition = {
  _id: 'trans-1' as Ref<WorkflowTransition>,
  _class: workflow.class.WorkflowTransition,
  attachedTo: workflowId,
  name: 'Close',
  from: [statusOpenId],
  to: statusDoneId,
  rank: '0|i00000:',
  validators: [
    {
      id: 'val-1',
      rule: workflow.validator.FieldRequired,
      ruleClass: 'core:class:Doc' as any,
      props: {
        fields: [{ fieldKey: 'assignee', attribute: 'attr-assignee-id' as Ref<AnyAttribute> }]
      }
    }
  ]
} as unknown as WorkflowTransition

export function createMockTx (store: { docs?: Doc[] } = {}): TxOperations {
  const allDocs: Doc[] = [
    taskTypeDoc,
    targetTaskTypeDoc,
    statusOpen,
    statusDone,
    statusResolved,
    workflowDoc,
    transitionDoc,
    ...(store.docs ?? [])
  ]

  const assigneeAttr: AnyAttribute = {
    _id: 'attr-assignee-id' as Ref<AnyAttribute>,
    name: 'assignee'
  } as unknown as AnyAttribute
  const attrMap = new Map<string, AnyAttribute>([['assignee', assigneeAttr]])
  const mockHierarchy = {
    as: (doc: any) => doc,
    getAllAttributes: jest.fn().mockReturnValue(attrMap),
    findAttribute: jest.fn((cls: any, name: any) => attrMap.get(name)),
    getAttribute: jest.fn((cls: any, name: any) => attrMap.get(name)),
    getDescendants: jest.fn().mockReturnValue([]),
    getClass: jest.fn((cls: any) => ({ kind: 'class' })),
    hasClass: jest.fn((cls: any) => cls !== 'non:existent:Class'),
    hasMixin: jest.fn().mockReturnValue(false),
    isDerived: jest.fn(
      (child: any, parent: any) =>
        child === parent || child === workflow.class.WorkflowRequest || parent === workflow.class.WorkflowRequest
    )
  } as unknown as Hierarchy

  const client: Partial<TxOperations> & { commit: any } = {
    getHierarchy: () => mockHierarchy,
    apply: jest.fn((): any => client),
    commit: jest.fn(async () => ({ result: true, time: 0, serverTime: 0 })),
    findOne: jest.fn(async (_cls: Ref<Class<Doc>>, query: any): Promise<any> => {
      if (query._id !== undefined) return allDocs.find((d) => d._id === query._id)
      if (query.projectType !== undefined && query.name !== undefined) {
        return allDocs.find((d) => (d as any).projectType === query.projectType && (d as any).name === query.name)
      }
      return undefined
    }),
    findAll: jest.fn(async (cls: Ref<Class<Doc>>, query: any): Promise<any> => {
      if (cls === task.class.TaskType) {
        if (query.parent !== undefined) {
          return allDocs.filter((d) => d._class === task.class.TaskType && (d as any).parent === query.parent)
        }
        return allDocs.filter((d) => d._class === task.class.TaskType)
      }
      if (cls === core.class.Status) {
        if (query._id?.$in !== undefined) {
          return allDocs.filter((d) => d._class === core.class.Status && query._id.$in.includes(d._id))
        }
        return allDocs.filter((d) => d._class === core.class.Status)
      }
      if (cls === workflow.class.Workflow) {
        if (query.projectType !== undefined) {
          return allDocs.filter(
            (d) => d._class === workflow.class.Workflow && (d as any).projectType === query.projectType
          )
        }
        return allDocs.filter((d) => d._class === workflow.class.Workflow)
      }
      if (cls === workflow.class.WorkflowTransition) {
        if (query.attachedTo !== undefined) {
          return allDocs.filter(
            (d) => d._class === workflow.class.WorkflowTransition && (d as any).attachedTo === query.attachedTo
          )
        }
        return allDocs.filter((d) => d._class === workflow.class.WorkflowTransition)
      }
      if (cls === workflow.class.Screen) {
        if (query._id?.$in !== undefined) {
          return allDocs.filter((d) => d._class === workflow.class.Screen && query._id.$in.includes(d._id))
        }
        if (query.projectType !== undefined) {
          return allDocs.filter(
            (d) => d._class === workflow.class.Screen && (d as any).projectType === query.projectType
          )
        }
        return allDocs.filter((d) => d._class === workflow.class.Screen)
      }
      if (cls === workflow.class.ScreenTab) {
        if (query.attachedTo?.$in !== undefined) {
          return allDocs.filter(
            (d) => d._class === workflow.class.ScreenTab && query.attachedTo.$in.includes((d as any).attachedTo)
          )
        }
        if (query.attachedTo !== undefined) {
          return allDocs.filter(
            (d) => d._class === workflow.class.ScreenTab && (d as any).attachedTo === query.attachedTo
          )
        }
        return allDocs.filter((d) => d._class === workflow.class.ScreenTab)
      }
      if (cls === workflow.class.ScreenField) {
        if (query.attachedTo?.$in !== undefined) {
          return allDocs.filter(
            (d) => d._class === workflow.class.ScreenField && query.attachedTo.$in.includes((d as any).attachedTo)
          )
        }
        if (query.attachedTo !== undefined) {
          return allDocs.filter(
            (d) => d._class === workflow.class.ScreenField && (d as any).attachedTo === query.attachedTo
          )
        }
        return allDocs.filter((d) => d._class === workflow.class.ScreenField)
      }
      if (cls === core.class.Enum) {
        if (query._id?.$in !== undefined) {
          return allDocs.filter((d) => d._class === core.class.Enum && query._id.$in.includes(d._id))
        }
        return allDocs.filter((d) => d._class === core.class.Enum)
      }
      if (cls === core.class.Attribute) {
        if (query._id?.$in !== undefined) {
          return allDocs.filter((d) => d._class === core.class.Attribute && query._id.$in.includes(d._id))
        }
        if (query.name?.$in !== undefined) {
          return allDocs.filter((d) => d._class === core.class.Attribute && query.name.$in.includes((d as any).name))
        }
        if (query.attributeOf !== undefined) {
          return allDocs.filter(
            (d) => d._class === core.class.Attribute && (d as any).attributeOf === query.attributeOf
          )
        }
        return allDocs.filter((d) => d._class === core.class.Attribute)
      }
      if (cls === task.class.Project) {
        if (query.type !== undefined) {
          return allDocs.filter((d) => d._class === task.class.Project && (d as any).type === query.type)
        }
        return allDocs.filter((d) => d._class === task.class.Project)
      }
      return []
    }),
    createDoc: jest.fn(async (_cls: Ref<Class<Doc>>, _space: any, props: any): Promise<any> => {
      const id = 'new-id-' + Math.random().toString(36).slice(2, 7)
      allDocs.push({ _id: id, _class: _cls, ...props } as unknown as Doc)
      return id
    }),
    createMixin: jest.fn(async () => ({})),
    addCollection: jest.fn(
      async (
        _cls: Ref<Class<Doc>>,
        _space: any,
        _attachedTo: any,
        _parentClass: any,
        _collectionName: string,
        props: any
      ): Promise<any> => {
        const id = 'new-id-' + Math.random().toString(36).slice(2, 7)
        allDocs.push({ _id: id, _class: _cls, ...props } as unknown as Doc)
        return id
      }
    ),
    updateDoc: jest.fn(async (): Promise<any> => ({})),
    updateCollection: jest.fn(async (): Promise<any> => ({})),
    removeDoc: jest.fn(async (): Promise<any> => ({}))
  }

  return client as unknown as TxOperations
}

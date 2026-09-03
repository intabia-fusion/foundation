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

import core, {
  generateId,
  type Ref,
  type TxUpdateDoc,
  TxFactory,
  type Status,
  type WithLookup,
  toFindResult
} from '@hcengineering/core'
import { type TriggerControl } from '@hcengineering/server-core'
import task, { type Task, type Project, type TaskType, type Rank } from '@hcengineering/task'
import contact from '@hcengineering/contact'
import workflow from '@hcengineering/model-workflow'
import serverWorkflow from '@hcengineering/server-workflow'
import tags from '@hcengineering/tags'
import { type Workflow, type WorkflowTransition } from '@hcengineering/workflow'
import { PostFunctionsTrigger } from '../PostFunctions'
import {
  UpdateFieldValue,
  ClearFieldValue,
  updateCollectionOrArrField,
  updateCollectionField,
  updateArrField,
  isCollectionOrArrAttribute,
  executeTransitionPostFunctions
} from '../post-functions'
const contactPersonClass = contact.class.Person

jest.mock('@hcengineering/platform', () => {
  const actual = jest.requireActual('@hcengineering/platform')
  return {
    ...actual,
    getResource: jest.fn().mockImplementation(async (res) => {
      if (res === 'UpdateFieldValue') return UpdateFieldValue
      if (res === 'ClearFieldValue') return ClearFieldValue
      return actual.getResource(res)
    })
  }
})

const testSpace = 'test-space' as Ref<Project>

function createMockTask (data: Partial<Task> & Record<string, any> = {}): WithLookup<Task> {
  return {
    _id: data._id ?? generateId(),
    _class: task.class.Task,
    space: data.space ?? testSpace,
    status: data.status ?? generateId(),
    kind: data.kind ?? generateId(),
    number: 1,
    identifier: 'TASK-1',
    description: '',
    rank: '0|i00000:' as Rank,
    modifiedBy: 'user-1' as any,
    modifiedOn: Date.now(),
    createdOn: Date.now(),
    createdBy: 'user-1' as any,
    ...data
  } as any
}

function createMockHierarchy (overrides: Record<string, any> = {}): any {
  return {
    isDerived: (c: any, target: any) => c === target || target === task.class.Task,
    hasMixin: () => false,
    findAttribute: () => undefined,
    isMixin: () => false,
    as: (obj: any) => obj,
    ...overrides
  }
}

describe('Workflow Post-Functions', () => {
  const txFactory = new TxFactory('test-account' as any)
  const mockCtx = {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    newChild: jest.fn().mockReturnThis(),
    contextData: { account: { uuid: 'user-current', primarySocialId: 'social-current' } }
  } as any

  it('should execute SetFieldValue post-function on status transition', async () => {
    const fromStatus = generateId<Status>()
    const toStatus = generateId<Status>()
    const taskTypeId = generateId<TaskType>()
    const workflowId = generateId<Workflow>()
    const pfRuleId = generateId()

    const oldTask = createMockTask({ status: fromStatus, kind: taskTypeId })
    const updateTx: TxUpdateDoc<Task> = txFactory.createTxUpdateDoc(task.class.Task, testSpace, oldTask._id, {
      status: toStatus
    })
    updateTx.meta = { fromStatus }

    const project: Project = {
      _id: testSpace,
      _class: task.class.Project,
      space: testSpace,
      name: 'Test Project',
      rank: '0|i00000:' as Rank,
      modifiedBy: 'user-1' as any,
      modifiedOn: Date.now(),
      createdOn: Date.now(),
      createdBy: 'user-1' as any,
      workflows: { [taskTypeId]: workflowId }
    } as any

    const transition: WorkflowTransition = {
      _id: generateId(),
      _class: workflow.class.WorkflowTransition,
      space: testSpace as any,
      modifiedOn: Date.now(),
      modifiedBy: 'user-1' as any,
      attachedTo: workflowId,
      attachedToClass: workflow.class.Workflow,
      collection: 'transitions',
      name: 'Close',
      from: [fromStatus],
      to: toStatus,
      rank: '0|i00000:' as Rank,
      postFunctions: [
        {
          id: 'pf-1',
          rule: pfRuleId as any,
          props: { fields: [{ fieldKey: 'assignee', value: { type: 'const', value: 'user-2' } }] }
        }
      ]
    } as any

    const pfRule = {
      _id: pfRuleId,
      _class: workflow.class.WorkflowPostFunction,
      space: testSpace,
      modifiedOn: Date.now(),
      modifiedBy: 'user-1',
      label: 'Set field value',
      description: '',
      order: 10,
      editor: 'editor',
      serverExecutor: 'UpdateFieldValue'
    } as any

    const hierarchy = createMockHierarchy({
      hasMixin: () => true,
      as: (obj: any, mixin: any) => {
        if (mixin === workflow.mixin.ProjectWorkflow) return project
        if (
          mixin === serverWorkflow.mixin.PostFunctionImpl ||
          mixin === 'server-workflow:mixin:PostFunctionImpl' ||
          String(mixin).includes('PostFunctionImpl')
        ) {
          return pfRule
        }
        return obj
      }
    })

    const control: TriggerControl = {
      ctx: mockCtx,
      hierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockImplementation(async (ctx, _class, query) => {
        if (_class === task.class.Project) return toFindResult([project])
        if (_class === task.class.Task) return toFindResult([oldTask])
        if (_class === workflow.class.WorkflowTransition) return toFindResult([transition])
        if (_class === workflow.class.WorkflowPostFunction) return toFindResult([pfRule])
        return toFindResult([])
      })
    } as any

    const resultTxes = await PostFunctionsTrigger([updateTx], control)
    expect(resultTxes.length).toBe(1)
    const pfTx = resultTxes[0] as TxUpdateDoc<Task>
    expect((pfTx.operations as any).assignee).toBe('user-2')
  })

  it('should evaluate presets, field functions, and parent references in UpdateFieldValue', async () => {
    const parentId = generateId<Task>()
    const parentTask = createMockTask({ _id: parentId, description: 'Parent Desc' })
    const currentTask = createMockTask({
      attachedTo: parentId,
      attachedToClass: task.class.Task,
      identifier: 'task-10'
    })

    const txFactoryUser = new TxFactory('email:user-current' as any)
    const control: TriggerControl = {
      ctx: mockCtx,
      hierarchy: createMockHierarchy(),
      txFactory: txFactoryUser,
      modelDb: {
        findAllSync: () => [
          { _id: workflow.function.UpperCase, type: 'transform' },
          { _id: workflow.function.Append, type: 'transform' },
          { _id: workflow.function.FirstValue, type: 'transform' },
          { _id: workflow.function.Replace, type: 'transform' },
          { _id: workflow.function.ReplaceAll, type: 'transform' }
        ]
      } as any,
      findAll: jest.fn().mockImplementation(async (ctx, _class, query) => {
        if (_class === task.class.Task && query._id === parentId) {
          return toFindResult([parentTask])
        }
        if (String(_class).includes('SocialIdentity')) {
          return toFindResult([
            {
              _id: 'sid-1',
              space: 'test',
              modifiedOn: 0,
              modifiedBy: 'test',
              _class: 'contact:class:SocialIdentity',
              attachedTo: 'user-current',
              attachedToClass: contactPersonClass
            } as any
          ])
        }
        if (String(_class).includes('Person')) {
          return toFindResult([
            { _id: 'user-current', space: 'test', modifiedOn: 0, modifiedBy: 'test', _class: contactPersonClass } as any
          ])
        }
        return toFindResult([])
      })
    } as any

    const props = {
      fields: [
        {
          fieldKey: 'assignee',
          value: { type: 'preset', preset: '$currentUser' }
        },
        {
          fieldKey: 'titleUpper',
          value: {
            type: 'const',
            value: 'hello world',
            functions: [
              { func: workflow.function.UpperCase },
              { func: workflow.function.Append, props: { value: '!' } }
            ]
          }
        },
        {
          fieldKey: 'parentDesc',
          value: {
            type: 'parent',
            fieldKey: 'description'
          }
        },
        {
          fieldKey: 'firstItem',
          value: {
            type: 'const',
            value: ['val1', 'val2'],
            functions: [{ func: workflow.function.FirstValue }]
          }
        },
        {
          fieldKey: 'titleReplaced',
          value: {
            type: 'const',
            value: 'NEW TASK NEW',
            functions: [{ func: workflow.function.Replace, props: { search: 'NEW', replacement: 'ТУЦ' } }]
          }
        },
        {
          fieldKey: 'titleReplacedAll',
          value: {
            type: 'const',
            value: 'NEW TASK NEW',
            functions: [{ func: workflow.function.ReplaceAll, props: { search: 'NEW', replacement: 'ТУЦ' } }]
          }
        }
      ]
    }

    const transition: WorkflowTransition = { _id: 't-1' } as any
    const txes = await UpdateFieldValue(control, currentTask, transition, props as any)

    expect(txes.length).toBe(1)
    const ops = (txes[0] as TxUpdateDoc<Task>).operations as any
    expect(ops.assignee).toBe('user-current')
    expect(ops.titleUpper).toBe('HELLO WORLD!')
    expect(ops.parentDesc).toBe('Parent Desc')
    expect(ops.firstItem).toBe('val1')
    expect(ops.titleReplaced).toBe('ТУЦ TASK NEW')
    expect(ops.titleReplacedAll).toBe('ТУЦ TASK ТУЦ')
  })

  it('should execute ClearFieldValue post-function on status transition', async () => {
    const fromStatus = generateId<Status>()
    const toStatus = generateId<Status>()
    const taskTypeId = generateId<TaskType>()
    const workflowId = generateId<Workflow>()
    const pfRuleId = generateId()

    const oldTask = createMockTask({ status: fromStatus, kind: taskTypeId, resolution: 'fixed' } as any)
    const updateTx: TxUpdateDoc<Task> = txFactory.createTxUpdateDoc(task.class.Task, testSpace, oldTask._id, {
      status: toStatus
    })
    updateTx.meta = { fromStatus }

    const project: Project = {
      _id: testSpace,
      _class: task.class.Project,
      space: testSpace,
      name: 'Test Project',
      rank: '0|i00000:' as Rank,
      modifiedBy: 'user-1' as any,
      modifiedOn: Date.now(),
      createdOn: Date.now(),
      createdBy: 'user-1' as any,
      workflows: { [taskTypeId]: workflowId }
    } as any

    const transition: WorkflowTransition = {
      _id: generateId(),
      _class: workflow.class.WorkflowTransition,
      space: testSpace as any,
      modifiedOn: Date.now(),
      modifiedBy: 'user-1' as any,
      attachedTo: workflowId,
      attachedToClass: workflow.class.Workflow,
      collection: 'transitions',
      name: 'Reopen',
      from: [fromStatus],
      to: toStatus,
      rank: '0|i00000:' as Rank,
      postFunctions: [
        {
          id: 'pf-1',
          rule: pfRuleId as any,
          props: { fields: [{ fieldKey: 'resolution' }] }
        }
      ]
    } as any

    const pfRule = {
      _id: pfRuleId,
      _class: workflow.class.WorkflowPostFunction,
      space: testSpace,
      modifiedOn: Date.now(),
      modifiedBy: 'user-1',
      label: 'Clear field value',
      description: '',
      order: 20,
      editor: 'editor',
      serverExecutor: 'ClearFieldValue'
    } as any

    const hierarchy = {
      isDerived: (c: any, target: any) => c === target || target === task.class.Task,
      hasMixin: () => true,
      findAttribute: () => undefined,
      as: (obj: any, mixin: any) => {
        if (mixin === workflow.mixin.ProjectWorkflow) return project
        if (
          mixin === serverWorkflow.mixin.PostFunctionImpl ||
          mixin === 'server-workflow:mixin:PostFunctionImpl' ||
          String(mixin).includes('PostFunctionImpl')
        ) {
          return pfRule
        }
        return obj
      }
    } as any

    const control: TriggerControl = {
      ctx: mockCtx,
      hierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockImplementation(async (ctx, _class, query) => {
        if (_class === task.class.Project) return toFindResult([project])
        if (_class === task.class.Task) return toFindResult([oldTask])
        if (_class === workflow.class.WorkflowTransition) return toFindResult([transition])
        if (_class === workflow.class.WorkflowPostFunction) return toFindResult([pfRule])
        return toFindResult([])
      })
    } as any

    const resultTxes = await PostFunctionsTrigger([updateTx], control)

    expect(resultTxes.length).toBe(1)
    const pfTx = resultTxes[0] as TxUpdateDoc<Task>
    expect((pfTx.operations as any).$unset?.resolution).toBe(true)
  })

  it('should handle ClearFieldValue directly with regular, mixin and collection fields', async () => {
    const currentTask = createMockTask({
      _id: 'task-1' as any,
      _class: task.class.Task,
      customField: 'value',
      'custom:mixin': { mixinField: 123 }
    })

    const collectionDoc = {
      _id: 'col-doc-1',
      _class: 'test:class:ColDoc',
      space: testSpace,
      attachedTo: 'task-1',
      attachedToClass: task.class.Task,
      collection: 'items'
    }

    const hierarchy = {
      isDerived: (c: any, target: any) => c === 'core:class:Collection' || target === task.class.Task,
      hasMixin: (doc: any, mixin: any) => mixin === 'custom:mixin',
      findAttribute: (cls: any, key: any) => {
        if (key === 'items') {
          return { _id: key, name: key, type: { _class: 'core:class:Collection', of: 'test:class:ColDoc' } }
        }
        return { _id: key, name: key, type: { _class: 'core:class:String' } }
      }
    } as any

    const control: TriggerControl = {
      ctx: mockCtx,
      hierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockImplementation(async (ctx, _class, query) => {
        if (_class === 'test:class:ColDoc') return [collectionDoc]
        return []
      })
    } as any

    const transition: WorkflowTransition = { _id: 't-1' } as any

    const emptyResult = await ClearFieldValue(control, currentTask, transition, { fields: [] })
    expect(emptyResult).toEqual([])

    const res = await ClearFieldValue(control, currentTask, transition, {
      fields: [
        { fieldKey: '', attribute: '' as any },
        { fieldKey: 'simpleField', attribute: 'simpleField' as any },
        { fieldKey: 'mixinField', mixin: 'custom:mixin' as any, attribute: 'mixinField' as any },
        { fieldKey: 'ignoredMixin', mixin: 'other:mixin' as any, attribute: 'ignoredMixin' as any },
        { fieldKey: 'items', attribute: 'items' as any }
      ]
    })

    expect(res.length).toBe(2)

    // Collection remove CUD tx
    const collectionTx = res[0] as any
    expect(collectionTx._class).toBe('core:class:TxRemoveDoc')
    expect(collectionTx.collection).toBe('items')
    expect(collectionTx.attachedTo).toBe('task-1')

    // Document update with $unset tx
    const updateTx = res[1] as TxUpdateDoc<Task>
    expect(updateTx._class).toBe('core:class:TxUpdateDoc')
    expect((updateTx.operations as any).$unset).toEqual({
      simpleField: true,
      'custom:mixin.mixinField': true
    })
  })

  it('should handle UpdateFieldValue with Collection fields (add and remove)', async () => {
    const currentTask = createMockTask({
      _id: 'task-1' as any,
      _class: task.class.Task
    })

    const existingDoc = {
      _id: 'col-doc-1',
      _class: 'test:class:ColDoc',
      space: testSpace,
      attachedTo: 'task-1',
      attachedToClass: task.class.Task,
      collection: 'labels',
      tag: 'tag-existing'
    }

    const hierarchy = {
      isDerived: (c: any, target: any) => c === 'core:class:Collection' || target === task.class.Task,
      hasMixin: () => true,
      findAttribute: (cls: any, key: any) => {
        if (cls === task.class.Task && key === 'labels') {
          return { _id: key, name: key, type: { _class: 'core:class:Collection', of: 'test:class:ColDoc' } }
        }
        if (cls === 'test:class:ColDoc' && key === 'tag') {
          return { _id: key, name: key, type: { _class: 'core:class:RefTo', to: 'test:class:Tag' } }
        }
        return undefined
      }
    } as any

    const control: TriggerControl = {
      ctx: mockCtx,
      hierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockImplementation(async (ctx, _class, query) => {
        if (_class === 'test:class:ColDoc') return [existingDoc]
        if (_class === tags.class.TagElement) {
          return [{ _id: query._id, title: String(query._id), color: 1 }]
        }
        return []
      })
    } as any

    const transition: WorkflowTransition = { _id: 't-1' } as any

    // Test set operation (replace: remove 'tag-existing', add 'tag-replaced')
    const setRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'labels',
          attribute: 'labels' as any,
          operation: 'set',
          value: { type: 'const', value: ['tag-replaced'] }
        }
      ]
    })

    // Should produce 1 remove tx for 'col-doc-1' and 1 create tx for 'tag-replaced'
    expect(setRes.length).toBe(2)
    const removeSetTx = setRes.find((tx: any) => tx._class === 'core:class:TxRemoveDoc') as any
    const createSetTx = setRes.find((tx: any) => tx._class === 'core:class:TxCreateDoc') as any
    expect(removeSetTx).toBeDefined()
    expect(removeSetTx.objectId).toBe('col-doc-1')
    expect(createSetTx).toBeDefined()
    expect(createSetTx.attributes.tag).toBe('tag-replaced')

    // Test add operation (1 new tag, 1 already existing tag)
    const addRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'labels',
          attribute: 'labels' as any,
          operation: 'add',
          value: { type: 'const', value: ['tag-existing', 'tag-new'] }
        }
      ]
    })

    // Only 'tag-new' should be created
    expect(addRes.length).toBe(1)
    const addTx = addRes[0] as any
    expect(addTx._class).toBe('core:class:TxCreateDoc')
    expect(addTx.collection).toBe('labels')
    expect(addTx.attachedTo).toBe('task-1')
    expect(addTx.attributes.tag).toBe('tag-new')

    // Test remove operation
    const removeRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'labels',
          attribute: 'labels' as any,
          operation: 'remove',
          value: { type: 'const', value: ['tag-existing'] }
        }
      ]
    })

    expect(removeRes.length).toBe(1)
    const removeTx = removeRes[0] as any
    expect(removeTx._class).toBe('core:class:TxRemoveDoc')
    expect(removeTx.objectId).toBe('col-doc-1')
  })

  it('should handle UpdateFieldValue with Collection of collaborators using $currentUser', async () => {
    const currentTask = createMockTask({
      _id: 'task-1' as any,
      _class: task.class.Task
    })

    const existingCollaboratorDoc = {
      _id: 'col-doc-user-1',
      _class: core.class.Collaborator,
      space: testSpace,
      attachedTo: 'task-1',
      attachedToClass: task.class.Task,
      collection: 'collaborators',
      collaborator: 'user-account-uuid'
    }

    const hierarchy = {
      isDerived: (c: any, target: any) =>
        c === 'core:class:Collection' || target === task.class.Task || target === core.class.Collaborator,
      hasMixin: () => true,
      findAttribute: (cls: any, key: any) => {
        if (cls === task.class.Task && key === 'collaborators') {
          return { _id: key, name: key, type: { _class: 'core:class:Collection', of: core.class.Collaborator } }
        }
        if (cls === core.class.Collaborator && key === 'collaborator') {
          return { _id: key, name: key, type: { _class: 'core:class:TypeAccountUuid' } }
        }
        return undefined
      }
    } as any

    const control: TriggerControl = {
      ctx: {
        ...mockCtx,
        contextData: {
          account: {
            uuid: 'user-account-uuid',
            primarySocialId: 'social-1'
          }
        }
      },
      hierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockImplementation(async (ctx, _class, query) => {
        if (_class === contact.class.SocialIdentity) {
          return [{ _id: 'social-1', attachedTo: 'user-account-uuid' }]
        }
        if (_class === core.class.Collaborator) {
          return [existingCollaboratorDoc]
        }
        return []
      })
    } as any

    const transition: WorkflowTransition = { _id: 't-1' } as any

    // Test add $currentUser when already present (should not duplicate)
    const addDuplicateRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'collaborators',
          attribute: 'collaborators' as any,
          operation: 'add',
          value: { type: 'preset', preset: '$currentUser' }
        }
      ]
    })
    expect(addDuplicateRes.length).toBe(0)

    // Test remove $currentUser
    const removeRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'collaborators',
          attribute: 'collaborators' as any,
          operation: 'remove',
          value: { type: 'preset', preset: '$currentUser' }
        }
      ]
    })
    expect(removeRes.length).toBe(1)
    const removeTx = removeRes[0] as any
    expect(removeTx._class).toBe('core:class:TxRemoveDoc')
    expect(removeTx.objectId).toBe('col-doc-user-1')

    // Test add $currentUser when not in collection
    const controlEmptyCol: TriggerControl = {
      ...control,
      findAll: jest.fn().mockImplementation(async (ctx, _class, query) => {
        if (_class === contact.class.SocialIdentity) {
          return [{ _id: 'social-1', attachedTo: 'user-account-uuid' }]
        }
        if (_class === core.class.Collaborator) {
          return []
        }
        return []
      })
    } as any

    const addRes = await UpdateFieldValue(controlEmptyCol, currentTask, transition, {
      fields: [
        {
          fieldKey: 'collaborators',
          attribute: 'collaborators' as any,
          operation: 'add',
          value: { type: 'preset', preset: '$currentUser' }
        }
      ]
    })
    expect(addRes.length).toBe(1)
    const addTx = addRes[0] as any
    expect(addTx._class).toBe('core:class:TxCreateDoc')
    expect(addTx.collection).toBe('collaborators')
    expect(addTx.attachedTo).toBe('task-1')
    expect(addTx.attributes.collaborator).toBe('user-account-uuid')
  })

  it('should handle updateArrField with set, add, and remove operations on Task', async () => {
    const currentTask = createMockTask({
      _id: 'task-arr-1' as any,
      _class: task.class.Task,
      tags: ['tag-1', 'tag-2'] as any
    })

    const hierarchy = {
      isDerived: (c: any, target: any) => c === target || target === task.class.Task,
      hasMixin: () => false,
      findAttribute: (cls: any, key: any) => {
        if (cls === task.class.Task && key === 'tags') {
          return {
            _id: key,
            name: key,
            type: { _class: 'core:class:ArrOf', of: { _class: 'core:class:RefTo', to: 'test:class:Tag' } }
          }
        }
        return undefined
      }
    } as any

    const control: TriggerControl = {
      ctx: mockCtx,
      hierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockResolvedValue([])
    } as any

    const transition: WorkflowTransition = { _id: 't-1' } as any

    // 1. SET operation
    const setRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'tags',
          attribute: 'tags' as any,
          operation: 'set',
          value: { type: 'const', value: ['tag-3', 'tag-4', 'tag-3'] } // with duplicate in input
        }
      ]
    })
    expect(setRes.length).toBe(1)
    const setTx = setRes[0] as TxUpdateDoc<Task>
    expect(setTx._class).toBe('core:class:TxUpdateDoc')
    expect((setTx.operations as any).tags).toEqual(['tag-3', 'tag-4'])

    // 2. SET operation with identical array -> no-op (empty result)
    const setSameRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'tags',
          attribute: 'tags' as any,
          operation: 'set',
          value: { type: 'const', value: ['tag-1', 'tag-2'] }
        }
      ]
    })
    expect(setSameRes.length).toBe(0)

    // 3. ADD operation: adds non-duplicate items
    const addRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'tags',
          attribute: 'tags' as any,
          operation: 'add',
          value: { type: 'const', value: ['tag-2', 'tag-3', 'tag-3'] }
        }
      ]
    })
    expect(addRes.length).toBe(1)
    const addTx = addRes[0] as TxUpdateDoc<Task>
    expect(addTx._class).toBe('core:class:TxUpdateDoc')
    expect((addTx.operations as any).$push?.tags).toBe('tag-3')

    // 4. ADD operation when already present -> no-op
    const addExistingRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'tags',
          attribute: 'tags' as any,
          operation: 'add',
          value: { type: 'const', value: ['tag-1', 'tag-2'] }
        }
      ]
    })
    expect(addExistingRes.length).toBe(0)

    // 5. REMOVE operation: removes matching items
    const removeRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'tags',
          attribute: 'tags' as any,
          operation: 'remove',
          value: { type: 'const', value: ['tag-1'] }
        }
      ]
    })
    expect(removeRes.length).toBe(1)
    const removeTx = removeRes[0] as TxUpdateDoc<Task>
    expect(removeTx._class).toBe('core:class:TxUpdateDoc')
    expect((removeTx.operations as any).$pull?.tags).toBe('tag-1')

    // 6. REMOVE operation when item not present -> no-op
    const removeNoneRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'tags',
          attribute: 'tags' as any,
          operation: 'remove',
          value: { type: 'const', value: ['tag-99'] }
        }
      ]
    })
    expect(removeNoneRes.length).toBe(0)
  })

  it('should handle updateArrField on mixin attributes', async () => {
    const mixinId = 'documents:mixin:Approval'
    const currentTask = createMockTask({
      _id: 'task-mixin-1' as any,
      _class: task.class.Task,
      [mixinId]: {
        reviewers: ['user-1']
      }
    })

    const hierarchy = {
      isDerived: (c: any, target: any) => c === target || target === task.class.Task,
      isMixin: (cls: any) => cls === mixinId,
      hasMixin: (doc: any, mixin: any) => mixin === mixinId,
      as: (doc: any, mixin: any) => doc[mixinId] ?? {},
      findAttribute: (cls: any, key: any) => {
        if (cls === mixinId && key === 'reviewers') {
          return {
            _id: key,
            name: key,
            type: { _class: 'core:class:ArrOf', of: { _class: 'core:class:TypeRef' } }
          }
        }
        return undefined
      }
    } as any

    const control: TriggerControl = {
      ctx: mockCtx,
      hierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockResolvedValue([])
    } as any

    const transition: WorkflowTransition = { _id: 't-1' } as any

    // ADD to mixin array
    const addRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          mixin: mixinId as any,
          fieldKey: 'reviewers',
          attribute: 'reviewers' as any,
          operation: 'add',
          value: { type: 'const', value: ['user-2'] }
        }
      ]
    })

    expect(addRes.length).toBe(1)
    const mixinTx = addRes[0] as any
    expect(mixinTx._class).toBe('core:class:TxMixin')
    expect(mixinTx.mixin).toBe(mixinId)
    expect(mixinTx.attributes.$push?.reviewers).toBe('user-2')
  })

  it('should handle updateArrField with TypeAccountUuid and $currentUser preset', async () => {
    const currentTask = createMockTask({
      _id: 'task-members-1' as any,
      _class: task.class.Task,
      members: ['other-user-uuid'] as any
    })

    const hierarchy = {
      isDerived: (c: any, target: any) => c === target || target === task.class.Task,
      hasMixin: () => false,
      findAttribute: (cls: any, key: any) => {
        if (cls === task.class.Task && key === 'members') {
          return {
            _id: key,
            name: key,
            type: { _class: 'core:class:ArrOf', of: { _class: core.class.TypeAccountUuid } }
          }
        }
        return undefined
      }
    } as any

    const control: TriggerControl = {
      ctx: {
        ...mockCtx,
        contextData: {
          account: {
            uuid: 'current-user-uuid',
            primarySocialId: 'social-1'
          }
        }
      },
      hierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockImplementation(async (ctx, _class) => {
        if (_class === contact.class.SocialIdentity) {
          return [{ _id: 'social-1', attachedTo: 'person-1' }]
        }
        return []
      })
    } as any

    const transition: WorkflowTransition = { _id: 't-1' } as any

    // ADD $currentUser to members array
    const addRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'members',
          attribute: 'members' as any,
          operation: 'add',
          value: { type: 'preset', preset: '$currentUser' }
        }
      ]
    })

    expect(addRes.length).toBe(1)
    const addTx = addRes[0] as TxUpdateDoc<Task>
    expect((addTx.operations as any).$push?.members).toBe('current-user-uuid')

    // REMOVE $currentUser from members array
    const taskWithCurrentUser = createMockTask({
      _id: 'task-members-1' as any,
      _class: task.class.Task,
      members: ['other-user-uuid', 'current-user-uuid'] as any
    })

    const removeRes = await UpdateFieldValue(control, taskWithCurrentUser, transition, {
      fields: [
        {
          fieldKey: 'members',
          attribute: 'members' as any,
          operation: 'remove',
          value: { type: 'preset', preset: '$currentUser' }
        }
      ]
    })

    expect(removeRes.length).toBe(1)
    const removeTx = removeRes[0] as TxUpdateDoc<Task>
    expect((removeTx.operations as any).$pull?.members).toBe('current-user-uuid')
  })

  it('should test isCollectionOrArrAttribute utility correctly', () => {
    const hierarchy = {
      isDerived: (c: any, target: any) =>
        (c === 'core:class:Collection' && target === core.class.Collection) ||
        (c === 'core:class:ArrOf' && target === core.class.ArrOf)
    } as any

    expect(isCollectionOrArrAttribute(hierarchy, { type: { _class: 'core:class:Collection' } } as any)).toBe(true)
    expect(isCollectionOrArrAttribute(hierarchy, { type: { _class: 'core:class:ArrOf' } } as any)).toBe(true)
    expect(isCollectionOrArrAttribute(hierarchy, { type: { _class: 'core:class:String' } } as any)).toBe(false)
    expect(isCollectionOrArrAttribute(hierarchy, null as any)).toBe(false)
  })

  it('should handle updateArrField with single scalar value and when initial array is undefined', async () => {
    const currentTask = createMockTask({
      _id: 'task-arr-undef' as any,
      _class: task.class.Task
      // tags is undefined
    })

    const hierarchy = {
      isDerived: (c: any, target: any) => c === target || target === task.class.Task,
      findAttribute: (cls: any, key: any) => {
        if (cls === task.class.Task && key === 'tags') {
          return {
            _id: key,
            name: key,
            type: { _class: 'core:class:ArrOf', of: { _class: 'core:class:TypeString' } }
          }
        }
        return undefined
      }
    } as any

    const control: TriggerControl = {
      ctx: mockCtx,
      hierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockResolvedValue([])
    } as any

    const transition: WorkflowTransition = { _id: 't-1' } as any

    // ADD single string to undefined array
    const addRes = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'tags',
          attribute: 'tags' as any,
          operation: 'add',
          value: { type: 'const', value: 'tag-single' } // scalar instead of array
        }
      ]
    })

    expect(addRes.length).toBe(1)
    const addTx = addRes[0] as TxUpdateDoc<Task>
    expect((addTx.operations as any).$push?.tags).toBe('tag-single')
  })

  it('should handle combined UpdateFieldValue with regular, array, and collection fields', async () => {
    const currentTask = createMockTask({
      _id: 'task-multi-1' as any,
      _class: task.class.Task,
      tags: ['tag-old'] as any
    })

    const hierarchy = {
      isDerived: (c: any, target: any) => c === target || target === task.class.Task,
      hasMixin: () => false,
      findAttribute: (cls: any, key: any) => {
        if (cls === task.class.Task && key === 'tags') {
          return {
            _id: key,
            name: key,
            type: { _class: 'core:class:ArrOf', of: { _class: 'core:class:TypeString' } }
          }
        }
        if (cls === task.class.Task && key === 'collaborators') {
          return {
            _id: key,
            name: key,
            type: { _class: 'core:class:Collection', of: core.class.Collaborator }
          }
        }
        if (cls === task.class.Task && key === 'title') {
          return {
            _id: key,
            name: key,
            type: { _class: 'core:class:String' }
          }
        }
        return undefined
      }
    } as any

    const control: TriggerControl = {
      ctx: mockCtx,
      hierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockImplementation(async (ctx, _class) => {
        if (_class === core.class.Collaborator) return []
        return []
      })
    } as any

    const transition: WorkflowTransition = { _id: 't-1' } as any

    const res = await UpdateFieldValue(control, currentTask, transition, {
      fields: [
        {
          fieldKey: 'title',
          attribute: 'title' as any,
          value: { type: 'const', value: 'Updated Title' }
        },
        {
          fieldKey: 'tags',
          attribute: 'tags' as any,
          operation: 'add',
          value: { type: 'const', value: ['tag-new'] }
        },
        {
          fieldKey: 'collaborators',
          attribute: 'collaborators' as any,
          operation: 'add',
          value: { type: 'const', value: ['user-1'] }
        }
      ]
    })

    // Expect 1 TxUpdateDoc for title, 1 TxUpdateDoc for tags, 1 TxCreateDoc (collection CUD) for collaborators
    expect(res.length).toBe(3)

    const titleTx = res.find((tx: any) => tx._class === 'core:class:TxUpdateDoc' && tx.operations?.title != null) as any
    expect(titleTx).toBeDefined()
    expect(titleTx.operations.title).toBe('Updated Title')

    const tagsTx = res.find(
      (tx: any) => tx._class === 'core:class:TxUpdateDoc' && tx.operations?.$push?.tags != null
    ) as any
    expect(tagsTx).toBeDefined()
    expect(tagsTx.operations.$push.tags).toBe('tag-new')

    const itemTx = res.find((tx: any) => tx._class === 'core:class:TxCreateDoc') as any
    expect(itemTx).toBeDefined()
    expect(itemTx.collection).toBe('collaborators')
    expect(itemTx.attributes.collaborator).toBe('user-1')
  })

  it('should test updateCollectionOrArrField, updateCollectionField, and updateArrField directly', async () => {
    const currentTask = createMockTask({
      _id: 'task-direct-1' as any,
      _class: task.class.Task,
      tags: ['tag-1'] as any
    })

    const tagAttr = {
      _id: 'tags',
      name: 'tags',
      type: { _class: core.class.ArrOf, of: { _class: core.class.TypeString } }
    } as any

    const colAttr = {
      _id: 'collaborators',
      name: 'collaborators',
      type: { _class: core.class.Collection, of: core.class.Collaborator }
    } as any

    const invalidAttr = {
      _id: 'other',
      name: 'other',
      type: { _class: core.class.TypeString }
    } as any

    const hierarchy = {
      isDerived: (c: any, target: any) => c === target || target === task.class.Task
    } as any

    const control: TriggerControl = {
      ctx: mockCtx,
      hierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockResolvedValue([])
    } as any

    // Direct updateArrField call
    const arrTxes = await updateArrField(control, tagAttr, task.class.Task, currentTask, {
      fieldKey: 'tags',
      attribute: 'tags' as any,
      operation: 'add',
      value: { type: 'const', value: ['tag-2'] }
    })
    expect(arrTxes.length).toBe(1)
    expect(((arrTxes[0] as TxUpdateDoc<Task>).operations as any).$push.tags).toBe('tag-2')

    // Direct updateCollectionField call
    const colTxes = await updateCollectionField(control, colAttr, task.class.Task, currentTask, {
      fieldKey: 'collaborators',
      attribute: 'collaborators' as any,
      operation: 'add',
      value: { type: 'const', value: ['user-direct-1'] }
    })
    expect(colTxes.length).toBe(1)
    expect((colTxes[0] as any).attributes.collaborator).toBe('user-direct-1')

    // Direct updateCollectionOrArrField call on ArrOf
    const dispatchedArr = await updateCollectionOrArrField(control, tagAttr, task.class.Task, currentTask, {
      fieldKey: 'tags',
      attribute: 'tags' as any,
      operation: 'add',
      value: { type: 'const', value: ['tag-2'] }
    })
    expect(dispatchedArr.length).toBe(1)

    // Direct updateCollectionOrArrField call on Collection
    const dispatchedCol = await updateCollectionOrArrField(control, colAttr, task.class.Task, currentTask, {
      fieldKey: 'collaborators',
      attribute: 'collaborators' as any,
      operation: 'add',
      value: { type: 'const', value: ['user-direct-1'] }
    })
    expect(dispatchedCol.length).toBe(1)

    // Direct updateCollectionOrArrField call on non-collection attribute -> returns empty
    const nonCol = await updateCollectionOrArrField(control, invalidAttr, task.class.Task, currentTask, {
      fieldKey: 'other',
      attribute: 'other' as any,
      operation: 'set',
      value: { type: 'const', value: 'test' }
    })
    expect(nonCol.length).toBe(0)
  })

  it('should not add duplicate collection elements when two rules add the same element', async () => {
    const currentTask = createMockTask({
      _id: 'task-dup-collab' as any,
      _class: task.class.Task
    })

    const collabAttr = {
      _id: 'collaborators',
      name: 'collaborators',
      type: { _class: core.class.Collection, of: 'core:class:Collaborator' }
    } as any

    const hierarchy = createMockHierarchy({
      findAttribute: (_cls: any, key: any) => (key === 'collaborators' ? collabAttr : undefined)
    })
    const control: TriggerControl = {
      ctx: {
        ...mockCtx,
        contextData: { account: { uuid: 'user-1' } }
      },
      hierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockResolvedValue([])
    } as any

    // Rule 1: adds 'user-1' to collaborators
    const rule1Txes = await UpdateFieldValue(control, currentTask, {} as any, {
      fields: [
        {
          fieldKey: 'collaborators',
          attribute: 'collaborators' as any,
          operation: 'add',
          value: { type: 'const', value: 'user-1' }
        }
      ]
    })
    expect(rule1Txes.length).toBe(1)
    expect((rule1Txes[0] as any).attributes.collaborator).toBe('user-1')

    // Rule 2: also adds 'user-1' to collaborators, with rule1Txes passed as currentTxes
    const rule2Txes = await UpdateFieldValue(
      control,
      currentTask,
      {} as any,
      {
        fields: [
          {
            fieldKey: 'collaborators',
            attribute: 'collaborators' as any,
            operation: 'add',
            value: { type: 'const', value: 'user-1' }
          }
        ]
      },
      rule1Txes
    )
    // Rule 2 should see rule1's pending transaction and NOT duplicate it
    expect(rule2Txes.length).toBe(0)

    // Test transition with two post functions in executeTransitionPostFunctions
    const pfRuleId = generateId()
    const pfRule = {
      _id: pfRuleId,
      _class: workflow.class.WorkflowPostFunction,
      space: testSpace,
      modifiedOn: Date.now(),
      modifiedBy: 'user-1',
      label: 'Add Collab',
      description: '',
      order: 10,
      editor: 'editor',
      serverExecutor: 'UpdateFieldValue'
    } as any

    const transitionWithTwoRules: WorkflowTransition = {
      _id: generateId(),
      _class: workflow.class.WorkflowTransition,
      space: testSpace as any,
      modifiedOn: Date.now(),
      modifiedBy: 'user-1' as any,
      attachedTo: generateId(),
      attachedToClass: workflow.class.Workflow,
      collection: 'transitions',
      name: 'Transition',
      from: [],
      to: generateId(),
      rank: '0|i00000:' as Rank,
      postFunctions: [
        {
          id: 'pf-1',
          rule: pfRuleId as any,
          props: {
            fields: [
              {
                fieldKey: 'collaborators',
                attribute: 'collaborators' as any,
                operation: 'add',
                value: { type: 'const', value: 'user-duplicate' }
              }
            ]
          }
        },
        {
          id: 'pf-2',
          rule: pfRuleId as any,
          props: {
            fields: [
              {
                fieldKey: 'collaborators',
                attribute: 'collaborators' as any,
                operation: 'add',
                value: { type: 'const', value: 'user-duplicate' }
              }
            ]
          }
        }
      ]
    } as any

    const execHierarchy = createMockHierarchy({
      hasMixin: () => true,
      as: () => pfRule,
      findAttribute: (cls: any, key: any) => {
        if (key === 'collaborators') return collabAttr
        return undefined
      }
    })

    const execControl: TriggerControl = {
      ctx: mockCtx,
      hierarchy: execHierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockImplementation(async (ctx, _class) => {
        if (_class === workflow.class.WorkflowPostFunction) return [pfRule]
        return []
      })
    } as any

    const transitionTxes = await executeTransitionPostFunctions(execControl, transitionWithTwoRules, currentTask)
    // Only 1 TxCreateDoc for user-duplicate should be returned, not 2
    expect(transitionTxes.length).toBe(1)
    expect((transitionTxes[0] as any).attributes.collaborator).toBe('user-duplicate')
  })

  it('should propagate task field modifications to subsequent rules during executeTransitionPostFunctions', async () => {
    const currentTask: any = createMockTask({
      _id: 'task-chained-rules' as any,
      description: 'Initial description'
    })

    const pfRuleId1 = generateId()
    const pfRuleId2 = generateId()

    const pfRule1 = {
      _id: pfRuleId1,
      _class: workflow.class.WorkflowPostFunction,
      space: testSpace,
      modifiedOn: Date.now(),
      modifiedBy: 'user-1',
      label: 'Rule 1',
      description: '',
      order: 10,
      editor: 'editor',
      serverExecutor: 'UpdateFieldValue'
    } as any

    const pfRule2 = {
      _id: pfRuleId2,
      _class: workflow.class.WorkflowPostFunction,
      space: testSpace,
      modifiedOn: Date.now(),
      modifiedBy: 'user-1',
      label: 'Rule 2',
      description: '',
      order: 20,
      editor: 'editor',
      serverExecutor: 'UpdateFieldValue'
    } as any

    const transitionWithChainedRules: WorkflowTransition = {
      _id: generateId(),
      _class: workflow.class.WorkflowTransition,
      space: testSpace as any,
      modifiedOn: Date.now(),
      modifiedBy: 'user-1' as any,
      attachedTo: generateId(),
      attachedToClass: workflow.class.Workflow,
      collection: 'transitions',
      name: 'Transition',
      from: [],
      to: generateId(),
      rank: '0|i00000:' as Rank,
      postFunctions: [
        {
          id: 'pf-1',
          rule: pfRuleId1 as any,
          props: {
            fields: [
              {
                fieldKey: 'description',
                attribute: 'description' as any,
                value: { type: 'const', value: 'Updated from rule 1' }
              }
            ]
          }
        },
        {
          id: 'pf-2',
          rule: pfRuleId2 as any,
          props: {
            fields: [
              {
                fieldKey: 'assignee',
                attribute: 'assignee' as any,
                value: { type: 'this', fieldKey: 'description' }
              }
            ]
          }
        }
      ]
    } as any

    const execHierarchy = createMockHierarchy({
      hasMixin: () => true,
      as: (obj: any) => obj,
      findAttribute: () => undefined
    })

    const execControl: TriggerControl = {
      ctx: mockCtx,
      hierarchy: execHierarchy,
      txFactory,
      modelDb: { findAllSync: () => [] } as any,
      findAll: jest.fn().mockImplementation(async (ctx, _class, query) => {
        if (_class === workflow.class.WorkflowPostFunction) {
          if (query._id === pfRuleId1) return [pfRule1]
          if (query._id === pfRuleId2) return [pfRule2]
        }
        return []
      })
    } as any

    const resultTxes = await executeTransitionPostFunctions(execControl, transitionWithChainedRules, currentTask)
    expect(resultTxes.length).toBe(2)

    // Rule 1 modified task.description
    expect(currentTask.description).toBe('Updated from rule 1')

    // Rule 2 picked up the updated description from task and set it as assignee
    const assigneeTx = resultTxes.find((tx: any) => tx.operations?.assignee != null) as any
    expect(assigneeTx).toBeDefined()
    expect(assigneeTx.operations.assignee).toBe('Updated from rule 1')
    expect(currentTask.assignee).toBe('Updated from rule 1')
  })
})

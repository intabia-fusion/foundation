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
  type Doc,
  generateId,
  type Ref,
  type Space,
  type TxCreateDoc,
  type TxUpdateDoc,
  TxFactory,
  type Class,
  toFindResult,
  type Status,
  type WithLookup
} from '@hcengineering/core'
import { type TriggerControl, type PipelineContext } from '@hcengineering/server-core'
import task, { type Task, type Project, type TaskType, type Rank } from '@hcengineering/task'
import workflow from '@hcengineering/model-workflow'
import { type Workflow, type WorkflowTransition } from '@hcengineering/workflow'
import { WorkflowMiddleware } from '@hcengineering/server-workflow'

import { PostFunctionsTrigger } from '../PostFunctions'

jest.mock('@hcengineering/platform', () => {
  const actual = jest.requireActual('@hcengineering/platform')
  return {
    ...actual,
    getResource: jest.fn().mockImplementation(async (res) => {
      if (res === 'FieldRequired') {
        const { FieldRequired } = jest.requireActual('../PostFunctions')
        return FieldRequired
      }
      return actual.getResource(res)
    })
  }
})

const testSpace = 'test-space' as Ref<Project>
const testAccount = 'user-account' as any

function createMockTask (data: Partial<Task> = {}): WithLookup<Task> {
  return {
    _id: data._id ?? generateId(),
    _class: task.class.Task,
    space: data.space ?? testSpace,
    status: data.status ?? generateId(),
    kind: data.kind ?? generateId(),
    number: 1,
    identifier: 'TASK-1',
    modifiedOn: Date.now(),
    modifiedBy: testAccount,
    createdBy: testAccount,
    createdOn: Date.now(),
    ...data
  } as unknown as WithLookup<Task>
}

function createCreateTx (t: WithLookup<Task>): TxCreateDoc<Task> {
  const { _id, _class, space, ...attributes } = t
  return {
    _id: generateId(),
    _class: core.class.TxCreateDoc,
    space: core.space.DerivedTx,
    objectId: _id,
    objectClass: _class,
    objectSpace: space,
    modifiedOn: Date.now(),
    modifiedBy: testAccount,
    createdBy: testAccount,
    attributes: attributes as any
  } satisfies TxCreateDoc<Task>
}

function createUpdateTx (
  taskId: Ref<Task>,
  operations: Partial<Task>,
  space: Ref<Space> = testSpace
): TxUpdateDoc<Task> {
  return {
    _id: generateId(),
    _class: core.class.TxUpdateDoc,
    space: core.space.DerivedTx,
    objectId: taskId,
    objectClass: task.class.Task,
    objectSpace: space,
    modifiedOn: Date.now(),
    modifiedBy: testAccount,
    createdBy: testAccount,
    operations
  } satisfies TxUpdateDoc<Task>
}

type FindAllFn = (ctx: any, _class: Ref<Class<Doc>>, query: any, options?: any) => Promise<Doc[]>

function createMockControl (findAllImpl: FindAllFn): TriggerControl & { getHierarchy: () => any } {
  const control = {
    ctx: {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      newChild: jest.fn().mockReturnThis(),
      contextData: { account: null }
    } as any,
    workspace: { url: 'test-ws', uuid: 'test-ws-uuid', dataId: 'test-data', accountsUrl: '' } as any,
    branding: null,
    findAll: jest.fn(async (...args: Parameters<FindAllFn>) => toFindResult(await findAllImpl(...args))),
    txFactory: new TxFactory(core.account.System, true),
    hierarchy: {
      isDerived: (_class: Ref<Class<Doc>>, base: Ref<Class<Doc>>) => {
        return _class === base
      },
      hasMixin: (doc: any, _class: any) => {
        return doc.workflows !== undefined
      },
      as: (doc: any, _class: any) => doc,
      findAttribute: (_class: any, fieldKey: any) => ({
        name: fieldKey,
        label: fieldKey,
        type: { _class: core.class.TypeString }
      })
    } as any,
    getHierarchy () {
      return this.hierarchy
    },
    modelDb: {} as any,
    removedMap: new Map(),
    userStatusMap: new Map(),
    cache: new Map(),
    contextCache: new Map(),
    withScope: async <T>(_scope: string, fn: () => Promise<T>) => await fn(),
    txes: [],
    apply: jest.fn().mockResolvedValue({})
  }
  return control as unknown as TriggerControl & { getHierarchy: () => any }
}

async function createMockMiddleware (findAllImpl: FindAllFn): Promise<WorkflowMiddleware> {
  const context: PipelineContext = {
    workspace: { url: 'test-ws', uuid: 'test-ws-uuid', dataId: 'test-data', accountsUrl: '' } as any,
    hierarchy: {
      isDerived: (_class: any, base: any) => _class === base || base === task.class.Task,
      hasMixin: (doc: any, _class: any) => doc.workflows !== undefined,
      as: (doc: any, _class: any) => doc,
      findAttribute: (_class: any, fieldKey: any) => ({
        name: fieldKey,
        label: fieldKey,
        type: { _class: core.class.TypeString }
      })
    } as any,
    modelDb: {} as any,
    branding: null,
    contextVars: {}
  } as any
  const middleware = (await WorkflowMiddleware.create({} as any, context)) as WorkflowMiddleware
  jest.spyOn(middleware as any, 'provideFindAll').mockImplementation(async (...args: any[]) => {
    return await findAllImpl(args[0], args[1], args[2], args[3])
  })
  return middleware
}

describe('PostFunctionsTrigger', () => {
  it('should allow all transitions if project has no workflow scheme', async () => {
    const project: Partial<Project> = {
      _id: testSpace as any,
      _class: task.class.Project,
      space: core.space.Model
    }

    const t = createMockTask()
    const tx = createUpdateTx(t._id, { status: generateId() })

    const control = createMockControl(async (ctx, cl, query) => {
      if (cl === task.class.Project && query._id === testSpace) {
        return [project as Doc]
      }
      if (cl === task.class.Task && query._id === t._id) {
        return [t]
      }
      return []
    })

    await expect(PostFunctionsTrigger([tx], control)).resolves.not.toThrow()
  })

  it('should allow creation with valid start status', async () => {
    const statusTodo = 'todo-status' as Ref<Status>
    const wfId = 'wf-1' as Ref<Workflow>

    const t = createMockTask({ status: statusTodo })
    const tx = createCreateTx(t)

    const project: Doc & any = {
      _id: testSpace as any,
      _class: task.class.Project,
      space: core.space.Model,
      workflows: {
        [t.kind]: wfId
      }
    }

    const transition: Doc & WorkflowTransition = {
      _id: 't-1' as any,
      _class: workflow.class.WorkflowTransition,
      space: testSpace,
      attachedTo: wfId,
      attachedToClass: workflow.class.Workflow,
      collection: 'transitions',
      name: 'Create',
      from: [],
      to: statusTodo,
      rank: 'a0' as Rank,
      modifiedOn: 0,
      modifiedBy: testAccount
    }

    const control = createMockControl(async (ctx, cl, query) => {
      if (cl === task.class.Project && query._id === testSpace) {
        return [project]
      }
      if (cl === workflow.class.WorkflowTransition && query.attachedTo === wfId) {
        return [transition]
      }
      return []
    })

    await expect(PostFunctionsTrigger([tx], control)).resolves.not.toThrow()
  })

  it('should throw error on creation with invalid start status', async () => {
    const statusTodo = 'todo-status' as Ref<Status>
    const statusDone = 'done-status' as Ref<Status>
    const wfId = 'wf-1' as Ref<Workflow>

    const t = createMockTask({ status: statusDone })
    const tx = createCreateTx(t)

    const project: Doc & any = {
      _id: testSpace as any,
      _class: task.class.Project,
      space: core.space.Model,
      workflows: {
        [t.kind]: wfId
      }
    }

    const transition: Doc & WorkflowTransition = {
      _id: 't-1' as any,
      _class: workflow.class.WorkflowTransition,
      space: testSpace,
      attachedTo: wfId,
      attachedToClass: workflow.class.Workflow,
      collection: 'transitions',
      name: 'Create',
      from: [],
      to: statusTodo,
      rank: 'a0' as Rank,
      modifiedOn: 0,
      modifiedBy: testAccount
    }

    const wfDoc: Doc & Workflow = {
      _id: wfId,
      _class: workflow.class.Workflow,
      space: testSpace,
      projectType: 'pt-1' as any,
      taskType: t.kind,
      name: 'WF 1',
      initialStatuses: [statusTodo],
      modifiedOn: 0,
      modifiedBy: testAccount
    }

    const middleware = await createMockMiddleware(async (ctx, cl, query) => {
      if (cl === task.class.Project && query._id === testSpace) {
        return [project]
      }
      if (cl === workflow.class.Workflow && query._id === wfId) {
        return [wfDoc]
      }
      if (cl === workflow.class.WorkflowTransition && query.attachedTo === wfId) {
        return [transition]
      }
      return []
    })

    await expect(middleware.tx({ contextData: { account: null } } as any, [tx])).rejects.toThrow()
  })

  it('should allow valid transition on update', async () => {
    const statusTodo = 'todo-status' as Ref<Status>
    const statusInProgress = 'in-progress-status' as Ref<Status>
    const wfId = 'wf-1' as Ref<Workflow>

    const t = createMockTask({ status: statusTodo })
    const tx = createUpdateTx(t._id, { status: statusInProgress })

    const project: Doc & any = {
      _id: testSpace as any,
      _class: task.class.Project,
      space: core.space.Model,
      workflows: {
        [t.kind]: wfId
      }
    }

    const transition: Doc & WorkflowTransition = {
      _id: 't-2' as any,
      _class: workflow.class.WorkflowTransition,
      space: testSpace,
      attachedTo: wfId,
      attachedToClass: workflow.class.Workflow,
      collection: 'transitions',
      name: 'Start Work',
      from: [statusTodo],
      to: statusInProgress,
      rank: 'a0' as Rank,
      modifiedOn: 0,
      modifiedBy: testAccount
    }

    const control = createMockControl(async (ctx, cl, query) => {
      if (cl === task.class.Project && query._id === testSpace) {
        return [project]
      }
      if (cl === task.class.Task && query._id === t._id) {
        return [t]
      }
      if (cl === workflow.class.WorkflowTransition && query.attachedTo === wfId) {
        return [transition]
      }
      return []
    })

    await expect(PostFunctionsTrigger([tx], control)).resolves.not.toThrow()
  })

  it('should throw error on invalid transition on update', async () => {
    const statusTodo = 'todo-status' as Ref<Status>
    const statusDone = 'done-status' as Ref<Status>
    const wfId = 'wf-1' as Ref<Workflow>

    const t = createMockTask({ status: statusTodo })
    const tx = createUpdateTx(t._id, { status: statusDone })

    const project: Doc & any = {
      _id: testSpace as any,
      _class: task.class.Project,
      space: core.space.Model,
      workflows: {
        [t.kind]: wfId
      }
    }

    const transition: Doc & WorkflowTransition = {
      _id: 't-2' as any,
      _class: workflow.class.WorkflowTransition,
      space: testSpace,
      attachedTo: wfId,
      attachedToClass: workflow.class.Workflow,
      collection: 'transitions',
      name: 'Start Work',
      from: [statusTodo],
      to: 'in-progress-status' as Ref<Status>,
      rank: 'a0' as Rank,
      modifiedOn: 0,
      modifiedBy: testAccount
    }

    const middleware = await createMockMiddleware(async (ctx, cl, query) => {
      if (cl === task.class.Project && query._id === testSpace) {
        return [project]
      }
      if (cl === task.class.Task && query._id === t._id) {
        return [t]
      }
      if (cl === workflow.class.WorkflowTransition && query.attachedTo === wfId) {
        return [transition]
      }
      return []
    })

    await expect(middleware.tx({ contextData: { account: null } } as any, [tx])).rejects.toThrow()
  })

  it('should resolve workflow mapping using project workflows array for task types', async () => {
    const taskTypeBug = 'bug-type' as Ref<TaskType>
    const statusTodo = 'todo-status' as Ref<Status>
    const statusInProgress = 'in-progress-status' as Ref<Status>
    const wfBugId = 'wf-bug' as Ref<Workflow>

    const project: Doc & any = {
      _id: testSpace as any,
      _class: task.class.Project,
      space: core.space.Model,
      workflows: {
        [taskTypeBug]: wfBugId
      }
    }

    const transition: Doc & WorkflowTransition = {
      _id: 't-bug-1' as any,
      _class: workflow.class.WorkflowTransition,
      space: testSpace,
      attachedTo: wfBugId,
      attachedToClass: workflow.class.Workflow,
      collection: 'transitions',
      name: 'Fix Bug',
      from: [statusTodo],
      to: statusInProgress,
      rank: 'a0' as Rank,
      modifiedOn: 0,
      modifiedBy: testAccount
    }

    const t = createMockTask({ status: statusTodo, kind: taskTypeBug })
    const tx = createUpdateTx(t._id, { status: statusInProgress })

    const control = createMockControl(async (ctx, cl, query) => {
      if (cl === task.class.Project && query._id === testSpace) {
        return [project]
      }
      if (cl === task.class.Task && query._id === t._id) {
        return [t]
      }
      if (cl === workflow.class.WorkflowTransition && query.attachedTo === wfBugId) {
        return [transition]
      }
      return []
    })

    await expect(PostFunctionsTrigger([tx], control)).resolves.not.toThrow()
  })

  it('should allow transition on update if required field is present in updateTx operations', async () => {
    const statusTodo = 'todo-status' as Ref<Status>
    const statusInProgress = 'in-progress-status' as Ref<Status>
    const wfId = 'wf-1' as Ref<Workflow>
    const valId = 'val-1' as Ref<any>

    const t = createMockTask({ status: statusTodo })
    const tx = createUpdateTx(t._id, { status: statusInProgress, assignee: 'person-1' as any })

    const project: Doc & any = {
      _id: testSpace as any,
      _class: task.class.Project,
      space: core.space.Model,
      workflows: {
        [t.kind]: wfId
      }
    }

    const transition: Doc & WorkflowTransition = {
      _id: 't-2' as any,
      _class: workflow.class.WorkflowTransition,
      space: testSpace,
      attachedTo: wfId,
      attachedToClass: workflow.class.Workflow,
      collection: 'transitions',
      name: 'Start Work',
      from: [statusTodo],
      to: statusInProgress,
      rank: 'a0' as Rank,
      modifiedOn: 0,
      modifiedBy: testAccount,
      validators: [
        {
          id: 'cfg-1',
          ruleClass: workflow.class.WorkflowValidator,
          rule: valId,
          props: {
            fields: ['assignee']
          }
        }
      ]
    }

    const control = createMockControl(async (ctx, cl, query) => {
      if (cl === task.class.Project && query._id === testSpace) {
        return [project]
      }
      if (cl === task.class.Task && query._id === t._id) {
        return [t]
      }
      if (cl === workflow.class.WorkflowTransition && query.attachedTo === wfId) {
        return [transition]
      }
      if (cl === workflow.class.WorkflowValidator && query._id === valId) {
        return [
          {
            _id: valId,
            _class: workflow.class.WorkflowValidator,
            space: core.space.Model,
            label: 'Field Required' as any,
            serverExecutor: 'FieldRequired',
            group: 'fields',
            modifiedOn: 0,
            modifiedBy: testAccount
          } as any as Doc
        ]
      }
      return []
    })

    await expect(PostFunctionsTrigger([tx], control)).resolves.not.toThrow()
  })

  it('should allow transition on update if required field is already present in task document', async () => {
    const statusTodo = 'todo-status' as Ref<Status>
    const statusInProgress = 'in-progress-status' as Ref<Status>
    const wfId = 'wf-1' as Ref<Workflow>
    const valId = 'val-1' as Ref<any>

    const t = createMockTask({ status: statusTodo })
    ;(t as any).assignee = 'person-1'
    const tx = createUpdateTx(t._id, { status: statusInProgress })

    const project: Doc & any = {
      _id: testSpace as any,
      _class: task.class.Project,
      space: core.space.Model,
      workflows: {
        [t.kind]: wfId
      }
    }

    const transition: Doc & WorkflowTransition = {
      _id: 't-2' as any,
      _class: workflow.class.WorkflowTransition,
      space: testSpace,
      attachedTo: wfId,
      attachedToClass: workflow.class.Workflow,
      collection: 'transitions',
      name: 'Start Work',
      from: [statusTodo],
      to: statusInProgress,
      rank: 'a0' as Rank,
      modifiedOn: 0,
      modifiedBy: testAccount,
      validators: [
        {
          id: 'cfg-1',
          ruleClass: workflow.class.WorkflowValidator,
          rule: valId,
          props: {
            fields: ['assignee']
          }
        }
      ]
    }

    const control = createMockControl(async (ctx, cl, query) => {
      if (cl === task.class.Project && query._id === testSpace) {
        return [project]
      }
      if (cl === task.class.Task && query._id === t._id) {
        return [t]
      }
      if (cl === workflow.class.WorkflowTransition && query.attachedTo === wfId) {
        return [transition]
      }
      if (cl === workflow.class.WorkflowValidator && query._id === valId) {
        return [
          {
            _id: valId,
            _class: workflow.class.WorkflowValidator,
            space: core.space.Model,
            label: 'Field Required' as any,
            serverExecutor: 'FieldRequired',
            group: 'fields',
            modifiedOn: 0,
            modifiedBy: testAccount
          } as any as Doc
        ]
      }
      return []
    })

    await expect(PostFunctionsTrigger([tx], control)).resolves.not.toThrow()
  })

  it('should throw error on update if required field is missing', async () => {
    const statusTodo = 'todo-status' as Ref<Status>
    const statusInProgress = 'in-progress-status' as Ref<Status>
    const wfId = 'wf-1' as Ref<Workflow>
    const valId = 'val-1' as Ref<any>

    const t = createMockTask({ status: statusTodo })
    const tx = createUpdateTx(t._id, { status: statusInProgress })

    const project: Doc & any = {
      _id: testSpace as any,
      _class: task.class.Project,
      space: core.space.Model,
      workflows: {
        [t.kind]: wfId
      }
    }

    const transition: Doc & WorkflowTransition = {
      _id: 't-2' as any,
      _class: workflow.class.WorkflowTransition,
      space: testSpace,
      attachedTo: wfId,
      attachedToClass: workflow.class.Workflow,
      collection: 'transitions',
      name: 'Start Work',
      from: [statusTodo],
      to: statusInProgress,
      rank: 'a0' as Rank,
      modifiedOn: 0,
      modifiedBy: testAccount,
      validators: [
        {
          id: 'cfg-1',
          ruleClass: workflow.class.WorkflowValidator,
          rule: valId,
          props: {
            fields: [{ fieldKey: 'assignee' }]
          }
        }
      ]
    }

    const middleware = await createMockMiddleware(async (ctx, cl, query) => {
      if (cl === task.class.Project && query._id === testSpace) {
        return [project]
      }
      if (cl === task.class.Task && query._id === t._id) {
        return [t]
      }
      if (cl === workflow.class.WorkflowTransition && query.attachedTo === wfId) {
        return [transition]
      }
      if (
        cl === workflow.class.WorkflowValidator &&
        (query._id === valId || (Array.isArray(query._id?.$in) && (query._id.$in as any[]).includes(valId)))
      ) {
        return [
          {
            _id: valId,
            _class: workflow.class.WorkflowValidator,
            space: core.space.Model,
            label: 'Field Required' as any,
            serverExecutor: 'FieldRequired',
            group: 'fields',
            modifiedOn: 0,
            modifiedBy: testAccount
          } as any as Doc
        ]
      }
      return []
    })

    await expect(middleware.tx({ contextData: { account: null } } as any, [tx])).rejects.toThrow()
  })

  describe('FieldRequired Executor', () => {
    it('should return ok: false with structured reason when required field is missing', async () => {
      const { FieldRequired } = jest.requireActual('../PostFunctions')
      const t = createMockTask({ status: 'todo' as Ref<Status> })
      const control = createMockControl(async () => [])

      const res = await FieldRequired(control as any, t, { name: 'Start', to: 'in-progress' as Ref<Status> } as any, {
        fields: [{ fieldKey: 'assignee' }]
      })
      expect(res).toEqual(
        expect.objectContaining({
          ok: false,
          reasonIntl: workflow.string.FieldRequiredError,
          intlParams: { field: 'assignee', transition: 'Any ➜ in-progress' }
        })
      )
    })

    it('should return ok: true when required fields are present', async () => {
      const { FieldRequired } = jest.requireActual('../PostFunctions')
      const t = createMockTask({ status: 'todo' as Ref<Status>, assignee: 'person-1' as any })
      const control = createMockControl(async () => [])

      const res = await FieldRequired(control as any, t, { name: 'Start', to: 'in-progress' as Ref<Status> } as any, {
        fields: ['assignee']
      })
      expect(res).toEqual({ ok: true })
    })
  })

  describe('SubtaskStatus Executor', () => {
    it('should return ok: true when task has no subtasks', async () => {
      const { SubtaskStatus } = jest.requireActual('../PostFunctions')
      const t = createMockTask({ _id: 'parent-1' as any, status: 'in-progress' as Ref<Status> })
      const control = createMockControl(async () => [])

      const res = await SubtaskStatus(control as any, t, { name: 'Done', to: 'done' as Ref<Status> } as any, {
        statuses: { 'task-type-1': ['done'] }
      })
      expect(res).toEqual({ ok: true })
    })

    it('should return ok: false when subtask is not in allowed status', async () => {
      const { SubtaskStatus } = jest.requireActual('../PostFunctions')
      const t = createMockTask({ _id: 'parent-1' as any, status: 'in-progress' as Ref<Status> })
      const subtask = createMockTask({
        _id: 'child-1' as any,
        kind: 'subtask-type' as any,
        status: 'in-progress' as Ref<Status>,
        attachedTo: 'parent-1' as any
      })
      const control = createMockControl(async () => [subtask])

      const res = await SubtaskStatus(control as any, t, { name: 'Done', to: 'done' as Ref<Status> } as any, {
        statuses: { 'subtask-type': ['done'] }
      })
      expect(res).toEqual({
        ok: false,
        reason: expect.stringContaining('allowed status'),
        reasonIntl: workflow.string.SubtaskStatusError,
        intlParams: { transition: 'Any ➜ done', statuses: expect.any(String) }
      })
    })

    it('should return ok: true when all subtasks have allowed statuses', async () => {
      const { SubtaskStatus } = jest.requireActual('../PostFunctions')
      const t = createMockTask({ _id: 'parent-1' as any, status: 'in-progress' as Ref<Status> })
      const subtask = createMockTask({
        _id: 'child-1' as any,
        kind: 'subtask-type' as any,
        status: 'done' as Ref<Status>,
        attachedTo: 'parent-1' as any
      })
      const control = createMockControl(async () => [subtask])

      const res = await SubtaskStatus(control as any, t, { name: 'Done', to: 'done' as Ref<Status> } as any, {
        statuses: { 'subtask-type': ['done', 'resolved'] }
      })
      expect(res).toEqual({ ok: true })
    })

    it('should validate subtask status based on TaskType status map in props', async () => {
      const { SubtaskStatus } = jest.requireActual('../PostFunctions')
      const t = createMockTask({ _id: 'parent-1' as any, status: 'in-progress' as Ref<Status> })
      const subtask = createMockTask({
        _id: 'child-1' as any,
        kind: 'bug-type' as any,
        status: 'todo' as Ref<Status>,
        attachedTo: 'parent-1' as any
      })
      const control = createMockControl(async () => [subtask])

      const res = await SubtaskStatus(control as any, t, { name: 'Done', to: 'done' as Ref<Status> } as any, {
        statuses: {
          'bug-type': ['done', 'resolved']
        }
      })
      expect(res).toEqual({
        ok: false,
        reason: expect.stringContaining('allowed status'),
        reasonIntl: workflow.string.SubtaskStatusError,
        intlParams: { transition: 'Any ➜ done', statuses: expect.any(String) }
      })
    })
  })

  describe('ParentStatus Executor', () => {
    it('should return ok: true when task has no parent task', async () => {
      const { ParentStatus } = jest.requireActual('../PostFunctions')
      const t = createMockTask({ _id: 'child-1' as any, status: 'in-progress' as Ref<Status> })
      const control = createMockControl(async () => [])

      const res = await ParentStatus(control as any, t, { name: 'Done', to: 'done' as Ref<Status> } as any, {
        statuses: { 'parent-type': ['in-progress'] }
      })
      expect(res).toEqual({ ok: true })
    })

    it('should return ok: false when parent task is not in allowed status', async () => {
      const { ParentStatus } = jest.requireActual('../PostFunctions')
      const parentTask = createMockTask({
        _id: 'parent-1' as any,
        kind: 'parent-type' as any,
        status: 'todo' as Ref<Status>
      })
      const t = createMockTask({
        _id: 'child-1' as any,
        status: 'in-progress' as Ref<Status>,
        attachedTo: 'parent-1' as any
      })
      const control = createMockControl(async () => [parentTask])

      const res = await ParentStatus(control as any, t, { name: 'Done', to: 'done' as Ref<Status> } as any, {
        statuses: { 'parent-type': ['in-progress', 'done'] }
      })
      expect(res).toEqual({
        ok: false,
        reason: expect.stringContaining('allowed status'),
        reasonIntl: workflow.string.ParentStatusError,
        intlParams: { transition: 'Any ➜ done', statuses: expect.any(String) }
      })
    })

    it('should return ok: true when parent task is in allowed status', async () => {
      const { ParentStatus } = jest.requireActual('../PostFunctions')
      const parentTask = createMockTask({
        _id: 'parent-1' as any,
        kind: 'parent-type' as any,
        status: 'in-progress' as Ref<Status>
      })
      const t = createMockTask({
        _id: 'child-1' as any,
        status: 'in-progress' as Ref<Status>,
        attachedTo: 'parent-1' as any
      })
      const control = createMockControl(async () => [parentTask])

      const res = await ParentStatus(control as any, t, { name: 'Done', to: 'done' as Ref<Status> } as any, {
        statuses: { 'parent-type': ['in-progress', 'done'] }
      })
      expect(res).toEqual({ ok: true })
    })

    it('should validate parent task status based on TaskType status map in props', async () => {
      const { ParentStatus } = jest.requireActual('../PostFunctions')
      const parentTask = createMockTask({
        _id: 'parent-1' as any,
        kind: 'epic-type' as any,
        status: 'todo' as Ref<Status>
      })
      const t = createMockTask({
        _id: 'child-1' as any,
        status: 'in-progress' as Ref<Status>,
        attachedTo: 'parent-1' as any
      })
      const control = createMockControl(async () => [parentTask])

      const res = await ParentStatus(control as any, t, { name: 'Done', to: 'done' as Ref<Status> } as any, {
        statuses: {
          'epic-type': ['in-progress', 'done']
        }
      })
      expect(res).toEqual({
        ok: false,
        reason: expect.stringContaining('allowed status'),
        reasonIntl: workflow.string.ParentStatusError,
        intlParams: { transition: 'Any ➜ done', statuses: expect.any(String) }
      })
    })

    it('should return ok: true when status map value is null for TaskType', async () => {
      const { ParentStatus } = jest.requireActual('../PostFunctions')
      const parentTask = createMockTask({
        _id: 'parent-1' as any,
        kind: 'feature-type' as any,
        status: 'any-status' as Ref<Status>
      })
      const t = createMockTask({
        _id: 'child-1' as any,
        status: 'in-progress' as Ref<Status>,
        attachedTo: 'parent-1' as any
      })
      const control = createMockControl(async () => [parentTask])

      const res = await ParentStatus(control as any, t, { name: 'Done', to: 'done' as Ref<Status> } as any, {
        statuses: {
          'feature-type': null
        }
      })
      expect(res).toEqual({ ok: true })
    })
  })

  describe('OnWorkflowDelete', () => {
    it('should generate TxMixin updating workflows mapping when a workflow referenced by project is deleted', async () => {
      const { OnWorkflowDelete } = jest.requireActual('../WorkflowTrigger')
      const workflowId = 'wf-1' as Ref<Workflow>
      const otherWorkflowId = 'wf-2' as Ref<Workflow>
      const projectId = 'proj-1' as Ref<Project>
      const projectSpace = 'space-1' as Ref<Space>

      const removeTx = {
        _id: generateId(),
        _class: core.class.TxRemoveDoc,
        space: core.space.DerivedTx,
        objectId: workflowId,
        objectClass: workflow.class.Workflow,
        objectSpace: projectSpace,
        modifiedOn: Date.now(),
        modifiedBy: testAccount
      }

      const projectWorkflow = {
        _id: projectId,
        _class: task.class.Project,
        space: projectSpace,
        workflows: {
          'task-type-1': workflowId,
          'task-type-2': otherWorkflowId
        }
      }

      const txFactory = new TxFactory(testAccount)
      const mockControl = {
        ctx: {} as any,
        hierarchy: {
          isDerived: (derived: any, base: any) =>
            derived === workflow.class.Workflow && base === workflow.class.Workflow
        },
        findAll: jest.fn().mockResolvedValue([projectWorkflow]),
        txFactory
      }

      const result = await OnWorkflowDelete([removeTx as any], mockControl as any)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        _class: core.class.TxMixin,
        objectId: projectId,
        objectClass: task.class.Project,
        objectSpace: projectSpace,
        mixin: workflow.mixin.ProjectWorkflow,
        attributes: {
          workflows: {
            'task-type-2': otherWorkflowId
          }
        }
      })
    })

    it('should not generate TxMixin when deleted workflow is not referenced by any project', async () => {
      const { OnWorkflowDelete } = jest.requireActual('../WorkflowTrigger')
      const workflowId = 'wf-1' as Ref<Workflow>
      const otherWorkflowId = 'wf-2' as Ref<Workflow>
      const projectId = 'proj-1' as Ref<Project>
      const projectSpace = 'space-1' as Ref<Space>

      const removeTx = {
        _id: generateId(),
        _class: core.class.TxRemoveDoc,
        space: core.space.DerivedTx,
        objectId: workflowId,
        objectClass: workflow.class.Workflow,
        objectSpace: projectSpace,
        modifiedOn: Date.now(),
        modifiedBy: testAccount
      }

      const projectWorkflow = {
        _id: projectId,
        _class: task.class.Project,
        space: projectSpace,
        workflows: {
          'task-type-2': otherWorkflowId
        }
      }

      const txFactory = new TxFactory(testAccount)
      const mockControl = {
        ctx: {} as any,
        hierarchy: {
          isDerived: (derived: any, base: any) =>
            derived === workflow.class.Workflow && base === workflow.class.Workflow
        },
        findAll: jest.fn().mockResolvedValue([projectWorkflow]),
        txFactory
      }

      const result = await OnWorkflowDelete([removeTx as any], mockControl as any)

      expect(result).toHaveLength(0)
    })
  })

  describe('OnTaskTypeDelete', () => {
    it('should generate TxRemoveDoc for Workflow when associated TaskType is deleted', async () => {
      const { OnTaskTypeDelete } = jest.requireActual('../WorkflowTrigger')
      const taskTypeId = 'task-type-1' as Ref<TaskType>
      const workflowId = 'wf-1' as Ref<Workflow>
      const wfSpace = 'space-1' as Ref<Space>

      const removeTx = {
        _id: generateId(),
        _class: core.class.TxRemoveDoc,
        space: core.space.DerivedTx,
        objectId: taskTypeId,
        objectClass: task.class.TaskType,
        objectSpace: wfSpace,
        modifiedOn: Date.now(),
        modifiedBy: testAccount
      }

      const workflowDoc = {
        _id: workflowId,
        _class: workflow.class.Workflow,
        space: wfSpace,
        taskType: taskTypeId
      }

      const txFactory = new TxFactory(testAccount)
      const mockControl = {
        ctx: {} as any,
        findAll: jest.fn().mockImplementation(async (ctx, _class, query) => {
          if (query?.taskType?.$in?.includes(taskTypeId) === true) {
            return [workflowDoc]
          }
          return []
        }),
        txFactory
      }

      const result = await OnTaskTypeDelete([removeTx as any], mockControl as any)

      expect(mockControl.findAll).toHaveBeenCalledWith(expect.anything(), workflow.class.Workflow, {
        taskType: { $in: [taskTypeId] }
      })
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        _class: core.class.TxRemoveDoc,
        objectId: workflowId,
        objectClass: workflow.class.Workflow,
        objectSpace: wfSpace
      })
    })

    it('should not generate TxRemoveDoc when deleted TaskType is not associated with any Workflow', async () => {
      const { OnTaskTypeDelete } = jest.requireActual('../WorkflowTrigger')
      const taskTypeId = 'task-type-1' as Ref<TaskType>
      const otherTaskTypeId = 'task-type-2' as Ref<TaskType>
      const workflowId = 'wf-1' as Ref<Workflow>
      const wfSpace = 'space-1' as Ref<Space>

      const removeTx = {
        _id: generateId(),
        _class: core.class.TxRemoveDoc,
        space: core.space.DerivedTx,
        objectId: taskTypeId,
        objectClass: task.class.TaskType,
        objectSpace: wfSpace,
        modifiedOn: Date.now(),
        modifiedBy: testAccount
      }

      const workflowDoc = {
        _id: workflowId,
        _class: workflow.class.Workflow,
        space: wfSpace,
        taskType: otherTaskTypeId
      }

      const txFactory = new TxFactory(testAccount)
      const mockControl = {
        ctx: {} as any,
        findAll: jest.fn().mockImplementation(async (ctx, _class, query) => {
          if (query?.taskType?.$in?.includes(otherTaskTypeId) === true) {
            return [workflowDoc]
          }
          return []
        }),
        txFactory
      }

      const result = await OnTaskTypeDelete([removeTx as any], mockControl as any)

      expect(mockControl.findAll).toHaveBeenCalledWith(expect.anything(), workflow.class.Workflow, {
        taskType: { $in: [taskTypeId] }
      })
      expect(result).toHaveLength(0)
    })
  })

  describe('OnStatusDelete', () => {
    it('should remove transitions where "to" is deleted status, update/remove "from", and update initialStatuses', async () => {
      const { OnStatusDelete } = jest.requireActual('../WorkflowTrigger')
      const deletedStatusId = 'status-1' as Ref<Status>
      const otherStatusId = 'status-2' as Ref<Status>
      const space = 'space-1' as Ref<Space>

      const removeTx = {
        _id: generateId(),
        _class: core.class.TxRemoveDoc,
        space: core.space.DerivedTx,
        objectId: deletedStatusId,
        objectClass: core.class.Status,
        objectSpace: space,
        modifiedOn: Date.now(),
        modifiedBy: testAccount
      }

      const transitionToDeleted = {
        _id: 't-1' as Ref<WorkflowTransition>,
        _class: workflow.class.WorkflowTransition,
        space,
        to: deletedStatusId,
        from: [otherStatusId]
      }

      const transitionFromDeletedMulti = {
        _id: 't-2' as Ref<WorkflowTransition>,
        _class: workflow.class.WorkflowTransition,
        space,
        to: otherStatusId,
        from: [deletedStatusId, otherStatusId]
      }

      const transitionFromDeletedSingle = {
        _id: 't-3' as Ref<WorkflowTransition>,
        _class: workflow.class.WorkflowTransition,
        space,
        to: otherStatusId,
        from: [deletedStatusId]
      }

      const workflowDoc = {
        _id: 'wf-1' as Ref<Workflow>,
        _class: workflow.class.Workflow,
        space,
        initialStatuses: [deletedStatusId, otherStatusId]
      }

      const txFactory = new TxFactory(testAccount)
      const mockControl = {
        ctx: {} as any,
        findAll: jest.fn().mockImplementation(async (ctx, _class) => {
          if (_class === workflow.class.WorkflowTransition) {
            return [transitionToDeleted, transitionFromDeletedMulti, transitionFromDeletedSingle]
          }
          if (_class === workflow.class.Workflow) {
            return [workflowDoc]
          }
          return []
        }),
        txFactory
      }

      const result = await OnStatusDelete([removeTx as any], mockControl as any)

      expect(result).toHaveLength(4)
      // t-1 (to == deletedStatusId) -> remove
      expect(result[0]).toMatchObject({
        _class: core.class.TxRemoveDoc,
        objectId: 't-1'
      })
      // t-2 (from has deletedStatusId & otherStatusId) -> update from to [otherStatusId]
      expect(result[1]).toMatchObject({
        _class: core.class.TxUpdateDoc,
        objectId: 't-2',
        operations: { from: [otherStatusId] }
      })
      // t-3 (from has only deletedStatusId) -> remove
      expect(result[2]).toMatchObject({
        _class: core.class.TxRemoveDoc,
        objectId: 't-3'
      })
      // wf-1 (initialStatuses has deletedStatusId) -> update initialStatuses to [otherStatusId]
      expect(result[3]).toMatchObject({
        _class: core.class.TxUpdateDoc,
        objectId: 'wf-1',
        operations: { initialStatuses: [otherStatusId] }
      })
    })
  })

  describe('OnTaskTypeUpdate', () => {
    it('should clean up transitions and initialStatuses when statuses array on TaskType is updated (removed a status)', async () => {
      const { OnTaskTypeUpdate } = jest.requireActual('../WorkflowTrigger')
      const taskTypeId = 'task-type-issue' as Ref<TaskType>
      const removedStatusId = 'status-removed' as Ref<Status>
      const keptStatusId = 'status-kept' as Ref<Status>
      const space = 'space-1' as Ref<Space>
      const workflowId = 'wf-issue' as Ref<Workflow>

      const updateTx = {
        _id: generateId(),
        _class: core.class.TxUpdateDoc,
        space: core.space.DerivedTx,
        objectId: taskTypeId,
        objectClass: task.class.TaskType,
        objectSpace: space,
        operations: { statuses: [keptStatusId] },
        modifiedOn: Date.now(),
        modifiedBy: testAccount
      }

      const oldTaskType = {
        _id: taskTypeId,
        _class: task.class.TaskType,
        space,
        statuses: [removedStatusId, keptStatusId]
      }

      const workflowDoc = {
        _id: workflowId,
        _class: workflow.class.Workflow,
        space,
        taskType: taskTypeId,
        initialStatuses: [removedStatusId, keptStatusId]
      }

      const transitionToRemoved = {
        _id: 't-removed-to' as Ref<WorkflowTransition>,
        _class: workflow.class.WorkflowTransition,
        space,
        attachedTo: workflowId,
        to: removedStatusId,
        from: [keptStatusId]
      }

      const txFactory = new TxFactory(testAccount)
      const mockControl = {
        ctx: {} as any,
        findAll: jest.fn().mockImplementation(async (ctx, _class, query) => {
          if (_class === task.class.TaskType) return [oldTaskType]
          if (_class === workflow.class.Workflow) return [workflowDoc]
          if (_class === workflow.class.WorkflowTransition) return [transitionToRemoved]
          return []
        }),
        txFactory
      }

      const result = await OnTaskTypeUpdate([updateTx as any], mockControl as any)

      expect(result).toHaveLength(2)
      // Initial status updated for workflow
      expect(result[0]).toMatchObject({
        _class: core.class.TxUpdateDoc,
        objectId: workflowId,
        operations: { initialStatuses: [keptStatusId] }
      })
      // Transition leading to removed status deleted
      expect(result[1]).toMatchObject({
        _class: core.class.TxRemoveDoc,
        objectId: 't-removed-to'
      })
    })
  })
})

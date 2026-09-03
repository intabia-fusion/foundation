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
  AccountRole,
  type Doc,
  type Ref,
  type Space,
  type MeasureContext,
  type SessionData,
  type Class,
  type AccountUuid,
  type WorkspaceUuid,
  type Hierarchy,
  type ModelDb,
  type PersonId,
  type TxUpdateDoc,
  type TxCreateDoc,
  type TxRemoveDoc,
  type TxMixin,
  type WorkspaceDataId,
  type Status as DocStatus,
  generateId,
  Mixin,
  DocumentUpdate,
  Data,
  Tx
} from '@hcengineering/core'
import { BaseMiddleware, type Middleware, type PipelineContext } from '@hcengineering/server-core'
import task, { type Project, type Task, type TaskType } from '@hcengineering/task'
import workflow, {
  type Workflow,
  type WorkflowTransition,
  type WorkflowValidator,
  type ProjectWorkflow,
  type ValidatorFunc
} from '@hcengineering/workflow'

import { WorkflowMiddleware } from '../middleware'
import serverWorkflow, { type ValidatorImpl } from '../index'
import { Resource } from '@hcengineering/platform'

interface PrivateMiddlewareAccess {
  getWorkflowRef: (
    ctx: MeasureContext<SessionData>,
    projectId: Ref<Project>,
    taskTypeRef: Ref<TaskType>
  ) => Promise<Ref<Workflow> | undefined>
  provideFindAll: (
    ctx: MeasureContext<SessionData>,
    objectClass: Ref<Class<Doc>>,
    query: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<Doc[]>
}

const mockExecutors = new Map<string, ValidatorFunc>()

jest.mock('@hcengineering/platform', () => {
  const actual = jest.requireActual('@hcengineering/platform')
  return {
    ...actual,
    getResource: jest.fn().mockImplementation(async (res: unknown) => {
      if (typeof res === 'string' && mockExecutors.has(res)) {
        return mockExecutors.get(res)
      }
      return actual.getResource(res)
    })
  }
})

class MockNextMiddleware extends BaseMiddleware {
  static async create (ctx: MeasureContext, context: PipelineContext, next?: Middleware): Promise<Middleware> {
    return new MockNextMiddleware(context, next)
  }

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)
  }

  tx = jest.fn(async (ctx, txes) => ({ txes, broadcast: [] }))
}

describe('WorkflowMiddleware', () => {
  let middleware: WorkflowMiddleware
  let privateMiddleware: PrivateMiddlewareAccess
  let nextMock: MockNextMiddleware
  let contextMock: PipelineContext
  let defaultCtx: MeasureContext<SessionData>

  beforeEach(async () => {
    mockExecutors.clear()

    contextMock = {
      workspace: {
        url: 'test-ws',
        uuid: 'test-ws-uuid' as WorkspaceUuid,
        dataId: 'test-data' as WorkspaceDataId,
        accountsUrl: ''
      },
      hierarchy: {
        isDerived: (c: Ref<Class<Doc>>, b: Ref<Class<Doc>>) => {
          if (c === b) return true
          if (b === workflow.class.WorkflowTransition && c === workflow.class.WorkflowTransition) return true
          if (b === task.class.Task && c === task.class.Task) return true
          if (b === task.class.Project && c === task.class.Project) return true
          if (b === workflow.class.Workflow && c === workflow.class.Workflow) return true
          return false
        },
        hasMixin: (doc: Doc, mixin: Ref<Mixin<Doc>>) => {
          if (mixin === workflow.mixin.ProjectWorkflow) {
            const record = doc as any
            return record[workflow.mixin.ProjectWorkflow] != null || record.workflows != null
          }
          if (mixin === serverWorkflow.mixin.ValidatorImpl) {
            return (doc as unknown as ValidatorImpl).serverExecutor != null
          }
          return false
        },
        as: <T extends Doc, M extends T>(doc: T, mixin: Ref<Mixin<M>>): M => {
          if (mixin === (workflow.mixin.ProjectWorkflow as Ref<Mixin<M>>)) {
            const record = doc as Record<string, unknown>
            return (record[workflow.mixin.ProjectWorkflow] ?? doc) as M
          }
          return doc as unknown as M
        }
      } as unknown as Hierarchy,
      modelDb: {} as unknown as ModelDb,
      branding: null,
      contextVars: {}
    } as unknown as PipelineContext

    nextMock = new MockNextMiddleware(contextMock)

    middleware = (await WorkflowMiddleware.create(
      {} as unknown as MeasureContext,
      contextMock,
      nextMock
    )) as WorkflowMiddleware

    privateMiddleware = middleware as unknown as PrivateMiddlewareAccess

    defaultCtx = {
      contextData: {
        account: {
          uuid: 'user-uuid' as AccountUuid,
          role: AccountRole.User
        }
      } as unknown as SessionData
    } as unknown as MeasureContext<SessionData>
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  function createMockUpdateTx<T extends Doc> (
    objectClass: Ref<Class<T>>,
    objectId: Ref<T>,
    operations: Record<string, unknown>,
    objectSpace = 'test-space' as Ref<Space>
  ): TxUpdateDoc<T> {
    return {
      _id: generateId(),
      _class: core.class.TxUpdateDoc,
      space: core.space.DerivedTx,
      objectId,
      objectClass,
      objectSpace,
      modifiedOn: Date.now(),
      modifiedBy: 'user-uuid' as PersonId,
      createdBy: 'user-uuid' as PersonId,
      operations: operations as DocumentUpdate<T>
    }
  }

  function createMockCreateTx<T extends Doc> (
    objectClass: Ref<Class<T>>,
    objectId: Ref<T>,
    attributes: Record<string, unknown>,
    objectSpace = 'test-space' as Ref<Space>
  ): TxCreateDoc<T> {
    return {
      _id: generateId(),
      _class: core.class.TxCreateDoc,
      space: core.space.DerivedTx,
      objectId,
      objectClass,
      objectSpace,
      modifiedOn: Date.now(),
      modifiedBy: 'user-uuid' as PersonId,
      createdBy: 'user-uuid' as PersonId,
      attributes: attributes as Data<T>
    }
  }

  describe('Bypass & Non-CUD Transactions', () => {
    it('should bypass checks when transaction modifiedBy is System account', async () => {
      const tx = createMockUpdateTx(workflow.class.Workflow, 'wf-1' as Ref<Workflow>, {})
      tx.modifiedBy = core.account.System

      await expect(middleware.tx(defaultCtx, [tx])).resolves.not.toThrow()
      expect(nextMock.tx).toHaveBeenCalledWith(defaultCtx, [tx])
    })

    it('should delegate non-CUD transactions directly to next middleware', async () => {
      const nonCudTx = {
        _id: generateId(),
        _class: 'some:class:NonCudTx' as Ref<Class<Doc>>,
        space: 'test' as Ref<Space>
      }

      await expect(middleware.tx(defaultCtx, [nonCudTx as Tx])).resolves.not.toThrow()
      expect(nextMock.tx).toHaveBeenCalledWith(defaultCtx, [nonCudTx])
    })

    it('should pass through CUD transactions for non-workflow/non-task classes', async () => {
      const tx = createMockUpdateTx('some:other:Class' as Ref<Class<Doc>>, 'doc-1' as Ref<Doc>, { name: 'New Name' })

      await expect(middleware.tx(defaultCtx, [tx])).resolves.not.toThrow()
      expect(nextMock.tx).toHaveBeenCalledWith(defaultCtx, [tx])
    })

    it('should handle batch array of multiple transactions', async () => {
      const tx1 = createMockUpdateTx('some:other:Class' as Ref<Class<Doc>>, 'doc-1' as Ref<Doc>, { name: 'A' })
      const tx2 = createMockUpdateTx('some:other:Class' as Ref<Class<Doc>>, 'doc-2' as Ref<Doc>, { name: 'B' })

      await expect(middleware.tx(defaultCtx, [tx1, tx2])).resolves.not.toThrow()
      expect(nextMock.tx).toHaveBeenCalledWith(defaultCtx, [tx1, tx2])
    })
  })

  describe('Project Workflows Cache & Management', () => {
    it('should update cache when ProjectWorkflow TxMixin transaction is executed', async () => {
      const txMixin: TxMixin<Project, ProjectWorkflow> = {
        _id: generateId(),
        _class: core.class.TxMixin,
        space: core.space.DerivedTx,
        objectId: 'proj-mixin-1' as Ref<Project>,
        objectClass: task.class.Project,
        objectSpace: 'proj-mixin-1' as Ref<Space>,
        modifiedOn: Date.now(),
        modifiedBy: 'user-uuid' as PersonId,
        createdBy: 'user-uuid' as PersonId,
        mixin: workflow.mixin.ProjectWorkflow,
        attributes: {
          workflows: {
            ['kind-1' as Ref<TaskType>]: 'wf-1' as Ref<Workflow>
          }
        }
      }

      await middleware.tx(defaultCtx, [txMixin])

      const provideFindAllSpy = jest.spyOn(privateMiddleware, 'provideFindAll').mockResolvedValue([])

      const wfRef = await privateMiddleware.getWorkflowRef(
        defaultCtx,
        'proj-mixin-1' as Ref<Project>,
        'kind-1' as Ref<TaskType>
      )
      expect(wfRef).toBe('wf-1')
      expect(provideFindAllSpy).not.toHaveBeenCalled()
    })

    it('should update cache when TxUpdateDoc modifies Project workflows', async () => {
      const updateTx = createMockUpdateTx(task.class.Project, 'proj-update-1' as Ref<Project>, {
        [`${workflow.mixin.ProjectWorkflow}.workflows`]: {
          'kind-1': 'wf-updated-1'
        }
      })

      await middleware.tx(defaultCtx, [updateTx])

      const provideFindAllSpy = jest.spyOn(privateMiddleware, 'provideFindAll').mockResolvedValue([])

      const wfRef = await privateMiddleware.getWorkflowRef(
        defaultCtx,
        'proj-update-1' as Ref<Project>,
        'kind-1' as Ref<TaskType>
      )
      expect(wfRef).toBe('wf-updated-1')
      expect(provideFindAllSpy).not.toHaveBeenCalled()
    })

    it('should delete project entry from cache when TxRemoveDoc is executed on Project', async () => {
      const txMixin: TxMixin<Project, ProjectWorkflow> = {
        _id: generateId(),
        _class: core.class.TxMixin,
        space: core.space.DerivedTx,
        objectId: 'proj-del-1' as Ref<Project>,
        objectClass: task.class.Project,
        objectSpace: 'proj-del-1' as Ref<Space>,
        modifiedOn: Date.now(),
        modifiedBy: 'user-uuid' as PersonId,
        createdBy: 'user-uuid' as PersonId,
        mixin: workflow.mixin.ProjectWorkflow,
        attributes: {
          workflows: { ['kind-1' as Ref<TaskType>]: 'wf-1' as Ref<Workflow> }
        }
      }
      await middleware.tx(defaultCtx, [txMixin])

      const removeTx: TxRemoveDoc<Project> = {
        _id: generateId(),
        _class: core.class.TxRemoveDoc,
        space: core.space.DerivedTx,
        objectId: 'proj-del-1' as Ref<Project>,
        objectClass: task.class.Project,
        objectSpace: 'proj-del-1' as Ref<Space>,
        modifiedOn: Date.now(),
        modifiedBy: 'user-uuid' as PersonId,
        createdBy: 'user-uuid' as PersonId
      }

      await middleware.tx(defaultCtx, [removeTx])

      const provideFindAllSpy = jest.spyOn(privateMiddleware, 'provideFindAll').mockResolvedValue([])
      const wfRef = await privateMiddleware.getWorkflowRef(
        defaultCtx,
        'proj-del-1' as Ref<Project>,
        'kind-1' as Ref<TaskType>
      )
      expect(wfRef).toBeUndefined()
      expect(provideFindAllSpy).toHaveBeenCalledWith(
        defaultCtx,
        task.class.Project,
        { _id: 'proj-del-1' },
        { limit: 1 }
      )
    })

    it('should cache null for project without ProjectWorkflow mixin and bypass DB on subsequent calls', async () => {
      const provideFindAllSpy = jest
        .spyOn(privateMiddleware, 'provideFindAll')
        .mockImplementation(async (_ctx, _class, query) => {
          if (_class === task.class.Project && query._id === 'proj-no-mixin') {
            return [{ _id: 'proj-no-mixin' as Ref<Project>, _class: task.class.Project } as unknown as Doc]
          }
          return []
        })

      const wfRef1 = await privateMiddleware.getWorkflowRef(
        defaultCtx,
        'proj-no-mixin' as Ref<Project>,
        'kind-1' as Ref<TaskType>
      )
      expect(wfRef1).toBeUndefined()
      expect(provideFindAllSpy).toHaveBeenCalledTimes(1)

      provideFindAllSpy.mockClear()

      const wfRef2 = await privateMiddleware.getWorkflowRef(
        defaultCtx,
        'proj-no-mixin' as Ref<Project>,
        'kind-1' as Ref<TaskType>
      )
      expect(wfRef2).toBeUndefined()
      expect(provideFindAllSpy).not.toHaveBeenCalled()
    })
  })

  describe('Transition Validation (validateTransition)', () => {
    describe('TxCreateDoc WorkflowTransition', () => {
      it('should allow valid transition creation attached to workflow', async () => {
        jest.spyOn(privateMiddleware, 'provideFindAll').mockResolvedValue([])

        const tx = createMockCreateTx(workflow.class.WorkflowTransition, 'trans-1' as Ref<WorkflowTransition>, {
          attachedTo: 'wf-1' as Ref<Workflow>,
          name: 'Move to Progress',
          from: ['todo' as Ref<DocStatus>],
          to: 'in-progress' as Ref<DocStatus>
        })

        await expect(middleware.tx(defaultCtx, [tx])).resolves.not.toThrow()
      })

      it('should throw WorkflowNotFound when attachedTo is missing', async () => {
        const tx = createMockCreateTx(workflow.class.WorkflowTransition, 'trans-1' as Ref<WorkflowTransition>, {
          attachedTo: null,
          name: 'Invalid Transition',
          from: ['todo' as Ref<DocStatus>],
          to: 'in-progress' as Ref<DocStatus>
        })

        await expect(middleware.tx(defaultCtx, [tx])).rejects.toThrow('workflow:status:WorkflowNotFound')
      })

      it('should throw SelfTransitionNotAllowed when transition source contains destination status', async () => {
        const tx = createMockCreateTx(workflow.class.WorkflowTransition, 'trans-1' as Ref<WorkflowTransition>, {
          attachedTo: 'wf-1' as Ref<Workflow>,
          name: 'Self transition',
          from: ['open' as Ref<DocStatus>, 'in-progress' as Ref<DocStatus>],
          to: 'in-progress' as Ref<DocStatus>
        })

        await expect(middleware.tx(defaultCtx, [tx])).rejects.toThrow('workflow:status:SelfTransitionNotAllowed')
      })

      it('should throw TransitionConflict on duplicate from status for same workflow', async () => {
        const existingTransition: WorkflowTransition = {
          _id: 't-existing' as Ref<WorkflowTransition>,
          _class: workflow.class.WorkflowTransition,
          space: 'test-space' as Ref<Space>,
          attachedTo: 'wf-1' as Ref<Workflow>,
          name: 'Existing Transition',
          from: ['todo' as Ref<DocStatus>],
          to: 'in-progress' as Ref<DocStatus>,
          modifiedBy: 'user-uuid' as PersonId,
          modifiedOn: Date.now(),
          rank: '',
          attachedToClass: workflow.class.Workflow,
          collection: 'transitions'
        }

        jest.spyOn(privateMiddleware, 'provideFindAll').mockResolvedValue([existingTransition])

        const tx = createMockCreateTx(workflow.class.WorkflowTransition, 't-new' as Ref<WorkflowTransition>, {
          attachedTo: 'wf-1' as Ref<Workflow>,
          name: 'Duplicate Transition',
          from: ['todo' as Ref<DocStatus>],
          to: 'in-progress' as Ref<DocStatus>
        })

        try {
          await middleware.tx(defaultCtx, [tx])
          expect(true).toBe(false)
        } catch (err: any) {
          expect(err.status?.code).toBe('workflow:status:TransitionConflict')
          expect(err.status?.params?.from).toBe('todo')
          expect(err.status?.params?.to).toBe('in-progress')
        }
      })

      it('should throw TransitionConflict when new transition uses general (null) status and overlap exists', async () => {
        const existingTransition: WorkflowTransition = {
          _id: 't-existing' as Ref<WorkflowTransition>,
          _class: workflow.class.WorkflowTransition,
          space: 'test-space' as Ref<Space>,
          attachedTo: 'wf-1' as Ref<Workflow>,
          name: 'Existing General Transition',
          from: null,
          to: 'done' as Ref<DocStatus>,
          modifiedBy: 'user-uuid' as PersonId,
          modifiedOn: Date.now(),
          rank: '',
          attachedToClass: workflow.class.Workflow,
          collection: 'transitions'
        }

        jest.spyOn(privateMiddleware, 'provideFindAll').mockResolvedValue([existingTransition])

        const tx = createMockCreateTx(workflow.class.WorkflowTransition, 't-new' as Ref<WorkflowTransition>, {
          attachedTo: 'wf-1' as Ref<Workflow>,
          name: 'New General Conflict',
          from: null,
          to: 'done' as Ref<DocStatus>
        })

        await expect(middleware.tx(defaultCtx, [tx])).rejects.toThrow('workflow:status:TransitionConflict')
      })
    })

    describe('TxUpdateDoc WorkflowTransition', () => {
      it('should validate transition conflict when updating from or to fields', async () => {
        const oldTransition: WorkflowTransition = {
          _id: 'trans-1' as Ref<WorkflowTransition>,
          _class: workflow.class.WorkflowTransition,
          space: 'test-space' as Ref<Space>,
          attachedTo: 'wf-1' as Ref<Workflow>,
          name: 'Existing Transition',
          from: ['todo' as Ref<DocStatus>],
          to: 'in-progress' as Ref<DocStatus>,
          modifiedBy: 'user-uuid' as PersonId,
          modifiedOn: Date.now(),
          rank: '',
          attachedToClass: workflow.class.Workflow,
          collection: 'transitions'
        }

        const conflictingTransition: WorkflowTransition = {
          _id: 'trans-2' as Ref<WorkflowTransition>,
          _class: workflow.class.WorkflowTransition,
          space: 'test-space' as Ref<Space>,
          attachedTo: 'wf-1' as Ref<Workflow>,
          name: 'Conflict Target',
          from: ['review' as Ref<DocStatus>],
          to: 'in-progress' as Ref<DocStatus>,
          modifiedBy: 'user-uuid' as PersonId,
          modifiedOn: Date.now(),
          rank: '',
          attachedToClass: workflow.class.Workflow,
          collection: 'transitions'
        }

        jest.spyOn(privateMiddleware, 'provideFindAll').mockImplementation(async (_ctx, _class, query) => {
          if (query._id === 'trans-1') return [oldTransition]
          if (query.attachedTo === 'wf-1') return [oldTransition, conflictingTransition]
          return []
        })

        const updateTx = createMockUpdateTx(workflow.class.WorkflowTransition, 'trans-1' as Ref<WorkflowTransition>, {
          from: ['review' as Ref<DocStatus>]
        })

        await expect(middleware.tx(defaultCtx, [updateTx])).rejects.toThrow('workflow:status:TransitionConflict')
      })

      it('should throw SelfTransitionNotAllowed when updating transition results in self transition', async () => {
        const oldTransition: WorkflowTransition = {
          _id: 'trans-1' as Ref<WorkflowTransition>,
          _class: workflow.class.WorkflowTransition,
          space: 'test-space' as Ref<Space>,
          attachedTo: 'wf-1' as Ref<Workflow>,
          name: 'Existing',
          from: ['todo' as Ref<DocStatus>],
          to: 'in-progress' as Ref<DocStatus>,
          modifiedBy: 'user-uuid' as PersonId,
          modifiedOn: Date.now(),
          rank: '',
          attachedToClass: workflow.class.Workflow,
          collection: 'transitions'
        }

        jest.spyOn(privateMiddleware, 'provideFindAll').mockImplementation(async (_ctx, _class, query) => {
          if (query._id === 'trans-1') return [oldTransition]
          return []
        })

        const updateTx = createMockUpdateTx(workflow.class.WorkflowTransition, 'trans-1' as Ref<WorkflowTransition>, {
          to: 'todo' as Ref<DocStatus>
        })

        await expect(middleware.tx(defaultCtx, [updateTx])).rejects.toThrow('workflow:status:SelfTransitionNotAllowed')
      })

      it('should bypass transition validation when operations do not modify from or to fields', async () => {
        const provideFindAllSpy = jest.spyOn(privateMiddleware, 'provideFindAll').mockResolvedValue([])

        const updateTx = createMockUpdateTx(workflow.class.WorkflowTransition, 'trans-1' as Ref<WorkflowTransition>, {
          name: 'Renamed Transition'
        })

        await expect(middleware.tx(defaultCtx, [updateTx])).resolves.not.toThrow()
        expect(provideFindAllSpy).not.toHaveBeenCalled()
      })

      it('should gracefully pass when updated transition document is not found in DB', async () => {
        jest.spyOn(privateMiddleware, 'provideFindAll').mockResolvedValue([])

        const updateTx = createMockUpdateTx(
          workflow.class.WorkflowTransition,
          'trans-non-existent' as Ref<WorkflowTransition>,
          { from: ['todo' as Ref<DocStatus>] }
        )

        await expect(middleware.tx(defaultCtx, [updateTx])).resolves.not.toThrow()
      })
    })
  })

  describe('Task Creation Validation (validateTaskCreate)', () => {
    it('should allow task creation when initial status is listed in Workflow initialStatuses', async () => {
      const project: Project = {
        _id: 'proj-1' as Ref<Project>,
        _class: task.class.Project,
        space: core.space.Model,
        name: 'Test Project',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now(),
        workflows: { ['kind-1' as Ref<TaskType>]: 'wf-1' as Ref<Workflow> }
      } as unknown as Project

      const wf: Workflow = {
        _id: 'wf-1' as Ref<Workflow>,
        _class: workflow.class.Workflow,
        space: core.space.Model,
        name: 'Workflow 1',
        initialStatuses: ['todo' as Ref<DocStatus>, 'backlog' as Ref<DocStatus>],
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now()
      } as any as Workflow

      jest.spyOn(privateMiddleware, 'provideFindAll').mockImplementation(async (_ctx, _class, query) => {
        if (query._id === 'proj-1') return [project]
        if (query._id === 'wf-1') return [wf]
        return []
      })

      const createTx = createMockCreateTx(
        task.class.Task,
        'task-1' as Ref<Task>,
        { kind: 'kind-1', status: 'todo' },
        'proj-1' as Ref<Space>
      )

      await expect(middleware.tx(defaultCtx, [createTx])).resolves.not.toThrow()
    })

    it('should throw InitialStatusNotAllowed when initial status is not in Workflow initialStatuses', async () => {
      const project: Project = {
        _id: 'proj-1' as Ref<Project>,
        _class: task.class.Project,
        space: core.space.Model,
        name: 'Test Project',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now(),
        workflows: { ['kind-1' as Ref<TaskType>]: 'wf-1' as Ref<Workflow> }
      } as unknown as Project

      const wf: Workflow = {
        _id: 'wf-1' as Ref<Workflow>,
        _class: workflow.class.Workflow,
        space: core.space.Model,
        name: 'Workflow 1',
        initialStatuses: ['todo' as Ref<DocStatus>, 'backlog' as Ref<DocStatus>],
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now()
      } as any as Workflow

      jest.spyOn(privateMiddleware, 'provideFindAll').mockImplementation(async (_ctx, _class, query) => {
        if (query._id === 'proj-1') return [project]
        if (query._id === 'wf-1') return [wf]
        return []
      })

      const createTx = createMockCreateTx(
        task.class.Task,
        'task-1' as Ref<Task>,
        { kind: 'kind-1', status: 'in-progress' },
        'proj-1' as Ref<Space>
      )

      await expect(middleware.tx(defaultCtx, [createTx])).rejects.toThrow('workflow:status:InitialStatusNotAllowed')
    })

    it('should allow task creation when Workflow has empty or null initialStatuses', async () => {
      const project: Project = {
        _id: 'proj-1' as Ref<Project>,
        _class: task.class.Project,
        space: core.space.Model,
        name: 'Test Project',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now(),
        workflows: { ['kind-1' as Ref<TaskType>]: 'wf-1' as Ref<Workflow> }
      } as unknown as Project

      const wf: Workflow = {
        _id: 'wf-1' as Ref<Workflow>,
        _class: workflow.class.Workflow,
        space: core.space.Model,
        name: 'Workflow 1',
        initialStatuses: [],
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now()
      } as any as Workflow

      jest.spyOn(privateMiddleware, 'provideFindAll').mockImplementation(async (_ctx, _class, query) => {
        if (query._id === 'proj-1') return [project]
        if (query._id === 'wf-1') return [wf]
        return []
      })

      const createTx = createMockCreateTx(
        task.class.Task,
        'task-1' as Ref<Task>,
        { kind: 'kind-1', status: 'in-progress' },
        'proj-1' as Ref<Space>
      )

      await expect(middleware.tx(defaultCtx, [createTx])).resolves.not.toThrow()
    })
  })

  describe('Task Update Validation (validateTaskUpdate)', () => {
    it('should ignore task updates that do not modify status', async () => {
      const provideFindAllSpy = jest.spyOn(privateMiddleware, 'provideFindAll').mockResolvedValue([])

      const updateTx = createMockUpdateTx(
        task.class.Task,
        'task-1' as Ref<Task>,
        { description: 'Updated task description' },
        'proj-1' as Ref<Space>
      )

      await expect(middleware.tx(defaultCtx, [updateTx])).resolves.not.toThrow()
      expect(provideFindAllSpy).not.toHaveBeenCalled()
    })

    it('should pass and set meta.fromStatus when status remains unchanged', async () => {
      const oldTask: Task = {
        _id: 'task-1' as Ref<Task>,
        _class: task.class.Task,
        space: 'proj-1' as Ref<Project>,
        kind: 'kind-1' as Ref<TaskType>,
        status: 'todo' as Ref<DocStatus>,
        number: 1,
        identifier: 'TASK-1',
        rank: '0|i00000:',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now()
      } as unknown as Task

      jest.spyOn(privateMiddleware, 'provideFindAll').mockImplementation(async (_ctx, _class, query) => {
        if (query._id === 'task-1') return [oldTask]
        return []
      })

      const updateTx = createMockUpdateTx(
        task.class.Task,
        'task-1' as Ref<Task>,
        { status: 'todo' },
        'proj-1' as Ref<Space>
      )

      await expect(middleware.tx(defaultCtx, [updateTx])).resolves.not.toThrow()
      expect(updateTx.meta?.fromStatus).toBe('todo')
    })

    it('should fast-path bypass task updates when project has no workflow cached', async () => {
      const provideFindAllSpy = jest
        .spyOn(privateMiddleware, 'provideFindAll')
        .mockImplementation(async (_ctx, _class, query) => {
          if (query._id === 'task-no-wf') {
            return [
              {
                _id: 'task-no-wf' as Ref<Task>,
                _class: task.class.Task,
                space: 'proj-no-wf' as Ref<Project>,
                kind: 'kind-1' as Ref<TaskType>,
                status: 'todo' as Ref<DocStatus>,
                number: 1,
                identifier: 'TASK-1',
                description: '',
                rank: '0|i00000:',
                modifiedBy: 'user-uuid' as PersonId,
                modifiedOn: Date.now()
              }
            ]
          }
          return []
        })

      const updateTx = createMockUpdateTx(
        task.class.Task,
        'task-no-wf' as Ref<Task>,
        { status: 'in-progress' },
        'proj-no-wf' as Ref<Space>
      )

      // First run populates cache that proj-no-wf has no workflow
      await expect(middleware.tx(defaultCtx, [updateTx])).resolves.not.toThrow()
      provideFindAllSpy.mockClear()

      // Second run uses cached null project workflows and bypasses DB queries
      await expect(middleware.tx(defaultCtx, [updateTx])).resolves.not.toThrow()
      expect(provideFindAllSpy).not.toHaveBeenCalled()
    })

    it('should throw ForbiddenTransition when transition between statuses is not allowed', async () => {
      const oldTask: Task = {
        _id: 'task-1' as Ref<Task>,
        _class: task.class.Task,
        space: 'proj-1' as Ref<Project>,
        kind: 'kind-1' as Ref<TaskType>,
        status: 'todo' as Ref<DocStatus>,
        number: 1,
        identifier: 'TASK-1',
        rank: '0|i00000:',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now()
      } as unknown as Task

      const project: Project = {
        _id: 'proj-1' as Ref<Project>,
        _class: task.class.Project,
        space: core.space.Model,
        name: 'Test Project',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now(),
        workflows: { ['kind-1' as Ref<TaskType>]: 'wf-1' as Ref<Workflow> }
      } as unknown as Project

      const transition: WorkflowTransition = {
        _id: 'trans-1' as Ref<WorkflowTransition>,
        _class: workflow.class.WorkflowTransition,
        space: 'proj-1' as Ref<Space>,
        attachedTo: 'wf-1' as Ref<Workflow>,
        name: 'Move to Progress',
        from: ['todo' as Ref<DocStatus>],
        to: 'in-progress' as Ref<DocStatus>,
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now(),
        rank: '',
        attachedToClass: workflow.class.Workflow,
        collection: 'transitions'
      }

      jest.spyOn(privateMiddleware, 'provideFindAll').mockImplementation(async (_ctx, _class, query) => {
        if (query._id === 'task-1') return [oldTask]
        if (query._id === 'proj-1') return [project]
        if (query.attachedTo === 'wf-1') return [transition]
        return []
      })

      const updateTx = createMockUpdateTx(
        task.class.Task,
        'task-1' as Ref<Task>,
        { status: 'done' },
        'proj-1' as Ref<Space>
      )

      await expect(middleware.tx(defaultCtx, [updateTx])).rejects.toThrow('workflow:status:ForbiddenTransition')
    })

    it('should allow valid status transition and set meta.fromStatus', async () => {
      const oldTask: Task = {
        _id: 'task-1' as Ref<Task>,
        _class: task.class.Task,
        space: 'proj-1' as Ref<Project>,
        kind: 'kind-1' as Ref<TaskType>,
        status: 'todo' as Ref<DocStatus>,
        number: 1,
        identifier: 'TASK-1',
        rank: '0|i00000:',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now()
      } as unknown as Task

      const project: Project = {
        _id: 'proj-1' as Ref<Project>,
        _class: task.class.Project,
        space: core.space.Model,
        name: 'Test Project',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now(),
        workflows: { ['kind-1' as Ref<TaskType>]: 'wf-1' as Ref<Workflow> }
      } as unknown as Project

      const transition: WorkflowTransition = {
        _id: 'trans-1' as Ref<WorkflowTransition>,
        _class: workflow.class.WorkflowTransition,
        space: 'proj-1' as Ref<Space>,
        attachedTo: 'wf-1' as Ref<Workflow>,
        name: 'Move to Progress',
        from: ['todo' as Ref<DocStatus>],
        to: 'in-progress' as Ref<DocStatus>,
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now(),
        rank: '',
        attachedToClass: workflow.class.Workflow,
        collection: 'transitions'
      }

      jest.spyOn(privateMiddleware, 'provideFindAll').mockImplementation(async (_ctx, _class, query) => {
        if (query._id === 'task-1') return [oldTask]
        if (query._id === 'proj-1') return [project]
        if (query.attachedTo === 'wf-1') return [transition]
        return []
      })

      const updateTx = createMockUpdateTx(
        task.class.Task,
        'task-1' as Ref<Task>,
        { status: 'in-progress' },
        'proj-1' as Ref<Space>
      )

      await expect(middleware.tx(defaultCtx, [updateTx])).resolves.not.toThrow()
      expect(updateTx.meta?.fromStatus).toBe('todo')
    })

    it('should allow transition matching general (null/empty from) transition', async () => {
      const oldTask: Task = {
        _id: 'task-1' as Ref<Task>,
        _class: task.class.Task,
        space: 'proj-1' as Ref<Project>,
        kind: 'kind-1' as Ref<TaskType>,
        status: 'any-status' as Ref<DocStatus>,
        number: 1,
        identifier: 'TASK-1',
        rank: '0|i00000:',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now()
      } as unknown as Task

      const project: Project = {
        _id: 'proj-1' as Ref<Project>,
        _class: task.class.Project,
        space: core.space.Model,
        name: 'Test Project',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now(),
        workflows: { ['kind-1' as Ref<TaskType>]: 'wf-1' as Ref<Workflow> }
      } as unknown as Project

      const generalTransition: WorkflowTransition = {
        _id: 'trans-general' as Ref<WorkflowTransition>,
        _class: workflow.class.WorkflowTransition,
        space: 'proj-1' as Ref<Space>,
        attachedTo: 'wf-1' as Ref<Workflow>,
        name: 'Cancel from anywhere',
        from: null,
        to: 'cancelled' as Ref<DocStatus>,
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now(),
        rank: '',
        attachedToClass: workflow.class.Workflow,
        collection: 'transitions'
      }

      jest.spyOn(privateMiddleware, 'provideFindAll').mockImplementation(async (_ctx, _class, query) => {
        if (query._id === 'task-1') return [oldTask]
        if (query._id === 'proj-1') return [project]
        if (query.attachedTo === 'wf-1') return [generalTransition]
        return []
      })

      const updateTx = createMockUpdateTx(
        task.class.Task,
        'task-1' as Ref<Task>,
        { status: 'cancelled' },
        'proj-1' as Ref<Space>
      )

      await expect(middleware.tx(defaultCtx, [updateTx])).resolves.not.toThrow()
    })
  })

  describe('Transition Validators Validation', () => {
    it('should execute validator and pass when validator returns ok', async () => {
      const oldTask: Task = {
        _id: 'task-1' as Ref<Task>,
        _class: task.class.Task,
        space: 'proj-1' as Ref<Project>,
        kind: 'kind-1' as Ref<TaskType>,
        status: 'todo' as Ref<DocStatus>,
        number: 1,
        identifier: 'TASK-1',
        rank: '0|i00000:',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now()
      } as unknown as Task

      const project: Project = {
        _id: 'proj-1' as Ref<Project>,
        _class: task.class.Project,
        space: core.space.Model,
        name: 'Test Project',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now(),
        workflows: { ['kind-1' as Ref<TaskType>]: 'wf-1' as Ref<Workflow> }
      } as unknown as Project

      const transition: WorkflowTransition = {
        _id: 'trans-1' as Ref<WorkflowTransition>,
        _class: workflow.class.WorkflowTransition,
        space: 'proj-1' as Ref<Space>,
        attachedTo: 'wf-1' as Ref<Workflow>,
        name: 'Move to Progress',
        from: ['todo' as Ref<DocStatus>],
        to: 'in-progress' as Ref<DocStatus>,
        validators: [{ rule: 'rule-required-desc' as Ref<WorkflowValidator>, props: { field: 'description' } }] as any,
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now(),
        rank: '',
        attachedToClass: workflow.class.Workflow,
        collection: 'transitions'
      }

      const validatorDoc: WorkflowValidator & ValidatorImpl = {
        _id: 'rule-required-desc',
        _class: workflow.class.WorkflowValidator,
        space: core.space.Model,
        serverExecutor: 'validateFieldRequired' as Resource<ValidatorFunc>,
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now()
      } as any

      mockExecutors.set('validateFieldRequired', jest.fn().mockResolvedValue({ ok: true }))

      jest.spyOn(privateMiddleware, 'provideFindAll').mockImplementation(async (_ctx, _class, query) => {
        if (query._id === 'task-1') return [oldTask]
        if (query._id === 'proj-1') return [project]
        if (query.attachedTo === 'wf-1') return [transition]
        if (_class === workflow.class.WorkflowValidator) return [validatorDoc]
        return []
      })

      const updateTx = createMockUpdateTx(
        task.class.Task,
        'task-1' as Ref<Task>,
        { status: 'in-progress' },
        'proj-1' as Ref<Space>
      )

      await expect(middleware.tx(defaultCtx, [updateTx])).resolves.not.toThrow()
      expect(mockExecutors.get('validateFieldRequired')).toHaveBeenCalled()
    })

    it('should throw ValidationFailed error when validator returns ok = false', async () => {
      const oldTask: Task = {
        _id: 'task-1' as Ref<Task>,
        _class: task.class.Task,
        space: 'proj-1' as Ref<Project>,
        kind: 'kind-1' as Ref<TaskType>,
        status: 'todo' as Ref<DocStatus>,
        number: 1,
        identifier: 'TASK-1',
        rank: '0|i00000:',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now()
      } as unknown as Task

      const project: Project = {
        _id: 'proj-1' as Ref<Project>,
        _class: task.class.Project,
        space: core.space.Model,
        name: 'Test Project',
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now(),
        workflows: { ['kind-1' as Ref<TaskType>]: 'wf-1' as Ref<Workflow> }
      } as unknown as Project

      const transition: WorkflowTransition = {
        _id: 'trans-1' as Ref<WorkflowTransition>,
        _class: workflow.class.WorkflowTransition,
        space: 'proj-1' as Ref<Space>,
        attachedTo: 'wf-1' as Ref<Workflow>,
        name: 'Move to Progress',
        from: ['todo' as Ref<DocStatus>],
        to: 'in-progress' as Ref<DocStatus>,
        validators: [{ rule: 'rule-check' as Ref<WorkflowValidator>, props: {} }] as any,
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now(),
        rank: '',
        attachedToClass: workflow.class.Workflow,
        collection: 'transitions'
      }

      const validatorDoc: WorkflowValidator & ValidatorImpl = {
        _id: 'rule-check' as Ref<WorkflowValidator>,
        _class: workflow.class.WorkflowValidator,
        space: core.space.Model,
        serverExecutor: 'validateCheck' as Resource<ValidatorFunc>,
        modifiedBy: 'user-uuid' as PersonId,
        modifiedOn: Date.now()
      } as any

      mockExecutors.set(
        'validateCheck',
        jest.fn().mockResolvedValue({ ok: false, reason: 'Field assignee is required' })
      )

      jest.spyOn(privateMiddleware, 'provideFindAll').mockImplementation(async (_ctx, _class, query) => {
        if (query._id === 'task-1') return [oldTask]
        if (query._id === 'proj-1') return [project]
        if (query.attachedTo === 'wf-1') return [transition]
        if (_class === workflow.class.WorkflowValidator) return [validatorDoc]
        return []
      })

      const updateTx = createMockUpdateTx(
        task.class.Task,
        'task-1' as Ref<Task>,
        { status: 'in-progress' },
        'proj-1' as Ref<Space>
      )

      await expect(middleware.tx(defaultCtx, [updateTx])).rejects.toThrow('workflow:status:ValidationFailed')
    })
  })
})

/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable n/no-callback-literal */

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
  type Account,
  type AccountUuid,
  type Class,
  type Client,
  type Doc,
  type DocumentUpdate,
  generateId,
  type Hierarchy,
  type Mixin,
  type PersonId,
  type Ref,
  setCurrentAccount,
  type SocialId,
  type Space,
  toFindResult,
  type Tx,
  type TxApplyIf,
  type TxCreateDoc,
  type TxRemoveDoc,
  type TxResult,
  type TxUpdateDoc,
  type WithLookup
} from '@hcengineering/core'
import platform, { PlatformError, Severity } from '@hcengineering/platform'
import { type PresentationMiddleware } from '@hcengineering/presentation'
import task, { type Project, type Task, type TaskType } from '@hcengineering/task'
import { showPopup } from '@hcengineering/ui'
import {
  type ProjectWorkflow,
  type Screen,
  type ScreenField,
  type ScreenTab,
  type Workflow,
  type WorkflowTransition
} from '@hcengineering/workflow'

import plugin from '../plugin'
import ScreenModal from '../components/screen/ScreenModal.svelte'
import { WorkflowMiddleware } from '../middleware'
import { type ScreenModalResult } from '../types'

jest.mock('@hcengineering/ui', () => {
  const actual = jest.requireActual('@hcengineering/ui')
  return {
    ...actual,
    showPopup: jest.fn()
  }
})

describe('WorkflowMiddleware', () => {
  let mockClient: jest.Mocked<Client>
  let mockHierarchy: jest.Mocked<Hierarchy>
  let mockNext: jest.Mocked<PresentationMiddleware>
  let middleware: WorkflowMiddleware
  let testAccount: Account

  const testUser = 'user-uuid' as unknown as AccountUuid
  const testSocialId = 'social:user:1' as unknown as SocialId

  beforeEach(() => {
    jest.clearAllMocks()

    testAccount = {
      uuid: testUser,
      primarySocialId: testSocialId,
      role: AccountRole.User,
      socialIds: [testSocialId],
      name: 'Test User'
    } as unknown as Account
    setCurrentAccount(testAccount)

    mockHierarchy = {
      isDerived: jest.fn((c: Ref<Class<Doc>>, b: Ref<Class<Doc>>) => {
        if (c === b) return true
        if (b === task.class.Task && c === task.class.Task) return true
        return false
      }),
      hasMixin: jest.fn((doc: Doc, mixin: Ref<Mixin<Doc>>) => {
        if (mixin === plugin.mixin.ProjectWorkflow) {
          const p = doc as Project & Record<string, unknown>
          return p[plugin.mixin.ProjectWorkflow] != null || p.workflows != null
        }
        return false
      }),
      as: jest.fn(<T extends Doc, M extends T>(doc: T, mixin: Ref<Mixin<M>>): M => {
        if (mixin === (plugin.mixin.ProjectWorkflow as Ref<Mixin<M>>)) {
          const record = doc as Record<string, unknown>
          return (record[plugin.mixin.ProjectWorkflow] ?? doc) as M
        }
        return doc as unknown as M
      }),
      clone: jest.fn(<T extends Doc>(doc: T): T => JSON.parse(JSON.stringify(doc)))
    } as unknown as jest.Mocked<Hierarchy>

    mockClient = {
      getHierarchy: jest.fn(() => mockHierarchy),
      findOne: jest.fn(),
      findAll: jest.fn(),
      tx: jest.fn().mockImplementation(async (tx: Tx) => ({ tx, success: true }) as unknown as TxResult),
      close: jest.fn().mockResolvedValue(undefined)
    } as unknown as jest.Mocked<Client>

    mockNext = {
      tx: jest.fn().mockImplementation(async (tx: Tx) => ({ tx, success: true }) as unknown as TxResult),
      notifyTx: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      findAll: jest.fn(),
      findOne: jest.fn(),
      subscribe: jest.fn()
    } as unknown as jest.Mocked<PresentationMiddleware>

    middleware = WorkflowMiddleware.create(mockClient, mockNext)
  })

  // =========================================================================
  // Helper factories
  // =========================================================================

  function createMockUpdateTx<T extends Doc> (
    objectId: Ref<T>,
    objectClass: Ref<Class<T>>,
    operations: DocumentUpdate<T>,
    space: Ref<Space> = 'space-1' as Ref<Space>
  ): TxUpdateDoc<T> {
    return {
      _id: generateId(),
      _class: core.class.TxUpdateDoc,
      space: core.space.DerivedTx,
      objectId,
      objectClass,
      objectSpace: space,
      modifiedOn: Date.now(),
      modifiedBy: testUser as unknown as PersonId,
      createdBy: testUser as unknown as PersonId,
      operations
    }
  }

  function createMockCreateTx<T extends Doc> (
    objectId: Ref<T>,
    objectClass: Ref<Class<T>>,
    attributes: Record<string, unknown>,
    space: Ref<Space> = 'space-1' as Ref<Space>
  ): TxCreateDoc<T> {
    return {
      _id: generateId(),
      _class: core.class.TxCreateDoc,
      space: core.space.DerivedTx,
      objectId,
      objectClass,
      objectSpace: space,
      modifiedOn: Date.now(),
      modifiedBy: testUser as unknown as PersonId,
      createdBy: testUser as unknown as PersonId,
      attributes: attributes as any
    }
  }

  function createMockTask (id: string, kind: string, status: string, space: string = 'proj-1'): Task {
    return {
      _id: id as Ref<Task>,
      _class: task.class.Task,
      space: space as Ref<Project>,
      kind: kind as Ref<TaskType>,
      status: status as any,
      number: 1,
      identifier: `TASK-${id}`,
      title: `Task ${id}`,
      rank: '0|i00000:',
      modifiedBy: testUser as unknown as PersonId,
      modifiedOn: Date.now()
    } as unknown as Task
  }

  function createMockProject (
    id: string,
    workflowsMap?: Record<string, Ref<Workflow>>
  ): Project & Record<string, unknown> {
    return {
      _id: id as Ref<Project>,
      _class: task.class.Project,
      space: core.space.Model,
      name: `Project ${id}`,
      modifiedBy: testUser as unknown as PersonId,
      modifiedOn: Date.now(),
      workflows: workflowsMap,
      ...(workflowsMap != null ? { [plugin.mixin.ProjectWorkflow]: { workflows: workflowsMap } } : {})
    } as unknown as Project & Record<string, unknown>
  }

  function createMockWorkflow (id: string, transitions: WorkflowTransition[] = []): WithLookup<Workflow> {
    return {
      _id: id as Ref<Workflow>,
      _class: plugin.class.Workflow,
      space: core.space.Model,
      name: `Workflow ${id}`,
      modifiedBy: testUser as unknown as PersonId,
      modifiedOn: Date.now(),
      $lookup: {
        transitions
      }
    } as unknown as WithLookup<Workflow>
  }

  function createMockTransition (id: string, to: string, from: string[] | null, requests?: any[]): WorkflowTransition {
    return {
      _id: id as Ref<WorkflowTransition>,
      _class: plugin.class.WorkflowTransition,
      attachedTo: 'wf-1' as Ref<Workflow>,
      name: `Transition ${id}`,
      from: from as any,
      to: to as any,
      requests,
      space: core.space.Model,
      modifiedBy: testUser as unknown as PersonId,
      modifiedOn: Date.now()
    } as unknown as WorkflowTransition
  }

  function createMockScreen (id: string, tabs: ScreenTab[] = []): WithLookup<Screen> {
    return {
      _id: id as Ref<Screen>,
      _class: plugin.class.Screen,
      name: `Screen ${id}`,
      space: core.space.Model,
      modifiedBy: testUser as unknown as PersonId,
      modifiedOn: Date.now(),
      $lookup: { tabs }
    } as unknown as WithLookup<Screen>
  }

  function createMockScreenTab (id: string, attachedTo: string): ScreenTab {
    return {
      _id: id as Ref<ScreenTab>,
      _class: plugin.class.ScreenTab,
      attachedTo: attachedTo as Ref<Screen>,
      name: `Tab ${id}`,
      space: core.space.Model,
      modifiedBy: testUser as unknown as PersonId,
      modifiedOn: Date.now()
    } as unknown as ScreenTab
  }

  function createMockScreenField (id: string, attachedTo: string): ScreenField {
    return {
      _id: id as Ref<ScreenField>,
      _class: plugin.class.ScreenField,
      attachedTo: attachedTo as Ref<ScreenTab>,
      name: `Field ${id}`,
      space: core.space.Model,
      modifiedBy: testUser as unknown as PersonId,
      modifiedOn: Date.now()
    } as unknown as ScreenField
  }

  // =========================================================================
  // 1. Middleware Lifecycle & Presentation Pipeline Integration
  // =========================================================================
  describe('Lifecycle & Pipeline Integration', () => {
    it('should create instance via WorkflowMiddleware.create without next', () => {
      const mw = WorkflowMiddleware.create(mockClient)
      expect(mw).toBeInstanceOf(WorkflowMiddleware)
    })

    it('should create instance via WorkflowMiddleware.create with next', () => {
      const mw = WorkflowMiddleware.create(mockClient, mockNext)
      expect(mw).toBeInstanceOf(WorkflowMiddleware)
    })

    it('should delegate notifyTx to next middleware when next is present', async () => {
      const tx = createMockCreateTx('doc-1' as Ref<Doc>, 'some:class' as Ref<Class<Doc>>, {})
      await middleware.notifyTx(tx)
      expect(mockNext.notifyTx).toHaveBeenCalledWith(tx)
    })

    it('should handle notifyTx gracefully when next is omitted', async () => {
      const mw = WorkflowMiddleware.create(mockClient)
      const tx = createMockCreateTx('doc-1' as Ref<Doc>, 'some:class' as Ref<Class<Doc>>, {})
      await expect(mw.notifyTx(tx)).resolves.toBeUndefined()
    })

    it('should delegate close to next middleware when next is present', async () => {
      await middleware.close()
      expect(mockNext.close).toHaveBeenCalledTimes(1)
      expect(mockClient.close).not.toHaveBeenCalled()
    })

    it('should delegate close to client when next is omitted', async () => {
      const mw = WorkflowMiddleware.create(mockClient)
      await mw.close()
      expect(mockClient.close).toHaveBeenCalledTimes(1)
    })
  })

  // =========================================================================
  // 2. Transaction Pass-Through (Bypass / Non-Task)
  // =========================================================================
  describe('Transaction Pass-Through', () => {
    it('should delegate non-TxUpdateDoc transactions directly to provideTx', async () => {
      const createTx = createMockCreateTx('doc-1' as Ref<Doc>, 'some:class' as Ref<Class<Doc>>, { name: 'Item' })
      const res = await middleware.tx(createTx)
      expect(mockNext.tx).toHaveBeenCalledWith(createTx)
      expect(mockClient.findOne).not.toHaveBeenCalled()
      expect(res).toBeDefined()
    })

    it('should delegate TxRemoveDoc transactions directly to provideTx', async () => {
      const removeTx: TxRemoveDoc<Doc> = {
        _id: generateId(),
        _class: core.class.TxRemoveDoc,
        space: core.space.DerivedTx,
        objectId: 'doc-del-1' as Ref<Doc>,
        objectClass: 'some:class' as Ref<Class<Doc>>,
        objectSpace: 'space-1' as Ref<Space>,
        modifiedOn: Date.now(),
        modifiedBy: testUser as unknown as PersonId,
        createdBy: testUser as unknown as PersonId
      }
      await middleware.tx(removeTx)
      expect(mockNext.tx).toHaveBeenCalledWith(removeTx)
      expect(mockClient.findOne).not.toHaveBeenCalled()
    })

    it('should delegate TxUpdateDoc for non-Task classes to provideTx', async () => {
      mockHierarchy.isDerived.mockReturnValue(false)
      const updateProjectTx = createMockUpdateTx('proj-1' as Ref<Project>, task.class.Project, {
        name: 'Updated'
      } as unknown as DocumentUpdate<Project>)

      await middleware.tx(updateProjectTx)
      expect(mockHierarchy.isDerived).toHaveBeenCalledWith(task.class.Project, task.class.Task)
      expect(mockNext.tx).toHaveBeenCalledWith(updateProjectTx)
      expect(mockClient.findOne).not.toHaveBeenCalled()
    })

    it('should delegate to client.tx when next is not provided for non-Task transactions', async () => {
      const standaloneMw = WorkflowMiddleware.create(mockClient)
      const createTx = createMockCreateTx('doc-1' as Ref<Doc>, 'some:class' as Ref<Class<Doc>>, {})

      await standaloneMw.tx(createTx)
      expect(mockClient.tx).toHaveBeenCalledWith(createTx)
    })
  })

  // =========================================================================
  // 3. Status Transition Bypasses (No Status Change / Task Missing)
  // =========================================================================
  describe('Status Transition Bypasses', () => {
    it('should pass through when update operations do not contain status', async () => {
      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        isDone: true
      })

      await middleware.tx(updateTx)
      expect(mockClient.findOne).not.toHaveBeenCalled()
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should pass through when operations.status is explicitly undefined', async () => {
      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: undefined,
        isDone: true
      })

      await middleware.tx(updateTx)
      expect(mockClient.findOne).not.toHaveBeenCalled()
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should pass through when task is not found in client', async () => {
      mockClient.findOne.mockResolvedValueOnce(undefined)

      const updateTx = createMockUpdateTx('task-missing' as Ref<Task>, task.class.Task, {
        status: 'in-progress' as any
      })

      await middleware.tx(updateTx)
      expect(mockClient.findOne).toHaveBeenCalledWith(task.class.Task, { _id: 'task-missing' })
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should pass through when task status is unchanged', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo')
      mockClient.findOne.mockResolvedValueOnce(existingTask)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'todo' as any
      })

      await middleware.tx(updateTx)
      expect(mockClient.findOne).toHaveBeenCalledWith(task.class.Task, { _id: 'task-1' })
      expect(mockClient.findOne).toHaveBeenCalledTimes(1)
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })
  })

  // =========================================================================
  // 4. Workflow Resolution (`getWorkflowForTask`)
  // =========================================================================
  describe('Workflow Resolution (getWorkflowForTask)', () => {
    it('should pass through when project is not found', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-unknown')
      mockClient.findOne.mockResolvedValueOnce(existingTask).mockResolvedValueOnce(undefined)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'in-progress' as any
      })

      await middleware.tx(updateTx)
      expect(mockClient.findOne).toHaveBeenCalledWith(task.class.Project, { _id: 'proj-unknown' })
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should pass through when project does not have ProjectWorkflow mixin', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-no-mixin')
      const projectWithoutMixin = createMockProject('proj-no-mixin', undefined)
      mockHierarchy.hasMixin.mockReturnValue(false)

      mockClient.findOne.mockResolvedValueOnce(existingTask).mockResolvedValueOnce(projectWithoutMixin)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'in-progress' as any
      })

      await middleware.tx(updateTx)
      expect(mockHierarchy.hasMixin).toHaveBeenCalledWith(projectWithoutMixin, plugin.mixin.ProjectWorkflow)
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should pass through when project workflows map does not have mapping for task kind', async () => {
      const existingTask = createMockTask('task-1', 'bug', 'todo', 'proj-1')
      const projectWithOtherWorkflows = createMockProject('proj-1', {
        feature: 'wf-feature' as Ref<Workflow>
      })
      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({
        workflows: {
          feature: 'wf-feature' as Ref<Workflow>
        }
      } as unknown as ProjectWorkflow)

      mockClient.findOne.mockResolvedValueOnce(existingTask).mockResolvedValueOnce(projectWithOtherWorkflows)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'in-progress' as any
      })

      await middleware.tx(updateTx)
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should pass through when projectWorkflow.workflows is undefined', async () => {
      const existingTask = createMockTask('task-1', 'bug', 'todo', 'proj-1')
      const project = createMockProject('proj-1', undefined)
      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({} as unknown as ProjectWorkflow)

      mockClient.findOne.mockResolvedValueOnce(existingTask).mockResolvedValueOnce(project)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'in-progress' as any
      })

      await middleware.tx(updateTx)
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should pass through when mapped workflow document is not found in client', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', {
        issue: 'wf-missing' as Ref<Workflow>
      })
      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({
        workflows: {
          issue: 'wf-missing' as Ref<Workflow>
        }
      } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(undefined)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'in-progress' as any
      })

      await middleware.tx(updateTx)
      expect(mockClient.findOne).toHaveBeenCalledWith(
        plugin.class.Workflow,
        { _id: 'wf-missing' },
        { lookup: { _id: { transitions: plugin.class.WorkflowTransition } } }
      )
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })
  })

  // =========================================================================
  // 5. Transition Matching & Rejection
  // =========================================================================
  describe('Transition Matching & Rejection', () => {
    it('should throw PlatformError when no transition matches toStatus', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [createMockTransition('t-1', 'in-progress', ['todo'])]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'done' as any
      })

      await expect(middleware.tx(updateTx)).rejects.toThrow(PlatformError)
      try {
        await middleware.tx(updateTx)
      } catch (err) {
        const pErr = err as PlatformError
        expect(pErr.status.severity).toBe(Severity.OK)
        expect(pErr.status.code).toBe(platform.status.OK)
        expect(pErr.status.params?.reason).toBe('Transition canceled by user')
      }
    })

    it('should throw PlatformError when workflow $lookup is undefined (no transitions)', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const workflowDoc: Workflow = {
        _id: 'wf-1' as Ref<Workflow>,
        _class: plugin.class.Workflow,
        space: core.space.Model,
        name: 'Workflow 1',
        modifiedBy: testUser as unknown as PersonId,
        modifiedOn: Date.now()
      } as unknown as Workflow

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'done' as any
      })

      await expect(middleware.tx(updateTx)).rejects.toThrow(PlatformError)
    })

    it('should throw PlatformError when transition exists for toStatus but fromStatus is not allowed', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'backlog', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [createMockTransition('t-1', 'in-progress', ['todo', 'review'])]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'in-progress' as any
      })

      await expect(middleware.tx(updateTx)).rejects.toThrow('Transition canceled by user')
    })

    it('should match transition with wildcard from (from: null)', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'backlog', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [createMockTransition('t-wildcard', 'canceled', null, [])]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'canceled' as any
      })

      await expect(middleware.tx(updateTx)).resolves.toBeDefined()
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should match transition with empty from array (from: [])', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'backlog', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [createMockTransition('t-empty-from', 'closed', [], [])]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'closed' as any
      })

      await expect(middleware.tx(updateTx)).resolves.toBeDefined()
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should prioritize explicit from match over wildcard from match', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [
        createMockTransition('t-wildcard', 'done', null, []),
        createMockTransition('t-explicit', 'done', ['todo'], [])
      ]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'done' as any
      })

      await expect(middleware.tx(updateTx)).resolves.toBeDefined()
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })
  })

  // =========================================================================
  // 6. Screen Requests Evaluation
  // =========================================================================
  describe('Screen Requests Evaluation', () => {
    it('should pass through when transition has no requests property', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [createMockTransition('t-1', 'in-progress', ['todo'])]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'in-progress' as any
      })

      await middleware.tx(updateTx)
      expect(mockClient.findAll).not.toHaveBeenCalled()
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should pass through when transition has non-ScreenRequest rules only', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [
        createMockTransition(
          't-1',
          'in-progress',
          ['todo'],
          [
            {
              _id: 'req-val' as Ref<any>,
              _class: plugin.class.WorkflowValidator,
              rule: 'some:other:ValidatorRule' as any,
              name: 'Check something',
              order: 0,
              props: {}
            }
          ]
        )
      ]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'in-progress' as any
      })

      await middleware.tx(updateTx)
      expect(mockClient.findAll).not.toHaveBeenCalled()
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should pass through when ScreenRequest has no screen prop', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [
        createMockTransition(
          't-1',
          'in-progress',
          ['todo'],
          [
            {
              _id: 'req-screen' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Empty Screen Request',
              order: 0,
              props: {}
            }
          ]
        )
      ]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'in-progress' as any
      })

      await middleware.tx(updateTx)
      expect(mockClient.findAll).not.toHaveBeenCalled()
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should pass through when screens are not found in client', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [
        createMockTransition(
          't-1',
          'done',
          ['todo'],
          [
            {
              _id: 'req-1' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Resolve Screen',
              order: 0,
              props: { screen: 'screen-missing' as Ref<Screen> }
            }
          ]
        )
      ]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      mockClient.findAll.mockResolvedValueOnce(toFindResult<Screen>([]))

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'done' as any
      })

      await middleware.tx(updateTx)
      expect(mockClient.findAll).toHaveBeenCalledWith(
        plugin.class.Screen,
        { _id: { $in: ['screen-missing'] } },
        { lookup: { _id: { tabs: plugin.class.ScreenTab } } }
      )
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should pass through when screens have tabs but no fields are found', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [
        createMockTransition(
          't-1',
          'done',
          ['todo'],
          [
            {
              _id: 'req-1' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Resolve Screen',
              order: 0,
              props: { screen: 'screen-1' as Ref<Screen> }
            }
          ]
        )
      ]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      const screenTab = createMockScreenTab('tab-1', 'screen-1')
      const screen1 = createMockScreen('screen-1', [screenTab])

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      mockClient.findAll
        .mockResolvedValueOnce(toFindResult<Screen>([screen1]))
        .mockResolvedValueOnce(toFindResult<ScreenField>([]))

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'done' as any
      })

      await middleware.tx(updateTx)
      expect(mockClient.findAll).toHaveBeenCalledWith(plugin.class.ScreenField, { attachedTo: { $in: ['tab-1'] } })
      expect(showPopup).not.toHaveBeenCalled()
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should pass through when screen.$lookup is undefined', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [
        createMockTransition(
          't-1',
          'done',
          ['todo'],
          [
            {
              _id: 'req-1' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Screen 1',
              order: 0,
              props: { screen: 'screen-1' as Ref<Screen> }
            }
          ]
        )
      ]
      const workflowDoc = createMockWorkflow('wf-1', transitions)
      const screenNoLookup: Screen = {
        _id: 'screen-1' as Ref<Screen>,
        _class: plugin.class.Screen,
        name: 'Screen No Lookup',
        space: core.space.Model,
        modifiedBy: testUser as unknown as PersonId,
        modifiedOn: Date.now()
      } as unknown as Screen

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      mockClient.findAll
        .mockResolvedValueOnce(toFindResult<Screen>([screenNoLookup]))
        .mockResolvedValueOnce(toFindResult<ScreenField>([]))

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'done' as any
      })

      await middleware.tx(updateTx)
      expect(showPopup).not.toHaveBeenCalled()
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should handle partial screen resolution when one of screen IDs is not found', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [
        createMockTransition(
          't-1',
          'done',
          ['todo'],
          [
            {
              _id: 'req-1' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Screen 1',
              order: 0,
              props: { screen: 'screen-1' as Ref<Screen> }
            },
            {
              _id: 'req-2' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Screen Missing',
              order: 1,
              props: { screen: 'screen-missing' as Ref<Screen> }
            }
          ]
        )
      ]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      const screenTab = createMockScreenTab('tab-1', 'screen-1')
      const screen1 = createMockScreen('screen-1', [screenTab])
      const field1 = createMockScreenField('field-1', 'tab-1')

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      // Only screen1 is returned from findAll, screen-missing is not in DB
      mockClient.findAll
        .mockResolvedValueOnce(toFindResult<Screen>([screen1]))
        .mockResolvedValueOnce(toFindResult<ScreenField>([field1]))
      ;(showPopup as jest.Mock).mockImplementation((_comp, _props, _pos, cb) => {
        cb({ update: { isDone: true } })
      })

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'done' as any
      })

      await middleware.tx(updateTx)
      expect(showPopup).toHaveBeenCalledTimes(1)
      expect(updateTx.operations.isDone).toBe(true)
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })
  })

  // =========================================================================
  // 7. Screen Ordering & Modal Presentation Flow
  // =========================================================================
  describe('Screen Ordering & Modal Presentation Flow', () => {
    it('should preserve screen ordering from screenRequests and skip screens with 0 fields', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [
        createMockTransition(
          't-1',
          'done',
          ['todo'],
          [
            {
              _id: 'req-2' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Screen B',
              order: 0,
              props: { screen: 'screen-B' as Ref<Screen> }
            },
            {
              _id: 'req-1' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Screen A',
              order: 1,
              props: { screen: 'screen-A' as Ref<Screen> }
            },
            {
              _id: 'req-empty' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Screen Empty',
              order: 2,
              props: { screen: 'screen-empty' as Ref<Screen> }
            }
          ]
        )
      ]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      const tabA = createMockScreenTab('tab-A', 'screen-A')
      const tabB = createMockScreenTab('tab-B', 'screen-B')
      const tabEmpty = createMockScreenTab('tab-empty', 'screen-empty')

      const screenA = createMockScreen('screen-A', [tabA])
      const screenB = createMockScreen('screen-B', [tabB])
      const screenEmpty = createMockScreen('screen-empty', [tabEmpty])

      const fieldA = createMockScreenField('field-A', 'tab-A')
      const fieldB = createMockScreenField('field-B', 'tab-B')

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      // findAll returns in different order: screenA, screenEmpty, screenB
      mockClient.findAll
        .mockResolvedValueOnce(toFindResult<Screen>([screenA, screenEmpty, screenB]))
        .mockResolvedValueOnce(toFindResult<ScreenField>([fieldA, fieldB]))

      const shownScreens: string[] = []
      ;(showPopup as jest.Mock).mockImplementation((_comp, props, _pos, cb) => {
        shownScreens.push(props.screen._id)
        cb({ update: {} })
      })

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'done' as any
      })

      await middleware.tx(updateTx)

      // Verify screenB was shown first, then screenA, and screenEmpty was skipped
      expect(shownScreens).toEqual(['screen-B', 'screen-A'])
      expect(showPopup).toHaveBeenCalledTimes(2)
    })

    it('should throw PlatformError when user cancels modal', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [
        createMockTransition(
          't-1',
          'done',
          ['todo'],
          [
            {
              _id: 'req-1' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Screen A',
              order: 0,
              props: { screen: 'screen-1' as Ref<Screen> }
            },
            {
              _id: 'req-2' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Screen B',
              order: 1,
              props: { screen: 'screen-2' as Ref<Screen> }
            }
          ]
        )
      ]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      const tab1 = createMockScreenTab('tab-1', 'screen-1')
      const screen1 = createMockScreen('screen-1', [tab1])
      const field1 = createMockScreenField('field-1', 'tab-1')

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      mockClient.findAll
        .mockResolvedValueOnce(toFindResult<Screen>([screen1]))
        .mockResolvedValueOnce(toFindResult<ScreenField>([field1]))

      // User cancels dialog -> callback invoked with null
      ;(showPopup as jest.Mock).mockImplementation((_comp, _props, _pos, cb) => {
        cb(null)
      })

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'done' as any
      })

      await expect(middleware.tx(updateTx)).rejects.toThrow('Transition canceled by user')
      expect(mockNext.tx).not.toHaveBeenCalled()
    })

    it('should clone task document and pass to showPopup props', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [
        createMockTransition(
          't-1',
          'done',
          ['todo'],
          [
            {
              _id: 'req-1' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Screen 1',
              order: 0,
              props: { screen: 'screen-1' as Ref<Screen> }
            }
          ]
        )
      ]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      const tab1 = createMockScreenTab('tab-1', 'screen-1')
      const screen1 = createMockScreen('screen-1', [tab1])
      const field1 = createMockScreenField('field-1', 'tab-1')

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      mockClient.findAll
        .mockResolvedValueOnce(toFindResult<Screen>([screen1]))
        .mockResolvedValueOnce(toFindResult<ScreenField>([field1]))
      ;(showPopup as jest.Mock).mockImplementation((_comp, _props, _pos, cb) => {
        cb({ update: {} })
      })

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'done' as any
      })

      await middleware.tx(updateTx)

      expect(mockHierarchy.clone).toHaveBeenCalledWith(existingTask)
      expect(showPopup).toHaveBeenCalledWith(
        ScreenModal,
        {
          screen: screen1,
          tabs: [tab1],
          fields: [field1],
          object: expect.objectContaining({ _id: 'task-1', title: 'Task task-1' })
        },
        'center',
        expect.any(Function)
      )
    })
  })

  // =========================================================================
  // 8. ScreenModal Results & Extra Transactions
  // =========================================================================
  describe('ScreenModal Results & Extra Transactions Application', () => {
    it('should merge modal updates into updateTx operations when no extra txes', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [
        createMockTransition(
          't-1',
          'done',
          ['todo'],
          [
            {
              _id: 'req-1' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Screen 1',
              order: 0,
              props: { screen: 'screen-1' as Ref<Screen> }
            }
          ]
        )
      ]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      const tab1 = createMockScreenTab('tab-1', 'screen-1')
      const screen1 = createMockScreen('screen-1', [tab1])
      const field1 = createMockScreenField('field-1', 'tab-1')

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      mockClient.findAll
        .mockResolvedValueOnce(toFindResult<Screen>([screen1]))
        .mockResolvedValueOnce(toFindResult<ScreenField>([field1]))

      const modalResult: ScreenModalResult<Task> = {
        update: {
          isDone: true,
          number: 42
        }
      }
      ;(showPopup as jest.Mock).mockImplementation((_comp, _props, _pos, cb) => {
        cb(modalResult)
      })

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'done' as any
      })

      await middleware.tx(updateTx)

      expect(updateTx.operations).toEqual({
        status: 'done',
        isDone: true,
        number: 42
      })
      expect(mockNext.tx).toHaveBeenCalledWith(updateTx)
    })

    it('should create batch TxApplyIf when modal returns extraTxes', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [
        createMockTransition(
          't-1',
          'done',
          ['todo'],
          [
            {
              _id: 'req-1' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Screen 1',
              order: 0,
              props: { screen: 'screen-1' as Ref<Screen> }
            }
          ]
        )
      ]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      const tab1 = createMockScreenTab('tab-1', 'screen-1')
      const screen1 = createMockScreen('screen-1', [tab1])
      const field1 = createMockScreenField('field-1', 'tab-1')

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      mockClient.findAll
        .mockResolvedValueOnce(toFindResult<Screen>([screen1]))
        .mockResolvedValueOnce(toFindResult<ScreenField>([field1]))

      const extraTx1 = createMockCreateTx('comment-1' as Ref<Doc>, 'some:class:Comment' as Ref<Class<Doc>>, {
        text: 'Closing comment'
      })

      const modalResult: ScreenModalResult<Task> = {
        update: {
          isDone: true
        },
        txes: [extraTx1]
      }
      ;(showPopup as jest.Mock).mockImplementation((_comp, _props, _pos, cb) => {
        cb(modalResult)
      })

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'done' as any
      })

      await middleware.tx(updateTx)

      expect(mockNext.tx).toHaveBeenCalledTimes(1)
      const submittedTx = mockNext.tx.mock.calls[0][0] as TxApplyIf

      expect(submittedTx._class).toBe(core.class.TxApplyIf)
      expect(submittedTx.txes).toHaveLength(2)
      expect(submittedTx.txes[0]).toBe(updateTx)
      expect(submittedTx.txes[1]).toBe(extraTx1)
      expect(updateTx.operations.isDone).toBe(true)
    })

    it('should combine updates and extra txes from multiple sequential screens', async () => {
      const existingTask = createMockTask('task-1', 'issue', 'todo', 'proj-1')
      const project = createMockProject('proj-1', { issue: 'wf-1' as Ref<Workflow> })
      const transitions: WorkflowTransition[] = [
        createMockTransition(
          't-1',
          'done',
          ['todo'],
          [
            {
              _id: 'req-1' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Screen 1',
              order: 0,
              props: { screen: 'screen-1' as Ref<Screen> }
            },
            {
              _id: 'req-2' as Ref<any>,
              _class: plugin.class.WorkflowRequest,
              rule: plugin.request.ScreenRequest,
              name: 'Screen 2',
              order: 1,
              props: { screen: 'screen-2' as Ref<Screen> }
            }
          ]
        )
      ]
      const workflowDoc = createMockWorkflow('wf-1', transitions)

      const tab1 = createMockScreenTab('tab-1', 'screen-1')
      const tab2 = createMockScreenTab('tab-2', 'screen-2')
      const screen1 = createMockScreen('screen-1', [tab1])
      const screen2 = createMockScreen('screen-2', [tab2])
      const field1 = createMockScreenField('field-1', 'tab-1')
      const field2 = createMockScreenField('field-2', 'tab-2')

      mockHierarchy.hasMixin.mockReturnValue(true)
      mockHierarchy.as.mockReturnValue({ workflows: { issue: 'wf-1' as Ref<Workflow> } } as unknown as ProjectWorkflow)

      mockClient.findOne
        .mockResolvedValueOnce(existingTask)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(workflowDoc)

      mockClient.findAll
        .mockResolvedValueOnce(toFindResult<Screen>([screen1, screen2]))
        .mockResolvedValueOnce(toFindResult<ScreenField>([field1, field2]))

      const extraTx1 = createMockCreateTx('sub-1' as Ref<Doc>, 'some:class' as Ref<Class<Doc>>, { item: 1 })
      const extraTx2 = createMockCreateTx('sub-2' as Ref<Doc>, 'some:class' as Ref<Class<Doc>>, { item: 2 })

      let callCount = 0
      ;(showPopup as jest.Mock).mockImplementation((_comp, props, _pos, cb) => {
        callCount++
        if (props.screen._id === 'screen-1') {
          cb({ update: { isDone: false }, txes: [extraTx1] })
        } else {
          cb({ update: { isDone: true }, txes: [extraTx2] })
        }
      })

      const updateTx = createMockUpdateTx('task-1' as Ref<Task>, task.class.Task, {
        status: 'done' as any
      })

      await middleware.tx(updateTx)

      expect(callCount).toBe(2)
      expect(mockNext.tx).toHaveBeenCalledTimes(1)
      const submittedTx = mockNext.tx.mock.calls[0][0] as TxApplyIf

      expect(submittedTx._class).toBe(core.class.TxApplyIf)
      expect(submittedTx.txes).toHaveLength(3)
      expect(submittedTx.txes).toEqual([updateTx, extraTx1, extraTx2])
      expect(updateTx.operations).toEqual({
        status: 'done',
        isDone: true
      })
    })
  })
})

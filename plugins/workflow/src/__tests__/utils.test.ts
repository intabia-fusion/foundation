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
  SortingOrder,
  type PersonId,
  type AnyAttribute,
  type Ref,
  type Status,
  type TxOperations
} from '@hcengineering/core'
import type { IntlString } from '@hcengineering/platform'
import task, { makeRank, type Project, type ProjectType, type TaskType } from '@hcengineering/task'
import {
  createWorkflow,
  removeWorkflow,
  addTransition,
  removeTransition,
  updateTransition,
  addRuleConfig,
  removeRuleConfig,
  updateRuleConfig,
  setWorkflow,
  findTransitionConflict,
  checkConflict,
  getTransitionConflict,
  hasTransitionConflict,
  hasSelfTransition,
  addScreenTab,
  removeScreenTab,
  addScreenField,
  removeScreenField,
  WorkflowValue,
  isPresetValue,
  isThisValue,
  isParentValue,
  isConstValue,
  type AnyRuleConfig,
  type Workflow,
  type WorkflowTransition,
  type WorkflowValidator,
  type WorkflowRequest,
  type WorkflowPostFunction,
  type Screen,
  type ScreenTab,
  type ScreenField,
  type Field,
  type WorkflowValueFunction
} from '../index'
import workflow from '../plugin'

function createMockClient (overrides: Partial<TxOperations> = {}): TxOperations {
  return overrides as unknown as TxOperations
}

describe('Workflow Utilities', () => {
  const projectTypeId = 'proj-type-1' as Ref<ProjectType>
  const taskTypeId = 'task-type-1' as Ref<TaskType>
  const workflowId = 'wf-1' as Ref<Workflow>
  const transitionId = 'trans-1' as Ref<WorkflowTransition>
  const statusOpen = 'status-open' as Ref<Status>
  const statusInProgress = 'status-in-progress' as Ref<Status>
  const statusDone = 'status-done' as Ref<Status>
  const validatorType = 'val-field-required' as Ref<WorkflowValidator>
  const requestType = 'req-approval' as Ref<WorkflowRequest>
  const postFunctionType = 'post-update-field' as Ref<WorkflowPostFunction>
  const screenId = 'screen-1' as Ref<Screen>
  const tabId = 'tab-1' as Ref<ScreenTab>
  const fieldId = 'field-1' as Ref<ScreenField>
  const attrAssignee = 'attr-assignee' as Ref<AnyAttribute>
  const testAccount = 'test-account' as PersonId
  const defaultRank = makeRank(undefined, undefined)

  describe('Workflow CRUD', () => {
    it('should create a workflow with expected parameters', async () => {
      const mockClient = createMockClient({
        createDoc: jest.fn().mockResolvedValue('wf-new-id' as Ref<Workflow>)
      })

      const res = await createWorkflow(mockClient, projectTypeId, taskTypeId, 'Default Workflow')

      expect(mockClient.createDoc).toHaveBeenCalledWith(workflow.class.Workflow, core.space.Workspace, {
        name: 'Default Workflow',
        projectType: projectTypeId,
        taskType: taskTypeId
      })
      expect(res).toBe('wf-new-id')
    })

    it('should remove a workflow by ID', async () => {
      const mockClient = createMockClient({
        removeDoc: jest.fn().mockResolvedValue(undefined)
      })

      await removeWorkflow(mockClient, workflowId)

      expect(mockClient.removeDoc).toHaveBeenCalledWith(workflow.class.Workflow, core.space.Workspace, workflowId)
    })
  })

  describe('Transition CRUD', () => {
    it('should add a transition with initial rank when no transitions exist', async () => {
      const mockClient = createMockClient({
        findOne: jest.fn().mockResolvedValue(null),
        addCollection: jest.fn().mockResolvedValue('trans-new-id' as Ref<WorkflowTransition>)
      })

      const res = await addTransition(mockClient, workflowId, 'Start Work', [statusOpen], statusInProgress)

      expect(mockClient.findOne).toHaveBeenCalledWith(
        workflow.class.WorkflowTransition,
        { attachedTo: workflowId },
        { sort: { rank: SortingOrder.Descending } }
      )
      expect(mockClient.addCollection).toHaveBeenCalledWith(
        workflow.class.WorkflowTransition,
        core.space.Workspace,
        workflowId,
        workflow.class.Workflow,
        'transitions',
        {
          name: 'Start Work',
          from: [statusOpen],
          to: statusInProgress,
          rank: defaultRank
        }
      )
      expect(res).toBe('trans-new-id')
    })

    it('should add a transition with incremental rank when last transition exists', async () => {
      const mockClient = createMockClient({
        findOne: jest.fn().mockResolvedValue({ rank: defaultRank }),
        addCollection: jest.fn().mockResolvedValue('trans-2-id' as Ref<WorkflowTransition>)
      })

      const expectedRank = makeRank(defaultRank, undefined)
      const res = await addTransition(mockClient, workflowId, 'Finish Work', [statusInProgress], statusDone)

      expect(mockClient.addCollection).toHaveBeenCalledWith(
        workflow.class.WorkflowTransition,
        core.space.Workspace,
        workflowId,
        workflow.class.Workflow,
        'transitions',
        {
          name: 'Finish Work',
          from: [statusInProgress],
          to: statusDone,
          rank: expectedRank
        }
      )
      expect(res).toBe('trans-2-id')
    })

    it('should remove a transition', async () => {
      const mockClient = createMockClient({
        removeCollection: jest.fn().mockResolvedValue(undefined)
      })

      await removeTransition(mockClient, workflowId, transitionId)

      expect(mockClient.removeCollection).toHaveBeenCalledWith(
        workflow.class.WorkflowTransition,
        core.space.Workspace,
        transitionId,
        workflowId,
        workflow.class.Workflow,
        'transitions'
      )
    })

    it('should update a transition', async () => {
      const mockClient = createMockClient({
        updateCollection: jest.fn().mockResolvedValue(undefined)
      })

      await updateTransition(mockClient, workflowId, transitionId, { name: 'New Name' })

      expect(mockClient.updateCollection).toHaveBeenCalledWith(
        workflow.class.WorkflowTransition,
        core.space.Workspace,
        transitionId,
        workflowId,
        workflow.class.Workflow,
        'transitions',
        { name: 'New Name' }
      )
    })
  })

  describe('Validator Config CRUD', () => {
    let transition: WorkflowTransition

    const mockClient = createMockClient({
      findOne: jest.fn().mockImplementation(async (cls, query) => {
        if (cls === workflow.class.WorkflowTransition && query._id === transitionId) {
          return transition
        }
        return null
      }),
      updateCollection: jest.fn().mockImplementation(async (cls, space, transId, wfId, wfCls, col, data) => {
        if (data.validators !== undefined) {
          transition.validators = data.validators
        } else if (data.$push?.validators != null) {
          transition.validators = [...(transition.validators ?? []), data.$push.validators]
        } else if (data.$pull?.validators != null) {
          const pullId = data.$pull.validators.id
          transition.validators = (transition.validators ?? []).filter((v) => v.id !== pullId)
        } else if (data.$update?.validators != null) {
          const queryId = data.$update.validators.$query?.id
          const updateData = data.$update.validators.$update
          transition.validators = (transition.validators ?? []).map((v) =>
            v.id === queryId ? { ...v, ...updateData } : v
          )
        }
      })
    })

    beforeEach(() => {
      transition = {
        _id: transitionId,
        _class: workflow.class.WorkflowTransition,
        space: core.space.Workspace,
        attachedTo: workflowId,
        attachedToClass: workflow.class.Workflow,
        collection: 'transitions',
        name: 'Start Work',
        from: null,
        to: statusInProgress,
        rank: defaultRank,
        modifiedOn: 0,
        modifiedBy: testAccount,
        validators: []
      }
    })

    it('should add validator config', async () => {
      const config = {
        id: 'custom-id-1',
        ruleClass: workflow.class.WorkflowValidator,
        rule: validatorType,
        props: { field: 'assignee' }
      } as unknown as AnyRuleConfig
      await addRuleConfig(mockClient, workflowId, transitionId, 'validators', config)

      expect(transition.validators).toHaveLength(1)
      expect(transition.validators?.[0]).toEqual(config)
    })

    it('should throw error when adding duplicate validator config', async () => {
      const config = {
        id: 'cfg-1',
        ruleClass: workflow.class.WorkflowValidator,
        rule: validatorType,
        props: { field: 'assignee' }
      } as unknown as AnyRuleConfig
      await addRuleConfig(mockClient, workflowId, transitionId, 'validators', config)

      await expect(addRuleConfig(mockClient, workflowId, transitionId, 'validators', config)).rejects.toThrow(
        `validators config already exists on transition ${transitionId}`
      )
    })

    it('should throw error when adding validator config if transition is not found', async () => {
      const missingTransitionId = 'non-existent' as Ref<WorkflowTransition>
      await expect(
        addRuleConfig(mockClient, workflowId, missingTransitionId, 'validators', {
          id: 'cfg-1',
          ruleClass: workflow.class.WorkflowValidator,
          rule: validatorType,
          props: {}
        } as unknown as AnyRuleConfig)
      ).rejects.toThrow('Transition non-existent not found')
    })

    it('should allow multiple validator configs of the same validator type', async () => {
      const config1 = {
        id: 'cfg-1',
        ruleClass: workflow.class.WorkflowValidator,
        rule: validatorType,
        props: { field: 'assignee' }
      } as unknown as AnyRuleConfig
      const config2 = {
        id: 'cfg-2',
        ruleClass: workflow.class.WorkflowValidator,
        rule: validatorType,
        props: { field: 'dueDate' }
      } as unknown as AnyRuleConfig
      await addRuleConfig(mockClient, workflowId, transitionId, 'validators', config1)
      await addRuleConfig(mockClient, workflowId, transitionId, 'validators', config2)

      expect(transition.validators).toHaveLength(2)
      expect(transition.validators?.[0].props).toEqual({ field: 'assignee' })
      expect(transition.validators?.[1].props).toEqual({ field: 'dueDate' })
    })

    it('should update specific validator config by id', async () => {
      const config1 = {
        id: 'cfg-1',
        ruleClass: workflow.class.WorkflowValidator,
        rule: validatorType,
        props: { field: 'assignee' }
      } as unknown as AnyRuleConfig
      const config2 = {
        id: 'cfg-2',
        ruleClass: workflow.class.WorkflowValidator,
        rule: validatorType,
        props: { field: 'dueDate' }
      } as unknown as AnyRuleConfig
      await addRuleConfig(mockClient, workflowId, transitionId, 'validators', config1)
      await addRuleConfig(mockClient, workflowId, transitionId, 'validators', config2)

      await updateRuleConfig(mockClient, workflowId, transitionId, 'validators', config1.id, {
        props: { field: 'assignee', required: true }
      } as unknown as Partial<Pick<AnyRuleConfig, 'props'>>)

      expect(transition.validators?.[0].props).toEqual({ field: 'assignee', required: true })
      expect(transition.validators?.[1].props).toEqual({ field: 'dueDate' })
    })

    it('should throw error when updating validator config if transition is not found', async () => {
      const missingTransitionId = 'non-existent' as Ref<WorkflowTransition>
      await expect(
        updateRuleConfig(mockClient, workflowId, missingTransitionId, 'validators', 'cfg-1', {})
      ).rejects.toThrow('Transition non-existent not found')
    })

    it('should remove specific validator config by id', async () => {
      const config1 = {
        id: 'cfg-1',
        ruleClass: workflow.class.WorkflowValidator,
        rule: validatorType,
        props: { field: 'assignee' }
      } as unknown as AnyRuleConfig
      const config2 = {
        id: 'cfg-2',
        ruleClass: workflow.class.WorkflowValidator,
        rule: validatorType,
        props: { field: 'dueDate' }
      } as unknown as AnyRuleConfig
      await addRuleConfig(mockClient, workflowId, transitionId, 'validators', config1)
      await addRuleConfig(mockClient, workflowId, transitionId, 'validators', config2)

      await removeRuleConfig(mockClient, workflowId, transitionId, 'validators', config1.id)

      expect(transition.validators).toHaveLength(1)
      expect(transition.validators?.[0].id).toEqual(config2.id)
    })

    it('should throw error when removing validator config if transition is not found', async () => {
      const missingTransitionId = 'non-existent' as Ref<WorkflowTransition>
      await expect(
        removeRuleConfig(mockClient, workflowId, missingTransitionId, 'validators', 'cfg-1')
      ).rejects.toThrow('Transition non-existent not found')
    })
  })

  describe('Request Config CRUD', () => {
    let transition: WorkflowTransition

    const mockClient = createMockClient({
      findOne: jest.fn().mockImplementation(async (cls, query) => {
        if (cls === workflow.class.WorkflowTransition && query._id === transitionId) {
          return transition
        }
        return null
      }),
      updateCollection: jest.fn().mockImplementation(async (cls, space, transId, wfId, wfCls, col, data) => {
        if (data.requests !== undefined) {
          transition.requests = data.requests
        } else if (data.$push?.requests != null) {
          transition.requests = [...(transition.requests ?? []), data.$push.requests]
        } else if (data.$pull?.requests != null) {
          const pullId = data.$pull.requests.id
          transition.requests = (transition.requests ?? []).filter((r) => r.id !== pullId)
        } else if (data.$update?.requests != null) {
          const queryId = data.$update.requests.$query?.id
          const updateData = data.$update.requests.$update
          transition.requests = (transition.requests ?? []).map((r) => (r.id === queryId ? { ...r, ...updateData } : r))
        }
      })
    })

    beforeEach(() => {
      transition = {
        _id: transitionId,
        _class: workflow.class.WorkflowTransition,
        space: core.space.Workspace,
        attachedTo: workflowId,
        attachedToClass: workflow.class.Workflow,
        collection: 'transitions',
        name: 'Start Work',
        from: null,
        to: statusInProgress,
        rank: defaultRank,
        modifiedOn: 0,
        modifiedBy: testAccount,
        requests: []
      }
    })

    it('should add request config', async () => {
      const config = {
        id: 'req-cfg-1',
        ruleClass: workflow.class.WorkflowRequest,
        rule: requestType,
        props: { approver: 'user-1' }
      } as unknown as AnyRuleConfig
      await addRuleConfig(mockClient, workflowId, transitionId, 'requests', config)

      expect(transition.requests).toHaveLength(1)
      expect(transition.requests?.[0]).toEqual(config)
    })

    it('should throw error when adding duplicate request config', async () => {
      const config = {
        id: 'req-cfg-1',
        ruleClass: workflow.class.WorkflowRequest,
        rule: requestType,
        props: {}
      } as unknown as AnyRuleConfig
      await addRuleConfig(mockClient, workflowId, transitionId, 'requests', config)

      await expect(addRuleConfig(mockClient, workflowId, transitionId, 'requests', config)).rejects.toThrow(
        `requests config already exists on transition ${transitionId}`
      )
    })

    it('should throw error when adding request config if transition is not found', async () => {
      const missingTransitionId = 'non-existent' as Ref<WorkflowTransition>
      await expect(
        addRuleConfig(mockClient, workflowId, missingTransitionId, 'requests', {
          id: 'req-cfg-1',
          ruleClass: workflow.class.WorkflowRequest,
          rule: requestType,
          props: {}
        } as unknown as AnyRuleConfig)
      ).rejects.toThrow('Transition non-existent not found')
    })

    it('should update specific request config by id', async () => {
      const config = {
        id: 'req-cfg-1',
        ruleClass: workflow.class.WorkflowRequest,
        rule: requestType,
        props: { approver: 'user-1' }
      } as unknown as AnyRuleConfig
      await addRuleConfig(mockClient, workflowId, transitionId, 'requests', config)

      await updateRuleConfig(mockClient, workflowId, transitionId, 'requests', config.id, {
        props: { approver: 'user-2' }
      } as unknown as Partial<Pick<AnyRuleConfig, 'props'>>)

      expect(transition.requests?.[0].props).toEqual({ approver: 'user-2' })
    })

    it('should throw error when updating request config if transition is not found', async () => {
      const missingTransitionId = 'non-existent' as Ref<WorkflowTransition>
      await expect(
        updateRuleConfig(mockClient, workflowId, missingTransitionId, 'requests', 'req-cfg-1', {})
      ).rejects.toThrow('Transition non-existent not found')
    })

    it('should remove specific request config by id', async () => {
      const config = {
        id: 'req-cfg-1',
        ruleClass: workflow.class.WorkflowRequest,
        rule: requestType,
        props: {}
      } as unknown as AnyRuleConfig
      await addRuleConfig(mockClient, workflowId, transitionId, 'requests', config)

      await removeRuleConfig(mockClient, workflowId, transitionId, 'requests', config.id)

      expect(transition.requests).toHaveLength(0)
    })

    it('should throw error when removing request config if transition is not found', async () => {
      const missingTransitionId = 'non-existent' as Ref<WorkflowTransition>
      await expect(
        removeRuleConfig(mockClient, workflowId, missingTransitionId, 'requests', 'req-cfg-1')
      ).rejects.toThrow('Transition non-existent not found')
    })
  })

  describe('Post-Function Config CRUD', () => {
    let transition: WorkflowTransition

    const mockClient = createMockClient({
      findOne: jest.fn().mockImplementation(async (cls, query) => {
        if (cls === workflow.class.WorkflowTransition && query._id === transitionId) {
          return transition
        }
        return null
      }),
      updateCollection: jest.fn().mockImplementation(async (cls, space, transId, wfId, wfCls, col, data) => {
        if (data.postFunctions !== undefined) {
          transition.postFunctions = data.postFunctions
        } else if (data.$push?.postFunctions != null) {
          transition.postFunctions = [...(transition.postFunctions ?? []), data.$push.postFunctions]
        } else if (data.$pull?.postFunctions != null) {
          const pullId = data.$pull.postFunctions.id
          transition.postFunctions = (transition.postFunctions ?? []).filter((pf) => pf.id !== pullId)
        } else if (data.$update?.postFunctions != null) {
          const queryId = data.$update.postFunctions.$query?.id
          const updateData = data.$update.postFunctions.$update
          transition.postFunctions = (transition.postFunctions ?? []).map((pf) =>
            pf.id === queryId ? { ...pf, ...updateData } : pf
          )
        }
      })
    })

    beforeEach(() => {
      transition = {
        _id: transitionId,
        _class: workflow.class.WorkflowTransition,
        space: core.space.Workspace,
        attachedTo: workflowId,
        attachedToClass: workflow.class.Workflow,
        collection: 'transitions',
        name: 'Start Work',
        from: null,
        to: statusInProgress,
        rank: defaultRank,
        modifiedOn: 0,
        modifiedBy: testAccount,
        postFunctions: []
      }
    })

    it('should add post-function config', async () => {
      const config = {
        id: 'pf-cfg-1',
        ruleClass: workflow.class.WorkflowPostFunction,
        rule: postFunctionType,
        props: { fields: [] }
      } as unknown as AnyRuleConfig
      await addRuleConfig(mockClient, workflowId, transitionId, 'postFunctions', config)

      expect(transition.postFunctions).toHaveLength(1)
      expect(transition.postFunctions?.[0]).toEqual(config)
    })

    it('should throw error when adding duplicate post-function config', async () => {
      const config = {
        id: 'pf-cfg-1',
        ruleClass: workflow.class.WorkflowPostFunction,
        rule: postFunctionType,
        props: {}
      } as unknown as AnyRuleConfig
      await addRuleConfig(mockClient, workflowId, transitionId, 'postFunctions', config)

      await expect(addRuleConfig(mockClient, workflowId, transitionId, 'postFunctions', config)).rejects.toThrow(
        `postFunctions config already exists on transition ${transitionId}`
      )
    })

    it('should throw error when adding post-function config if transition is not found', async () => {
      const missingTransitionId = 'non-existent' as Ref<WorkflowTransition>
      await expect(
        addRuleConfig(mockClient, workflowId, missingTransitionId, 'postFunctions', {
          id: 'pf-cfg-1',
          ruleClass: workflow.class.WorkflowPostFunction,
          rule: postFunctionType,
          props: {}
        } as unknown as AnyRuleConfig)
      ).rejects.toThrow('Transition non-existent not found')
    })

    it('should update specific post-function config by id', async () => {
      const config = {
        id: 'pf-cfg-1',
        ruleClass: workflow.class.WorkflowPostFunction,
        rule: postFunctionType,
        props: { fields: [] }
      } as unknown as AnyRuleConfig
      await addRuleConfig(mockClient, workflowId, transitionId, 'postFunctions', config)

      await updateRuleConfig(mockClient, workflowId, transitionId, 'postFunctions', config.id, {
        props: {
          fields: [{ fieldKey: 'assignee', attribute: attrAssignee, value: { type: 'preset', preset: '$currentUser' } }]
        }
      })

      expect(transition.postFunctions?.[0].props.fields).toHaveLength(1)
    })

    it('should throw error when updating post-function config if transition is not found', async () => {
      const missingTransitionId = 'non-existent' as Ref<WorkflowTransition>
      await expect(
        updateRuleConfig(mockClient, workflowId, missingTransitionId, 'postFunctions', 'pf-cfg-1', {})
      ).rejects.toThrow('Transition non-existent not found')
    })

    it('should remove specific post-function config by id', async () => {
      const config = {
        id: 'pf-cfg-1',
        ruleClass: workflow.class.WorkflowPostFunction,
        rule: postFunctionType,
        props: {}
      } as unknown as AnyRuleConfig
      await addRuleConfig(mockClient, workflowId, transitionId, 'postFunctions', config)

      await removeRuleConfig(mockClient, workflowId, transitionId, 'postFunctions', config.id)

      expect(transition.postFunctions).toHaveLength(0)
    })

    it('should throw error when removing post-function config if transition is not found', async () => {
      const missingTransitionId = 'non-existent' as Ref<WorkflowTransition>
      await expect(
        removeRuleConfig(mockClient, workflowId, missingTransitionId, 'postFunctions', 'pf-cfg-1')
      ).rejects.toThrow('Transition non-existent not found')
    })
  })

  describe('setWorkflow', () => {
    it('should create mixin when project does not have ProjectWorkflow mixin', async () => {
      const project = {
        _id: 'proj-1' as Ref<Project>,
        _class: task.class.Project,
        space: core.space.Workspace,
        name: 'Project 1',
        modifiedOn: 0,
        modifiedBy: testAccount
      } as unknown as Project

      const mockHierarchy = {
        as: jest.fn().mockReturnValue({ workflows: {} }),
        hasMixin: jest.fn().mockReturnValue(false)
      }

      const mockClient = createMockClient({
        getHierarchy: jest.fn().mockReturnValue(mockHierarchy),
        createMixin: jest.fn().mockResolvedValue(undefined),
        updateMixin: jest.fn().mockResolvedValue(undefined)
      })

      await setWorkflow(mockClient, project, taskTypeId, workflowId)

      expect(mockClient.createMixin).toHaveBeenCalledWith(
        project._id,
        project._class,
        project.space,
        workflow.mixin.ProjectWorkflow,
        { workflows: { [taskTypeId]: workflowId } }
      )
    })

    it('should update mixin when project already has ProjectWorkflow mixin', async () => {
      const project = {
        _id: 'proj-1' as Ref<Project>,
        _class: task.class.Project,
        space: core.space.Workspace,
        name: 'Project 1',
        modifiedOn: 0,
        modifiedBy: testAccount
      } as unknown as Project

      const mockHierarchy = {
        as: jest.fn().mockReturnValue({ workflows: { existingType: 'wf-old' } }),
        hasMixin: jest.fn().mockReturnValue(true)
      }

      const mockClient = createMockClient({
        getHierarchy: jest.fn().mockReturnValue(mockHierarchy),
        updateMixin: jest.fn().mockResolvedValue(undefined)
      })

      await setWorkflow(mockClient, project, taskTypeId, workflowId)

      expect(mockClient.updateMixin).toHaveBeenCalledWith(
        project._id,
        project._class,
        project.space,
        workflow.mixin.ProjectWorkflow,
        { workflows: { existingType: 'wf-old', [taskTypeId]: workflowId } }
      )
    })

    it('should remove workflow mapping when workflowId is null', async () => {
      const project = {
        _id: 'proj-1' as Ref<Project>,
        _class: task.class.Project,
        space: core.space.Workspace,
        name: 'Project 1',
        modifiedOn: 0,
        modifiedBy: testAccount
      } as unknown as Project

      const mockHierarchy = {
        as: jest.fn().mockReturnValue({ workflows: { [taskTypeId]: workflowId, otherType: 'wf-2' } }),
        hasMixin: jest.fn().mockReturnValue(true)
      }

      const mockClient = createMockClient({
        getHierarchy: jest.fn().mockReturnValue(mockHierarchy),
        updateMixin: jest.fn().mockResolvedValue(undefined)
      })

      await setWorkflow(mockClient, project, taskTypeId, null)

      expect(mockClient.updateMixin).toHaveBeenCalledWith(
        project._id,
        project._class,
        project.space,
        workflow.mixin.ProjectWorkflow,
        { workflows: { otherType: 'wf-2' } }
      )
    })
  })

  describe('Conflict Utilities', () => {
    const transitionOpenToInProgress: WorkflowTransition = {
      _id: 't-1' as Ref<WorkflowTransition>,
      _class: workflow.class.WorkflowTransition,
      space: core.space.Workspace,
      attachedTo: workflowId,
      attachedToClass: workflow.class.Workflow,
      collection: 'transitions',
      name: 'Start',
      from: [statusOpen],
      to: statusInProgress,
      rank: defaultRank,
      modifiedOn: 0,
      modifiedBy: testAccount
    }

    describe('findTransitionConflict', () => {
      it('should return null when target status differs', () => {
        const t1 = { from: [statusOpen], to: statusInProgress }
        const t2 = { from: [statusOpen], to: statusDone }
        expect(findTransitionConflict(t1, t2)).toBeNull()
      })

      it('should return "null" string representation when both from arrays are null or empty for same target status', () => {
        expect(findTransitionConflict({ from: null, to: statusInProgress }, { from: [], to: statusInProgress })).toBe(
          'null'
        )
        expect(findTransitionConflict({ from: null, to: statusInProgress }, { from: null, to: statusInProgress })).toBe(
          'null'
        )
        expect(findTransitionConflict({ from: [], to: statusInProgress }, { from: [], to: statusInProgress })).toBe(
          'null'
        )
      })

      it('should return null when one from is null/empty and the other is non-empty', () => {
        expect(
          findTransitionConflict({ from: null, to: statusInProgress }, { from: [statusOpen], to: statusInProgress })
        ).toBeNull()
        expect(
          findTransitionConflict({ from: [statusOpen], to: statusInProgress }, { from: null, to: statusInProgress })
        ).toBeNull()
      })

      it('should return intersecting status when target status is same and from arrays overlap', () => {
        const t1 = { from: [statusOpen, statusDone], to: statusInProgress }
        const t2 = { from: [statusOpen], to: statusInProgress }
        expect(findTransitionConflict(t1, t2)).toBe(statusOpen)
      })

      it('should return null when target status is same but from arrays do not overlap', () => {
        const t1 = { from: [statusOpen], to: statusInProgress }
        const t2 = { from: [statusDone], to: statusInProgress }
        expect(findTransitionConflict(t1, t2)).toBeNull()
      })
    })

    describe('checkConflict', () => {
      it('should return true when transition conflict exists', () => {
        const t1 = { from: [statusOpen], to: statusInProgress }
        const t2 = { from: [statusOpen], to: statusInProgress }
        expect(checkConflict(t1, t2)).toBe(true)
      })

      it('should return false when no transition conflict exists', () => {
        const t1 = { from: [statusOpen], to: statusInProgress }
        const t3 = { from: [statusDone], to: statusInProgress }
        expect(checkConflict(t1, t3)).toBe(false)
      })
    })

    describe('getTransitionConflict', () => {
      it('should find conflicting transition and matching status', () => {
        const newTrans = { from: [statusOpen], to: statusInProgress }
        const conflict = getTransitionConflict(newTrans, [transitionOpenToInProgress])

        expect(conflict).not.toBeNull()
        expect(conflict?.transition._id).toBe('t-1')
        expect(conflict?.status).toBe(statusOpen)
      })

      it('should ignore self when _id matches', () => {
        const newTrans = { _id: 't-1' as Ref<WorkflowTransition>, from: [statusOpen], to: statusInProgress }
        const conflict = getTransitionConflict(newTrans, [transitionOpenToInProgress])

        expect(conflict).toBeNull()
      })

      it('should return null when no conflict is present', () => {
        const newTrans = { from: [statusDone], to: statusInProgress }
        expect(getTransitionConflict(newTrans, [transitionOpenToInProgress])).toBeNull()
      })
    })

    describe('hasTransitionConflict', () => {
      it('should return boolean conflict state', () => {
        const newTrans1 = { from: [statusOpen], to: statusInProgress }
        const newTrans2 = { from: [statusDone], to: statusInProgress }

        expect(hasTransitionConflict(newTrans1, [transitionOpenToInProgress])).toBe(true)
        expect(hasTransitionConflict(newTrans2, [transitionOpenToInProgress])).toBe(false)
      })
    })

    describe('hasSelfTransition', () => {
      it('should identify self transitions when from array includes to status', () => {
        expect(hasSelfTransition({ from: [statusOpen, statusInProgress], to: statusInProgress })).toBe(true)
      })

      it('should return false when from array does not include to status', () => {
        expect(hasSelfTransition({ from: [statusOpen], to: statusInProgress })).toBe(false)
      })

      it('should return false when from or to is null or non-array', () => {
        expect(hasSelfTransition({ from: null, to: statusInProgress })).toBe(false)
        expect(hasSelfTransition({ from: [statusOpen], to: null as unknown as Ref<Status> })).toBe(false)
        expect(hasSelfTransition({ from: 'invalid' as unknown as Ref<Status>[], to: statusInProgress })).toBe(false)
      })
    })
  })

  describe('Screen Tab CRUD', () => {
    it('should add a screen tab with initial rank when no tabs exist', async () => {
      const mockClient = createMockClient({
        findOne: jest.fn().mockResolvedValue(null),
        addCollection: jest.fn().mockResolvedValue('tab-new-id' as Ref<ScreenTab>)
      })

      const res = await addScreenTab(mockClient, screenId, 'General')

      expect(mockClient.findOne).toHaveBeenCalledWith(
        workflow.class.ScreenTab,
        { attachedTo: screenId },
        { sort: { rank: SortingOrder.Descending } }
      )
      expect(mockClient.addCollection).toHaveBeenCalledWith(
        workflow.class.ScreenTab,
        core.space.Workspace,
        screenId,
        workflow.class.Screen,
        'tabs',
        {
          name: 'General',
          rank: defaultRank
        }
      )
      expect(res).toBe('tab-new-id')
    })

    it('should add a screen tab with incremental rank when last tab exists', async () => {
      const mockClient = createMockClient({
        findOne: jest.fn().mockResolvedValue({ rank: defaultRank }),
        addCollection: jest.fn().mockResolvedValue('tab-2-id' as Ref<ScreenTab>)
      })

      const expectedRank = makeRank(defaultRank, undefined)
      const res = await addScreenTab(mockClient, screenId, 'Custom Fields')

      expect(mockClient.addCollection).toHaveBeenCalledWith(
        workflow.class.ScreenTab,
        core.space.Workspace,
        screenId,
        workflow.class.Screen,
        'tabs',
        {
          name: 'Custom Fields',
          rank: expectedRank
        }
      )
      expect(res).toBe('tab-2-id')
    })

    it('should remove a screen tab', async () => {
      const mockClient = createMockClient({
        removeCollection: jest.fn().mockResolvedValue(undefined)
      })

      await removeScreenTab(mockClient, screenId, tabId)

      expect(mockClient.removeCollection).toHaveBeenCalledWith(
        workflow.class.ScreenTab,
        core.space.Workspace,
        tabId,
        screenId,
        workflow.class.Screen,
        'tabs'
      )
    })
  })

  describe('Screen Field CRUD', () => {
    const fieldData = {
      attribute: attrAssignee,
      fieldKey: 'assignee',
      required: true
    }

    it('should add a screen field with initial rank when no fields exist', async () => {
      const mockClient = createMockClient({
        findOne: jest.fn().mockResolvedValue(null),
        addCollection: jest.fn().mockResolvedValue('field-new-id' as Ref<ScreenField>)
      })

      const res = await addScreenField(mockClient, tabId, fieldData)

      expect(mockClient.findOne).toHaveBeenCalledWith(
        workflow.class.ScreenField,
        { attachedTo: tabId },
        { sort: { rank: SortingOrder.Descending } }
      )
      expect(mockClient.addCollection).toHaveBeenCalledWith(
        workflow.class.ScreenField,
        core.space.Workspace,
        tabId,
        workflow.class.ScreenTab,
        'fields',
        {
          ...fieldData,
          rank: defaultRank
        }
      )
      expect(res).toBe('field-new-id')
    })

    it('should add a screen field with incremental rank when last field exists', async () => {
      const mockClient = createMockClient({
        findOne: jest.fn().mockResolvedValue({ rank: defaultRank }),
        addCollection: jest.fn().mockResolvedValue('field-2-id' as Ref<ScreenField>)
      })

      const expectedRank = makeRank(defaultRank, undefined)
      const res = await addScreenField(mockClient, tabId, fieldData)

      expect(mockClient.addCollection).toHaveBeenCalledWith(
        workflow.class.ScreenField,
        core.space.Workspace,
        tabId,
        workflow.class.ScreenTab,
        'fields',
        {
          ...fieldData,
          rank: expectedRank
        }
      )
      expect(res).toBe('field-2-id')
    })

    it('should remove a screen field', async () => {
      const mockClient = createMockClient({
        removeCollection: jest.fn().mockResolvedValue(undefined)
      })

      await removeScreenField(mockClient, tabId, fieldId)

      expect(mockClient.removeCollection).toHaveBeenCalledWith(
        workflow.class.ScreenField,
        core.space.Workspace,
        fieldId,
        tabId,
        workflow.class.ScreenTab,
        'fields'
      )
    })
  })

  describe('WorkflowValue Builders & Type Guards', () => {
    const dummyFunc: WorkflowValueFunction = {
      _id: 'fn-1' as Ref<WorkflowValueFunction>,
      _class: workflow.class.WorkflowValueFunction,
      space: core.space.Workspace,
      of: task.class.Task,
      category: 'general',
      label: 'Format' as IntlString,
      type: 'transform',
      modifiedOn: 0,
      modifiedBy: testAccount
    }

    const transformCall = { func: dummyFunc._id, props: { opt: true } }

    describe('preset', () => {
      it('should create preset value without transforms', () => {
        const val = WorkflowValue.preset('$currentUser')
        expect(val).toEqual({ type: 'preset', preset: '$currentUser', functions: undefined })
        expect(isPresetValue(val)).toBe(true)
        expect(isThisValue(val)).toBe(false)
        expect(isParentValue(val)).toBe(false)
        expect(isConstValue(val)).toBe(false)
      })

      it('should create preset value with transforms', () => {
        const val = WorkflowValue.preset('$now', [transformCall])
        expect(val).toEqual({ type: 'preset', preset: '$now', functions: [transformCall] })
      })
    })

    describe('this', () => {
      const field: Field = { attribute: attrAssignee, fieldKey: 'assignee' }

      it('should create this value without transforms', () => {
        const val = WorkflowValue.this(field)
        expect(val).toEqual({ type: 'this', attribute: attrAssignee, fieldKey: 'assignee', functions: undefined })
        expect(isThisValue(val)).toBe(true)
        expect(isPresetValue(val)).toBe(false)
        expect(isParentValue(val)).toBe(false)
        expect(isConstValue(val)).toBe(false)
      })

      it('should create this value with transforms', () => {
        const val = WorkflowValue.this(field, [transformCall])
        expect(val).toEqual({ type: 'this', attribute: attrAssignee, fieldKey: 'assignee', functions: [transformCall] })
      })
    })

    describe('parent', () => {
      const field: Field = { attribute: attrAssignee, fieldKey: 'parentAssignee' }

      it('should create parent value without transforms', () => {
        const val = WorkflowValue.parent(field)
        expect(val).toEqual({
          type: 'parent',
          attribute: attrAssignee,
          fieldKey: 'parentAssignee',
          functions: undefined
        })
        expect(isParentValue(val)).toBe(true)
        expect(isPresetValue(val)).toBe(false)
        expect(isThisValue(val)).toBe(false)
        expect(isConstValue(val)).toBe(false)
      })

      it('should create parent value with transforms', () => {
        const val = WorkflowValue.parent(field, [transformCall])
        expect(val).toEqual({
          type: 'parent',
          attribute: attrAssignee,
          fieldKey: 'parentAssignee',
          functions: [transformCall]
        })
      })
    })

    describe('const', () => {
      it('should create const value without transforms', () => {
        const val = WorkflowValue.const('literal-string')
        expect(val).toEqual({ type: 'const', value: 'literal-string', functions: undefined })
        expect(isConstValue(val)).toBe(true)
        expect(isPresetValue(val)).toBe(false)
        expect(isThisValue(val)).toBe(false)
        expect(isParentValue(val)).toBe(false)
      })

      it('should create const value with object value and transforms', () => {
        const val = WorkflowValue.const({ num: 42 }, [transformCall])
        expect(val).toEqual({ type: 'const', value: { num: 42 }, functions: [transformCall] })
      })
    })
  })
})

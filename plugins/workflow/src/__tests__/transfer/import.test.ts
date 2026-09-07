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

import core, { type Ref, type Status } from '@hcengineering/core'
import { getEmbeddedLabel, type IntlString } from '@hcengineering/platform'
import task, { type TaskType } from '@hcengineering/task'

import workflow from '../../plugin'
import type { Screen, Workflow, WorkflowTransition } from '../../schema'
import { importWorkflowConfig, type WorkflowConfig } from '../../transfer'
import {
  createMockTx,
  projectTypeId,
  statusDoneId,
  statusOpenId,
  targetTaskTypeDoc,
  targetTaskTypeId,
  taskTypeId,
  workflowId,
  ws1
} from './fixtures'

describe('Workflow Import', () => {
  it('creates missing custom attributes when action is "create"', async () => {
    const client = createMockTx()
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      workflows: [
        {
          id: workflowId,
          name: 'Wf with custom field',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: [
            {
              id: 'trans-1' as Ref<WorkflowTransition>,
              name: 'Step',
              from: [statusOpenId],
              to: statusDoneId,
              validators: [
                {
                  id: 'rule-val-1',
                  rule: workflow.validator.FieldRequired,
                  ruleClass: workflow.class.WorkflowValidator,
                  props: {
                    fields: [{ fieldKey: 'missingField', attribute: 'attr-old' as any }]
                  }
                }
              ]
            }
          ]
        }
      ]
    }

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      attributeResolutions: {
        missingField: {
          action: 'create',
          label: getEmbeddedLabel('Missing Field')
        }
      }
    })

    expect(result.workflows[workflowId]).toBeDefined()
    expect(client.createDoc).toHaveBeenCalledWith(
      core.class.Attribute,
      core.space.Model,
      expect.objectContaining({
        isCustom: true
      })
    )
  })

  it('skips rules when attribute resolution action is "skip"', async () => {
    const client = createMockTx()
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      workflows: [
        {
          id: workflowId,
          name: 'Wf with skipped rule',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: [
            {
              id: 'trans-2' as Ref<WorkflowTransition>,
              name: 'Step',
              from: [statusOpenId],
              to: statusDoneId,
              validators: [
                {
                  id: 'rule-val-2',
                  rule: workflow.validator.FieldRequired,
                  ruleClass: workflow.class.WorkflowValidator,
                  props: {
                    fields: [{ fieldKey: 'fieldToSkip', attribute: 'attr-skip' as any }]
                  }
                }
              ]
            }
          ]
        }
      ]
    }

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      attributeResolutions: {
        fieldToSkip: {
          action: 'skip'
        }
      }
    })

    expect(result.workflows[workflowId]).toBeDefined()
    // Transition created without the skipped validator
    expect(client.updateCollection).not.toHaveBeenCalled()
  })

  it('handles unmapped source statuses by skipping affected transitions', async () => {
    const client = createMockTx()
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      workflows: [
        {
          id: workflowId,
          name: 'Wf with unmapped status',
          taskTypeName: 'Bug',
          taskTypeId,
          initialStatuses: [statusOpenId, 'status-qa' as Ref<Status>],
          transitions: [
            {
              id: 'trans-3' as Ref<WorkflowTransition>,
              name: 'Open -> Done',
              from: [statusOpenId],
              to: statusDoneId
            },
            {
              id: 'trans-4' as Ref<WorkflowTransition>,
              name: 'Send to QA',
              from: [statusOpenId],
              to: 'status-qa' as Ref<Status>
            },
            {
              id: 'trans-5' as Ref<WorkflowTransition>,
              name: 'QA -> Done',
              from: ['status-qa' as Ref<Status>],
              to: statusDoneId
            }
          ]
        }
      ]
    }

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      statusMap: {
        [statusOpenId]: statusOpenId,
        [statusDoneId]: statusDoneId
        // 'status-qa' is unmapped / left undefined
      }
    })

    expect(result.workflows[workflowId]).toBeDefined()
    // Only 'Open -> Done' should be created because 'QA' is not mapped
    expect(result.transitions['trans-3' as Ref<WorkflowTransition>]).toBeDefined()
    expect(result.transitions['trans-4' as Ref<WorkflowTransition>]).toBeUndefined()
    expect(result.transitions['trans-5' as Ref<WorkflowTransition>]).toBeUndefined()
  })

  it('supports redirecting transitions from unmapped statuses', async () => {
    const client = createMockTx()
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      workflows: [
        {
          id: workflowId,
          name: 'Wf with redirect',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: [
            {
              id: 'trans-6' as Ref<WorkflowTransition>,
              name: 'Send to QA',
              from: [statusOpenId],
              to: 'status-qa' as Ref<Status>
            }
          ]
        }
      ]
    }

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      statusMap: {
        [statusOpenId]: statusOpenId
      },
      transitionResolutions: {
        ['trans-6' as Ref<WorkflowTransition>]: {
          action: 'redirect',
          targetToStatusId: statusDoneId
        }
      }
    })

    expect(result.workflows[workflowId]).toBeDefined()
    expect(result.transitions['trans-6' as Ref<WorkflowTransition>]).toBeDefined()
  })

  it('creates custom attribute preserving already formatted IntlString label', async () => {
    const client = createMockTx()
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      workflows: [
        {
          id: workflowId,
          name: 'Wf Intl Label',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: [
            {
              id: 'trans-7' as Ref<WorkflowTransition>,
              name: 'Step',
              from: [statusOpenId],
              to: statusDoneId,
              validators: [
                {
                  id: 'rule-val-3',
                  rule: workflow.validator.FieldRequired,
                  ruleClass: workflow.class.WorkflowValidator,
                  props: {
                    fields: [{ fieldKey: 'intlField', attribute: 'attr-intl' as any }]
                  }
                }
              ]
            }
          ]
        }
      ]
    }

    await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      attributeResolutions: {
        intlField: {
          action: 'create',
          label: 'plugin:string:AlreadyFormatted' as IntlString
        }
      }
    })

    expect(client.createDoc).toHaveBeenCalledWith(
      core.class.Attribute,
      core.space.Model,
      expect.objectContaining({
        label: 'plugin:string:AlreadyFormatted',
        isCustom: true
      })
    )
  })

  it('adapts screen targetClass to targetTaskType targetClass during import', async () => {
    const client = createMockTx()
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      screens: [
        {
          id: 'screen-1' as Ref<Screen>,
          name: 'Resolution Screen',
          targetClass: 'old:class:Doc' as any,
          tabs: [
            {
              name: 'Main',
              fields: [{ attribute: 'attr-1' as any, fieldKey: 'f1', required: true }]
            }
          ]
        }
      ],
      workflows: [
        {
          id: workflowId,
          name: 'Wf with Screen',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: [
            {
              id: 'trans-8' as Ref<WorkflowTransition>,
              name: 'Resolve',
              from: [statusOpenId],
              to: statusDoneId
            }
          ]
        }
      ]
    }

    await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      copyScreens: true
    })

    expect(client.createDoc).toHaveBeenCalledWith(
      workflow.class.Screen,
      core.space.Workspace,
      expect.objectContaining({
        name: 'Resolution Screen',
        targetClass: targetTaskTypeDoc.targetClass ?? task.class.Task
      })
    )
  })

  it('generates unique screen name if screen with same name already exists', async () => {
    const existingScreen: Screen = {
      _id: 'existing-screen-1' as Ref<Screen>,
      _class: workflow.class.Screen,
      name: 'Resolution Screen',
      projectType: projectTypeId,
      targetClass: task.class.Task,
      space: core.space.Workspace,
      modifiedOn: 0,
      modifiedBy: '' as any
    }

    const client = createMockTx({ docs: [existingScreen] })
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      screens: [
        {
          id: 'screen-2' as Ref<Screen>,
          name: 'Resolution Screen',
          targetClass: task.class.Task,
          tabs: [{ name: 'Main', fields: [] }]
        }
      ],
      workflows: [
        {
          id: workflowId,
          name: 'Wf with duplicate screen name',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: []
        }
      ]
    }

    await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      copyScreens: true
    })

    expect(client.createDoc).toHaveBeenCalledWith(
      workflow.class.Screen,
      core.space.Workspace,
      expect.objectContaining({
        name: 'Resolution Screen (1)'
      })
    )
  })

  it('reuses existing screen if signature matches when resolution is undefined', async () => {
    const existingScreen: Screen = {
      _id: 'existing-screen-1' as Ref<Screen>,
      _class: workflow.class.Screen,
      name: 'Resolution Screen',
      projectType: projectTypeId,
      targetClass: task.class.Task,
      space: core.space.Workspace,
      modifiedOn: 0,
      modifiedBy: '' as any
    }

    const client = createMockTx({ docs: [existingScreen] })
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      screens: [
        {
          id: 'screen-2' as Ref<Screen>,
          name: 'Resolution Screen',
          targetClass: task.class.Task,
          tabs: []
        }
      ],
      workflows: [
        {
          id: workflowId,
          name: 'Wf with matching screen',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: []
        }
      ]
    }

    const res = await importWorkflowConfig(client, projectTypeId, config)
    expect(res.screens['screen-2' as Ref<Screen>]).toBe('existing-screen-1')
    expect(client.createDoc).not.toHaveBeenCalledWith(workflow.class.Screen, core.space.Workspace, expect.anything())
  })

  it('reuses existing screen if signature matches even with different name', async () => {
    const existingScreen: Screen = {
      _id: 'existing-screen-1' as Ref<Screen>,
      _class: workflow.class.Screen,
      name: 'Custom Screen Name',
      projectType: projectTypeId,
      targetClass: task.class.Task,
      space: core.space.Workspace,
      modifiedOn: 0,
      modifiedBy: '' as any
    }

    const client = createMockTx({ docs: [existingScreen] })
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      screens: [
        {
          id: 'screen-2' as Ref<Screen>,
          name: 'Different Name',
          targetClass: task.class.Task,
          tabs: []
        }
      ],
      workflows: [
        {
          id: workflowId,
          name: 'Wf with matching signature screen',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: []
        }
      ]
    }

    const res = await importWorkflowConfig(client, projectTypeId, config)
    expect(res.screens['screen-2' as Ref<Screen>]).toBe('existing-screen-1')
  })

  it('prefers screen with matching name when multiple screens match signature', async () => {
    const screenA: Screen = {
      _id: 'screen-a' as Ref<Screen>,
      _class: workflow.class.Screen,
      name: 'Alpha Screen',
      projectType: projectTypeId,
      targetClass: task.class.Task,
      space: core.space.Workspace,
      modifiedOn: 0,
      modifiedBy: '' as any
    }
    const screenB: Screen = {
      _id: 'screen-b' as Ref<Screen>,
      _class: workflow.class.Screen,
      name: 'Beta Screen',
      projectType: projectTypeId,
      targetClass: task.class.Task,
      space: core.space.Workspace,
      modifiedOn: 0,
      modifiedBy: '' as any
    }

    const client = createMockTx({ docs: [screenA, screenB] })
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      screens: [
        {
          id: 'screen-req' as Ref<Screen>,
          name: 'Beta Screen',
          targetClass: task.class.Task,
          tabs: []
        }
      ],
      workflows: [
        {
          id: workflowId,
          name: 'Wf with name preference',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: []
        }
      ]
    }

    const res = await importWorkflowConfig(client, projectTypeId, config)
    expect(res.screens['screen-req' as Ref<Screen>]).toBe('screen-b')
  })

  it('remaps target and source attribute references in UpdateFieldValue post-function', async () => {
    const client = createMockTx()
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      workflows: [
        {
          id: workflowId,
          name: 'Wf with UpdateFieldValue',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: [
            {
              id: 'trans-update' as Ref<WorkflowTransition>,
              name: 'Apply',
              from: [statusOpenId],
              to: statusOpenId,
              postFunctions: [
                {
                  id: 'post-fn-1',
                  rule: workflow.postFunction.UpdateFieldValue,
                  ruleClass: workflow.class.WorkflowPostFunction,
                  props: {
                    fields: [
                      {
                        attribute: 'attr-source-target' as any,
                        fieldKey: 'targetField',
                        value: {
                          type: 'this',
                          attribute: 'attr-source-src' as any,
                          fieldKey: 'sourceField'
                        }
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
    }

    const targetAttr1 = 'attr-mapped-target' as any
    const targetAttr2 = 'attr-mapped-source' as any

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      attributeResolutions: {
        targetField: { action: 'map', targetAttributeId: targetAttr1 },
        sourceField: { action: 'map', targetAttributeId: targetAttr2 }
      }
    })

    expect(result.workflows[workflowId]).toBeDefined()
    expect(client.updateCollection).toHaveBeenCalledWith(
      workflow.class.WorkflowTransition,
      core.space.Workspace,
      expect.anything(),
      expect.anything(),
      workflow.class.Workflow,
      'transitions',
      expect.objectContaining({
        postFunctions: [
          expect.objectContaining({
            props: {
              fields: [
                expect.objectContaining({
                  attribute: targetAttr1,
                  value: expect.objectContaining({
                    attribute: targetAttr2
                  })
                })
              ]
            }
          })
        ]
      })
    )
  })

  it('restores project workflow bindings from config.projects', async () => {
    const projectDoc = {
      _id: 'proj-1' as any,
      _class: task.class.Project,
      name: 'Mobile App',
      identifier: 'MOB',
      type: projectTypeId,
      space: core.space.Workspace,
      modifiedOn: 0,
      modifiedBy: '' as any
    }

    const client = createMockTx({ docs: [projectDoc] })
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      workflows: [
        {
          id: workflowId,
          name: 'Bug Workflow',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: []
        }
      ],
      projects: [
        {
          project: 'proj-1' as any,
          identifier: 'MOB',
          workflows: {
            Bug: 'Bug Workflow'
          }
        }
      ]
    }

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId
    })

    expect(result.workflows[workflowId]).toBeDefined()
  })

  it('drops transitions when source or target status has no mapped replacement in resolution', async () => {
    const statusAId = 'status-a' as Ref<Status>
    const statusBId = 'status-b' as Ref<Status>
    const statusUnmappedId = 'status-unmapped' as Ref<Status>

    const client = createMockTx({
      docs: [
        { _id: statusAId, _class: core.class.Status, name: 'StatusA' } as any,
        { _id: statusBId, _class: core.class.Status, name: 'StatusB' } as any
      ]
    })

    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      workflows: [
        {
          id: 'wf-test' as Ref<Workflow>,
          name: 'Wf Drop Transition Test',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: [
            {
              id: 'trans-valid' as Ref<WorkflowTransition>,
              name: 'Valid Transition',
              from: [statusAId],
              to: statusBId
            },
            {
              id: 'trans-unmapped-from' as Ref<WorkflowTransition>,
              name: 'Unmapped From Transition',
              from: [statusUnmappedId],
              to: statusBId
            },
            {
              id: 'trans-unmapped-to' as Ref<WorkflowTransition>,
              name: 'Unmapped To Transition',
              from: [statusAId],
              to: statusUnmappedId
            }
          ]
        }
      ]
    }

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      statusMap: {
        [statusAId]: statusAId,
        [statusBId]: statusBId
        // statusUnmappedId is explicitly not mapped
      }
    })

    expect(result.transitions['trans-valid' as Ref<WorkflowTransition>]).toBeDefined()
    expect(result.transitions['trans-unmapped-from' as Ref<WorkflowTransition>]).toBeUndefined()
    expect(result.transitions['trans-unmapped-to' as Ref<WorkflowTransition>]).toBeUndefined()
  })

  it('throws error on unresolved rule references in importRules', async () => {
    const client = createMockTx()
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      workflows: [
        {
          id: workflowId,
          name: 'Wf with Unresolved Token',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: [
            {
              id: 'trans-unresolved' as Ref<WorkflowTransition>,
              name: 'Step',
              from: [statusOpenId],
              to: statusOpenId,
              validators: [
                {
                  id: 'rule-unresolved',
                  rule: workflow.validator.FieldRequired,
                  ruleClass: workflow.class.WorkflowValidator,
                  props: {
                    missingStatus: '$status:NonExistentStatus'
                  }
                }
              ]
            }
          ]
        }
      ]
    }

    await expect(importWorkflowConfig(client, projectTypeId, config, { targetTaskTypeId })).rejects.toThrow(
      'Workflow import: could not resolve rule references: $status:NonExistentStatus'
    )
  })

  it('correctly maps task type tokens in SubtaskStatus validator', async () => {
    const bugTaskTypeId = 'bug-tt-id' as Ref<TaskType>
    const storyTaskTypeId = 'story-tt-id' as Ref<TaskType>
    const statusDoneId = 'status-done' as Ref<Status>

    const client = createMockTx({
      docs: [
        { _id: bugTaskTypeId, _class: task.class.TaskType, name: 'Bug', parent: 'other-project-type' as any } as any,
        {
          _id: storyTaskTypeId,
          _class: task.class.TaskType,
          name: 'Story',
          parent: 'other-project-type' as any
        } as any,
        { _id: statusDoneId, _class: core.class.Status, name: 'Done' } as any
      ]
    })

    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      statuses: [{ id: statusDoneId, name: 'Done', color: 1, category: 'cat-done' as any }],
      workflows: [
        {
          id: 'wf-with-subtask-status' as Ref<Workflow>,
          name: 'Wf with Subtask Validator',
          taskTypeName: 'Bug',
          taskTypeId: bugTaskTypeId,
          transitions: [
            {
              id: 'trans-subtask' as Ref<WorkflowTransition>,
              name: 'Resolve',
              from: [statusDoneId],
              to: statusDoneId,
              validators: [
                {
                  id: 'rule-subtask',
                  rule: workflow.validator.SubtaskStatus,
                  ruleClass: workflow.class.WorkflowValidator,
                  props: {
                    statuses: {
                      '$taskType:Bug': ['$status:Done'],
                      '$taskType:Story': ['$status:Done']
                    }
                  }
                }
              ]
            }
          ]
        }
      ]
    }

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      statusMap: { [statusDoneId]: statusDoneId }
    })
    expect(result.workflows['wf-with-subtask-status' as Ref<Workflow>]).toBeDefined()
  })

  it('creates missing mixins and mixin attributes on import', async () => {
    const client = createMockTx()
    const mixinId = 'mixin-1' as any
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      mixins: [
        {
          id: mixinId,
          label: getEmbeddedLabel('Custom Mixin'),
          attributes: [
            {
              id: 'attr-m-1' as any,
              name: 'mixinField',
              label: getEmbeddedLabel('Mixin Field'),
              type: { _class: core.class.TypeString, label: getEmbeddedLabel('String') },
              isCustom: true
            }
          ]
        }
      ],
      screens: [
        {
          id: 'screen-1' as any,
          name: 'Screen with Mixin',
          targetClass: 'tracker:class:Issue' as any,
          tabs: [
            {
              name: 'General',
              fields: [
                {
                  attribute: 'attr-m-1' as any,
                  fieldKey: 'mixinField',
                  mixin: mixinId,
                  required: false
                }
              ]
            }
          ]
        }
      ],
      workflows: [
        {
          id: workflowId,
          name: 'Bug Workflow',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: []
        }
      ]
    }

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId
    })

    expect(result.workflows[workflowId]).toBeDefined()
    expect(client.createDoc).toHaveBeenCalledWith(
      core.class.Mixin,
      core.space.Model,
      expect.objectContaining({
        label: getEmbeddedLabel('Custom Mixin')
      }),
      expect.any(String)
    )
    expect(client.createDoc).toHaveBeenCalledWith(
      core.class.Attribute,
      core.space.Model,
      expect.objectContaining({
        isCustom: true
      })
    )
  })

  it('handles screen resolution actions (copy, replace, skip)', async () => {
    const client = createMockTx()
    const screenId1 = 'screen-1' as any
    const screenId2 = 'screen-2' as any
    const existingScreenId = 'screen-existing' as any

    ;(client.findAll as jest.Mock).mockImplementation(async (_cls: any, query: any) => {
      if (_cls === workflow.class.Screen) {
        return [
          {
            _id: existingScreenId,
            name: 'Existing Screen',
            projectType: projectTypeId,
            targetClass: 'tracker:class:Issue'
          }
        ]
      }
      return []
    })

    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      screens: [
        {
          id: screenId1,
          name: 'Existing Screen',
          targetClass: 'tracker:class:Issue' as any,
          tabs: [{ name: 'General', fields: [] }]
        },
        {
          id: screenId2,
          name: 'Skipped Screen',
          targetClass: 'tracker:class:Issue' as any,
          tabs: [{ name: 'Details', fields: [] }]
        }
      ],
      workflows: [
        {
          id: workflowId,
          name: 'Test Workflow',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: []
        }
      ]
    }

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      screenResolutions: {
        [screenId1]: { action: 'copy', targetScreenId: existingScreenId },
        [screenId2]: { action: 'skip' }
      }
    })

    expect(result.screens[screenId1]).toBe(existingScreenId)
    expect(result.screens[screenId2]).toBeUndefined()
    expect(client.createDoc).not.toHaveBeenCalledWith(
      workflow.class.Screen,
      core.space.Workspace,
      expect.objectContaining({ name: 'Screen 1' })
    )
  })

  it('auto-creates custom attributes with exact key from import', async () => {
    const client = createMockTx()
    const customKey = 'my_custom_field'
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      attributes: [
        {
          id: 'attr-custom-1' as any,
          name: customKey,
          label: getEmbeddedLabel('My Custom Field'),
          type: { _class: core.class.TypeString, label: getEmbeddedLabel('String') },
          isCustom: true
        }
      ],
      workflows: [
        {
          id: workflowId,
          name: 'Wf with custom key',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: []
        }
      ]
    }

    await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId
    })

    expect(client.createDoc).toHaveBeenCalledWith(
      core.class.Attribute,
      core.space.Model,
      expect.objectContaining({
        name: customKey,
        isCustom: true
      })
    )
  })

  it('binds to existing attribute when key and type match', async () => {
    const client = createMockTx()
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      attributes: [
        {
          id: 'attr-assignee' as any,
          name: 'assignee',
          label: getEmbeddedLabel('Assignee'),
          type: { _class: core.class.RefTo, to: core.class.Doc, label: getEmbeddedLabel('Doc') } as any,
          isCustom: false
        }
      ],
      workflows: [
        {
          id: workflowId,
          name: 'Wf with existing assignee',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: []
        }
      ]
    }

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId
    })

    expect(result.workflows[workflowId]).toBeDefined()
    // Should NOT create doc for assignee attribute because it already exists
    expect(client.createDoc).not.toHaveBeenCalledWith(
      core.class.Attribute,
      core.space.Model,
      expect.objectContaining({ name: 'assignee' })
    )
  })

  it('does not create attribute when action is "skip" and strips related rule fields', async () => {
    const client = createMockTx()
    const customKey = 'skipped_field'
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      attributes: [
        {
          id: 'attr-skipped' as any,
          name: customKey,
          label: getEmbeddedLabel('Skipped Field'),
          type: { _class: core.class.TypeString, label: getEmbeddedLabel('String') },
          isCustom: true
        }
      ],
      workflows: [
        {
          id: workflowId,
          name: 'Wf with skipped field',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: [
            {
              id: 'trans-skip-1' as Ref<WorkflowTransition>,
              name: 'Step With Skipped Field',
              from: [statusOpenId],
              to: statusDoneId,
              validators: [
                {
                  id: 'rule-val-skip',
                  rule: workflow.validator.FieldRequired,
                  ruleClass: workflow.class.WorkflowValidator,
                  props: {
                    fields: [
                      {
                        attribute: 'attr-skipped' as any,
                        fieldKey: customKey
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
    }

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      attributeResolutions: {
        [customKey]: { action: 'skip' }
      }
    })

    expect(result.workflows[workflowId]).toBeDefined()
    // Should NOT create doc for skipped field
    expect(client.createDoc).not.toHaveBeenCalledWith(
      core.class.Attribute,
      core.space.Model,
      expect.objectContaining({ name: customKey })
    )
  })

  it('does not create attribute when it is only used in a screen that is skipped', async () => {
    const client = createMockTx()
    const screenOnlyKey = 'screen_only_field'
    const screenId = 'screen-1' as Ref<Screen>
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      screens: [
        {
          id: screenId,
          name: 'My Screen',
          targetClass: task.class.Task,
          tabs: [
            {
              name: 'General',
              fields: [
                {
                  attribute: 'attr-screen-only' as any,
                  fieldKey: screenOnlyKey,
                  required: false
                }
              ]
            }
          ]
        }
      ],
      attributes: [
        {
          id: 'attr-screen-only' as any,
          name: screenOnlyKey,
          label: getEmbeddedLabel('Screen Only Field'),
          type: { _class: core.class.TypeString, label: getEmbeddedLabel('String') },
          isCustom: true
        }
      ],
      workflows: [
        {
          id: workflowId,
          name: 'Wf with screen only field',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: []
        }
      ]
    }

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      screenResolutions: {
        [screenId]: { action: 'skip' }
      }
    })

    expect(result.workflows[workflowId]).toBeDefined()
    // Attribute should NOT be created because the only screen using it was skipped
    expect(client.createDoc).not.toHaveBeenCalledWith(
      core.class.Attribute,
      core.space.Model,
      expect.objectContaining({ name: screenOnlyKey })
    )
  })

  it('creates custom enum and binds EnumOf attribute when importing workflow with custom enum', async () => {
    const client = createMockTx()
    const enumFieldKey = 'select-color'
    const config: WorkflowConfig = {
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: ws1,
      projectTypeId,
      enums: [
        {
          id: 'old-enum-id' as any,
          name: 'Colors',
          enumValues: ['Red', 'Green', 'Blue']
        }
      ],
      attributes: [
        {
          id: 'attr-enum-1' as any,
          name: enumFieldKey,
          label: getEmbeddedLabel('Color Selection'),
          type: { _class: core.class.EnumOf, of: 'old-enum-id' } as any,
          enumName: 'Colors',
          enumValues: ['Red', 'Green', 'Blue'],
          isCustom: true
        }
      ],
      workflows: [
        {
          id: workflowId,
          name: 'Wf with Enum',
          taskTypeName: 'Bug',
          taskTypeId,
          transitions: [
            {
              id: 'trans-1' as Ref<WorkflowTransition>,
              name: 'Step',
              from: [statusOpenId],
              to: statusDoneId,
              validators: [
                {
                  id: 'rule-val-1',
                  rule: workflow.validator.FieldRequired,
                  ruleClass: workflow.class.WorkflowValidator,
                  props: {
                    fields: [{ fieldKey: enumFieldKey, attribute: 'attr-enum-1' as any }]
                  }
                }
              ]
            }
          ]
        }
      ]
    }

    const result = await importWorkflowConfig(client, projectTypeId, config, {
      targetTaskTypeId,
      attributeResolutions: {
        [enumFieldKey]: {
          action: 'create',
          label: getEmbeddedLabel('Color Selection')
        }
      }
    })

    expect(result.workflows[workflowId]).toBeDefined()
    expect(client.createDoc).toHaveBeenCalledWith(
      core.class.Enum,
      core.space.Model,
      expect.objectContaining({
        name: 'Colors',
        enumValues: ['Red', 'Green', 'Blue']
      })
    )
    expect(client.createDoc).toHaveBeenCalledWith(
      core.class.Attribute,
      core.space.Model,
      expect.objectContaining({
        name: enumFieldKey,
        type: expect.objectContaining({
          _class: core.class.EnumOf
        })
      })
    )
  })

  it('atomically commits transactions on success and does not commit on error', async () => {
    const client = createMockTx()

    const config: WorkflowConfig = {
      version: 1,
      exportDate: new Date().toISOString(),
      workspace: ws1,
      projectTypeId,
      workflows: [
        {
          id: workflowId,
          name: 'Atomic Wf',
          taskTypeName: 'Bug',
          taskTypeId
        }
      ]
    }

    await importWorkflowConfig(client, projectTypeId, config)
    expect((client as any).commit).toHaveBeenCalledTimes(1)

    // On error, commit must not be called
    const failingConfig: WorkflowConfig = {
      version: 1,
      exportDate: new Date().toISOString(),
      workspace: ws1,
      projectTypeId,
      workflows: [
        {
          id: 'invalid-wf' as any,
          name: 'Failing Wf',
          taskTypeName: 'NonExistentTaskType',
          taskTypeId: 'non-existent' as any
        }
      ]
    }

    const failingClient = createMockTx()
    await expect(importWorkflowConfig(failingClient, projectTypeId, failingConfig)).rejects.toThrow()
    expect((failingClient as any).commit).not.toHaveBeenCalled()
  })
})

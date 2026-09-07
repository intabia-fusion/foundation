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

import core, { ClassifierKind, type Ref, type WorkspaceUuid } from '@hcengineering/core'
import type { IntlString } from '@hcengineering/platform'

import { ProjectType, TaskType, exportTaskTypeConfig } from '../../index'
import { TaskTypeConfigVersion } from '../../transfer'

describe('Export transfer helpers (export.ts)', () => {
  const projectType1 = 'proj-1' as Ref<ProjectType>
  const ws1 = 'ws-1' as WorkspaceUuid

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
    allowedAsChildOf: ['epic' as Ref<TaskType>, 'issue' as Ref<TaskType>],
    targetClass: 'tracker:class:Issue' as any,
    statuses: ['st-open', 'st-done'] as any,
    statusCategories: ['cat-1', 'cat-2'] as any
  } as any as TaskType

  const subtask = {
    _id: 'subtask' as Ref<TaskType>,
    parent: projectType1,
    name: 'Subtask',
    isRootTaskType: false,
    allowedAsChildOf: ['issue' as Ref<TaskType>],
    targetClass: 'tracker:class:Subtask' as any,
    statuses: ['st-open'] as any
  } as any as TaskType

  const bug = {
    _id: 'bug' as Ref<TaskType>,
    parent: projectType1,
    name: 'Bug',
    isRootTaskType: true,
    allowAnyParent: true
  } as any as TaskType

  const mockClient = {
    findAll: jest.fn().mockImplementation(async (clazz: any) => {
      if (clazz === 'task:class:TaskType') {
        return [epic, issue, subtask, bug]
      }
      if (clazz === 'core:class:Status') {
        return [
          { _id: 'st-open', name: 'Open', color: 1, category: 'UnStarted' },
          { _id: 'st-done', name: 'Done', color: 2, category: 'Done' }
        ]
      }
      if (clazz === 'core:class:Attribute') {
        return [
          {
            _id: 'attr-1',
            name: 'priority',
            label: 'Priority',
            type: { _class: 'core:class:TypeString' },
            required: true
          }
        ]
      }
      if (clazz === 'core:class:Class') {
        return []
      }
      return []
    })
  } as any

  it('exports single task type config', async () => {
    const config = await exportTaskTypeConfig(mockClient, [issue], {
      mode: 'single',
      taskTypeName: 'Issue',
      taskTypeId: 'issue' as Ref<TaskType>,
      workspace: ws1
    })

    expect(config.version).toBe(TaskTypeConfigVersion)
    expect(config.mode).toBe('single')
    expect(config.taskTypeName).toBe('Issue')
    expect(config.taskTypeId).toBe('issue')
    expect(config.workspace).toBe(ws1)
    expect(config.projectTypeId).toBe(projectType1)
    expect(config.taskTypes.length).toBe(1)
    expect(config.taskTypes[0].id).toBe('issue')
    expect(config.taskTypes[0].name).toBe('Issue')
    expect(config.taskTypes[0].allowedAsChildOf).toEqual(['epic', 'issue'])
    expect(config.taskTypes[0].statuses).toEqual([
      { id: 'st-open', name: 'Open', color: 1, category: 'UnStarted' },
      { id: 'st-done', name: 'Done', color: 2, category: 'Done' }
    ])
    expect(config.taskTypes[0].attributes).toEqual([
      {
        id: 'attr-1',
        name: 'priority',
        label: 'Priority',
        type: { _class: 'core:class:TypeString' },
        required: true,
        defaultValue: undefined,
        enumName: undefined,
        enumValues: undefined,
        icon: undefined,
        color: undefined
      }
    ])
  })

  it('exports hierarchy with exclusions', async () => {
    const config = await exportTaskTypeConfig(mockClient, [epic, issue], {
      mode: 'hierarchy',
      taskTypeName: 'Issue',
      taskTypeId: 'issue' as Ref<TaskType>,
      workspace: 'test-workspace-uuid' as WorkspaceUuid,
      projectTypeId: projectType1
    })

    expect(config.workspace).toBe('test-workspace-uuid')
    expect(config.projectTypeId).toBe(projectType1)
    expect(config.taskTypes.length).toBe(2)
    const epicCfg = config.taskTypes.find((t) => t.id === 'epic')
    const issueCfg = config.taskTypes.find((t) => t.id === 'issue')

    expect(epicCfg).toBeDefined()
    expect(issueCfg).toBeDefined()
    expect(issueCfg?.allowedAsChildOf).toEqual(['epic', 'issue'])
  })

  it('exports task type with custom mixins and mixin attributes', async () => {
    const mixinMockClient = {
      findAll: jest.fn().mockImplementation(async (clazz: any, query: any) => {
        if (clazz === core.class.Class && query?.kind === ClassifierKind.MIXIN) {
          return [
            {
              _id: 'custom-mixin-1',
              label: 'Custom Mixin' as IntlString,
              extends: 'tracker:class:Issue'
            }
          ]
        }
        if (clazz === core.class.Attribute) {
          return [
            {
              _id: 'attr-mixin-1',
              attributeOf: 'custom-mixin-1',
              name: 'custom_text',
              label: 'Custom Text' as IntlString,
              type: { _class: 'core:class:TypeString' }
            }
          ]
        }
        if (clazz === core.class.Status) {
          return [{ _id: 'st-open', name: 'Open', color: 1, category: 'UnStarted' }]
        }
        return []
      })
    } as any

    const config = await exportTaskTypeConfig(mixinMockClient, [issue], {
      mode: 'single',
      taskTypeName: 'Issue',
      taskTypeId: 'issue' as Ref<TaskType>,
      workspace: ws1
    })

    expect(config.taskTypes[0].mixins).toBeDefined()
    expect(config.taskTypes[0].mixins?.length).toBe(1)
    expect(config.taskTypes[0].mixins?.[0].label).toBe('Custom Mixin')
    expect(config.taskTypes[0].mixins?.[0].attributes).toEqual([
      {
        id: 'attr-mixin-1',
        name: 'custom_text',
        label: 'Custom Text',
        type: { _class: 'core:class:TypeString' },
        required: undefined,
        defaultValue: undefined,
        enumName: undefined,
        enumValues: undefined,
        icon: undefined,
        color: undefined
      }
    ])
  })

  it('exports task type and preserves allowedAsChildOf even if parent is not in exported selection', async () => {
    const isolated = {
      _id: 'isolated' as Ref<TaskType>,
      parent: projectType1,
      name: 'Isolated',
      allowedAsChildOf: ['unselected-parent' as Ref<TaskType>],
      targetClass: 'target:class:Isolated' as any
    } as any as TaskType

    const emptyMockClient = {
      findAll: jest.fn().mockResolvedValue([])
    } as any

    const config = await exportTaskTypeConfig(emptyMockClient, [isolated], {
      mode: 'single',
      taskTypeName: 'Isolated',
      taskTypeId: 'isolated' as Ref<TaskType>,
      workspace: ws1
    })

    expect(config.taskTypes[0].allowedAsChildOf).toEqual(['unselected-parent'])
    expect(config.taskTypes[0].statusCategories).toEqual([])
    expect(config.taskTypes[0].attributes).toBeUndefined()
    expect(config.taskTypes[0].mixins).toBeUndefined()
  })
})

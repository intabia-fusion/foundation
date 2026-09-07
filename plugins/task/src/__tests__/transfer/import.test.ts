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
  type PropertyType,
  type Ref,
  type Status,
  type StatusCategory,
  type Type,
  type WorkspaceUuid
} from '@hcengineering/core'
import type { Asset, IntlString } from '@hcengineering/platform'
import setting from '@hcengineering/setting'
import task, { ProjectType, TaskType, type TaskTypeExportConfig, importTaskTypeConfig } from '../../index'

describe('Import transfer helpers (import.ts)', () => {
  const projectType1 = 'proj-1' as Ref<ProjectType>
  const ws1 = 'ws-1' as WorkspaceUuid

  const stringType: Type<PropertyType> = {
    icon: 'core:icon:TypeString' as Asset,
    label: 'core:string:String' as IntlString,
    _class: 'core:class:TypeString' as any
  }

  const singleEnumType: Type<PropertyType> = {
    _class: 'core:class:EnumOf' as any,
    label: 'core:string:Enum' as IntlString,
    icon: 'core:icon:TypeEnumOf' as Asset,
    of: '6a9170a4e3666958ff9bc46f' as any
  } as any

  it('imports single task type into project type', async () => {
    const createdDocs: any[] = []
    const updatedDocs: any[] = []

    const mockClient = {
      findOne: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === task.class.ProjectType) {
          return {
            _id: projectType1,
            name: 'Classic Project',
            tasks: [],
            statuses: []
          }
        }
        return undefined
      }),
      findAll: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === 'task:class:TaskType') {
          return []
        }
        if (clazz === 'core:class:Enum') {
          return []
        }
        return []
      }),
      getHierarchy: jest.fn().mockReturnValue({
        findClass: jest.fn().mockReturnValue({ icon: 'icon' }),
        getAttribute: jest.fn().mockReturnValue({ _id: 'status-attr' }),
        getAllAttributes: jest.fn().mockReturnValue(new Map())
      }),
      createDoc: jest.fn().mockImplementation(async (clazz: any, space: any, data: any, id?: any) => {
        const doc = { _id: id ?? 'id-' + createdDocs.length, _class: clazz, ...data }
        createdDocs.push(doc)
        return doc._id
      }),
      createMixin: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockImplementation(async (doc: any, update: any) => {
        updatedDocs.push({ doc, update })
        return doc
      })
    } as any

    const config: TaskTypeExportConfig = {
      version: 1,
      exportDate: new Date().toISOString(),
      mode: 'single',
      taskTypeName: 'Issue',
      taskTypeId: 'issue-id' as Ref<TaskType>,
      workspace: ws1,
      projectTypeId: projectType1,
      taskTypes: [
        {
          id: 'issue-id' as Ref<TaskType>,
          name: 'Issue',
          descriptor: 'desc' as any,
          ofClass: 'tracker:class:Issue' as any,
          statusCategories: ['cat-1' as Ref<StatusCategory>, 'cat-2' as Ref<StatusCategory>],
          statuses: [
            { id: 'st-1' as Ref<Status>, name: 'Open', color: 1, category: 'UnStarted' as any },
            { id: 'st-2' as Ref<Status>, name: 'Done', color: 2, category: 'Done' as any }
          ],
          attributes: [
            {
              id: 'attr-1' as any,
              name: 'priority',
              label: 'Priority' as IntlString,
              type: stringType,
              required: true
            }
          ]
        }
      ]
    }

    const result = await importTaskTypeConfig(mockClient, projectType1, config)
    expect(result.createdCount).toBe(1)
    expect(result.importedTaskTypes.length).toBe(1)
    expect(result.importedTaskTypes[0].name).toBe('Issue')

    // Verify task type class was created
    const createdClass = createdDocs.find((d) => d._class === core.class.Class)
    expect(createdClass).toBeDefined()
    expect(createdClass.extends).toBe('tracker:class:Issue')

    // Verify attribute was created
    const createdAttr = createdDocs.find((d) => d._class === core.class.Attribute)
    expect(createdAttr).toBeDefined()
    expect(createdAttr.name).toBe('priority')
    expect(createdAttr.required).toBe(true)

    // Verify projectType was updated
    expect(updatedDocs.length).toBeGreaterThan(0)
    const ptUpdate = updatedDocs.find((u) => u.doc._id === projectType1)
    expect(ptUpdate).toBeDefined()
    expect(ptUpdate.update.tasks).toContain(result.importedTaskTypes[0]._id)
  })

  it('respects selective inclusion via selectedTypeNames', async () => {
    const createdDocs: any[] = []
    const mockClient = {
      findOne: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === task.class.ProjectType) {
          return {
            _id: projectType1,
            name: 'Classic Project',
            tasks: [],
            statuses: []
          }
        }
        return undefined
      }),
      findAll: jest.fn().mockResolvedValue([]),
      getHierarchy: jest.fn().mockReturnValue({
        findClass: jest.fn().mockReturnValue({ icon: 'icon' }),
        getAttribute: jest.fn().mockReturnValue({ _id: 'status-attr' }),
        getAllAttributes: jest.fn().mockReturnValue(new Map())
      }),
      createDoc: jest.fn().mockImplementation(async (clazz: any, space: any, data: any, id?: any) => {
        const doc = { _id: id ?? 'id-' + createdDocs.length, _class: clazz, ...data }
        createdDocs.push(doc)
        return doc._id
      }),
      createMixin: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockResolvedValue(true)
    } as any

    const config: TaskTypeExportConfig = {
      version: 1,
      exportDate: new Date().toISOString(),
      mode: 'hierarchy',
      taskTypeName: 'Epic',
      taskTypeId: 'epic-id' as Ref<TaskType>,
      workspace: ws1,
      projectTypeId: projectType1,
      taskTypes: [
        {
          id: 'epic-id' as Ref<TaskType>,
          name: 'Epic',
          descriptor: 'desc' as any,
          ofClass: 'tracker:class:Issue' as any,
          statusCategories: [],
          statuses: []
        },
        {
          id: 'issue-id' as Ref<TaskType>,
          name: 'Issue',
          descriptor: 'desc' as any,
          ofClass: 'tracker:class:Issue' as any,
          statusCategories: [],
          statuses: []
        }
      ]
    }

    const result = await importTaskTypeConfig(mockClient, projectType1, config, {
      selectedTypeNames: ['Issue']
    })

    expect(result.createdCount).toBe(1)
    expect(result.importedTaskTypes.length).toBe(1)
    expect(result.importedTaskTypes[0].name).toBe('Issue')
  })

  it('generates new unique task type ID and preserves status IDs', async () => {
    const createdDocs: any[] = []
    const mockClient = {
      findOne: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === task.class.ProjectType) {
          return {
            _id: projectType1,
            name: 'Classic Project',
            tasks: [],
            statuses: []
          }
        }
        return undefined
      }),
      findAll: jest.fn().mockResolvedValue([]),
      getHierarchy: jest.fn().mockReturnValue({
        findClass: jest.fn().mockReturnValue({ icon: 'icon' }),
        getAttribute: jest.fn().mockReturnValue({ _id: 'status-attr' }),
        getAllAttributes: jest.fn().mockReturnValue(new Map())
      }),
      createDoc: jest.fn().mockImplementation(async (clazz: any, space: any, data: any, id?: any) => {
        const doc = { _id: id ?? 'id-' + createdDocs.length, _class: clazz, ...data }
        createdDocs.push(doc)
        return doc._id
      }),
      createMixin: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockResolvedValue(true)
    } as any

    const config: TaskTypeExportConfig = {
      version: 1,
      exportDate: new Date().toISOString(),
      mode: 'single',
      taskTypeName: 'Task With Statuses',
      taskTypeId: 'old-task-id' as Ref<TaskType>,
      workspace: ws1,
      projectTypeId: projectType1,
      taskTypes: [
        {
          id: 'old-task-id' as Ref<TaskType>,
          name: 'Task With Statuses',
          descriptor: 'desc' as any,
          ofClass: 'tracker:class:Issue' as any,
          statusCategories: [],
          statuses: [
            { id: 'st-fixed-1' as Ref<Status>, name: 'In Progress', color: 3, category: 'InProgress' as any },
            { id: 'st-fixed-2' as Ref<Status>, name: 'Resolved', color: 4, category: 'Done' as any }
          ]
        }
      ]
    }

    const result = await importTaskTypeConfig(mockClient, projectType1, config)
    expect(result.createdCount).toBe(1)
    const imported = result.importedTaskTypes[0]
    expect(imported._id).not.toBe('old-task-id')
    expect(imported.statuses).toEqual(['st-fixed-1', 'st-fixed-2'])
    expect(imported.targetClass).toBe(`${imported._id}:type:class`)
  })

  it('creates Enum document for enumValues when importing custom attributes', async () => {
    const createdDocs: any[] = []
    const mockClient = {
      findOne: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === task.class.ProjectType) {
          return {
            _id: projectType1,
            name: 'Classic Project',
            tasks: [],
            statuses: []
          }
        }
        return undefined
      }),
      findAll: jest.fn().mockResolvedValue([]),
      getHierarchy: jest.fn().mockReturnValue({
        findClass: jest.fn().mockReturnValue({ icon: 'icon' }),
        getAttribute: jest.fn().mockReturnValue({ _id: 'status-attr' }),
        getAllAttributes: jest.fn().mockReturnValue(new Map())
      }),
      createDoc: jest.fn().mockImplementation(async (clazz: any, space: any, data: any, id?: any) => {
        const doc = { _id: id ?? 'id-' + createdDocs.length, _class: clazz, ...data }
        createdDocs.push(doc)
        return doc._id
      }),
      createMixin: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockResolvedValue(true)
    } as any

    const config: TaskTypeExportConfig = {
      version: 1,
      exportDate: new Date().toISOString(),
      mode: 'single',
      taskTypeName: 'Task With Enum',
      taskTypeId: 'enum-task-id' as Ref<TaskType>,
      workspace: ws1,
      projectTypeId: projectType1,
      taskTypes: [
        {
          id: 'enum-task-id' as Ref<TaskType>,
          name: 'Task With Enum',
          descriptor: 'desc' as any,
          ofClass: 'tracker:class:Issue' as any,
          statusCategories: [],
          statuses: [],
          attributes: [
            {
              id: 'attr-enum-1' as any,
              name: 'severity',
              label: 'Severity' as IntlString,
              type: singleEnumType,
              defaultValue: 'critical',
              enumName: 'severity_enum',
              enumValues: ['low', 'medium', 'high', 'critical']
            }
          ]
        }
      ]
    }

    const result = await importTaskTypeConfig(mockClient, projectType1, config)
    expect(result.createdCount).toBe(1)

    const enumDoc = createdDocs.find((d) => d._class === 'core:class:Enum')
    expect(enumDoc).toBeDefined()
    expect(enumDoc.name).toBe('severity_enum')
    expect(enumDoc.enumValues).toEqual(['low', 'medium', 'high', 'critical'])

    const attrDoc = createdDocs.find((d) => d._class === 'core:class:Attribute')
    expect(attrDoc).toBeDefined()
    expect(attrDoc.name).toBe('severity')
    expect(attrDoc.type._class).toBe('core:class:EnumOf')
    expect(attrDoc.type.of).toBe(enumDoc._id)
    expect(attrDoc.defaultValue).toBe('critical')
  })

  it('reuses existing Enum document when matching enumValues exist', async () => {
    const createdDocs: any[] = []
    const existingEnumDoc = {
      _id: 'existing-enum-id',
      _class: 'core:class:Enum',
      name: 'severity_enum',
      enumValues: ['low', 'medium', 'high', 'critical']
    }

    const mockClient = {
      findOne: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === task.class.ProjectType) {
          return {
            _id: projectType1,
            name: 'Classic Project',
            tasks: [],
            statuses: []
          }
        }
        return undefined
      }),
      findAll: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === 'core:class:Enum') {
          return [existingEnumDoc]
        }
        return []
      }),
      getHierarchy: jest.fn().mockReturnValue({
        findClass: jest.fn().mockReturnValue({ icon: 'icon' }),
        getAttribute: jest.fn().mockReturnValue({ _id: 'status-attr' }),
        getAllAttributes: jest.fn().mockReturnValue(new Map())
      }),
      createDoc: jest.fn().mockImplementation(async (clazz: any, space: any, data: any, id?: any) => {
        const doc = { _id: id ?? 'id-' + createdDocs.length, _class: clazz, ...data }
        createdDocs.push(doc)
        return doc._id
      }),
      createMixin: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockResolvedValue(true)
    } as any

    const config: TaskTypeExportConfig = {
      version: 1,
      exportDate: new Date().toISOString(),
      mode: 'single',
      taskTypeName: 'Task With Reused Enum',
      taskTypeId: 'reused-enum-task-id' as Ref<TaskType>,
      workspace: ws1,
      projectTypeId: projectType1,
      taskTypes: [
        {
          id: 'reused-enum-task-id' as Ref<TaskType>,
          name: 'Task With Reused Enum',
          descriptor: 'desc' as any,
          ofClass: 'tracker:class:Issue' as any,
          statusCategories: [],
          statuses: [],
          attributes: [
            {
              id: 'attr-enum-reused' as any,
              name: 'severity',
              label: 'Severity' as IntlString,
              type: singleEnumType,
              defaultValue: 'medium',
              enumValues: ['low', 'medium', 'high', 'critical']
            }
          ]
        }
      ]
    }

    await importTaskTypeConfig(mockClient, projectType1, config)

    const newlyCreatedEnums = createdDocs.filter((d) => d._class === 'core:class:Enum')
    expect(newlyCreatedEnums).toHaveLength(0)

    const attrDoc = createdDocs.find((d) => d._class === 'core:class:Attribute')
    expect(attrDoc).toBeDefined()
    expect(attrDoc.type.of).toBe('existing-enum-id')
  })

  it('creates Mixin documents and their attributes when importing task type with mixins', async () => {
    const createdDocs: any[] = []
    const createdMixins: any[] = []

    const mockClient = {
      findOne: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === task.class.ProjectType) {
          return {
            _id: projectType1,
            name: 'Classic Project',
            tasks: [],
            statuses: []
          }
        }
        return undefined
      }),
      findAll: jest.fn().mockResolvedValue([]),
      getHierarchy: jest.fn().mockReturnValue({
        findClass: jest.fn().mockReturnValue({ icon: 'icon' }),
        getAttribute: jest.fn().mockReturnValue({ _id: 'status-attr' }),
        getAllAttributes: jest.fn().mockReturnValue(new Map())
      }),
      createDoc: jest.fn().mockImplementation(async (clazz: any, space: any, data: any, id?: any) => {
        const doc = { _id: id ?? 'id-' + createdDocs.length, _class: clazz, ...data }
        createdDocs.push(doc)
        return doc._id
      }),
      createMixin: jest
        .fn()
        .mockImplementation(async (targetId: any, targetClass: any, space: any, mixinClass: any, data: any) => {
          createdMixins.push({ targetId, mixinClass, data })
          return true
        }),
      update: jest.fn().mockResolvedValue(true)
    } as any

    const config: TaskTypeExportConfig = {
      version: 1,
      exportDate: new Date().toISOString(),
      mode: 'single',
      taskTypeName: 'Task With Mixins',
      taskTypeId: 'mixin-task-id' as Ref<TaskType>,
      workspace: ws1,
      projectTypeId: projectType1,
      taskTypes: [
        {
          id: 'mixin-task-id' as Ref<TaskType>,
          name: 'Task With Mixins',
          descriptor: 'desc' as any,
          ofClass: 'tracker:class:Issue' as any,
          statusCategories: [],
          statuses: [],
          mixins: [
            {
              id: 'custom-mixin-old-id' as any,
              label: 'Custom Fields' as IntlString,
              attributes: [
                {
                  id: 'attr-in-mixin' as any,
                  name: 'extra_notes',
                  label: 'Extra Notes' as IntlString,
                  type: stringType
                }
              ]
            }
          ]
        }
      ]
    }

    const result = await importTaskTypeConfig(mockClient, projectType1, config)
    expect(result.createdCount).toBe(1)

    const mixinDoc = createdDocs.find((d) => d._class === core.class.Mixin)
    expect(mixinDoc).toBeDefined()
    expect(mixinDoc.label).toBe('Custom Fields')
    expect(mixinDoc.extends).toBe(`${result.importedTaskTypes[0]._id}:type:class`)

    const editableMixin = createdMixins.find(
      (m) => m.targetId === mixinDoc._id && m.mixinClass === setting.mixin.Editable
    )
    expect(editableMixin).toBeDefined()
    expect(editableMixin.data.value).toBe(true)

    const userMixin = createdMixins.find((m) => m.targetId === mixinDoc._id && m.mixinClass === setting.mixin.UserMixin)
    expect(userMixin).toBeDefined()

    const mixinAttrDoc = createdDocs.find((d) => d._class === 'core:class:Attribute' && d.attributeOf === mixinDoc._id)
    expect(mixinAttrDoc).toBeDefined()
    expect(mixinAttrDoc.name).toBe('extra_notes')
  })

  it('returns empty result when project type is not found', async () => {
    const mockClient = {
      findOne: jest.fn().mockResolvedValue(undefined)
    } as any

    const config: TaskTypeExportConfig = {
      version: 1,
      exportDate: new Date().toISOString(),
      mode: 'single',
      taskTypeName: 'Task',
      taskTypeId: 'task-id' as Ref<TaskType>,
      workspace: ws1,
      projectTypeId: projectType1,
      taskTypes: []
    }

    const result = await importTaskTypeConfig(mockClient, 'missing-proj' as Ref<ProjectType>, config)
    expect(result).toEqual({ importedTaskTypes: [], createdCount: 0 })
  })

  it('handles duplicate renaming in import with multiple iterations', async () => {
    const createdDocs: any[] = []
    const mockClient = {
      findOne: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === task.class.ProjectType) {
          return {
            _id: projectType1,
            name: 'Project Type 1',
            tasks: [],
            statuses: []
          }
        }
        return undefined
      }),
      findAll: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === 'task:class:TaskType') {
          return [
            { _id: 'tt-1', name: 'Task', parent: projectType1 },
            { _id: 'tt-2', name: 'Task (1)', parent: projectType1 },
            { _id: 'tt-3', name: 'Task (2)', parent: projectType1 }
          ]
        }
        return []
      }),
      getHierarchy: jest.fn().mockReturnValue({
        findClass: jest.fn().mockReturnValue({ icon: 'icon' }),
        getAttribute: jest.fn().mockReturnValue({ _id: 'status-attr' }),
        getAllAttributes: jest.fn().mockReturnValue(new Map())
      }),
      createDoc: jest.fn().mockImplementation(async (clazz: any, space: any, data: any, id?: any) => {
        const doc = { _id: id ?? 'id-' + createdDocs.length, _class: clazz, ...data }
        createdDocs.push(doc)
        return doc._id
      }),
      createMixin: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockResolvedValue(true)
    } as any

    const config: TaskTypeExportConfig = {
      version: 1,
      exportDate: new Date().toISOString(),
      mode: 'single',
      taskTypeName: 'Task',
      taskTypeId: 'task-id' as Ref<TaskType>,
      workspace: ws1,
      projectTypeId: projectType1,
      taskTypes: [
        {
          id: 'task-id' as Ref<TaskType>,
          name: 'Task',
          descriptor: 'desc' as any,
          ofClass: 'class' as any,
          statusCategories: [],
          statuses: []
        }
      ]
    }

    const result = await importTaskTypeConfig(mockClient, projectType1, config, { renameDuplicates: true })
    expect(result.createdCount).toBe(1)
    expect(result.importedTaskTypes[0].name).toBe('Task (3)')
  })

  it('remaps self parent, sibling parent, and existing project parents in linkParentChildRelations', async () => {
    const createdDocs: any[] = []
    const updatedDocs: any[] = []

    const mockClient = {
      findOne: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === task.class.ProjectType) {
          return {
            _id: projectType1,
            name: 'Project Type 1',
            tasks: [],
            statuses: []
          }
        }
        return undefined
      }),
      findAll: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === 'task:class:TaskType') {
          return [{ _id: 'existing-parent-id', name: 'Existing Parent', parent: projectType1 }]
        }
        return []
      }),
      getHierarchy: jest.fn().mockReturnValue({
        findClass: jest.fn().mockReturnValue({ icon: 'icon' }),
        getAttribute: jest.fn().mockReturnValue({ _id: 'status-attr' }),
        getAllAttributes: jest.fn().mockReturnValue(new Map())
      }),
      createDoc: jest.fn().mockImplementation(async (clazz: any, space: any, data: any, id?: any) => {
        const doc = { _id: id ?? 'id-' + createdDocs.length, _class: clazz, ...data }
        createdDocs.push(doc)
        return doc._id
      }),
      createMixin: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockImplementation(async (doc: any, update: any) => {
        updatedDocs.push({ doc, update })
        return doc
      })
    } as any

    const config: TaskTypeExportConfig = {
      version: 1,
      exportDate: new Date().toISOString(),
      mode: 'hierarchy',
      taskTypeName: 'Parent Type',
      taskTypeId: 'old-parent-id' as Ref<TaskType>,
      workspace: ws1,
      projectTypeId: projectType1,
      taskTypes: [
        {
          id: 'old-parent-id' as Ref<TaskType>,
          name: 'Imported Parent',
          descriptor: 'desc' as any,
          ofClass: 'class' as any,
          statusCategories: [],
          statuses: [],
          // self parent + existing parent
          allowedAsChildOf: ['old-parent-id' as Ref<TaskType>, 'existing-parent-id' as Ref<TaskType>]
        },
        {
          id: 'old-child-id' as Ref<TaskType>,
          name: 'Imported Child',
          descriptor: 'desc' as any,
          ofClass: 'class' as any,
          statusCategories: [],
          statuses: [],
          // sibling parent + unknown parent
          allowedAsChildOf: ['old-parent-id' as Ref<TaskType>, 'unknown-parent-id' as Ref<TaskType>]
        }
      ]
    }

    const result = await importTaskTypeConfig(mockClient, projectType1, config)
    expect(result.createdCount).toBe(2)

    const importedParent = result.importedTaskTypes[0]
    const importedChild = result.importedTaskTypes[1]

    // Parent should have remapped self-id and existing-parent-id
    expect(importedParent.allowedAsChildOf).toEqual([importedParent._id, 'existing-parent-id'])

    // Child should have remapped parent id and omitted unknown parent
    expect(importedChild.allowedAsChildOf).toEqual([importedParent._id])
  })

  it('gracefully skips targetClass creation if ofClass is missing in hierarchy', async () => {
    const createdDocs: any[] = []
    const mockClient = {
      findOne: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === task.class.ProjectType) {
          return {
            _id: projectType1,
            name: 'Project Type 1',
            tasks: [],
            statuses: []
          }
        }
        return undefined
      }),
      findAll: jest.fn().mockResolvedValue([]),
      getHierarchy: jest.fn().mockReturnValue({
        findClass: jest.fn().mockReturnValue(undefined), // ofClass not found
        getAttribute: jest.fn().mockReturnValue({ _id: 'status-attr' }),
        getAllAttributes: jest.fn().mockReturnValue(new Map())
      }),
      createDoc: jest.fn().mockImplementation(async (clazz: any, space: any, data: any, id?: any) => {
        const doc = { _id: id ?? 'id-' + createdDocs.length, _class: clazz, ...data }
        createdDocs.push(doc)
        return doc._id
      }),
      createMixin: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockResolvedValue(true)
    } as any

    const config: TaskTypeExportConfig = {
      version: 1,
      exportDate: new Date().toISOString(),
      mode: 'single',
      taskTypeName: 'Task Missing ofClass',
      taskTypeId: 'task-id' as Ref<TaskType>,
      workspace: ws1,
      projectTypeId: projectType1,
      taskTypes: [
        {
          id: 'task-id' as Ref<TaskType>,
          name: 'Task Missing ofClass',
          descriptor: 'desc' as any,
          ofClass: 'nonexistent:class:Base' as any,
          statusCategories: [],
          statuses: []
        }
      ]
    }

    const result = await importTaskTypeConfig(mockClient, projectType1, config)
    expect(result.createdCount).toBe(1)
    expect(createdDocs.find((d) => d._class === 'core:class:Class')).toBeUndefined()
  })

  it('preserves and deduplicates pre-existing tasks and statuses on ProjectType', async () => {
    const createdDocs: any[] = []
    let updatedProjectType: any = null

    const existingTaskTypeId = 'existing-tt-id' as Ref<TaskType>
    const existingStatusId = 'existing-st-id' as Ref<Status>

    const mockClient = {
      findOne: jest.fn().mockImplementation(async (clazz: any) => {
        if (clazz === task.class.ProjectType) {
          return {
            _id: projectType1,
            name: 'Project Type 1',
            tasks: [existingTaskTypeId],
            statuses: [{ _id: existingStatusId, taskType: existingTaskTypeId }]
          }
        }
        return undefined
      }),
      findAll: jest.fn().mockResolvedValue([]),
      getHierarchy: jest.fn().mockReturnValue({
        findClass: jest.fn().mockReturnValue({ icon: 'icon' }),
        getAttribute: jest.fn().mockReturnValue({ _id: 'status-attr' }),
        getAllAttributes: jest.fn().mockReturnValue(new Map())
      }),
      createDoc: jest.fn().mockImplementation(async (clazz: any, space: any, data: any, id?: any) => {
        const doc = { _id: id ?? 'id-' + createdDocs.length, _class: clazz, ...data }
        createdDocs.push(doc)
        return doc._id
      }),
      createMixin: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockImplementation(async (doc: any, update: any) => {
        if (doc._id === projectType1) {
          updatedProjectType = { ...doc, ...update }
        }
        return doc
      })
    } as any

    const config: TaskTypeExportConfig = {
      version: 1,
      exportDate: new Date().toISOString(),
      mode: 'single',
      taskTypeName: 'New Task',
      taskTypeId: 'new-task-id' as Ref<TaskType>,
      workspace: ws1,
      projectTypeId: projectType1,
      taskTypes: [
        {
          id: 'new-task-id' as Ref<TaskType>,
          name: 'New Task',
          descriptor: 'desc' as any,
          ofClass: 'class' as any,
          statusCategories: [],
          statuses: [{ id: 'st-new' as Ref<Status>, name: 'New Status', color: 1, category: 'Open' as any }]
        }
      ]
    }

    const result = await importTaskTypeConfig(mockClient, projectType1, config)
    expect(result.createdCount).toBe(1)
    const importedId = result.importedTaskTypes[0]._id

    expect(updatedProjectType.tasks).toEqual([existingTaskTypeId, importedId])
    expect(updatedProjectType.statuses).toEqual([
      { _id: existingStatusId, taskType: existingTaskTypeId },
      { _id: 'st-new', taskType: importedId }
    ])
  })
})

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

import type { PropertyType, Ref, Type, WorkspaceUuid } from '@hcengineering/core'
import type { Asset, IntlString } from '@hcengineering/platform'
import {
  isEnumOfType,
  isArrOfType,
  isRefToType,
  getEnumRefFromType,
  getRefToClassFromType,
  isAttributeClassMissing,
  findIncompatibleAttributes,
  exportAttributes,
  createCustomAttributes,
  findOrCreateEnum,
  ProjectType,
  TaskType,
  type TaskTypeExportConfig
} from '../../index'

describe('Attribute transfer helpers (attributes.ts)', () => {
  const stringType: Type<PropertyType> = {
    icon: 'core:icon:TypeString' as Asset,
    label: 'core:string:String' as IntlString,
    _class: 'core:class:TypeString' as any
  }

  const refPersonType: Type<PropertyType> = {
    _class: 'core:class:RefTo' as any,
    label: 'core:string:Ref' as IntlString,
    icon: 'core:icon:TypeRef' as Asset,
    to: 'contact:class:Person' as any
  } as any

  const multiEnumType: Type<PropertyType> = {
    _class: 'core:class:ArrOf' as any,
    label: 'core:string:Array' as IntlString,
    of: {
      _class: 'core:class:EnumOf' as any,
      label: 'core:string:Enum' as IntlString,
      icon: 'core:icon:TypeEnumOf' as Asset,
      of: '6a9170a4e3666958ff9bc46f' as any
    },
    icon: 'core:icon:TypeArray' as Asset
  } as any

  const multiRefType: Type<PropertyType> = {
    _class: 'core:class:ArrOf' as any,
    label: 'core:string:Array' as IntlString,
    of: {
      _class: 'core:class:RefTo' as any,
      label: 'core:string:Ref' as IntlString,
      icon: 'core:icon:TypeRef' as Asset,
      to: 'contact:class:Organization' as any
    },
    icon: 'core:icon:TypeArray' as Asset
  } as any

  const singleEnumType: Type<PropertyType> = {
    _class: 'core:class:EnumOf' as any,
    label: 'core:string:Enum' as IntlString,
    icon: 'core:icon:TypeEnumOf' as Asset,
    of: '6a9170a4e3666958ff9bc46f' as any
  } as any

  describe('Type Guards and Resolvers', () => {
    it('correctly identifies types with type guards', () => {
      expect(isEnumOfType(singleEnumType)).toBe(true)
      expect(isEnumOfType(stringType)).toBe(false)
      expect(isEnumOfType(multiEnumType)).toBe(false)

      expect(isArrOfType(multiEnumType)).toBe(true)
      expect(isArrOfType(multiRefType)).toBe(true)
      expect(isArrOfType(singleEnumType)).toBe(false)
      expect(isArrOfType(stringType)).toBe(false)

      expect(isRefToType(refPersonType)).toBe(true)
      expect(isRefToType(singleEnumType)).toBe(false)
    })

    it('extracts enum ref correctly from EnumOf and ArrOf<EnumOf>, and returns undefined for others', () => {
      expect(getEnumRefFromType(singleEnumType)).toBe('6a9170a4e3666958ff9bc46f')
      expect(getEnumRefFromType(multiEnumType)).toBe('6a9170a4e3666958ff9bc46f')
      expect(getEnumRefFromType(stringType)).toBeUndefined()
      expect(getEnumRefFromType(refPersonType)).toBeUndefined()
      expect(getEnumRefFromType(multiRefType)).toBeUndefined()
      expect(getEnumRefFromType(undefined)).toBeUndefined()
    })

    it('correctly extracts referenced class with getRefToClassFromType', () => {
      expect(getRefToClassFromType(undefined)).toBeUndefined()
      expect(getRefToClassFromType(stringType)).toBeUndefined()
      expect(getRefToClassFromType(singleEnumType)).toBeUndefined()
      expect(getRefToClassFromType(refPersonType)).toBe('contact:class:Person')
      expect(getRefToClassFromType(multiRefType)).toBe('contact:class:Organization')
    })
  })

  describe('exportAttributes', () => {
    it('exports and resolves custom attributes for all 5 attribute types', async () => {
      const realAttributes = [
        {
          name: 'custom6a7b0b147f0f71a50e1bcd61',
          type: stringType,
          label: 'embedded:embedded:issue text',
          isCustom: true,
          attributeOf: 'tracker:class:IssueTaskType',
          _id: '6a7b0b147f0f71a50e1bcd63'
        },
        {
          attributeOf: 'tracker:class:IssueTaskType',
          name: 'custom6a91708ce3666958ff9bc464',
          label: 'embedded:embedded:ref-person',
          isCustom: true,
          type: refPersonType,
          _id: '6a91708ce3666958ff9bc466'
        },
        {
          attributeOf: 'tracker:class:IssueTaskType',
          name: 'custom6a9170ace3666958ff9bc470',
          label: 'embedded:embedded:multi-enum',
          isCustom: true,
          type: multiEnumType,
          _id: '6a9170ace3666958ff9bc472'
        },
        {
          attributeOf: 'tracker:class:IssueTaskType',
          name: 'custom6a9170cee3666958ff9bc476',
          label: 'embedded:embedded:multi-ref',
          isCustom: true,
          type: multiRefType,
          _id: '6a9170cee3666958ff9bc478'
        },
        {
          attributeOf: 'tracker:class:IssueTaskType',
          name: 'custom6a9170e7e3666958ff9bc482',
          label: 'embedded:embedded:select-color',
          isCustom: true,
          type: singleEnumType,
          defaultValue: 'white',
          _id: '6a9170e7e3666958ff9bc484'
        }
      ]

      const enumDocs = [
        {
          _id: '6a9170a4e3666958ff9bc46f',
          name: 'colors',
          enumValues: ['white', 'black', 'red']
        }
      ]

      const mockClient = {
        findAll: jest.fn().mockImplementation(async (clazz: any) => {
          if (clazz === 'core:class:Attribute') return realAttributes
          if (clazz === 'core:class:Enum') return enumDocs
          return []
        })
      } as any

      const exported = await exportAttributes(mockClient, 'tracker:class:IssueTaskType' as any)
      expect(exported).toHaveLength(5)

      const strExport = exported?.find((a) => a.name === 'custom6a7b0b147f0f71a50e1bcd61')
      expect(strExport?.type).toEqual(stringType)
      expect(strExport?.enumValues).toBeUndefined()

      const refPersonExport = exported?.find((a) => a.name === 'custom6a91708ce3666958ff9bc464')
      expect(refPersonExport?.type).toEqual(refPersonType)
      expect(refPersonExport?.enumValues).toBeUndefined()

      const multiEnumExport = exported?.find((a) => a.name === 'custom6a9170ace3666958ff9bc470')
      expect(multiEnumExport?.type).toEqual(multiEnumType)
      expect(multiEnumExport?.enumName).toBe('colors')
      expect(multiEnumExport?.enumValues).toEqual(['white', 'black', 'red'])

      const multiRefExport = exported?.find((a) => a.name === 'custom6a9170cee3666958ff9bc476')
      expect(multiRefExport?.type).toEqual(multiRefType)
      expect(multiRefExport?.enumValues).toBeUndefined()

      const singleEnumExport = exported?.find((a) => a.name === 'custom6a9170e7e3666958ff9bc482')
      expect(singleEnumExport?.type).toEqual(singleEnumType)
      expect(singleEnumExport?.defaultValue).toBe('white')
      expect(singleEnumExport?.enumName).toBe('colors')
      expect(singleEnumExport?.enumValues).toEqual(['white', 'black', 'red'])
    })
  })

  describe('createCustomAttributes and Enum mapping', () => {
    it('creates custom attributes with enum mapping for all 5 attribute types', async () => {
      const createdDocs: any[] = []
      const mockClient = {
        findAll: jest.fn().mockImplementation(async (clazz: any) => {
          if (clazz === 'core:class:Enum') return []
          return []
        }),
        getHierarchy: jest.fn().mockReturnValue({
          findClass: jest.fn().mockReturnValue({ _id: 'class' })
        }),
        createDoc: jest.fn().mockImplementation(async (clazz: any, space: any, data: any) => {
          const doc = { _id: 'doc-' + createdDocs.length, _class: clazz, ...data }
          createdDocs.push(doc)
          return doc._id
        })
      } as any

      const exportedAttrs = [
        {
          id: '6a7b0b147f0f71a50e1bcd63' as any,
          name: 'custom6a7b0b147f0f71a50e1bcd61',
          label: 'embedded:embedded:issue text' as IntlString,
          type: stringType,
          required: false
        },
        {
          id: '6a91708ce3666958ff9bc466' as any,
          name: 'custom6a91708ce3666958ff9bc464',
          label: 'embedded:embedded:ref-person' as IntlString,
          type: refPersonType,
          required: false
        },
        {
          id: '6a9170ace3666958ff9bc472' as any,
          name: 'custom6a9170ace3666958ff9bc470',
          label: 'embedded:embedded:multi-enum' as IntlString,
          type: multiEnumType,
          enumValues: ['white', 'black'],
          required: false
        },
        {
          id: '6a9170cee3666958ff9bc478' as any,
          name: 'custom6a9170cee3666958ff9bc476',
          label: 'embedded:embedded:multi-ref' as IntlString,
          type: multiRefType,
          required: false
        },
        {
          id: '6a9170e7e3666958ff9bc484' as any,
          name: 'custom6a9170e7e3666958ff9bc482',
          label: 'embedded:embedded:select-color' as IntlString,
          type: singleEnumType,
          defaultValue: 'white',
          enumValues: ['white', 'black'],
          required: false
        }
      ]

      await createCustomAttributes(mockClient, 'target:class:NewTaskType' as any, exportedAttrs)

      const enumDocs = createdDocs.filter((d) => d._class === 'core:class:Enum')
      expect(enumDocs.length).toBeGreaterThanOrEqual(1)

      const attrs = createdDocs.filter((d) => d._class === 'core:class:Attribute')
      expect(attrs).toHaveLength(5)

      const strCreated = attrs.find((a) => a.name === 'custom6a7b0b147f0f71a50e1bcd61')
      expect(strCreated.type).toEqual(stringType)

      const refPersonCreated = attrs.find((a) => a.name === 'custom6a91708ce3666958ff9bc464')
      expect(refPersonCreated.type).toEqual(refPersonType)

      const multiEnumCreated = attrs.find((a) => a.name === 'custom6a9170ace3666958ff9bc470')
      expect(multiEnumCreated.type._class).toBe('core:class:ArrOf')
      expect(multiEnumCreated.type.of._class).toBe('core:class:EnumOf')
      expect(multiEnumCreated.type.of.of).toBeDefined()

      const multiRefCreated = attrs.find((a) => a.name === 'custom6a9170cee3666958ff9bc476')
      expect(multiRefCreated.type).toEqual(multiRefType)

      const singleEnumCreated = attrs.find((a) => a.name === 'custom6a9170e7e3666958ff9bc482')
      expect(singleEnumCreated.type._class).toBe('core:class:EnumOf')
      expect(singleEnumCreated.type.of).toBeDefined()
      expect(singleEnumCreated.defaultValue).toBe('white')
    })

    it('handles undefined attributes array in createCustomAttributes', async () => {
      const mockClient = { createDoc: jest.fn() } as any
      await expect(createCustomAttributes(mockClient, 'target:class:Doc' as any, undefined)).resolves.not.toThrow()
      expect(mockClient.createDoc).not.toHaveBeenCalled()
    })

    it('findOrCreateEnum matches existing enums by name and values, or creates new ones', async () => {
      const existingEnums = [
        { _id: 'enum-1', name: 'status_enum', enumValues: ['open', 'closed'] },
        { _id: 'enum-2', name: 'color_enum', enumValues: ['red', 'green', 'blue'] }
      ]
      const createdDocs: any[] = []
      const mockClient = {
        findAll: jest.fn().mockResolvedValue(existingEnums),
        createDoc: jest.fn().mockImplementation(async (clazz: any, space: any, data: any) => {
          const doc = { _id: 'new-enum-' + createdDocs.length, _class: clazz, ...data }
          createdDocs.push(doc)
          return doc._id
        })
      } as any

      // 1. Exact match by name and values
      const res1 = await findOrCreateEnum(mockClient, 'status_enum', ['open', 'closed'])
      expect(res1).toBe('enum-1')

      // 2. Match by values only with different name
      const res2 = await findOrCreateEnum(mockClient, 'other_status_name', ['open', 'closed'])
      expect(res2).toBe('enum-1')

      // 3. No match -> creates new enum
      const res3 = await findOrCreateEnum(mockClient, 'priority_enum', ['low', 'medium', 'high'])
      expect(res3).toBe('new-enum-0')
      expect(createdDocs[0].name).toBe('priority_enum')
      expect(createdDocs[0].enumValues).toEqual(['low', 'medium', 'high'])
    })
  })

  describe('Missing / Incompatible Class Detection', () => {
    it('detects incompatible attributes when target class does not exist in workspace', () => {
      const mockClient = {
        getHierarchy: jest.fn().mockReturnValue({
          findClass: jest.fn().mockImplementation((cls) => {
            if (cls === 'contact:class:Person') return { _id: 'contact:class:Person' }
            return undefined // Organization does not exist
          })
        })
      } as any

      expect(isAttributeClassMissing(mockClient, refPersonType)).toBe(false)
      expect(isAttributeClassMissing(mockClient, multiRefType)).toBe(true)
      expect(isAttributeClassMissing(mockClient, stringType)).toBe(false)

      const exportConfig: TaskTypeExportConfig = {
        version: 1,
        exportDate: new Date().toISOString(),
        mode: 'single',
        taskTypeName: 'Test Issue',
        taskTypeId: 'issue-id' as Ref<TaskType>,
        workspace: 'ws-1' as WorkspaceUuid,
        projectTypeId: 'proj-1' as Ref<ProjectType>,
        taskTypes: [
          {
            id: 'issue-id' as Ref<TaskType>,
            name: 'Test Issue',
            descriptor: 'desc' as any,
            ofClass: 'class' as any,
            statusCategories: [],
            statuses: [],
            attributes: [
              {
                id: 'attr-1' as any,
                name: 'person_ref',
                label: 'Person' as IntlString,
                type: refPersonType
              },
              {
                id: 'attr-2' as any,
                name: 'org_multi_ref',
                label: 'Organization' as IntlString,
                type: multiRefType
              }
            ],
            mixins: [
              {
                id: 'mixin-1' as any,
                label: 'Mixin' as IntlString,
                attributes: [
                  {
                    id: 'attr-3' as any,
                    name: 'missing_ref_in_mixin',
                    label: 'Missing in Mixin' as IntlString,
                    type: {
                      _class: 'core:class:RefTo',
                      to: 'nonexistent:class:Missing'
                    } as any
                  }
                ]
              }
            ]
          }
        ]
      }

      const incompatible = findIncompatibleAttributes(mockClient, exportConfig)
      expect(incompatible).toHaveLength(2)
      expect(incompatible).toEqual([
        {
          taskTypeName: 'Test Issue',
          attributeName: 'org_multi_ref',
          targetClass: 'contact:class:Organization'
        },
        {
          taskTypeName: 'Test Issue',
          attributeName: 'missing_ref_in_mixin',
          targetClass: 'nonexistent:class:Missing'
        }
      ])
    })

    it('skips attributes with missing target classes when creating attributes', async () => {
      const createdDocs: any[] = []
      const mockClient = {
        findAll: jest.fn().mockResolvedValue([]),
        getHierarchy: jest.fn().mockReturnValue({
          findClass: jest.fn().mockImplementation((cls) => {
            if (cls === 'contact:class:Person') return { _id: 'contact:class:Person' }
            return undefined // Organization does not exist
          })
        }),
        createDoc: jest.fn().mockImplementation(async (clazz: any, space: any, data: any) => {
          const doc = { _id: 'doc-' + createdDocs.length, _class: clazz, ...data }
          createdDocs.push(doc)
          return doc._id
        })
      } as any

      const attrsToCreate = [
        {
          id: 'attr-1' as any,
          name: 'valid_string',
          label: 'Valid String' as IntlString,
          type: stringType
        },
        {
          id: 'attr-2' as any,
          name: 'valid_person_ref',
          label: 'Valid Person Ref' as IntlString,
          type: refPersonType
        },
        {
          id: 'attr-3' as any,
          name: 'missing_org_ref',
          label: 'Missing Org Ref' as IntlString,
          type: multiRefType
        }
      ]

      await createCustomAttributes(mockClient, 'target:class:Issue' as any, attrsToCreate)

      const createdAttrs = createdDocs.filter((d) => d._class === 'core:class:Attribute')
      expect(createdAttrs).toHaveLength(2)
      expect(createdAttrs.map((a) => a.name)).toEqual(['valid_string', 'valid_person_ref'])
      expect(createdAttrs.find((a) => a.name === 'missing_org_ref')).toBeUndefined()
    })

    it('handles findIncompatibleAttributes when client has no getHierarchy or when filtering by selectedTypeNames', () => {
      const mockClientNoHierarchy = {} as any
      const exportConfig: TaskTypeExportConfig = {
        version: 1,
        exportDate: new Date().toISOString(),
        mode: 'single',
        taskTypeName: 'Test Issue',
        taskTypeId: 'issue-id' as Ref<TaskType>,
        workspace: 'ws-1' as WorkspaceUuid,
        projectTypeId: 'proj-1' as Ref<ProjectType>,
        taskTypes: [
          {
            id: 'issue-id' as Ref<TaskType>,
            name: 'Test Issue',
            descriptor: 'desc' as any,
            ofClass: 'class' as any,
            statusCategories: [],
            statuses: [],
            attributes: [
              {
                id: 'attr-1' as any,
                name: 'missing_ref',
                label: 'Missing' as IntlString,
                type: multiRefType
              }
            ]
          },
          {
            id: 'feature-id' as Ref<TaskType>,
            name: 'Test Feature',
            descriptor: 'desc' as any,
            ofClass: 'class' as any,
            statusCategories: [],
            statuses: [],
            attributes: [
              {
                id: 'attr-2' as any,
                name: 'missing_ref_feature',
                label: 'Missing Feature' as IntlString,
                type: multiRefType
              }
            ]
          }
        ]
      }

      expect(findIncompatibleAttributes(mockClientNoHierarchy, exportConfig)).toEqual([])

      const mockClientWithHierarchy = {
        getHierarchy: jest.fn().mockReturnValue({
          findClass: jest.fn().mockReturnValue(undefined)
        })
      } as any

      // Filtered by selectedTypeNames: only Test Feature
      const filteredIncompatible = findIncompatibleAttributes(mockClientWithHierarchy, exportConfig, ['Test Feature'])
      expect(filteredIncompatible).toHaveLength(1)
      expect(filteredIncompatible[0].taskTypeName).toBe('Test Feature')
      expect(filteredIncompatible[0].attributeName).toBe('missing_ref_feature')
    })
  })
})

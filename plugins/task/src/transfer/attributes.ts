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
  ArrOf,
  Class,
  Doc,
  Enum,
  EnumOf,
  notEmpty,
  PropertyType,
  Ref,
  RefTo,
  TxOperations,
  Type
} from '@hcengineering/core'
import type { IncompatibleAttributeItem, TaskTypeAttributeConfig, TaskTypeExportConfig } from './types'

/**
 * Type guard to check if a type object is EnumOf.
 *
 * @public
 */
export function isEnumOfType (type: Type<PropertyType> | undefined): type is EnumOf {
  return type?._class === core.class.EnumOf
}

/**
 * Type guard to check if a type object is ArrOf.
 *
 * @public
 */
export function isArrOfType (type: Type<PropertyType> | undefined): type is ArrOf<PropertyType> {
  return type?._class === core.class.ArrOf
}

/**
 * Type guard to check if a type object is RefTo.
 *
 * @public
 */
export function isRefToType (type: Type<PropertyType> | undefined): type is RefTo<Doc> {
  return type?._class === core.class.RefTo
}

/**
 * Extracts Enum reference from a Type object if present (e.g. EnumOf or ArrOf<EnumOf>).
 *
 * @public
 */
export function getEnumRefFromType (type: Type<PropertyType> | undefined): Ref<Enum> | undefined {
  if (type === undefined) return undefined

  if (isEnumOfType(type)) {
    return type.of
  }

  if (isArrOfType(type) && isEnumOfType(type.of)) {
    return type.of.of
  }

  return undefined
}

/**
 * Extracts referenced Class ID from a RefTo or ArrOf<RefTo> type object.
 *
 * @public
 */
export function getRefToClassFromType (type: Type<PropertyType> | undefined): Ref<Class<Doc>> | undefined {
  if (type === undefined) return undefined

  if (isRefToType(type)) {
    return type.to
  }

  if (isArrOfType(type) && isRefToType(type.of)) {
    return type.of.to
  }

  return undefined
}

/**
 * Checks if an attribute refers to a missing class in the workspace hierarchy.
 *
 * @public
 */
export function isAttributeClassMissing (client: TxOperations, type: Type<PropertyType> | undefined): boolean {
  const referencedClass = getRefToClassFromType(type)
  if (referencedClass === undefined) return false

  if (typeof client.getHierarchy !== 'function') return false

  const hierarchy = client.getHierarchy()
  return hierarchy.findClass(referencedClass) === undefined
}

/**
 * Finds all custom attributes in an export configuration that reference classes missing in current workspace.
 *
 * @public
 */
export function findIncompatibleAttributes (
  client: TxOperations,
  config: TaskTypeExportConfig,
  selectedTypeNames?: string[]
): IncompatibleAttributeItem[] {
  if (typeof client.getHierarchy !== 'function') return []

  const hierarchy = client.getHierarchy()
  const result: IncompatibleAttributeItem[] = []
  const selectedSet = selectedTypeNames !== undefined ? new Set(selectedTypeNames) : undefined

  for (const entry of config.taskTypes) {
    if (selectedSet !== undefined && !selectedSet.has(entry.name)) continue

    const checkAttr = (attr: TaskTypeAttributeConfig): void => {
      const refClass = getRefToClassFromType(attr.type)
      if (refClass !== undefined && hierarchy.findClass(refClass) === undefined) {
        result.push({
          taskTypeName: entry.name,
          attributeName: attr.name,
          targetClass: refClass
        })
      }
    }

    for (const attr of entry.attributes ?? []) {
      checkAttr(attr)
    }

    for (const mixin of entry.mixins ?? []) {
      for (const attr of mixin.attributes ?? []) {
        checkAttr(attr)
      }
    }
  }

  return result
}

/**
 * Exports custom attributes defined on a class or mixin, resolving enum options if present.
 *
 * @public
 */
export async function exportAttributes (
  client: TxOperations,
  attributeOf: Ref<Class<Doc>>
): Promise<TaskTypeAttributeConfig[] | undefined> {
  const attrs = await client.findAll(core.class.Attribute, { attributeOf })
  if (attrs.length === 0) return undefined

  const enumIds = attrs.map((a) => getEnumRefFromType(a.type)).filter(notEmpty)
  const enumDocs = enumIds.length > 0 ? await client.findAll(core.class.Enum, { _id: { $in: enumIds } }) : []
  const enumMap = new Map<Ref<Enum>, Enum>(enumDocs.map((e) => [e._id, e]))

  return attrs.map((a) => {
    const enumRef = getEnumRefFromType(a.type)
    const enumDoc = enumRef != null ? enumMap.get(enumRef) : undefined
    const enumName: string | undefined = enumDoc?.name
    const enumValues: string[] | undefined = enumDoc?.enumValues

    return {
      id: a._id,
      name: a.name,
      label: a.label,
      type: a.type,
      required: a.required,
      defaultValue: a.defaultValue,
      enumName,
      enumValues,
      icon: a.icon,
      color: a.color
    }
  })
}

/**
 * Finds an existing enum matching the requested values or creates a new one.
 */
export async function findOrCreateEnum (
  client: TxOperations,
  enumName: string,
  enumValues: string[]
): Promise<Ref<Enum>> {
  const existingEnums = await client.findAll(core.class.Enum, {})

  const isMatchingValues = (e: Enum): boolean =>
    e.enumValues?.length === enumValues.length && e.enumValues.every((v) => enumValues.includes(v))

  const matched =
    existingEnums.find((e) => e.name === enumName && isMatchingValues(e)) ??
    existingEnums.find((e) => isMatchingValues(e))

  if (matched !== undefined) return matched._id

  return await client.createDoc(core.class.Enum, core.space.Model, {
    name: enumName,
    enumValues
  })
}

/**
 * Creates custom attributes on a target class or mixin from configuration.
 *
 * @public
 */
export async function createCustomAttributes (
  client: TxOperations,
  targetClass: Ref<Class<Doc>>,
  attributes: TaskTypeAttributeConfig[] | undefined
): Promise<void> {
  for (const attr of attributes ?? []) {
    if (isAttributeClassMissing(client, attr.type)) {
      continue
    }

    let typeObj: Type<PropertyType> = { ...attr.type }

    if (attr.enumValues !== undefined && attr.enumValues.length > 0) {
      const enumName = attr.enumName ?? `${attr.name}_enum`
      const enumRef = await findOrCreateEnum(client, enumName, attr.enumValues)

      if (isEnumOfType(typeObj)) {
        const enumType: EnumOf = { ...typeObj, of: enumRef }
        typeObj = enumType
      } else if (isArrOfType(typeObj) && isEnumOfType(typeObj.of)) {
        const nestedEnum: EnumOf = { ...typeObj.of, of: enumRef }
        const arrType: ArrOf<PropertyType> = { ...typeObj, of: nestedEnum }
        typeObj = arrType
      }
    }

    await client.createDoc(core.class.Attribute, core.space.Model, {
      attributeOf: targetClass,
      name: attr.name,
      label: attr.label,
      type: typeObj,
      required: attr.required ?? false,
      defaultValue: attr.defaultValue,
      icon: attr.icon,
      color: attr.color,
      isCustom: true
    })
  }
}

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
// See the License for the specific language governing permissions and
// limitations under the License.
//

import core, {
  type AnyAttribute,
  type Doc,
  type Hierarchy,
  type RefTo,
  type Client,
  type ArrOf,
  type PropertyType,
  type EnumOf,
  type Collection,
  type AttachedDoc
} from '@hcengineering/core'
import workflow, {
  type WorkflowFieldValue,
  type WorkflowValueFunction,
  type WorkflowTransformCall
} from '@hcengineering/workflow'
import contact from '@hcengineering/contact'
import { type TaskType } from '@hcengineering/task'
import { getEmbeddedLabel, type IntlString } from '@hcengineering/platform'

import plugin from '../../../../plugin'
import { getAllClassAttributes } from '../../../../utils'
import { type ContextOption, type TransformOption } from './types'

export const EXCLUDED_FIELDS = new Set([
  '_class',
  '_id',
  'attachedTo',
  'createdBy',
  'createdOn',
  'estimation',
  'identifier',
  'modifiedBy',
  'modifiedOn',
  'number',
  'reportedTime',
  'space',
  'status',
  'attachments',
  'reports',
  'comments',
  'subIssues',
  'blockedBy',
  'relations'
])
export const EXCLUDED_TYPES = new Set([
  core.class.TypeMarkup,
  core.class.TypeCollaborativeDoc,
  core.class.TypeAny,
  core.class.TypeBlob,
  core.class.TypeIdentifier,
  core.class.TypeRank,
  core.class.TypeRecord,
  core.class.TypeRelation
])

export function ensureFieldValue (val: unknown): WorkflowFieldValue {
  return typeof val === 'object' && val !== null && 'type' in val
    ? (val as WorkflowFieldValue)
    : { type: 'const', value: val }
}

export function isPersonAttribute (client: Client, attr: AnyAttribute): boolean {
  const hierarchy = client.getHierarchy()
  if (hierarchy.isDerived(attr.type._class, core.class.RefTo)) {
    const to = (attr.type as RefTo<Doc>).to
    return hierarchy.isDerived(to, contact.class.Person)
  }
  if (attr.type._class === core.class.TypePersonId || attr.type._class === core.class.TypeAccountUuid) return true

  if (hierarchy.isDerived(attr.type._class, core.class.Collection)) {
    const type = attr.type as Collection<AttachedDoc>
    return hierarchy.isDerived(type.of, contact.class.Person) || hierarchy.isDerived(type.of, core.class.Collaborator)
  }
  if (hierarchy.isDerived(attr.type._class, core.class.ArrOf)) {
    const type = attr.type as ArrOf<PropertyType>
    if (hierarchy.isDerived(type.of._class, core.class.RefTo)) {
      const to = (type.of as RefTo<Doc>).to
      return hierarchy.isDerived(to, contact.class.Person)
    }
    if (type.of._class === core.class.TypePersonId || type.of._class === core.class.TypeAccountUuid) {
      return true
    }
  }
  return false
}

export function isDateAttribute (client: Client, attr: AnyAttribute): boolean {
  const hierarchy = client.getHierarchy()
  const attrType = attr.type._class
  return hierarchy.isDerived(attrType, core.class.TypeDate) || hierarchy.isDerived(attrType, core.class.TypeTimestamp)
}

export function isExcludedAttribute (attr: AnyAttribute): boolean {
  if (attr.hidden === true) return true
  if (EXCLUDED_FIELDS.has(attr.name)) return true
  if (EXCLUDED_TYPES.has(attr.type._class)) return true

  return false
}

export interface CompatibilityResult {
  compatible: boolean
  functions?: WorkflowTransformCall[]
}

export function isAttributeCompatible (
  hierarchy: Hierarchy,
  srcAttr: AnyAttribute,
  targetAttr: AnyAttribute
): CompatibilityResult {
  const srcType = srcAttr.type
  const targetType = targetAttr.type

  if (
    hierarchy.isDerived(srcType._class, core.class.Collection) ||
    hierarchy.isDerived(targetType._class, core.class.Collection)
  ) {
    return { compatible: false }
  }

  if (
    hierarchy.isDerived(srcType._class, core.class.ArrOf) ||
    hierarchy.isDerived(targetType._class, core.class.ArrOf)
  ) {
    return { compatible: false }
  }

  if (targetAttr._id === srcAttr._id) return { compatible: true }

  if (
    hierarchy.isDerived(srcType._class, core.class.ArrOf) &&
    hierarchy.isDerived(targetType._class, core.class.ArrOf)
  ) {
    const _srcType = srcType as ArrOf<PropertyType>
    const _targetType = targetType as ArrOf<PropertyType>
    if (_srcType.of._class !== _targetType.of._class) return { compatible: false }
    if (_srcType.of._class === core.class.EnumOf) {
      const enumTypeSrc = _srcType.of as EnumOf
      const enumTypeTarget = _targetType.of as EnumOf
      if (enumTypeSrc.of !== enumTypeTarget.of) return { compatible: false }
      return { compatible: true }
    } else if (_srcType.of._class === core.class.RefTo) {
      const refSrcType = _srcType.of as RefTo<Doc>
      const refTargetType = _targetType.of as RefTo<Doc>
      if (refSrcType.to !== refTargetType.to) return { compatible: false }
      return { compatible: true }
    }

    return { compatible: false }
  }

  if (srcType._class === targetType._class) {
    if (hierarchy.isDerived(targetType._class, core.class.RefTo)) {
      const isRefCompat = hierarchy.isDerived((srcType as RefTo<Doc>).to, (targetType as RefTo<Doc>).to)
      return { compatible: isRefCompat }
    }
    return { compatible: true }
  }

  // Conversions to String
  if (hierarchy.isDerived(targetType._class, core.class.TypeString)) {
    if (hierarchy.isDerived(srcType._class, core.class.TypeNumber)) {
      return { compatible: true, functions: [{ func: workflow.function.TextFromNumber }] }
    }
    if (
      hierarchy.isDerived(srcType._class, core.class.TypeDate) ||
      hierarchy.isDerived(srcType._class, core.class.TypeTimestamp)
    ) {
      return { compatible: true, functions: [{ func: workflow.function.TextFromDate }] }
    }
    if (hierarchy.isDerived(srcType._class, core.class.TypeBoolean)) {
      return { compatible: true, functions: [{ func: workflow.function.TextFromCheckbox }] }
    }
  }

  // Conversions to Number
  if (hierarchy.isDerived(targetType._class, core.class.TypeNumber)) {
    if (hierarchy.isDerived(srcType._class, core.class.TypeString)) {
      return { compatible: true, functions: [{ func: workflow.function.NumberFromText }] }
    }
    if (
      hierarchy.isDerived(srcType._class, core.class.TypeDate) ||
      hierarchy.isDerived(srcType._class, core.class.TypeTimestamp)
    ) {
      return { compatible: true, functions: [{ func: workflow.function.NumberFromDate }] }
    }
  }

  // Conversions to Date
  if (
    hierarchy.isDerived(targetType._class, core.class.TypeDate) ||
    hierarchy.isDerived(targetType._class, core.class.TypeTimestamp)
  ) {
    if (hierarchy.isDerived(srcType._class, core.class.TypeString)) {
      return { compatible: true, functions: [{ func: workflow.function.DateFromText }] }
    }
    if (hierarchy.isDerived(srcType._class, core.class.TypeNumber)) {
      return { compatible: true, functions: [{ func: workflow.function.DateFromNumber }] }
    }
  }

  return { compatible: false }
}

export function hasTransformFunctions (client: Client, attr?: AnyAttribute): boolean {
  if (attr == null) return false
  const hierarchy = client.getHierarchy()
  if (hierarchy.isDerived(attr.type._class, core.class.Collection)) return false
  const attrClass = attr.type._class
  const allFuncs = client.getModel().findAllSync<WorkflowValueFunction>(workflow.class.WorkflowValueFunction, {})
  return allFuncs.some(
    (fn: WorkflowValueFunction) =>
      fn.type === 'transform' && (fn.of === attrClass || hierarchy.isDerived(attrClass, fn.of))
  )
}

export function isFieldValueEmpty (val?: WorkflowFieldValue): boolean {
  if (val == null) return true
  if (val.type === 'const') {
    if (Array.isArray(val.value)) {
      return val.value.length === 0
    }
    return val.value == null || val.value === ''
  }
  if (val.type === 'preset') {
    return val.preset == null
  }
  if (val.type === 'this' || val.type === 'parent') {
    return val.fieldKey == null || val.fieldKey === ''
  }
  return false
}

function getPresetOptions (client: Client, attr: AnyAttribute): ContextOption[] {
  const presets: ContextOption[] = []
  if (isPersonAttribute(client, attr)) {
    presets.push({
      id: '$currentUser',
      value: { type: 'preset', preset: '$currentUser' },
      label: plugin.string.CurrentUser
    })
  } else if (isDateAttribute(client, attr)) {
    presets.push({ id: '$now', value: { type: 'preset', preset: '$now' }, label: plugin.string.Now })
  }
  return presets
}

function getDirectFieldOptions (
  hierarchy: Hierarchy,
  allAttrs: AnyAttribute[],
  attr: AnyAttribute,
  type: 'this' | 'parent'
): ContextOption[] {
  const items: ContextOption[] = []
  allAttrs.forEach((srcAttr) => {
    if (type === 'this' && srcAttr._id === attr._id) return
    if (isExcludedAttribute(srcAttr)) return
    const compat = isAttributeCompatible(hierarchy, srcAttr, attr)
    if (compat.compatible && compat.functions == null) {
      items.push({
        id: `${type}.${srcAttr._id}`,
        value: {
          type,
          attribute: srcAttr._id,
          fieldKey: srcAttr.name,
          mixin: srcAttr.attributeOf
        },
        label: srcAttr.label
      })
    }
  })
  return items
}

function getConversionGroupOptions (
  client: Client,
  hierarchy: Hierarchy,
  allAttrs: AnyAttribute[],
  attr: AnyAttribute
): ContextOption[] {
  const functionGroups = new Map<
  string,
  { label: IntlString, thisItems: ContextOption[], parentItems: ContextOption[] }
  >()

  const collectConvertibleItems = (srcAttr: AnyAttribute, isParent: boolean): void => {
    if (!isParent && srcAttr._id === attr._id) return
    if (isExcludedAttribute(srcAttr)) return
    const compat = isAttributeCompatible(hierarchy, srcAttr, attr)
    if (compat.compatible && compat.functions != null && compat.functions.length > 0) {
      const funcCall = compat.functions[0]
      const funcRef = funcCall.func
      const funcDoc = client.getModel().getObject(funcRef)
      const funcLabel = funcDoc?.label ?? getEmbeddedLabel(funcRef)
      const groupKey = funcRef.toString()

      if (!functionGroups.has(groupKey)) {
        functionGroups.set(groupKey, { label: funcLabel, thisItems: [], parentItems: [] })
      }

      const type = isParent ? 'parent' : 'this'
      const item: ContextOption = {
        id: `${type}.${srcAttr._id}`,
        value: {
          type,
          attribute: srcAttr._id,
          fieldKey: srcAttr.name,
          mixin: srcAttr.attributeOf,
          functions: compat.functions
        },
        label: srcAttr.label,
        ...(isParent ? { isParent: true } : {})
      }

      const group = functionGroups.get(groupKey)
      if (isParent) {
        group?.parentItems.push(item)
      } else {
        group?.thisItems.push(item)
      }
    }
  }

  allAttrs.forEach((srcAttr) => {
    collectConvertibleItems(srcAttr, false)
  })
  allAttrs.forEach((srcAttr) => {
    collectConvertibleItems(srcAttr, true)
  })

  const groupOptions: ContextOption[] = []
  functionGroups.forEach((group, funcKey) => {
    if (group.thisItems.length > 0 && group.parentItems.length > 0) {
      group.parentItems[0].separatorBefore = true
    }
    const children: ContextOption[] = [...group.thisItems, ...group.parentItems]

    if (children.length > 0) {
      groupOptions.push({
        id: `func.${funcKey}`,
        label: group.label,
        children
      })
    }
  })

  return groupOptions
}

export function getContextOptions (client: Client, taskType: TaskType, attr?: AnyAttribute): ContextOption[] {
  if (attr == null) return []
  const hierarchy = client.getHierarchy()
  const options: ContextOption[] = []

  // 1. Preset System Constants ($currentUser, $now)
  const presets = getPresetOptions(client, attr)
  options.push(...presets)

  // 2. Gather all attributes from class and mixins
  const allAttrs = getAllClassAttributes(hierarchy, taskType.targetClass)

  // 3. Direct Current Task Fields Submenu Group (ThisTaskField ►)
  const thisDirectItems = getDirectFieldOptions(hierarchy, allAttrs, attr, 'this')
  if (thisDirectItems.length > 0) {
    options.push({
      id: 'thisTaskGroup',
      label: plugin.string.Fields,
      children: thisDirectItems,
      separatorBefore: options.length > 0
    })
  }

  // 4. Direct Parent Task Fields Submenu Group (Parent ►)
  const parentDirectItems = getDirectFieldOptions(hierarchy, allAttrs, attr, 'parent')
  if (parentDirectItems.length > 0) {
    options.push({
      id: 'parentGroup',
      label: plugin.string.Parent,
      children: parentDirectItems,
      separatorBefore: options.length > 0
    })
  }

  // 5. Conversion Submenu Groups
  const conversionGroups = getConversionGroupOptions(client, hierarchy, allAttrs, attr)
  if (conversionGroups.length > 0) {
    conversionGroups[0].separatorBefore = options.length > 0
    options.push(...conversionGroups)
  }

  return options
}

export function getTransformOptions (client: Client, attr?: AnyAttribute): TransformOption[] {
  if (attr == null) return []
  const hierarchy = client.getHierarchy()
  if (hierarchy.isDerived(attr.type._class, core.class.Collection)) return []
  const allFuncs: WorkflowValueFunction[] = client
    .getModel()
    .findAllSync<WorkflowValueFunction>(workflow.class.WorkflowValueFunction, {})
  const attrClass = attr.type?._class

  if (attrClass == null) return []

  const transformFuncs = allFuncs.filter((fn: WorkflowValueFunction) => {
    if (fn.type !== 'transform') return false
    return fn.of === attrClass || hierarchy.isDerived(attrClass, fn.of)
  })

  return transformFuncs.map((fn: WorkflowValueFunction) => ({
    id: fn._id,
    label: fn.label,
    value: { type: 'preset', func: fn._id } as any,
    funcRef: fn._id,
    editor: fn.editor
  }))
}

export function isCollectionAttribute (h: Hierarchy, attr: AnyAttribute): boolean {
  return h.isDerived(attr.type._class, core.class.Collection) || h.isDerived(attr.type._class, core.class.ArrOf)
}

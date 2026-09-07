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
  type AnyAttribute,
  ArrOf,
  type Class,
  ClassifierKind,
  Doc,
  type Enum,
  EnumOf,
  type Hierarchy,
  type PropertyType,
  type Ref,
  RefTo,
  type Status,
  type StatusCategory,
  type TxOperations,
  type Type
} from '@hcengineering/core'
import { getEmbeddedLabel, type IntlString } from '@hcengineering/platform'
import task, { type TaskType } from '@hcengineering/task'

import workflow from '../plugin'
import type { Screen, ScreenField, ScreenTab } from '../schema'

import type {
  AttributeCompatibilityItem,
  AttributeConfig,
  AttributeUsageSource,
  ScreenCompatibilityItem,
  ScreenConfig,
  ScreenResolutionConfig,
  StatusCompatibilityItem,
  StatusConfig,
  TransitionCompatibilityItem,
  WorkflowCompatibilityReport,
  WorkflowConfig
} from './types'
import { extractRuleFieldReferences, getEnumRefFromType } from './utils'

/**
 * Checks a workflow configuration for compatibility against a target TaskType (statuses & attributes).
 */
export async function checkWorkflowCompatibility (
  client: TxOperations,
  config: WorkflowConfig,
  targetTaskTypeId: Ref<TaskType>
): Promise<WorkflowCompatibilityReport> {
  const targetTaskType = await client.findOne(task.class.TaskType, { _id: targetTaskTypeId })
  if (targetTaskType == null) {
    throw new Error(`Target task type "${targetTaskTypeId}" not found`)
  }

  const statuses = await checkStatusesCompatibility(client, config, targetTaskType)
  const attributes = checkAttributesCompatibility(client, config, targetTaskType)
  const transitions = extractTransitionsReport(config)
  const screens = await checkScreensCompatibility(client, config, targetTaskType)
  const hasScreens = hasScreensInConfig(config)

  return {
    statuses,
    attributes,
    transitions,
    screens: screens.length > 0 ? screens : undefined,
    hasScreens
  }
}

/**
 * Checks screens in the workflow config against existing screens in the target project type using structure/signature matching.
 */
async function checkScreensCompatibility (
  client: TxOperations,
  config: WorkflowConfig,
  targetTaskType: TaskType
): Promise<ScreenCompatibilityItem[]> {
  const existingScreens = await client.findAll(workflow.class.Screen, { projectType: targetTaskType.parent })
  const existingByName = new Map<string, (typeof existingScreens)[0]>()
  for (const s of existingScreens) {
    existingByName.set(s.name.toLowerCase(), s)
  }

  const screenIds = Array.from(new Set(existingScreens.map((s) => s._id)))
  const existingTabs =
    screenIds.length > 0 ? await client.findAll(workflow.class.ScreenTab, { attachedTo: { $in: screenIds } }) : []

  const tabIds = Array.from(new Set(existingTabs.map((t) => t._id)))
  const existingFields =
    tabIds.length > 0 ? await client.findAll(workflow.class.ScreenField, { attachedTo: { $in: tabIds } }) : []

  const hierarchy = client.getHierarchy()
  const allAttributes = hierarchy.getAllAttributes(targetTaskType.targetClass, core.class.Doc)
  const attrById = new Map<Ref<AnyAttribute>, AnyAttribute>()
  for (const attr of allAttributes.values()) {
    attrById.set(attr._id, attr)
  }

  const tabsByScreen = new Map<Ref<Screen>, ScreenTab[]>()
  for (const t of existingTabs) {
    const list = tabsByScreen.get(t.attachedTo) ?? []
    list.push(t)
    tabsByScreen.set(t.attachedTo, list)
  }

  const fieldsByTab = new Map<Ref<ScreenTab>, ScreenField[]>()
  for (const f of existingFields) {
    const list = fieldsByTab.get(f.attachedTo) ?? []
    list.push(f)
    fieldsByTab.set(f.attachedTo, list)
  }

  function isScreenSignatureMatch (sc: ScreenConfig, existing: Screen): boolean {
    if (sc.targetClass !== undefined && existing.targetClass !== undefined && sc.targetClass !== existing.targetClass) {
      return false
    }

    const impTabs = sc.tabs ?? []
    const extTabs = tabsByScreen.get(existing._id) ?? []
    if (impTabs.length !== extTabs.length) return false

    for (let i = 0; i < impTabs.length; i++) {
      const impTab = impTabs[i]
      const extTab = extTabs[i]
      if (impTab.name.trim().toLowerCase() !== extTab.name.trim().toLowerCase()) {
        return false
      }

      const impFields = impTab.fields ?? []
      const extFields = fieldsByTab.get(extTab._id) ?? []
      if (impFields.length !== extFields.length) return false

      for (let j = 0; j < impFields.length; j++) {
        const impField = impFields[j]
        const extField = extFields[j]
        const impKey = (impField.fieldKey ?? (impField.attribute as string)).trim().toLowerCase()
        const extKey = (extField.fieldKey ?? attrById.get(extField.attribute)?.name ?? (extField.attribute as string))
          .trim()
          .toLowerCase()
        if (impKey !== extKey) return false
        if (Boolean(impField.required) !== Boolean(extField.required)) return false
      }
    }
    return true
  }

  const result: ScreenCompatibilityItem[] = []
  for (const sc of config.screens ?? []) {
    let totalFields = 0
    for (const t of sc.tabs ?? []) {
      totalFields += t.fields?.length ?? 0
    }

    // 1. Try exact signature match with the same name first
    let match = existingScreens.find(
      (s) => s.name.trim().toLowerCase() === sc.name.trim().toLowerCase() && isScreenSignatureMatch(sc, s)
    )
    // 2. If not found, try any exact signature match
    if (match === undefined) {
      match = existingScreens.find((s) => isScreenSignatureMatch(sc, s))
    }

    const existingByNameDoc = existingByName.get(sc.name.toLowerCase())
    const isExactMatch = match !== undefined
    const isExisting = isExactMatch || existingByNameDoc !== undefined

    result.push({
      sourceScreenId: sc.id,
      name: sc.name,
      targetClass: sc.targetClass,
      description: sc.description,
      tabsCount: sc.tabs?.length ?? 0,
      fieldsCount: totalFields,
      isExisting,
      existingScreenId: match?._id ?? existingByNameDoc?._id,
      isExactMatch,
      matchingScreenId: match?._id,
      matchingScreenName: match?.name
    })
  }
  return result
}

/**
 * Collects unique status IDs referenced in initialStatuses and transitions of all workflows.
 */
function collectSourceStatusIds (config: WorkflowConfig): Set<Ref<Status>> {
  const ids = new Set<Ref<Status>>()
  if (Array.isArray(config.statuses)) {
    for (const s of config.statuses) {
      if (s?.id !== undefined) ids.add(s.id)
    }
  }
  for (const wf of config.workflows) {
    for (const s of wf.initialStatuses ?? []) ids.add(s)
    for (const t of wf.transitions ?? []) {
      if (t.to !== undefined) ids.add(t.to)
      for (const f of t.from ?? []) ids.add(f)
    }
  }
  return ids
}

/**
 * Matches source status IDs against target task type statuses using a 3-tier strategy (ID -> Name -> Category).
 */
async function checkStatusesCompatibility (
  client: TxOperations,
  config: WorkflowConfig,
  targetTaskType: TaskType
): Promise<StatusCompatibilityItem[]> {
  const allWorkspaceStatuses = await client.findAll(core.class.Status, {})
  const allCategories = await client.findAll(core.class.StatusCategory, {})
  const categoryOrderMap = new Map<Ref<StatusCategory>, number>()
  for (const cat of allCategories) {
    categoryOrderMap.set(cat._id, cat.order)
  }

  const workspaceStatusById = new Map<Ref<Status>, Status>()
  const workspaceStatusByName = new Map<string, Status>()
  for (const st of allWorkspaceStatuses) {
    workspaceStatusById.set(st._id, st)
    if (!workspaceStatusByName.has(st.name)) {
      workspaceStatusByName.set(st.name, st)
    }
  }

  const targetStatusIds = targetTaskType.statuses ?? []
  const targetStatusDocs = targetStatusIds
    .map((id) => workspaceStatusById.get(id))
    .filter((s): s is Status => s !== undefined)

  const configStatusById = new Map<Ref<Status>, StatusConfig>()
  const configStatusByName = new Map<string, StatusConfig>()
  const configStatusOrder = new Map<Ref<Status>, number>()
  if (Array.isArray(config.statuses)) {
    config.statuses.forEach((sc, idx) => {
      configStatusById.set(sc.id, sc)
      configStatusByName.set(sc.name, sc)
      configStatusOrder.set(sc.id, idx)
    })
  }

  const sourceStatusIds = Array.from(collectSourceStatusIds(config))

  // Sort source status IDs to preserve:
  // 1) Category order
  // 2) Original order from config.statuses (or task type status order)
  sourceStatusIds.sort((a, b) => {
    const stConfigA = configStatusById.get(a) ?? configStatusByName.get(a as string)
    const stDocA = workspaceStatusById.get(a) ?? workspaceStatusByName.get(a as string)
    const catA = stConfigA?.category ?? stDocA?.category
    const catOrderA = catA !== undefined ? (categoryOrderMap.get(catA) ?? 9999) : 9999

    const stConfigB = configStatusById.get(b) ?? configStatusByName.get(b as string)
    const stDocB = workspaceStatusById.get(b) ?? workspaceStatusByName.get(b as string)
    const catB = stConfigB?.category ?? stDocB?.category
    const catOrderB = catB !== undefined ? (categoryOrderMap.get(catB) ?? 9999) : 9999

    if (catOrderA !== catOrderB) {
      return catOrderA - catOrderB
    }

    const idxA = configStatusOrder.get(a)
    const idxB = configStatusOrder.get(b)
    if (idxA !== undefined && idxB !== undefined) {
      return idxA - idxB
    }
    if (idxA !== undefined) return -1
    if (idxB !== undefined) return 1

    const nameA = stConfigA?.name ?? stDocA?.name ?? (a as string)
    const nameB = stConfigB?.name ?? stDocB?.name ?? (b as string)
    return nameA.localeCompare(nameB)
  })

  // Multi-pass matching: Exact ID -> Exact Name -> Category
  const matchedTargetBySourceId = new Map<Ref<Status>, Ref<Status>>()
  const usedTargetStatusIds = new Set<Ref<Status>>()

  // Pass 1: Match by ID
  for (const sourceStatusId of sourceStatusIds) {
    const matchedDoc = targetStatusDocs.find((t) => !usedTargetStatusIds.has(t._id) && t._id === sourceStatusId)
    if (matchedDoc !== undefined) {
      matchedTargetBySourceId.set(sourceStatusId, matchedDoc._id)
      usedTargetStatusIds.add(matchedDoc._id)
    }
  }

  // Pass 2: Match by exact Name (case-insensitive)
  for (const sourceStatusId of sourceStatusIds) {
    if (matchedTargetBySourceId.has(sourceStatusId)) continue
    const stConfig = configStatusById.get(sourceStatusId) ?? configStatusByName.get(sourceStatusId as string)
    const stDoc = workspaceStatusById.get(sourceStatusId) ?? workspaceStatusByName.get(sourceStatusId as string)
    const sourceName = (stConfig?.name ?? stDoc?.name ?? (sourceStatusId as string)).trim().toLowerCase()
    if (sourceName !== '') {
      const matchedDoc = targetStatusDocs.find(
        (t) => !usedTargetStatusIds.has(t._id) && t.name.trim().toLowerCase() === sourceName
      )
      if (matchedDoc !== undefined) {
        matchedTargetBySourceId.set(sourceStatusId, matchedDoc._id)
        usedTargetStatusIds.add(matchedDoc._id)
      }
    }
  }

  // Pass 3: Match by Category (first available from same category in target status list)
  for (const sourceStatusId of sourceStatusIds) {
    if (matchedTargetBySourceId.has(sourceStatusId)) continue
    const stConfig = configStatusById.get(sourceStatusId) ?? configStatusByName.get(sourceStatusId as string)
    const stDoc = workspaceStatusById.get(sourceStatusId) ?? workspaceStatusByName.get(sourceStatusId as string)
    const sourceCategory = stConfig?.category ?? stDoc?.category
    if (sourceCategory !== undefined) {
      const matchedDoc = targetStatusDocs.find((t) => !usedTargetStatusIds.has(t._id) && t.category === sourceCategory)
      if (matchedDoc !== undefined) {
        matchedTargetBySourceId.set(sourceStatusId, matchedDoc._id)
        usedTargetStatusIds.add(matchedDoc._id)
      }
    }
  }

  const result: StatusCompatibilityItem[] = []
  for (const sourceStatusId of sourceStatusIds) {
    const stConfig = configStatusById.get(sourceStatusId) ?? configStatusByName.get(sourceStatusId as string)
    const stDoc = workspaceStatusById.get(sourceStatusId) ?? workspaceStatusByName.get(sourceStatusId as string)
    const sourceName = stConfig?.name ?? stDoc?.name ?? (sourceStatusId as string)
    const sourceCategory = stConfig?.category ?? stDoc?.category
    const sourceColor = stConfig?.color ?? stDoc?.color ?? 0
    const targetStatusId = matchedTargetBySourceId.get(sourceStatusId)

    result.push({
      sourceStatusId,
      sourceName,
      sourceColor,
      sourceCategory,
      isMatched: targetStatusId !== undefined,
      targetStatusId
    })
  }

  return result
}

interface FieldUsage {
  sourceAttributeId: Ref<AnyAttribute>
  label: IntlString
  ruleTypes: Set<AttributeUsageSource>
}

/**
 * Collects all field references from screens and rule properties across the workflow configuration.
 */
export function collectAttributeUsages (
  config: WorkflowConfig,
  screenResolutions?: Record<string, ScreenResolutionConfig>
): Map<string, FieldUsage> {
  const attributeMap = new Map<string, FieldUsage>()

  const addFieldRef = (
    fieldKey: string,
    attributeId: Ref<AnyAttribute> | undefined,
    ruleType: AttributeUsageSource,
    label?: IntlString
  ): void => {
    if (fieldKey.length === 0) return
    const attrId = attributeId ?? (fieldKey as Ref<AnyAttribute>)
    const lbl = label ?? getEmbeddedLabel(fieldKey)
    const existing = attributeMap.get(fieldKey)
    if (existing !== undefined) {
      existing.ruleTypes.add(ruleType)
      if (attributeId !== undefined) {
        existing.sourceAttributeId = attributeId
      }
      if (label !== undefined) existing.label = label
    } else {
      attributeMap.set(fieldKey, {
        sourceAttributeId: attrId,
        label: lbl,
        ruleTypes: new Set([ruleType])
      })
    }
  }

  for (const sc of config.screens ?? []) {
    const screenRes = screenResolutions?.[sc.id] ?? screenResolutions?.[sc.name]
    if (screenRes?.action === 'skip') {
      continue
    }
    for (const tab of sc.tabs ?? []) {
      for (const f of tab.fields ?? []) {
        addFieldRef(f.fieldKey, f.attribute, 'ScreenField')
      }
    }
  }

  for (const wf of config.workflows) {
    for (const t of wf.transitions ?? []) {
      for (const r of [...(t.validators ?? []), ...(t.postFunctions ?? [])]) {
        for (const f of extractRuleFieldReferences(r.rule, r.props)) {
          addFieldRef(f.fieldKey, f.attribute, r.rule)
        }
      }
    }
  }

  return attributeMap
}

/**
 * Checks whether an attribute type is resolvable within the current workspace hierarchy.
 */
export function isAttributeTypeResolvable (
  hierarchy: Hierarchy,
  type: Type<PropertyType> | undefined,
  visited = new Set<Type<PropertyType>>()
): boolean {
  if (type === undefined) return true
  if (visited.has(type)) return true
  visited.add(type)

  try {
    if (type._class === core.class.RefTo) {
      const to = (type as RefTo<Doc>).to
      if (to !== undefined && !hierarchy.hasClass(to)) {
        return false
      }
    }
    if (type._class === core.class.EnumOf) {
      // Enums are documents in Model space and are created on import if missing
      return true
    }
    if (type._class === core.class.ArrOf) {
      const of = (type as ArrOf<Doc>).of
      return isAttributeTypeResolvable(hierarchy, of, visited)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Checks whether two attribute types are strictly compatible.
 */
export function isAttributeTypeCompatible (
  hierarchy: Hierarchy,
  sourceType: Type<PropertyType> | undefined,
  targetType: Type<PropertyType> | undefined,
  visited = new Set<Ref<Class<Doc>>>(),
  enumMapping?: Map<Ref<Enum>, Ref<Enum>>
): boolean {
  if (sourceType === undefined || targetType === undefined) {
    return true
  }
  if (sourceType._class !== targetType._class) {
    return false
  }
  try {
    // RefTo comparison
    if (sourceType._class === core.class.RefTo) {
      const srcTo = (sourceType as RefTo<Doc>).to
      const tgtTo = (targetType as RefTo<Doc>).to
      if (srcTo !== undefined && tgtTo !== undefined) {
        return srcTo === tgtTo || hierarchy.isDerived(srcTo, tgtTo)
      }
    }
    // EnumOf comparison
    if (sourceType._class === core.class.EnumOf) {
      const srcOf = (sourceType as EnumOf).of
      const tgtOf = (targetType as EnumOf).of
      if (srcOf !== undefined && tgtOf !== undefined) {
        if (srcOf === tgtOf) return true
        if (enumMapping !== undefined && enumMapping.get(srcOf) === tgtOf) return true
        return false
      }
      return true
    }
    // ArrOf comparison
    if (sourceType._class === core.class.ArrOf) {
      const srcOf = (sourceType as ArrOf<Doc>).of
      const tgtOf = (targetType as ArrOf<Doc>).of
      return isAttributeTypeCompatible(hierarchy, srcOf, tgtOf, visited, enumMapping)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Checks attribute compatibility between the workflow config and the target task type class.
 */
function checkAttributesCompatibility (
  client: TxOperations,
  config: WorkflowConfig,
  targetTaskType: TaskType
): AttributeCompatibilityItem[] {
  const hierarchy = client.getHierarchy()
  const targetClass = targetTaskType.targetClass
  const allTargetAttributes = hierarchy.getAllAttributes(targetClass)
  const attributesByKey = new Map<string, AnyAttribute>()
  const attributesById = new Map<Ref<AnyAttribute>, AnyAttribute>()
  const attributesByLabel = new Map<string, AnyAttribute>()

  const registerAttr = (attr: AnyAttribute): void => {
    attributesByKey.set(attr.name, attr)
    attributesById.set(attr._id, attr)
    if (attr.label !== undefined) {
      attributesByLabel.set(attr.label, attr)
    }
  }

  for (const attr of allTargetAttributes.values()) {
    registerAttr(attr)
  }

  try {
    const descendants = hierarchy.getDescendants(targetClass)
    for (const m of descendants) {
      if (hierarchy.getClass(m).kind === ClassifierKind.MIXIN) {
        for (const attr of hierarchy.getAllAttributes(m).values()) {
          registerAttr(attr)
        }
      }
    }
  } catch {}

  const configAttributeById = new Map<Ref<AnyAttribute>, AttributeConfig>()
  const configAttributeByName = new Map<string, AttributeConfig>()
  for (const ac of config.attributes ?? []) {
    configAttributeById.set(ac.id, ac)
    configAttributeByName.set(ac.name, ac)
  }
  for (const m of config.mixins ?? []) {
    for (const ac of m.attributes ?? []) {
      configAttributeById.set(ac.id, ac)
      configAttributeByName.set(ac.name, ac)
    }
  }

  const attributeUsages = collectAttributeUsages(config)
  const result: AttributeCompatibilityItem[] = []

  for (const [fieldKey, info] of attributeUsages) {
    const attrConfig =
      (info.sourceAttributeId !== undefined ? configAttributeById.get(info.sourceAttributeId) : undefined) ??
      configAttributeByName.get(fieldKey)

    const rawLabel = attrConfig?.label ?? info.label

    const matchedAttr =
      attributesByKey.get(fieldKey) ??
      (info.sourceAttributeId !== undefined ? attributesById.get(info.sourceAttributeId) : undefined) ??
      (rawLabel !== undefined ? attributesByLabel.get(rawLabel) : undefined)

    const sourceType = attrConfig?.type
    const isResolvable = isAttributeTypeResolvable(hierarchy, sourceType)

    const enumMapping = new Map<Ref<Enum>, Ref<Enum>>()
    if (matchedAttr !== undefined) {
      const srcEnum = getEnumRefFromType(sourceType)
      const tgtEnum = getEnumRefFromType(matchedAttr.type)
      if (srcEnum !== undefined && tgtEnum !== undefined) {
        enumMapping.set(srcEnum, tgtEnum)
      }
    }

    const isCompatible =
      isResolvable &&
      matchedAttr !== undefined &&
      isAttributeTypeCompatible(hierarchy, sourceType, matchedAttr.type, new Set(), enumMapping)

    result.push({
      fieldKey,
      sourceAttributeId: info.sourceAttributeId,
      label: matchedAttr?.label ?? attrConfig?.label ?? info.label,
      sourceType,
      ruleTypes: Array.from(info.ruleTypes),
      isMatched: isCompatible,
      targetAttributeId: isCompatible ? matchedAttr?._id : undefined,
      unresolvable: !isResolvable,
      unresolvableReason: !isResolvable ? workflow.string.UnresolvableTypeMissingClass : undefined
    })
  }

  return result
}

/**
 * Extracts flat transition compatibility items for all transitions in the workflow config.
 */
function extractTransitionsReport (config: WorkflowConfig): TransitionCompatibilityItem[] {
  const result: TransitionCompatibilityItem[] = []
  for (const wf of config.workflows) {
    for (const t of wf.transitions ?? []) {
      result.push({
        id: t.id,
        name: t.name,
        from: t.from,
        to: t.to
      })
    }
  }
  return result
}

/**
 * Checks whether the workflow config contains screens directly or references screen requests.
 */
function hasScreensInConfig (config: WorkflowConfig): boolean {
  if (config.screens !== undefined && config.screens.length > 0) {
    return true
  }

  return config.workflows.some((w) =>
    w.transitions?.some((t) => t.requests?.some((r) => r.rule === workflow.request.ScreenRequest))
  )
}

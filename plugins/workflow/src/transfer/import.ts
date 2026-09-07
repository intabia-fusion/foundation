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
  ClassifierKind,
  generateId,
  type AnyAttribute,
  type ArrOf,
  type Class,
  type Doc,
  type EnumOf,
  type Hierarchy,
  type Mixin,
  type PropertyType,
  type Ref,
  SortingOrder,
  type Status,
  type TxOperations,
  type Type
} from '@hcengineering/core'
import { getEmbeddedLabel, type IntlString } from '@hcengineering/platform'
import setting from '@hcengineering/setting'
import task, {
  calculateStatuses,
  createState,
  findStatusAttr,
  makeRank,
  type Project,
  type ProjectType,
  type TaskType
} from '@hcengineering/task'
import tracker from '@hcengineering/tracker'

import workflow from '../plugin'
import type {
  Field,
  FieldListProps,
  Screen,
  UpdateFieldValueConfig,
  UpdateFieldValueProps,
  Workflow,
  WorkflowRule,
  WorkflowRuleConfig,
  WorkflowTransition
} from '../schema'
import { addScreenField, addScreenTab, addTransition, createWorkflow } from '../utils'
import { collectAttributeUsages, isAttributeTypeCompatible, isAttributeTypeResolvable } from './compatibility'
import { findOrCreateEnum, getEnumRefFromType, isArrOfType, isEnumOfType } from './utils'
import {
  AttributeToken,
  NameResolver,
  ScreenToken,
  StatusToken,
  TaskTypeToken,
  buildResolver,
  identifierOf,
  remap,
  requireRef
} from './resolver'
import {
  type AttributeConfig,
  type AttributeResolutionConfig,
  type ImportResult,
  type ProjectWorkflowsConfig,
  type RuleConfig,
  type ScreenConfig,
  type ScreenResolutionConfig,
  type StatusConfig,
  type WorkflowConfig,
  type WorkflowImportResolution,
  type WorkflowMixinConfig,
  WorkflowConfigVersion
} from './types'

type StatusResolver = (sourceId: Ref<Status>) => Ref<Status> | undefined

export function filterAndRemapRuleProps (
  ruleId: Ref<WorkflowRule>,
  props: Record<string, any>,
  attrResolutions: Record<string, AttributeResolutionConfig>,
  targetAttributeById?: Map<Ref<AnyAttribute>, AnyAttribute>,
  screenResolutions?: Record<string, ScreenResolutionConfig>,
  resolver?: NameResolver
): { valid: boolean, props: Record<string, any> } {
  if (ruleId === workflow.request.ScreenRequest) {
    const screenProp =
      (props as { screen?: string, screenId?: string }).screen ?? (props as { screenId?: string }).screenId
    if (screenProp !== undefined && screenResolutions !== undefined) {
      const cleanKey = screenProp.replace('$screen:', '')
      const screenRes = screenResolutions[cleanKey] ?? screenResolutions[screenProp]
      if (screenRes?.action === 'skip') {
        return { valid: false, props }
      }
    }
    return { valid: true, props }
  }

  if (ruleId === workflow.validator.FieldRequired || ruleId === workflow.postFunction.ClearFieldValue) {
    const ruleProps = props as FieldListProps
    if (ruleProps.fields === undefined) {
      return { valid: true, props }
    }

    const filteredFields: Field[] = []
    for (const f of ruleProps.fields) {
      const res = attrResolutions[f.fieldKey]
      if (res?.action === 'skip') {
        continue
      }
      let targetAttr: Ref<AnyAttribute> = f.attribute
      if (res?.action === 'map' && res.targetAttributeId !== undefined) {
        targetAttr = res.targetAttributeId
      } else if (typeof f.attribute === 'string' && f.attribute.startsWith(AttributeToken)) {
        targetAttr =
          resolver?.getRef<AnyAttribute>(AttributeToken, f.attribute.slice(AttributeToken.length)) ?? f.attribute
      } else if (f.attribute === undefined) {
        targetAttr = resolver?.getRef<AnyAttribute>(AttributeToken, f.fieldKey) ?? f.attribute
      }

      const targetKey =
        (res?.action === 'map' && res.targetAttributeId !== undefined
          ? targetAttributeById?.get(res.targetAttributeId)?.name
          : undefined) ??
        targetAttributeById?.get(targetAttr)?.name ??
        f.fieldKey
      filteredFields.push({ ...f, attribute: targetAttr, fieldKey: targetKey })
    }

    if (filteredFields.length === 0) {
      return { valid: false, props }
    }

    return { valid: true, props: { ...props, fields: filteredFields } }
  }

  if (ruleId === workflow.postFunction.UpdateFieldValue) {
    const ruleProps = props as UpdateFieldValueProps
    if (ruleProps.fields === undefined) {
      return { valid: true, props }
    }

    const filteredFields: UpdateFieldValueConfig[] = []
    for (const f of ruleProps.fields) {
      const attrRes = attrResolutions[f.fieldKey]
      if (attrRes?.action === 'skip') {
        continue
      }

      let targetAttr: Ref<AnyAttribute> = f.attribute
      let targetKey: string = f.fieldKey

      if (attrRes?.action === 'map' && attrRes.targetAttributeId !== undefined) {
        targetAttr = attrRes.targetAttributeId
        targetKey = targetAttributeById?.get(attrRes.targetAttributeId)?.name ?? f.fieldKey
      }

      let updatedVal = f.value
      if (f.value.type === 'this' || f.value.type === 'parent') {
        const sourceVal = f.value
        const sourceRes = attrResolutions[sourceVal.fieldKey]
        if (sourceRes?.action === 'skip') {
          continue
        }
        const srcTargetAttr =
          (sourceRes?.action === 'map' && sourceRes.targetAttributeId !== undefined
            ? sourceRes.targetAttributeId
            : undefined) ??
          resolver?.getRef<AnyAttribute>(AttributeToken, sourceVal.attribute) ??
          resolver?.getRef<AnyAttribute>(AttributeToken, sourceVal.fieldKey) ??
          sourceVal.attribute
        const srcTargetKey =
          (sourceRes?.action === 'map' && sourceRes.targetAttributeId !== undefined
            ? targetAttributeById?.get(sourceRes.targetAttributeId)?.name
            : undefined) ??
          targetAttributeById?.get(srcTargetAttr)?.name ??
          sourceVal.fieldKey
        updatedVal = { ...sourceVal, attribute: srcTargetAttr, fieldKey: srcTargetKey }
      }

      filteredFields.push({
        ...f,
        attribute: targetAttr,
        fieldKey: targetKey,
        value: updatedVal
      })
    }

    if (filteredFields.length === 0) {
      return { valid: false, props }
    }

    return { valid: true, props: { ...props, fields: filteredFields } }
  }

  if (ruleId === workflow.validator.SubtaskStatus || ruleId === workflow.validator.ParentStatus) {
    const ruleProps = props as { statuses?: Record<string, Ref<Status>[] | null> }
    if (ruleProps.statuses === undefined) {
      return { valid: true, props }
    }

    const filteredStatuses: Record<string, Ref<Status>[] | null> = {}
    for (const [key, val] of Object.entries(ruleProps.statuses)) {
      if (key.startsWith(TaskTypeToken)) {
        const ttName = key.slice(TaskTypeToken.length)
        const targetRef =
          resolver?.getRef<TaskType>(TaskTypeToken, ttName) ?? resolver?.getRef<TaskType>(TaskTypeToken, key)
        if (targetRef !== undefined) {
          filteredStatuses[targetRef] = val
        }
      } else {
        filteredStatuses[key] = val
      }
    }

    if (Object.keys(filteredStatuses).length === 0) {
      return { valid: false, props }
    }

    return { valid: true, props: { ...props, statuses: filteredStatuses } }
  }

  return { valid: true, props }
}

export function importRules<TRule extends WorkflowRule> (
  rules: RuleConfig<TRule>[] | undefined,
  resolver: NameResolver,
  attrResolutions?: Record<string, AttributeResolutionConfig>,
  targetAttributeById?: Map<Ref<AnyAttribute>, AnyAttribute>,
  screenResolutions?: Record<string, ScreenResolutionConfig>
): WorkflowRuleConfig<TRule>[] | undefined {
  if (rules === undefined || rules.length === 0) return undefined
  const importedRules: WorkflowRuleConfig<TRule>[] = []
  for (const r of rules) {
    let currentProps = r.props ?? {}
    if (attrResolutions !== undefined || screenResolutions !== undefined || targetAttributeById !== undefined) {
      const filtered = filterAndRemapRuleProps(
        r.rule,
        currentProps,
        attrResolutions ?? {},
        targetAttributeById,
        screenResolutions,
        resolver
      )
      if (!filtered.valid) {
        continue
      }
      currentProps = filtered.props
    }
    const unresolved: string[] = []
    const remappedProps = remap(currentProps, resolver.fromToken, unresolved)
    if (unresolved.length > 0) {
      throw new Error(
        `Workflow import: could not resolve rule references: ${unresolved.join(', ')} (unresolved references ${unresolved.join(', ')})`
      )
    }
    importedRules.push({
      id: r.id ?? 'rule-' + generateId(),
      rule: r.rule,
      ruleClass: r.ruleClass,
      props: remappedProps
    })
  }
  return importedRules.length > 0 ? importedRules : undefined
}

/**
 * Builds a strict status resolver matching source statuses against target task type statuses.
 */
function createStatusResolver (
  targetStatusDocs: Status[],
  configStatusById: Map<Ref<Status>, StatusConfig>,
  configStatusByName: Map<string, StatusConfig>,
  resolver?: NameResolver,
  wfRes?: WorkflowImportResolution
): StatusResolver {
  return (sourceId: Ref<Status>): Ref<Status> | undefined => {
    // 1. Explicit mapping in resolution
    if (wfRes?.statusMap?.[sourceId] !== undefined) {
      return wfRes.statusMap[sourceId]
    }
    // 2. Direct ID match in target task type
    if (targetStatusDocs.some((t) => t._id === sourceId)) {
      return sourceId
    }
    // 3. Case-insensitive name match in target task type
    const stConfig = configStatusById.get(sourceId) ?? configStatusByName.get(sourceId)
    const srcName =
      stConfig?.name ??
      (resolver !== undefined && resolver.hasRef(sourceId) ? resolver.getName(sourceId, StatusToken) : undefined) ??
      (sourceId as string)
    if (srcName !== '') {
      const byName = targetStatusDocs.find((t) => t.name.toLowerCase() === srcName.toLowerCase())
      if (byName !== undefined) return byName._id
    }
    // 4. Category match in target task type
    const srcCategory = stConfig?.category
    if (srcCategory !== undefined) {
      const byCat = targetStatusDocs.find((t) => t.category === srcCategory)
      if (byCat !== undefined) return byCat._id
    }
    return undefined
  }
}

/**
 * Generates a unique attribute name on the target class if name already exists.
 */
function getUniqueAttributeName (
  hierarchy: Hierarchy,
  targetClass: Ref<Class<Doc>>,
  baseName: string,
  createdNames: Set<string>
): string {
  if (hierarchy.findAttribute(targetClass, baseName) === undefined && !createdNames.has(baseName)) {
    return baseName
  }
  let counter = 1
  while (
    hierarchy.findAttribute(targetClass, `${baseName}_${counter}`) !== undefined ||
    createdNames.has(`${baseName}_${counter}`)
  ) {
    counter++
  }
  return `${baseName}_${counter}`
}

/**
 * Generates a unique screen name within the project type if name already exists.
 */
async function getUniqueScreenName (
  client: TxOperations,
  projectTypeId: Ref<ProjectType>,
  baseName: string,
  createdScreenNames?: Set<string>
): Promise<string> {
  const existingScreens = await client.findAll(workflow.class.Screen, { projectType: projectTypeId })
  const existingNames = new Set(existingScreens.map((s) => s.name.toLowerCase()))

  if (!existingNames.has(baseName.toLowerCase()) && createdScreenNames?.has(baseName.toLowerCase()) !== true) {
    createdScreenNames?.add(baseName.toLowerCase())
    return baseName
  }

  let counter = 1
  while (
    existingNames.has(`${baseName} (${counter})`.toLowerCase()) ||
    createdScreenNames?.has(`${baseName} (${counter})`.toLowerCase()) === true
  ) {
    counter++
  }
  const result = `${baseName} (${counter})`
  createdScreenNames?.add(result.toLowerCase())
  return result
}

async function resolveAttributeTypeEnums (
  client: TxOperations,
  type: Type<PropertyType> | undefined,
  config: WorkflowConfig,
  attrConfig?: AttributeConfig
): Promise<Type<PropertyType> | undefined> {
  if (type === undefined) return undefined

  const enumRef = getEnumRefFromType(type)
  if (enumRef === undefined) return type

  const enumConfig = config.enums?.find(
    (e) => e.id === enumRef || (attrConfig?.enumName !== undefined && e.name === attrConfig.enumName)
  )
  const enumName = enumConfig?.name ?? attrConfig?.enumName ?? 'CustomEnum'
  const enumValues = enumConfig?.enumValues ?? attrConfig?.enumValues ?? []

  const targetEnumId = await findOrCreateEnum(client, enumName, enumValues)

  if (isEnumOfType(type)) {
    const enumType: EnumOf = {
      ...type,
      of: targetEnumId
    }
    return enumType
  }

  if (isArrOfType(type) && isEnumOfType(type.of)) {
    const enumType: EnumOf = {
      ...type.of,
      of: targetEnumId
    }
    const arrType: ArrOf<string> = {
      ...type,
      of: enumType
    }
    return arrType
  }

  return type
}

/**
 * Registers an existing compatible attribute in resolver and targetAttributeById map.
 */
function bindExistingAttribute (
  existingAttr: AnyAttribute,
  sourceAttrId: Ref<AnyAttribute> | string | undefined,
  name: string,
  resolver: NameResolver,
  targetAttributeById: Map<Ref<AnyAttribute>, AnyAttribute>,
  attrRes?: AttributeResolutionConfig
): void {
  resolver.add(AttributeToken, existingAttr._id, name)
  if (sourceAttrId !== undefined) {
    resolver.setRef(AttributeToken, sourceAttrId as string, existingAttr._id)
  }
  resolver.setRef(AttributeToken, name, existingAttr._id)

  if (sourceAttrId !== undefined) {
    targetAttributeById.set(sourceAttrId as Ref<AnyAttribute>, existingAttr)
  }
  targetAttributeById.set(existingAttr._id, existingAttr)

  if (attrRes !== undefined) {
    attrRes.targetAttributeId = existingAttr._id
    attrRes.action = 'map'
  }
}

/**
 * Creates an attribute document in Model space and registers it in resolver and targetAttributeById map.
 */
async function createAndRegisterAttribute (
  client: TxOperations,
  attributeOf: Ref<Class<Doc>>,
  name: string,
  label: IntlString,
  type: Type<PropertyType> | undefined,
  config: WorkflowConfig,
  attrConfig: AttributeConfig | undefined,
  sourceAttrId: Ref<AnyAttribute> | string | undefined,
  createdAttrNames: Set<string>,
  resolver: NameResolver,
  targetAttributeById: Map<Ref<AnyAttribute>, AnyAttribute>,
  attrRes?: AttributeResolutionConfig
): Promise<Ref<AnyAttribute>> {
  const finalType = (await resolveAttributeTypeEnums(client, type, config, attrConfig)) ?? {
    _class: core.class.TypeString
  }
  const createdAttrId = await client.createDoc(core.class.Attribute, core.space.Model, {
    attributeOf,
    name,
    label,
    type: finalType,
    isCustom: true
  })

  createdAttrNames.add(name)
  resolver.add(AttributeToken, createdAttrId, name)
  if (sourceAttrId !== undefined) {
    resolver.setRef(AttributeToken, sourceAttrId as string, createdAttrId)
  }
  resolver.setRef(AttributeToken, name, createdAttrId)

  const attrDoc = {
    _id: createdAttrId,
    name,
    label,
    type: finalType,
    attributeOf,
    isCustom: true
  } as any

  if (sourceAttrId !== undefined) {
    targetAttributeById.set(sourceAttrId as Ref<AnyAttribute>, attrDoc)
  }
  targetAttributeById.set(createdAttrId, attrDoc)

  if (attrRes !== undefined) {
    attrRes.targetAttributeId = createdAttrId
    attrRes.action = 'map'
  }

  return createdAttrId
}

/**
 * Creates custom mixins and their attributes for an imported workflow's target class.
 */
async function createImportedMixins (
  client: TxOperations,
  targetClassId: Ref<Class<Doc>>,
  mixins: WorkflowMixinConfig[] | undefined,
  config: WorkflowConfig,
  attrResolutions: Record<string, AttributeResolutionConfig>,
  targetAttributeById: Map<Ref<AnyAttribute>, AnyAttribute>,
  mixinIdMapping: Map<Ref<Mixin<Doc>>, Ref<Mixin<Doc>>>,
  resolver: NameResolver,
  createdAttrNames: Set<string>
): Promise<void> {
  if (mixins == null || mixins.length === 0) return

  const hierarchy = client.getHierarchy()
  const existingMixins = await client.findAll(core.class.Class, {
    extends: targetClassId,
    kind: ClassifierKind.MIXIN
  })
  const existingMixinByName = new Map<string, Ref<Mixin<Doc>>>()
  for (const m of existingMixins) {
    if (m.label != null) {
      existingMixinByName.set(String(m.label).toLowerCase(), m._id as Ref<Mixin<Doc>>)
    }
  }

  for (const mixinCfg of mixins) {
    const existingRef =
      existingMixinByName.get(String(mixinCfg.label).toLowerCase()) ??
      (existingMixins.find((m) => m._id === mixinCfg.id)?._id as Ref<Mixin<Doc>> | undefined)

    let mixinDocId: Ref<Mixin<Doc>>
    if (existingRef !== undefined) {
      mixinDocId = existingRef
    } else {
      mixinDocId = generateId<Mixin<Doc>>()
      await client.createDoc(
        core.class.Mixin,
        core.space.Model,
        {
          extends: targetClassId,
          kind: ClassifierKind.MIXIN,
          label: mixinCfg.label,
          icon: mixinCfg.icon,
          color: mixinCfg.color
        },
        mixinDocId
      )

      await client.createMixin(mixinDocId, core.class.Class, core.space.Model, setting.mixin.Editable, {
        value: true
      } as any)
      await client.createMixin(mixinDocId, core.class.Class, core.space.Model, setting.mixin.UserMixin, {})
    }

    mixinIdMapping.set(mixinCfg.id, mixinDocId)

    // Process attributes on this mixin
    for (const attr of mixinCfg.attributes ?? []) {
      const attrRes = attrResolutions[attr.name] ?? attrResolutions[attr.id]
      if (attrRes?.action === 'skip') continue
      if (!isAttributeTypeResolvable(hierarchy, attr.type)) continue

      const existingAttr = hierarchy.findAttribute(mixinDocId, attr.name)
      if (existingAttr !== undefined && isAttributeTypeCompatible(hierarchy, attr.type, existingAttr.type)) {
        bindExistingAttribute(existingAttr, attr.id, attr.name, resolver, targetAttributeById, attrRes)
      } else {
        const finalName =
          existingAttr !== undefined
            ? getUniqueAttributeName(hierarchy, mixinDocId, attr.name, createdAttrNames)
            : attr.name
        const attrLabel = attrRes?.label ?? attr.label ?? getEmbeddedLabel(finalName)
        await createAndRegisterAttribute(
          client,
          mixinDocId,
          finalName,
          attrLabel,
          attr.type,
          config,
          attr,
          attr.id,
          createdAttrNames,
          resolver,
          targetAttributeById,
          attrRes
        )
      }
    }
  }
}

/**
 * Automatically creates or binds custom attributes on the target task type class.
 */
async function autoCreateTargetClassAttributes (
  client: TxOperations,
  targetClass: Ref<Class<Doc>>,
  config: WorkflowConfig,
  attrResolutions: Record<string, AttributeResolutionConfig>,
  targetAttributeById: Map<Ref<AnyAttribute>, AnyAttribute>,
  resolver: NameResolver,
  createdAttrNames: Set<string>,
  screenResolutions?: Record<string, ScreenResolutionConfig>
): Promise<void> {
  const hierarchy = client.getHierarchy()

  const configAttributesMap = new Map<string, AttributeConfig>()
  for (const ac of config.attributes ?? []) {
    configAttributesMap.set(ac.name, ac)
    if (ac.id !== undefined) {
      configAttributesMap.set(ac.id as string, ac)
    }
  }

  const allConfigUsages = collectAttributeUsages(config)
  const activeUsages = collectAttributeUsages(config, screenResolutions)

  for (const [fieldKey, usage] of activeUsages) {
    const attrRes =
      attrResolutions[fieldKey] ??
      (usage.sourceAttributeId !== undefined ? attrResolutions[usage.sourceAttributeId] : undefined)
    if (attrRes?.action === 'skip') continue

    const attrConfig =
      configAttributesMap.get(fieldKey) ??
      (usage.sourceAttributeId !== undefined ? configAttributesMap.get(usage.sourceAttributeId as string) : undefined)
    const attrId = usage.sourceAttributeId ?? (fieldKey as Ref<AnyAttribute>)
    const attrName = attrConfig?.name ?? fieldKey
    const attrType = attrConfig?.type
    const attrLabel = attrRes?.label ?? attrConfig?.label ?? usage.label

    if (
      resolver.getRef(AttributeToken, attrId as string) !== undefined ||
      resolver.getRef(AttributeToken, attrName) !== undefined
    ) {
      continue
    }

    if (!isAttributeTypeResolvable(hierarchy, attrType)) {
      continue
    }

    if (attrRes?.action === 'map' && attrRes.targetAttributeId !== undefined) {
      resolver.setRef(AttributeToken, attrId as string, attrRes.targetAttributeId)
      resolver.setRef(AttributeToken, attrName, attrRes.targetAttributeId)
      continue
    }

    const existingAttr =
      (attrRes?.targetAttributeId !== undefined ? targetAttributeById.get(attrRes.targetAttributeId) : undefined) ??
      hierarchy.findAttribute(targetClass, attrName)
    if (existingAttr !== undefined && isAttributeTypeCompatible(hierarchy, attrType, existingAttr.type)) {
      bindExistingAttribute(existingAttr, attrId, attrName, resolver, targetAttributeById, attrRes)
    } else {
      const finalName =
        existingAttr !== undefined
          ? getUniqueAttributeName(hierarchy, targetClass, attrName, createdAttrNames)
          : attrName
      const finalLabel = attrLabel ?? getEmbeddedLabel(finalName)
      await createAndRegisterAttribute(
        client,
        targetClass,
        finalName,
        finalLabel,
        attrType,
        config,
        attrConfig,
        attrId,
        createdAttrNames,
        resolver,
        targetAttributeById,
        attrRes
      )
    }
  }

  for (const ac of config.attributes ?? []) {
    const attrRes = attrResolutions[ac.name] ?? (ac.id !== undefined ? attrResolutions[ac.id] : undefined)
    if (attrRes?.action === 'skip') continue

    const wasUsedInConfig =
      allConfigUsages.has(ac.name) || (ac.id !== undefined && allConfigUsages.has(ac.id as string))
    const isUsedInActive = activeUsages.has(ac.name) || (ac.id !== undefined && activeUsages.has(ac.id as string))
    if (wasUsedInConfig && !isUsedInActive) {
      continue
    }

    if (
      resolver.getRef(AttributeToken, ac.id as string) !== undefined ||
      resolver.getRef(AttributeToken, ac.name) !== undefined
    ) {
      continue
    }
    if (!isAttributeTypeResolvable(hierarchy, ac.type)) {
      continue
    }
    const existingAttr = hierarchy.findAttribute(targetClass, ac.name)
    if (existingAttr !== undefined && isAttributeTypeCompatible(hierarchy, ac.type, existingAttr.type)) {
      bindExistingAttribute(existingAttr, ac.id, ac.name, resolver, targetAttributeById, attrRes)
    } else {
      const finalName =
        existingAttr !== undefined ? getUniqueAttributeName(hierarchy, targetClass, ac.name, createdAttrNames) : ac.name
      const finalLabel = ac.label ?? getEmbeddedLabel(finalName)
      await createAndRegisterAttribute(
        client,
        targetClass,
        finalName,
        finalLabel,
        ac.type,
        config,
        ac,
        ac.id,
        createdAttrNames,
        resolver,
        targetAttributeById,
        attrRes
      )
    }
  }
}

async function isScreenSignatureMatching (
  client: TxOperations,
  existingScreen: Screen,
  configScreen: ScreenConfig,
  screenTargetClass: Ref<Class<Doc>>,
  attrResolutions: Record<string, AttributeResolutionConfig>,
  targetAttributeById: Map<Ref<AnyAttribute>, AnyAttribute>
): Promise<boolean> {
  const existingTabs = await client.findAll(
    workflow.class.ScreenTab,
    { attachedTo: existingScreen._id },
    { sort: { rank: SortingOrder.Ascending } }
  )
  const configTabs = configScreen.tabs ?? []
  if (existingTabs.length !== configTabs.length) {
    return false
  }

  for (let i = 0; i < existingTabs.length; i++) {
    const et = existingTabs[i]
    const ct = configTabs[i]
    if (et.name !== ct.name) {
      return false
    }

    const existingFields = await client.findAll(
      workflow.class.ScreenField,
      { attachedTo: et._id },
      { sort: { rank: SortingOrder.Ascending } }
    )
    const configFields = ct.fields ?? []
    if (existingFields.length !== configFields.length) {
      return false
    }

    for (let j = 0; j < existingFields.length; j++) {
      const ef = existingFields[j]
      const cf = configFields[j]

      if (ef.required !== cf.required) {
        return false
      }

      const attrRes = attrResolutions[cf.fieldKey]
      const expectedFieldKey =
        (attrRes?.action === 'map' && attrRes.targetAttributeId !== undefined
          ? targetAttributeById.get(attrRes.targetAttributeId)?.name
          : undefined) ?? cf.fieldKey

      if (ef.fieldKey !== expectedFieldKey) {
        return false
      }
    }
  }

  return true
}

async function findMatchingScreen (
  client: TxOperations,
  existingScreens: Screen[],
  sc: ScreenConfig,
  screenTargetClass: Ref<Class<Doc>>,
  attrResolutions: Record<string, AttributeResolutionConfig>,
  targetAttributeById: Map<Ref<AnyAttribute>, AnyAttribute>
): Promise<Screen | undefined> {
  // 1. Try exact signature match with the same name first
  for (const s of existingScreens) {
    if (
      s.name.trim().toLowerCase() === sc.name.trim().toLowerCase() &&
      (await isScreenSignatureMatching(client, s, sc, screenTargetClass, attrResolutions, targetAttributeById))
    ) {
      return s
    }
  }

  // 2. If not found by name, try any exact signature match
  for (const s of existingScreens) {
    if (await isScreenSignatureMatching(client, s, sc, screenTargetClass, attrResolutions, targetAttributeById)) {
      return s
    }
  }

  return undefined
}

/**
 * Imports screens and screen tabs/fields into the target project type.
 */
async function importScreens (
  client: TxOperations,
  projectTypeId: Ref<ProjectType>,
  config: WorkflowConfig,
  targetClass: Ref<Class<Doc>>,
  attrResolutions: Record<string, AttributeResolutionConfig>,
  targetAttributeById: Map<Ref<AnyAttribute>, AnyAttribute>,
  mixinIdMapping: Map<Ref<Mixin<Doc>>, Ref<Mixin<Doc>>>,
  resolver: NameResolver,
  result: ImportResult,
  resolution?: WorkflowImportResolution
): Promise<void> {
  const hierarchy = client.getHierarchy()
  const existingScreens = await client.findAll(workflow.class.Screen, { projectType: projectTypeId })

  for (const sc of config.screens ?? []) {
    const screenRes =
      (sc.id !== undefined ? resolution?.screenResolutions?.[sc.id] : undefined) ??
      resolution?.screenResolutions?.[sc.name]

    if (screenRes?.action === 'skip' || (resolution?.copyScreens === false && screenRes === undefined)) {
      continue
    }

    let screenId: Ref<Screen>

    const screenTargetClass =
      sc.targetClass === tracker.class.Issue || (sc.targetClass as string) === 'tracker:class:Issue'
        ? tracker.class.Issue
        : (targetClass ?? sc.targetClass)

    let isNewScreen = false

    if (screenRes?.targetScreenId !== undefined) {
      screenId = screenRes.targetScreenId
    } else if (screenRes?.action === 'copy' || resolution?.copyScreens === true) {
      const uniqueName = await getUniqueScreenName(client, projectTypeId, sc.name)
      screenId = await client.createDoc(workflow.class.Screen, core.space.Workspace, {
        name: uniqueName,
        description: sc.description,
        projectType: projectTypeId,
        targetClass: screenTargetClass
      })
      isNewScreen = true
    } else {
      // resolution is undefined or screenRes not specified: check signature
      const matchingScreen = await findMatchingScreen(
        client,
        existingScreens,
        sc,
        screenTargetClass,
        attrResolutions,
        targetAttributeById
      )
      if (matchingScreen !== undefined) {
        screenId = matchingScreen._id
      } else {
        const uniqueName = await getUniqueScreenName(client, projectTypeId, sc.name)
        screenId = await client.createDoc(workflow.class.Screen, core.space.Workspace, {
          name: uniqueName,
          description: sc.description,
          projectType: projectTypeId,
          targetClass: screenTargetClass
        })
        isNewScreen = true
      }
    }

    if (isNewScreen) {
      let tabRank = makeRank(undefined, undefined)
      for (const tab of sc.tabs ?? []) {
        const tabId = await addScreenTab(client, screenId, tab.name, tabRank)
        tabRank = makeRank(tabRank, undefined)
        let fieldRank = makeRank(undefined, undefined)
        for (const f of tab.fields ?? []) {
          const attrRes = attrResolutions[f.fieldKey]
          if (attrRes?.action === 'skip') {
            continue
          }
          let attributeRef: Ref<AnyAttribute>
          if (attrRes?.action === 'map' && attrRes.targetAttributeId !== undefined) {
            attributeRef = attrRes.targetAttributeId
          } else if (
            f.attribute !== undefined &&
            hierarchy.findAttribute(screenTargetClass, f.fieldKey)?._id === f.attribute
          ) {
            attributeRef = f.attribute
          } else if (f.attribute !== undefined && targetAttributeById.has(f.attribute)) {
            attributeRef = f.attribute
          } else {
            attributeRef =
              resolver.getRef<AnyAttribute>(AttributeToken, f.attribute) ??
              resolver.getRef<AnyAttribute>(AttributeToken, f.fieldKey) ??
              hierarchy.findAttribute(screenTargetClass, f.fieldKey)?._id ??
              f.attribute
          }
          const fieldKey =
            (attrRes?.action === 'map' && attrRes.targetAttributeId !== undefined
              ? targetAttributeById.get(attrRes.targetAttributeId)?.name
              : undefined) ??
            targetAttributeById.get(attributeRef)?.name ??
            f.fieldKey
          const mixinRef = f.mixin !== undefined ? (mixinIdMapping.get(f.mixin) ?? f.mixin) : undefined
          await addScreenField(
            client,
            tabId,
            {
              attribute: attributeRef,
              fieldKey,
              mixin: mixinRef,
              required: f.required
            },
            fieldRank
          )
          fieldRank = makeRank(fieldRank, undefined)
        }
      }
    }

    result.screens[sc.id] = screenId
    resolver.add(ScreenToken, screenId, sc.name)
  }
}

/**
 * Restores project-to-workflow bindings according to the exported config.
 */
async function restoreProjectWorkflows (
  client: TxOperations,
  projectTypeId: Ref<ProjectType>,
  projectsConfig: ProjectWorkflowsConfig[] | undefined,
  workflowByName: Map<string, Ref<Workflow>>,
  existingByName: Map<string, Workflow>,
  resolver: NameResolver
): Promise<void> {
  if (projectsConfig === undefined || projectsConfig.length === 0) {
    return
  }

  const projects = await client.findAll(task.class.Project, { type: projectTypeId })
  const projectByIdent = new Map<string, Project>(projects.map((p) => [identifierOf(p), p]))
  const hierarchy = client.getHierarchy()
  for (const pw of projectsConfig) {
    const p = (await client.findOne(task.class.Project, { _id: pw.project })) ?? projectByIdent.get(pw.identifier)
    if (p === undefined) {
      throw new Error(`Workflow import: unknown project "${pw.identifier}"`)
    }
    const current = (await client.findOne(task.class.Project, { _id: p._id })) ?? p
    const currentMappings = hierarchy.as(current, workflow.mixin.ProjectWorkflow).workflows ?? {}
    const newMappings: Record<Ref<TaskType>, Ref<Workflow>> = { ...currentMappings }
    for (const [ttName, wfName] of Object.entries(pw.workflows)) {
      const taskTypeId = requireRef<TaskType>(resolver, TaskTypeToken, ttName)
      const workflowId = workflowByName.get(wfName) ?? existingByName.get(wfName)?._id
      if (workflowId === undefined) {
        throw new Error(`Workflow import: unknown workflow "${wfName}"`)
      }
      newMappings[taskTypeId] = workflowId
    }
    if (!hierarchy.hasMixin(current, workflow.mixin.ProjectWorkflow)) {
      await client.createMixin(current._id, current._class, current.space, workflow.mixin.ProjectWorkflow, {
        workflows: newMappings
      })
    } else {
      await client.updateMixin(current._id, current._class, current.space, workflow.mixin.ProjectWorkflow, {
        workflows: newMappings
      })
    }
  }
}

/**
 * Creates workflows, transitions, rules and screens from a config.
 */
export async function importWorkflowConfig (
  client: TxOperations,
  projectTypeId: Ref<ProjectType>,
  config: WorkflowConfig,
  resolution?: WorkflowImportResolution
): Promise<ImportResult> {
  if (config.version !== WorkflowConfigVersion) {
    throw new Error(`Workflow import: unsupported version ${config.version}`)
  }

  const op = client.apply()

  const existingWfs = await client.findAll(workflow.class.Workflow, { projectType: projectTypeId })
  const existingByName = new Map<string, Workflow>(existingWfs.map((w) => [w.name, w]))

  const resolver = await buildResolver(client, projectTypeId)

  // Apply custom task type mappings to resolver
  if (resolution?.taskTypeMap !== undefined) {
    for (const [ttName, ttRef] of Object.entries(resolution.taskTypeMap)) {
      resolver.setRef(TaskTypeToken, ttName, ttRef)
    }
  }
  if (resolution?.statusMap !== undefined) {
    for (const [stName, stRef] of Object.entries(resolution.statusMap)) {
      if (stRef !== undefined) {
        resolver.setRef(StatusToken, stName, stRef)
      }
    }
  }

  // Handle attribute creation on target task type if requested
  const attrResolutions = resolution?.attributeResolutions ?? {}
  let targetTaskType: TaskType | undefined
  if (resolution?.targetTaskTypeId !== undefined) {
    targetTaskType = await client.findOne(task.class.TaskType, { _id: resolution.targetTaskTypeId })
    if (targetTaskType !== undefined) {
      resolver.setRef(TaskTypeToken, targetTaskType.name, targetTaskType._id)
      for (const wf of config.workflows) {
        if (wf.taskTypeName !== undefined && wf.taskTypeName !== '') {
          resolver.setRef(TaskTypeToken, wf.taskTypeName, targetTaskType._id)
        }
      }
    }
  }

  const hierarchy = client.getHierarchy()
  const targetClass = targetTaskType?.targetClass ?? task.class.Task
  const allTargetAttributes = hierarchy.getAllAttributes(targetClass, core.class.Doc)
  const targetAttributeById = new Map<Ref<AnyAttribute>, AnyAttribute>()
  for (const attr of allTargetAttributes.values()) {
    targetAttributeById.set(attr._id, attr)
    resolver.add(AttributeToken, attr._id, attr.name)
    resolver.setRef(AttributeToken, attr.name, attr._id)
  }

  const createdAttrNames = new Set<string>()
  const mixinIdMapping = new Map<Ref<Mixin<Doc>>, Ref<Mixin<Doc>>>()
  if (targetTaskType !== undefined) {
    if (config.mixins !== undefined && config.mixins.length > 0) {
      await createImportedMixins(
        op,
        targetClass,
        config.mixins,
        config,
        attrResolutions,
        targetAttributeById,
        mixinIdMapping,
        resolver,
        createdAttrNames
      )
    }
    await autoCreateTargetClassAttributes(
      op,
      targetClass,
      config,
      attrResolutions,
      targetAttributeById,
      resolver,
      createdAttrNames,
      resolution?.screenResolutions
    )
  }

  const result: ImportResult = { screens: {}, workflows: {}, transitions: {} }

  // Import screens according to screen resolutions
  await importScreens(
    op,
    projectTypeId,
    config,
    targetClass,
    attrResolutions,
    targetAttributeById,
    mixinIdMapping,
    resolver,
    result,
    resolution
  )

  // Pre-index config statuses once
  const configStatusById = new Map<Ref<Status>, StatusConfig>()
  const configStatusByName = new Map<string, StatusConfig>()
  for (const sc of config.statuses ?? []) {
    configStatusById.set(sc.id, sc)
    configStatusByName.set(sc.name, sc)
  }

  const workflowByName = new Map<string, Ref<Workflow>>()
  for (const wf of config.workflows) {
    const wfName = resolution?.name ?? wf.name
    const existing = existingByName.get(wfName)

    const rawTaskType = wf.taskTypeName
    const taskTypeId: Ref<TaskType> =
      resolution?.targetTaskTypeId ??
      (wf.taskTypeId !== undefined && resolution?.taskTypeMap?.[wf.taskTypeId] !== undefined
        ? resolution.taskTypeMap[wf.taskTypeId]
        : undefined) ??
      requireRef<TaskType>(resolver, TaskTypeToken, rawTaskType)

    const workflowId = existing?._id ?? (await createWorkflow(op, projectTypeId, taskTypeId, wfName))
    result.workflows[wf.id] = workflowId
    workflowByName.set(wfName, workflowId)
    workflowByName.set(wf.name, workflowId)

    const currentTaskType = await client.findOne(task.class.TaskType, { _id: taskTypeId })

    if (resolution?.createMissingStatuses === true && currentTaskType !== undefined && config.statuses !== undefined) {
      const existingStatusIds = new Set(currentTaskType.statuses ?? [])
      const updatedStatuses = [...(currentTaskType.statuses ?? [])]
      let taskTypeUpdated = false

      if (resolution.statusMap === undefined) {
        resolution.statusMap = {}
      }

      const statusAttr =
        findStatusAttr(hierarchy, currentTaskType.targetClass) ?? hierarchy.getAttribute(task.class.Task, 'status')

      for (const sc of config.statuses) {
        const mappedTargetId = resolution.statusMap[sc.id]
        if (mappedTargetId === undefined) {
          const createdStatusId = await createState(
            op,
            core.class.Status,
            {
              name: sc.name,
              color: sc.color,
              category: sc.category,
              ofAttribute: statusAttr._id
            },
            sc.id
          )

          if (!existingStatusIds.has(createdStatusId)) {
            updatedStatuses.push(createdStatusId)
            existingStatusIds.add(createdStatusId)
            taskTypeUpdated = true
          }

          resolution.statusMap[sc.id] = createdStatusId
          resolver.setRef(StatusToken, sc.id, createdStatusId)
        }
      }

      if (taskTypeUpdated) {
        await op.updateDoc(task.class.TaskType, core.space.Model, currentTaskType._id, {
          statuses: updatedStatuses
        })
        currentTaskType.statuses = updatedStatuses

        const prjType = await client.findOne(task.class.ProjectType, { _id: projectTypeId })
        if (prjType !== undefined) {
          const allTaskTypes = await client.findAll(task.class.TaskType, { _id: { $in: prjType.tasks } })
          const taskTypeMap = new Map(allTaskTypes.map((tt) => [tt._id, tt]))
          taskTypeMap.set(currentTaskType._id, { ...currentTaskType, statuses: updatedStatuses })
          const calcStatuses = calculateStatuses(prjType, taskTypeMap, [])
          await op.updateDoc(task.class.ProjectType, core.space.Model, prjType._id, {
            statuses: calcStatuses
          })
        }
      }
    }

    let targetStatusDocs: Status[] = []
    if (currentTaskType?.statuses !== undefined && currentTaskType.statuses.length > 0) {
      targetStatusDocs = await client.findAll(core.class.Status, { _id: { $in: currentTaskType.statuses } })
    }

    const resolveStatus = createStatusResolver(
      targetStatusDocs,
      configStatusById,
      configStatusByName,
      resolver,
      resolution
    )

    if (wf.initialStatuses !== undefined) {
      const initialStatuses: Ref<Status>[] = []
      for (const s of wf.initialStatuses) {
        const resolved = resolveStatus(s)
        if (resolved === undefined) {
          if (resolution === undefined) {
            throw new Error(`Workflow import: unknown status "${s}"`)
          }
        } else {
          initialStatuses.push(resolved)
        }
      }
      if (initialStatuses.length > 0) {
        await op.updateDoc(workflow.class.Workflow, core.space.Workspace, workflowId, {
          initialStatuses: Array.from(new Set(initialStatuses))
        })
      }
    }

    const existingTransitions = await client.findAll(workflow.class.WorkflowTransition, { attachedTo: workflowId })
    const existingTransByName = new Map<string, WorkflowTransition>(existingTransitions.map((t) => [t.name, t]))

    let transitionRank = makeRank(undefined, undefined)
    for (const t of wf.transitions ?? []) {
      const tRes = t.id !== undefined ? resolution?.transitionResolutions?.[t.id] : undefined
      if (tRes?.action === 'skip') {
        continue
      }

      let to: Ref<Status> | undefined
      if (tRes?.action === 'redirect' && tRes.targetToStatusId !== undefined) {
        to = tRes.targetToStatusId
      } else {
        to = resolveStatus(t.to)
      }

      if (to === undefined) {
        if (resolution === undefined) {
          throw new Error(`Workflow import: unknown status "${t.to}"`)
        }
        continue
      }

      let from: Ref<Status>[] | null = null
      if (t.from != null) {
        if (t.from.length === 0) {
          from = []
        } else {
          const resolvedFrom: Ref<Status>[] = []
          let hasUnresolved = false
          for (const s of t.from) {
            const resolved = resolveStatus(s)
            if (resolved === undefined) {
              if (resolution === undefined) {
                throw new Error(`Workflow import: unknown status "${s}"`)
              }
              hasUnresolved = true
            } else {
              resolvedFrom.push(resolved)
            }
          }
          if (hasUnresolved && resolution !== undefined) {
            continue
          }
          if (resolvedFrom.length === 0) {
            continue
          }
          from = Array.from(new Set(resolvedFrom))
        }
      }

      const existingTrans = existingTransByName.get(t.name)
      const transitionId = existingTrans?._id ?? (await addTransition(op, workflowId, t.name, from, to, transitionRank))
      transitionRank = makeRank(transitionRank, undefined)
      result.transitions[t.id] = transitionId

      const screenResolutions = resolution?.screenResolutions as Record<string, ScreenResolutionConfig> | undefined
      const importedRequests = importRules(
        t.requests,
        resolver,
        attrResolutions,
        targetAttributeById,
        screenResolutions
      )
      const importedValidators = importRules(
        t.validators,
        resolver,
        attrResolutions,
        targetAttributeById,
        screenResolutions
      )
      const importedPostFunctions = importRules(
        t.postFunctions,
        resolver,
        attrResolutions,
        targetAttributeById,
        screenResolutions
      )

      if (importedRequests !== undefined || importedValidators !== undefined || importedPostFunctions !== undefined) {
        await op.updateCollection(
          workflow.class.WorkflowTransition,
          core.space.Workspace,
          transitionId,
          workflowId,
          workflow.class.Workflow,
          'transitions',
          {
            requests: importedRequests,
            validators: importedValidators,
            postFunctions: importedPostFunctions
          }
        )
      }
    }
  }

  // Restore project mappings if the config has any and projects exist in the workspace
  await restoreProjectWorkflows(op, projectTypeId, config.projects, workflowByName, existingByName, resolver)

  await op.commit()

  return result
}

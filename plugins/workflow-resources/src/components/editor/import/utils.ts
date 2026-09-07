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
  type Class,
  type Doc,
  type Hierarchy,
  type PersonId,
  type PropertyType,
  type Ref,
  type Status,
  type Type
} from '@hcengineering/core'
import { type Asset, getEmbeddedLabel, type IntlString } from '@hcengineering/platform'
import { type TaskType } from '@hcengineering/task'
import workflow, {
  extractRuleFieldReferences,
  type AttributeCompatibilityItem,
  type AttributeConfig,
  type AttributeResolutionConfig,
  type Screen,
  type ScreenCompatibilityItem,
  type ScreenConfig,
  type ScreenResolutionConfig,
  type StatusCompatibilityItem,
  type WorkflowCompatibilityReport,
  type WorkflowConfig,
  type WorkflowRule
} from '@hcengineering/workflow'

import plugin from '../../../plugin'
import { getAttributeIcon } from '../../../utils'

export type ParseConfigResult =
  | { ok: true, config: WorkflowConfig, workflowName: string }
  | { ok: false, error: 'InvalidFormat' | 'ClipboardEmpty' }

/**
 * Validates and parses raw text into a WorkflowConfig.
 */
export function parseWorkflowConfig (text: string, sourceName?: string): ParseConfigResult {
  if (text.trim().length === 0) {
    return { ok: false, error: sourceName === 'Clipboard' ? 'ClipboardEmpty' : 'InvalidFormat' }
  }
  try {
    const json = JSON.parse(text)
    if (
      json == null ||
      typeof json !== 'object' ||
      typeof json.version !== 'number' ||
      !Array.isArray(json.workflows) ||
      json.workflows.length === 0
    ) {
      return { ok: false, error: 'InvalidFormat' }
    }
    const validWorkflows = json.workflows.filter(
      (w: unknown): w is { name: string } =>
        w != null &&
        typeof w === 'object' &&
        'name' in w &&
        typeof (w as { name: unknown }).name === 'string' &&
        (w as { name: string }).name.trim() !== ''
    )
    if (validWorkflows.length === 0) {
      return { ok: false, error: 'InvalidFormat' }
    }
    return { ok: true, config: json as WorkflowConfig, workflowName: validWorkflows[0].name }
  } catch {
    return { ok: false, error: 'InvalidFormat' }
  }
}

/**
 * Computes the initial 1-to-1 status mapping based on report matches and task type statuses.
 */
export function computeInitialStatusMap (
  reportStatuses: StatusCompatibilityItem[],
  targetStatuses: Status[]
): Record<Ref<Status>, Ref<Status> | undefined> {
  const newStatusMap: Record<Ref<Status>, Ref<Status> | undefined> = {}
  const assignedTargetIds = new Set<Ref<Status>>()

  for (const st of reportStatuses) {
    if (st.targetStatusId !== undefined && !assignedTargetIds.has(st.targetStatusId)) {
      newStatusMap[st.sourceStatusId] = st.targetStatusId
      assignedTargetIds.add(st.targetStatusId)
    } else {
      const match = targetStatuses.find(
        (s) => s.name.toLowerCase() === st.sourceName.toLowerCase() && !assignedTargetIds.has(s._id)
      )
      if (match !== undefined) {
        newStatusMap[st.sourceStatusId] = match._id
        assignedTargetIds.add(match._id)
      } else if (st.targetStatusId !== undefined) {
        newStatusMap[st.sourceStatusId] = st.targetStatusId
      }
    }
  }
  return newStatusMap
}

/**
 * Checks if statusMap has duplicate target status assignments.
 */
export function hasDuplicateTargetStatuses (statusMap: Record<Ref<Status>, Ref<Status> | undefined>): boolean {
  const mapped = Object.values(statusMap).filter((id): id is Ref<Status> => id !== undefined)
  return new Set(mapped).size !== mapped.length
}

/**
 * Computes default attribute resolutions (auto-map or auto-create).
 */
export function computeInitialAttributeResolutions (
  reportAttributes: AttributeCompatibilityItem[]
): Record<string, AttributeResolutionConfig> {
  const newAttrRes: Record<string, AttributeResolutionConfig> = {}
  for (const attr of reportAttributes) {
    if (attr.isMatched && attr.targetAttributeId !== undefined) {
      newAttrRes[attr.fieldKey] = {
        action: 'map',
        targetAttributeId: attr.targetAttributeId,
        label: attr.label
      }
    } else {
      newAttrRes[attr.fieldKey] = {
        action: 'create',
        label: attr.label
      }
    }
  }
  return newAttrRes
}

/**
 * Computes default screen resolutions: uses matching screen by signature if found, otherwise defaults to copy.
 */
export function computeInitialScreenResolutions (
  screens: ScreenConfig[] | undefined,
  existingScreens: Screen[],
  screenReport?: ScreenCompatibilityItem[]
): Record<string, ScreenResolutionConfig> {
  const res: Record<string, ScreenResolutionConfig> = {}
  for (const sc of screens ?? []) {
    const reportItem = screenReport?.find((r) => r.sourceScreenId === sc.id || r.name === sc.name)
    if (reportItem?.isExactMatch === true && reportItem.matchingScreenId !== undefined) {
      res[sc.id] = {
        action: 'copy',
        targetScreenId: reportItem.matchingScreenId
      }
    } else {
      res[sc.id] = {
        action: 'copy'
      }
    }
  }
  return res
}

export function getFieldIntlLabel (
  fieldKey: string,
  report: WorkflowCompatibilityReport | null,
  parsedConfig: WorkflowConfig | null,
  targetTaskType: TaskType | undefined,
  hierarchy: Hierarchy,
  attributeRef?: Ref<AnyAttribute>
): IntlString {
  const attrReport = report?.attributes.find(
    (a) => a.fieldKey === fieldKey || (attributeRef !== undefined && a.sourceAttributeId === attributeRef)
  )
  if (attrReport?.label != null && attrReport.label !== '') {
    return attrReport.label
  }
  const attrCfg = parsedConfig?.attributes?.find(
    (a) => a.name === fieldKey || (attributeRef !== undefined && a.id === attributeRef)
  )
  if (attrCfg?.label != null && attrCfg.label !== '') {
    return attrCfg.label
  }
  if (targetTaskType !== undefined) {
    try {
      const fromHierarchy = hierarchy.findAttribute(targetTaskType.targetClass, fieldKey)
      if (fromHierarchy?.label != null && fromHierarchy.label !== '') {
        return fromHierarchy.label
      }
    } catch {}

    try {
      for (const m of hierarchy.getDescendants(targetTaskType.targetClass)) {
        const mixinAttr = hierarchy.findAttribute(m, fieldKey)
        if (mixinAttr?.label != null && mixinAttr.label !== '') {
          return mixinAttr.label
        }
      }
    } catch {}
  }

  for (const sc of parsedConfig?.screens ?? []) {
    for (const tab of sc.tabs ?? []) {
      for (const f of tab.fields ?? []) {
        if (f.fieldKey === fieldKey || (attributeRef !== undefined && f.attribute === attributeRef)) {
          if (f.attribute !== undefined) {
            const byAttrId = parsedConfig?.attributes?.find((a) => a.id === f.attribute)
            if (byAttrId?.label != null && byAttrId.label !== '') {
              return byAttrId.label
            }
          }
        }
      }
    }
  }

  for (const m of parsedConfig?.mixins ?? []) {
    const byMixin = m.attributes?.find(
      (a) => a.name === fieldKey || (attributeRef !== undefined && a.id === attributeRef)
    )
    if (byMixin?.label != null && byMixin.label !== '') {
      return byMixin.label
    }
  }

  return getEmbeddedLabel(fieldKey)
}

export function getTransitionsUsingScreen (
  sc: ScreenConfig,
  parsedConfig: WorkflowConfig | null,
  anyStatusLabel?: string
): string[] {
  const transitionsList: string[] = []
  const cleanScreenId = (sc.id as string).replace('$screen:', '').toLowerCase()
  const cleanScreenName = sc.name.replace('$screen:', '').toLowerCase()

  const statusMap = new Map<string, string>()
  for (const st of parsedConfig?.statuses ?? []) {
    statusMap.set(st.id, st.name)
  }

  for (const wf of parsedConfig?.workflows ?? []) {
    for (const t of wf.transitions ?? []) {
      const checkRule = (r: { props?: Record<string, unknown> } | undefined): boolean => {
        if (r?.props == null) return false
        const screenProp = (r.props.screen ?? r.props.screenId ?? r.props.screenName) as string | undefined
        if (screenProp == null) return false
        const cleanProp = screenProp.replace('$screen:', '').toLowerCase()
        return (
          cleanProp === cleanScreenId ||
          cleanProp === cleanScreenName ||
          cleanProp === (sc.id as string).toLowerCase() ||
          cleanProp === sc.name.toLowerCase()
        )
      }
      if (
        t.requests?.some(checkRule) === true ||
        t.validators?.some(checkRule) === true ||
        t.postFunctions?.some(checkRule) === true
      ) {
        let fromStr = ''
        if (t.from === null || t.from === undefined || t.from.length === 0) {
          fromStr = anyStatusLabel ?? ''
        } else {
          fromStr = t.from.map((f) => statusMap.get(f) ?? (f as string).split(':').pop() ?? f).join(', ')
        }
        const toStr = statusMap.get(t.to) ?? (t.to as string).split(':').pop() ?? t.to

        const transitionLabel =
          t.name !== ''
            ? fromStr !== ''
              ? `«${t.name}» (${fromStr} → ${toStr})`
              : `«${t.name}» (→ ${toStr})`
            : fromStr !== ''
              ? `${fromStr} → ${toStr}`
              : `→ ${toStr}`

        transitionsList.push(transitionLabel)
      }
    }
  }
  return Array.from(new Set(transitionsList))
}

export function getSourceStatusDoc (
  item: StatusCompatibilityItem,
  statusState: { byId: Map<Ref<Status>, Status>, array: Status[] }
): Status | undefined {
  const found =
    statusState.byId.get(item.sourceStatusId) ??
    statusState.array.find((s) => s.name.toLowerCase() === item.sourceName.toLowerCase())
  if (found !== undefined) return found
  if (item.sourceCategory !== undefined) {
    const syntheticStatus: Status = {
      _id: item.sourceStatusId,
      _class: core.class.Status,
      space: core.space.Model,
      modifiedOn: Date.now(),
      modifiedBy: '' as PersonId,
      name: item.sourceName,
      category: item.sourceCategory,
      color: item.sourceColor,
      ofAttribute: '' as unknown as Ref<AnyAttribute>
    }
    return syntheticStatus
  }
  return undefined
}

export interface AttributeUsageLocation {
  type: 'screen' | 'rule'
  screenName?: string
  transitionName?: string
  ruleTitle?: IntlString
}

export function getRuleDisplayName (ruleId: Ref<WorkflowRule>): IntlString {
  if (ruleId === workflow.validator.FieldRequired) {
    return plugin.string.FieldRequiredValidator
  }
  if (ruleId === workflow.postFunction.UpdateFieldValue) {
    return plugin.string.UpdateFieldValuePostFunction
  }
  if (ruleId === workflow.postFunction.ClearFieldValue) {
    return plugin.string.ClearFieldValuePostFunction
  }
  return plugin.string.Transition
}

export function getAttributeUsageLocations (
  fieldKey: string,
  sourceAttributeId: Ref<AnyAttribute> | undefined,
  parsedConfig: WorkflowConfig | null,
  screenResolutions?: Record<string, ScreenResolutionConfig>
): AttributeUsageLocation[] {
  const result: AttributeUsageLocation[] = []
  if (parsedConfig == null) return result

  // 1. Screens
  for (const sc of parsedConfig.screens ?? []) {
    const screenRes = screenResolutions?.[sc.id] ?? screenResolutions?.[sc.name]
    if (screenRes?.action === 'skip') {
      continue
    }
    let usedInScreen = false
    for (const tab of sc.tabs ?? []) {
      for (const f of tab.fields ?? []) {
        if (f.fieldKey === fieldKey || (sourceAttributeId !== undefined && f.attribute === sourceAttributeId)) {
          usedInScreen = true
          break
        }
      }
      if (usedInScreen) break
    }
    if (usedInScreen) {
      result.push({ type: 'screen', screenName: sc.name })
    }
  }

  // 2. Transitions (validators, postFunctions)
  for (const wf of parsedConfig.workflows ?? []) {
    for (const t of wf.transitions ?? []) {
      const checkRuleList = (
        rules: Array<{ rule: Ref<WorkflowRule>, props?: Record<string, unknown> }> | undefined
      ): void => {
        for (const r of rules ?? []) {
          const refs = extractRuleFieldReferences(r.rule, r.props)
          const matches = refs.some(
            (ref) =>
              ref.fieldKey === fieldKey || (sourceAttributeId !== undefined && ref.attribute === sourceAttributeId)
          )
          if (matches) {
            result.push({
              type: 'rule',
              transitionName: t.name,
              ruleTitle: getRuleDisplayName(r.rule)
            })
          }
        }
      }

      checkRuleList(t.validators)
      checkRuleList(t.postFunctions)
    }
  }

  return result
}

export function resolveAttributeItemIcon (
  item: { fieldKey: string, sourceAttributeId?: Ref<AnyAttribute>, sourceType?: Type<PropertyType> },
  parsedConfig: WorkflowConfig | null,
  hierarchy: Hierarchy,
  targetClass?: Ref<Class<Doc>>
): { icon?: Asset, iconProps?: Record<string, unknown> } {
  // 1. Try finding in local hierarchy if attribute exists in targetClass
  if (targetClass != null) {
    const localAttr = hierarchy.findAttribute(targetClass, item.fieldKey)
    if (localAttr != null) {
      return getAttributeIcon(hierarchy, localAttr)
    }
  }

  // 2. Find attribute in parsedConfig
  let attrConfig: AttributeConfig | undefined
  for (const ac of parsedConfig?.attributes ?? []) {
    if (ac.name === item.fieldKey || (item.sourceAttributeId !== undefined && ac.id === item.sourceAttributeId)) {
      attrConfig = ac
      break
    }
  }
  if (attrConfig == null) {
    for (const m of parsedConfig?.mixins ?? []) {
      for (const ac of m.attributes ?? []) {
        if (ac.name === item.fieldKey || (item.sourceAttributeId !== undefined && ac.id === item.sourceAttributeId)) {
          attrConfig = ac
          break
        }
      }
      if (attrConfig != null) break
    }
  }

  const type = item.sourceType ?? attrConfig?.type
  if (type != null) {
    const syntheticAttr: AnyAttribute = {
      _id: (item.sourceAttributeId ?? attrConfig?.id ?? item.fieldKey) as Ref<AnyAttribute>,
      _class: core.class.Attribute,
      space: core.space.Model,
      modifiedOn: 0,
      modifiedBy: '' as PersonId,
      attributeOf: targetClass ?? core.class.Doc,
      name: item.fieldKey,
      label: getEmbeddedLabel(item.fieldKey),
      type
    }

    return getAttributeIcon(hierarchy, syntheticAttr)
  }

  return { icon: core.icon.TypeString }
}

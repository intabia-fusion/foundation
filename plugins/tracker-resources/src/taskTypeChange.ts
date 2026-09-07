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
  type ArrOf,
  type AttachedDoc,
  type Class,
  ClassifierKind,
  type Collection,
  type Doc,
  type DocumentUpdate,
  type EnumOf,
  type Hierarchy,
  type IdMap,
  type Mixin,
  type PropertyType,
  type Ref,
  type RefTo,
  type Status,
  type Type,
  type TxOperations
} from '@hcengineering/core'
import { type ProjectType, type TaskType, type TaskTypeDescriptor } from '@hcengineering/task'
import { type Issue } from '@hcengineering/tracker'

import tracker from './plugin'

export interface LostAttribute {
  key: string
  attribute: AnyAttribute
  value: any
}

export interface TaskTypeChangePlan {
  /**
   * Attributes the target type does not carry. Their values stay on the document — hidden under the
   * new type, but back again if the type is switched back — so this only drives the warning.
   */
  lost: LostAttribute[]
  /** Attributes only the target type declares, filled with their default value. */
  defaults: Record<string, any>
}

export function getTaskTypeAttributes (
  hierarchy: Hierarchy,
  _class: Ref<Class<Doc>>,
  baseClass: Ref<Class<Doc>> = tracker.class.Issue
): Map<string, AnyAttribute> {
  if (!hierarchy.hasClass(_class) || _class === baseClass) {
    return new Map()
  }
  return hierarchy.getAllAttributes(_class, baseClass)
}

export function isCompatibleAttribute (a: AnyAttribute, b: AnyAttribute): boolean {
  return isCompatibleType(a.type, b.type)
}

function isCompatibleType (a: Type<PropertyType>, b: Type<PropertyType>): boolean {
  if (a._class !== b._class) {
    return false
  }

  switch (a._class) {
    case core.class.RefTo:
      return (a as RefTo<Doc>).to === (b as RefTo<Doc>).to
    case core.class.Collection:
      return (a as Collection<AttachedDoc>).of === (b as Collection<AttachedDoc>).of
    case core.class.EnumOf:
      return (a as EnumOf).of === (b as EnumOf).of
    // `of` is a nested type here, not a ref, so it has to be compared the same way again.
    case core.class.ArrOf:
      return isCompatibleType((a as ArrOf<PropertyType>).of, (b as ArrOf<PropertyType>).of)
    default:
      return true
  }
}

/**
 * A task type's custom attributes live both on its target class and on mixins stamped onto the
 * document, and `getAllAttributes` only walks the class chain.
 */
function getMixinAttributes (
  hierarchy: Hierarchy,
  issue: Issue
): Array<{ key: string, attribute: AnyAttribute, value: any }> {
  const result: Array<{ key: string, attribute: AnyAttribute, value: any }> = []

  for (const id of hierarchy.getDescendants(core.class.Doc)) {
    if (hierarchy.findClass(id)?.kind !== ClassifierKind.MIXIN) continue

    const mixin = id as Ref<Mixin<Doc>>
    if (!hierarchy.hasMixin(issue, mixin)) continue

    const data = hierarchy.as(issue, mixin) as any
    for (const [key, attribute] of hierarchy.getOwnAttributes(mixin)) {
      if (attribute.hidden === true) continue
      result.push({ key, attribute, value: data?.[key] })
    }
  }

  return result
}

export function buildTaskTypeChangePlan (hierarchy: Hierarchy, issue: Issue, targetType: TaskType): TaskTypeChangePlan {
  const targetClass = getTargetClass(hierarchy, targetType)
  const oldAttrs = getTaskTypeAttributes(hierarchy, issue._class)
  const newAttrs = getTaskTypeAttributes(hierarchy, targetClass)

  const lost: LostAttribute[] = []
  const defaults: Record<string, any> = {}

  for (const [key, attribute] of oldAttrs) {
    const target = newAttrs.get(key)
    if (target !== undefined && isCompatibleAttribute(attribute, target)) {
      continue
    }
    lost.push({ key, attribute, value: (issue as any)[key] })
  }

  for (const { key, attribute, value } of getMixinAttributes(hierarchy, issue)) {
    const target = newAttrs.get(key)
    if (target !== undefined && isCompatibleAttribute(attribute, target)) {
      continue
    }
    lost.push({ key, attribute, value })
  }

  for (const [key, attribute] of newAttrs) {
    if (oldAttrs.has(key)) continue
    if (attribute.defaultValue !== undefined) {
      defaults[key] = attribute.defaultValue
    }
  }

  return { lost, defaults }
}

export function getTargetClass (hierarchy: Hierarchy, taskType: TaskType): Ref<Class<Doc>> {
  return taskType.targetClass != null && hierarchy.hasClass(taskType.targetClass)
    ? taskType.targetClass
    : (taskType.ofClass ?? tracker.class.Issue)
}

export function getReportableLostAttributes (plan: TaskTypeChangePlan): LostAttribute[] {
  return plan.lost.filter((it) => it.value !== undefined && it.value !== null)
}

export function buildTaskTypeChangeUpdate (
  plan: TaskTypeChangePlan,
  targetType: TaskType,
  status: Ref<Status>,
  currentStatus: Ref<Status>
): DocumentUpdate<Issue> {
  const update: DocumentUpdate<Issue> = {
    kind: targetType._id
  }

  if (status !== currentStatus) {
    update.status = status
  }

  for (const [key, value] of Object.entries(plan.defaults)) {
    ;(update as any)[key] = value
  }

  return update
}

export async function changeIssueTaskType (
  client: TxOperations,
  issue: Issue,
  targetType: TaskType,
  status: Ref<Status>
): Promise<void> {
  if (issue.kind === targetType._id) {
    return
  }
  const plan = buildTaskTypeChangePlan(client.getHierarchy(), issue, targetType)
  const update = buildTaskTypeChangeUpdate(plan, targetType, status, issue.status)

  await client.updateDoc(issue._class, issue.space, issue._id, update)
}

export function getSelectableTaskTypes (
  hierarchy: Hierarchy,
  taskTypes: IdMap<TaskType>,
  projectType: Ref<ProjectType> | undefined,
  descriptorAllowsCreate: (descriptor: Ref<Doc>) => boolean
): TaskType[] {
  if (projectType === undefined) return []
  return Array.from(taskTypes.values()).filter(
    (it) =>
      it.parent === projectType &&
      descriptorAllowsCreate(it.descriptor) &&
      hierarchy.isDerived(it.targetClass, tracker.class.Issue)
  )
}

export function hasAlternativeTaskTypes (
  hierarchy: Hierarchy,
  taskTypes: IdMap<TaskType>,
  projectType: Ref<ProjectType> | undefined,
  descriptors: TaskTypeDescriptor[]
): boolean {
  return getTaskTypeChoices(hierarchy, taskTypes, projectType, descriptors).length > 1
}

export function getTaskTypeChoices (
  hierarchy: Hierarchy,
  taskTypes: IdMap<TaskType>,
  projectType: Ref<ProjectType> | undefined,
  descriptors: TaskTypeDescriptor[]
): TaskType[] {
  const allowCreate = new Set<Ref<Doc>>(descriptors.filter((it) => it.allowCreate).map((it) => it._id))
  return getSelectableTaskTypes(hierarchy, taskTypes, projectType, (d) => allowCreate.has(d))
}

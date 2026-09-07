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
  type ArrOf,
  type Class,
  type Doc,
  type Enum,
  type EnumOf,
  type PropertyType,
  type Ref,
  type RefTo,
  type TxOperations,
  type Type
} from '@hcengineering/core'
import { type ProjectType } from '@hcengineering/task'

import workflow from '../plugin'
import type { Field, FieldListProps, UpdateFieldValueProps, WorkflowRule } from '../schema'

/**
 * @internal
 * FOR TESTING AND CLEAN STATE RESETS ONLY.
 *
 * Removes all workflows, transitions, screens and project workflow mappings from a project type.
 * Do NOT use in production user flows.
 */

export async function clearWorkflowConfig (client: TxOperations, projectTypeId: Ref<ProjectType>): Promise<void> {
  const op = client.apply()
  const workflows = await client.findAll(workflow.class.Workflow, { projectType: projectTypeId })
  for (const wf of workflows) {
    await op.removeDoc(workflow.class.Workflow, core.space.Workspace, wf._id)
  }
  const screens = await client.findAll(workflow.class.Screen, { projectType: projectTypeId })
  for (const sc of screens) {
    await op.removeDoc(workflow.class.Screen, core.space.Workspace, sc._id)
  }
  await op.commit()
}

/**
 * Extracts all field references (attributes) used by a specific workflow rule
 * based on its concrete rule type and schema.
 */
export function extractRuleFieldReferences (ruleId: Ref<WorkflowRule>, props: Record<string, any> | undefined): Field[] {
  if (props == null) return []

  if (ruleId === workflow.validator.FieldRequired || ruleId === workflow.postFunction.ClearFieldValue) {
    const p = props as FieldListProps
    return p.fields ?? []
  }

  if (ruleId === workflow.postFunction.UpdateFieldValue) {
    const p = props as UpdateFieldValueProps
    const fields: Field[] = []
    for (const f of p.fields ?? []) {
      fields.push(f)
      if (f.value.type === 'this' || f.value.type === 'parent') {
        const sourceVal = f.value
        if (sourceVal.fieldKey !== '' && sourceVal.attribute !== undefined) {
          fields.push({
            attribute: sourceVal.attribute,
            fieldKey: sourceVal.fieldKey,
            mixin: sourceVal.mixin
          })
        }
      }
    }
    return fields
  }

  return []
}

/**
 * Type guard to check if a type object is EnumOf.
 */
export function isEnumOfType (type: Type<PropertyType> | undefined): type is EnumOf {
  return type?._class === core.class.EnumOf
}

/**
 * Type guard to check if a type object is ArrOf.
 */
export function isArrOfType (type: Type<PropertyType> | undefined): type is ArrOf<PropertyType> {
  return type?._class === core.class.ArrOf
}

/**
 * Type guard to check if a type object is RefTo.
 */
export function isRefToType (type: Type<PropertyType> | undefined): type is RefTo<Doc> {
  return type?._class === core.class.RefTo
}

/**
 * Extracts Enum reference from a Type object if present (e.g. EnumOf or ArrOf<EnumOf>).
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
 * Finds an existing enum matching the requested values or creates a new one.
 */
export async function findOrCreateEnum (
  client: TxOperations,
  enumName: string,
  enumValues: string[]
): Promise<Ref<Enum>> {
  const existingEnums = await client.findAll(core.class.Enum, {})

  const isMatchingValues = (e: Enum): boolean =>
    e.enumValues !== undefined &&
    e.enumValues.length === enumValues.length &&
    e.enumValues.every((v) => enumValues.includes(v))

  const matched =
    existingEnums.find((e) => e.name === enumName && isMatchingValues(e)) ??
    (enumValues.length > 0 ? existingEnums.find((e) => isMatchingValues(e)) : undefined) ??
    existingEnums.find((e) => e.name === enumName)

  if (matched !== undefined) return matched._id

  return await client.createDoc(core.class.Enum, core.space.Model, {
    name: enumName,
    enumValues
  })
}

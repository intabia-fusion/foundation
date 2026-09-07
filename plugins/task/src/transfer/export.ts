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

import core, { Class, ClassifierKind, Ref, Status, TxOperations, notEmpty } from '@hcengineering/core'

import { Task, TaskType } from '../index'
import { exportAttributes } from './attributes'
import {
  TaskTypeConfigVersion,
  type TaskTypeAttributeConfig,
  type TaskTypeConfigEntry,
  type TaskTypeExportConfig,
  type TaskTypeExportOptions,
  type TaskTypeMixinConfig,
  type TaskTypeStatusConfig
} from './types'

/**
 * Extracts status configurations for a task type from preloaded workspace statuses.
 */
function exportTaskTypeStatuses (statuses: Status[]): TaskTypeStatusConfig[] {
  const toExport: TaskTypeStatusConfig[] = []
  for (const s of statuses) {
    toExport.push({
      id: s._id,
      name: s.name,
      color: s.color,
      category: s.category
    })
  }
  return toExport
}

/**
 * Extracts custom mixins and their attributes for a target class.
 */
async function exportTaskTypeMixins (
  client: TxOperations,
  targetClass: Ref<Class<Task>>
): Promise<TaskTypeMixinConfig[] | undefined> {
  const mixinDocs = await client.findAll(core.class.Class, {
    extends: targetClass,
    kind: ClassifierKind.MIXIN
  })
  if (mixinDocs.length === 0) return undefined

  const mixinConfigs: TaskTypeMixinConfig[] = []
  for (const m of mixinDocs) {
    const mAttrs = await exportAttributes(client, m._id)
    const mixinLabel = m.label

    mixinConfigs.push({
      id: m._id,
      label: mixinLabel,
      icon: m.icon,
      color: m.color,
      attributes: mAttrs
    })
  }

  return mixinConfigs.length > 0 ? mixinConfigs : undefined
}

/**
 * Serializes a single TaskType into a TaskTypeConfigEntry.
 */
async function exportSingleTaskType (
  client: TxOperations,
  tt: TaskType,
  selectedTypeIds: Set<Ref<TaskType>>,
  statusById: Map<Ref<Status>, Status>
): Promise<TaskTypeConfigEntry> {
  const statuses = exportTaskTypeStatuses((tt.statuses ?? []).map((it) => statusById.get(it)).filter(notEmpty))
  const attributes: TaskTypeAttributeConfig[] | undefined = await exportAttributes(client, tt.targetClass)
  const mixins: TaskTypeMixinConfig[] | undefined = await exportTaskTypeMixins(client, tt.targetClass)

  let allowedAsChildOf: Array<Ref<TaskType>> | undefined
  if (tt.allowedAsChildOf !== undefined && tt.allowedAsChildOf.length > 0) {
    allowedAsChildOf = [...tt.allowedAsChildOf]
  }

  return {
    id: tt._id,
    name: tt.name,
    icon: tt.icon,
    color: tt.color,
    isRootTaskType: tt.isRootTaskType,
    allowAnyParent: tt.allowAnyParent,
    allowedAsChildOf,
    showParentTasks: tt.showParentTasks,
    descriptor: tt.descriptor,
    ofClass: tt.ofClass,
    statusCategories: tt.statusCategories ?? [],
    statuses,
    attributes,
    mixins
  }
}

/**
 * Exports a task type (single or connected hierarchy) into a serializable configuration.
 *
 * @public
 */
export async function exportTaskTypeConfig (
  client: TxOperations,
  selectedTypes: TaskType[],
  options: TaskTypeExportOptions
): Promise<TaskTypeExportConfig> {
  const { mode, taskTypeName, taskTypeId, workspace } = options
  const projectTypeId = options.projectTypeId ?? selectedTypes[0]?.parent
  const selectedTypeIds = new Set<Ref<TaskType>>(selectedTypes.map((t) => t._id))

  const allWorkspaceStatuses = await client.findAll(core.class.Status, {})
  const statusById = new Map<Ref<Status>, Status>(allWorkspaceStatuses.map((s) => [s._id, s]))

  const entries: TaskTypeConfigEntry[] = []
  for (const tt of selectedTypes) {
    entries.push(await exportSingleTaskType(client, tt, selectedTypeIds, statusById))
  }

  return {
    version: TaskTypeConfigVersion,
    exportDate: new Date().toISOString(),
    mode,
    taskTypeName,
    taskTypeId,
    workspace,
    projectTypeId,
    taskTypes: entries
  }
}

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
  Class,
  ClassifierKind,
  Data,
  Doc,
  Ref,
  Status,
  TxOperations,
  generateId,
  type Mixin
} from '@hcengineering/core'
import { getEmbeddedLabel, setPlatformStatus, unknownStatus } from '@hcengineering/platform'
import setting from '@hcengineering/setting'

import task, { ProjectType, Task, TaskType } from '../index'
import { createState, findStatusAttr } from '../utils'
import { createCustomAttributes } from './attributes'
import type {
  TaskTypeConfigEntry,
  TaskTypeExportConfig,
  TaskTypeImportOptions,
  TaskTypeImportResult,
  TaskTypeMixinConfig,
  TaskTypeStatusConfig
} from './types'

/**
 * Resolves a unique name for an imported task type by appending numeric suffix if duplicate.
 */
function resolveUniqueTypeName (requestedName: string, existingNames: Set<string>, renameDuplicates?: boolean): string {
  let typeName = requestedName
  if (existingNames.has(typeName) && renameDuplicates !== false) {
    let counter = 1
    while (existingNames.has(`${requestedName} (${counter})`)) {
      counter++
    }
    typeName = `${requestedName} (${counter})`
  }
  existingNames.add(typeName)
  return typeName
}

/**
 * Reuses or creates statuses for an imported task type.
 */
async function createImportedStatuses (
  client: TxOperations,
  ofClass: Ref<Class<Doc>>,
  statusConfigs: TaskTypeStatusConfig[] | undefined
): Promise<Array<Ref<Status>>> {
  const hierarchy = client.getHierarchy()
  const statusAttr =
    findStatusAttr(hierarchy, ofClass as Ref<Class<Task>>) ?? hierarchy.getAttribute(task.class.Task, 'status')
  const statusIds: Array<Ref<Status>> = []

  for (const statusCfg of statusConfigs ?? []) {
    const statusId = await createState(
      client,
      core.class.Status,
      {
        name: statusCfg.name,
        color: statusCfg.color,
        category: statusCfg.category,
        ofAttribute: statusAttr._id
      },
      statusCfg.id
    )
    if (!statusIds.includes(statusId)) {
      statusIds.push(statusId)
    }
  }

  return statusIds
}

/**
 * Creates custom mixins and their attributes for an imported task type's target class.
 */
async function createImportedMixins (
  client: TxOperations,
  targetClassId: Ref<Class<TaskType>>,
  mixins: TaskTypeMixinConfig[] | undefined
): Promise<void> {
  for (const mixinCfg of mixins ?? []) {
    const mixinDocId = generateId<Mixin<Doc>>()
    await client.createDoc(
      core.class.Mixin,
      core.space.Model,
      {
        extends: targetClassId,
        kind: ClassifierKind.MIXIN,
        label: mixinCfg.label,
        icon: mixinCfg.icon
      },
      mixinDocId
    )

    await client.createMixin(mixinDocId, core.class.Class, core.space.Model, setting.mixin.Editable, { value: true })
    await client.createMixin(mixinDocId, core.class.Class, core.space.Model, setting.mixin.UserMixin, {})

    await createCustomAttributes(client, mixinDocId, mixinCfg.attributes)
  }
}

/**
 * Creates target class document and binds TaskTypeClass mixin.
 */
async function createTargetClass (
  client: TxOperations,
  entry: TaskTypeConfigEntry,
  typeName: string,
  projectTypeId: Ref<ProjectType>,
  taskTypeId: Ref<TaskType>,
  targetClassId: Ref<Class<TaskType>>
): Promise<void> {
  const hierarchy = client.getHierarchy()
  const ofClassObj = hierarchy.findClass(entry.ofClass)
  if (ofClassObj == null) return

  await client.createDoc(
    core.class.Class,
    core.space.Model,
    {
      extends: entry.ofClass,
      kind: ClassifierKind.CLASS,
      label: getEmbeddedLabel(typeName),
      icon: entry.icon ?? ofClassObj?.icon,
      color: entry.color ?? ofClassObj?.color,
      shortLabel: ofClassObj.shortLabel,
      sortingKey: ofClassObj.sortingKey,
      filteringKey: ofClassObj.filteringKey,
      titleKey: ofClassObj.titleKey
    },
    targetClassId
  )

  await client.createMixin(targetClassId, core.class.Class, core.space.Model, task.mixin.TaskTypeClass, {
    taskType: taskTypeId,
    projectType: projectTypeId
  })
}

/**
 * Remaps allowedAsChildOf parent relations using newly generated task type IDs.
 */
async function linkParentChildRelations (
  client: TxOperations,
  entriesToImport: TaskTypeConfigEntry[],
  createdTaskTypes: TaskType[],
  typeIdMapping: Map<Ref<TaskType>, Ref<TaskType>>,
  existingTaskTypes: TaskType[]
): Promise<void> {
  for (let i = 0; i < entriesToImport.length; i++) {
    const entry = entriesToImport[i]
    const createdType = createdTaskTypes[i]
    if (entry.allowedAsChildOf === undefined || entry.allowedAsChildOf.length === 0) continue

    const remappedParents: Array<Ref<TaskType>> = []
    for (const oldParentId of entry.allowedAsChildOf) {
      if (oldParentId === entry.id) {
        remappedParents.push(createdType._id)
        continue
      }
      const newParentId = typeIdMapping.get(oldParentId)
      if (newParentId !== undefined) {
        remappedParents.push(newParentId)
      } else {
        const existingInProject = existingTaskTypes.find((t) => t._id === oldParentId)
        if (existingInProject !== undefined) {
          remappedParents.push(existingInProject._id)
        }
      }
    }

    if (remappedParents.length > 0) {
      createdType.allowedAsChildOf = remappedParents
      await client.update(createdType, {
        allowedAsChildOf: remappedParents
      })
    }
  }
}

/**
 * Updates ProjectType document by adding newly created tasks and statuses.
 */
async function updateProjectTypeBindings (
  client: TxOperations,
  projectType: ProjectType,
  createdTaskTypes: TaskType[]
): Promise<void> {
  const allTaskIds = [...(projectType.tasks ?? [])]
  for (const tt of createdTaskTypes) {
    if (!allTaskIds.includes(tt._id)) {
      allTaskIds.push(tt._id)
    }
  }

  const allStatuses = [...(projectType.statuses ?? [])]
  for (const tt of createdTaskTypes) {
    for (const sId of tt.statuses ?? []) {
      if (!allStatuses.some((st) => st._id === sId && st.taskType === tt._id)) {
        allStatuses.push({ _id: sId, taskType: tt._id })
      }
    }
  }

  await client.update(projectType, {
    tasks: allTaskIds,
    statuses: allStatuses
  })
}

/**
 * Imports task type configurations into a project type.
 *
 * @public
 */
export async function importTaskTypeConfig (
  client: TxOperations,
  projectTypeId: Ref<ProjectType>,
  config: TaskTypeExportConfig,
  options?: TaskTypeImportOptions
): Promise<TaskTypeImportResult> {
  const projectType = await client.findOne(task.class.ProjectType, { _id: projectTypeId })
  if (projectType === undefined) {
    await setPlatformStatus(unknownStatus(`Project type ${projectTypeId} not found`))
    return {
      importedTaskTypes: [],
      createdCount: 0
    }
  }

  const existingTaskTypes = await client.findAll(task.class.TaskType, { parent: projectTypeId })
  const existingNames = new Set(existingTaskTypes.map((t) => t.name))

  // Filter entries if selective inclusion is configured
  let entriesToImport = config.taskTypes
  if (options?.selectedTypeNames !== undefined && options.selectedTypeNames.length > 0) {
    const selectedSet = new Set(options.selectedTypeNames)
    entriesToImport = entriesToImport.filter((entry) => selectedSet.has(entry.name))
  }

  const createdTaskTypes: TaskType[] = []
  const typeIdMapping = new Map<Ref<TaskType>, Ref<TaskType>>()

  // PASS 1: Create all entities (statuses, targetClass, attributes, mixins, taskType)
  for (const entry of entriesToImport) {
    const typeName = resolveUniqueTypeName(entry.name, existingNames, options?.renameDuplicates)
    const statusIds = await createImportedStatuses(client, entry.ofClass, entry.statuses)

    // Always generate a new unique task type ID to ensure a fresh, independent entity
    const taskTypeId = generateId<TaskType>()
    const targetClassId = `${taskTypeId}:type:class` as Ref<Class<TaskType>>

    // Create targetClass and mixins
    await createTargetClass(client, entry, typeName, projectTypeId, taskTypeId, targetClassId)
    await createCustomAttributes(client, targetClassId, entry.attributes)
    await createImportedMixins(client, targetClassId, entry.mixins)

    // Create TaskType document
    const taskTypeData: Data<TaskType> = {
      parent: projectTypeId,
      name: typeName,
      icon: entry.icon,
      color: entry.color,
      isRootTaskType: entry.isRootTaskType ?? true,
      allowAnyParent: entry.allowAnyParent ?? false,
      allowedAsChildOf: [],
      showParentTasks: entry.showParentTasks ?? true,
      descriptor: entry.descriptor,
      ofClass: entry.ofClass,
      targetClass: targetClassId as Ref<Class<Task>>,
      statuses: statusIds,
      statusClass: core.class.Status,
      statusCategories: entry.statusCategories ?? []
    }

    await client.createDoc(task.class.TaskType, core.space.Model, taskTypeData, taskTypeId)

    const createdType: TaskType = {
      _id: taskTypeId,
      _class: task.class.TaskType,
      space: core.space.Model,
      modifiedOn: Date.now(),
      modifiedBy: '' as any,
      ...taskTypeData
    }

    createdTaskTypes.push(createdType)
    typeIdMapping.set(entry.id, taskTypeId)
  }

  // PASS 2: Link allowedAsChildOf references using the new IDs
  await linkParentChildRelations(client, entriesToImport, createdTaskTypes, typeIdMapping, existingTaskTypes)

  // PASS 3: Update ProjectType tasks and statuses arrays
  await updateProjectTypeBindings(client, projectType, createdTaskTypes)

  return {
    importedTaskTypes: createdTaskTypes,
    createdCount: createdTaskTypes.length
  }
}

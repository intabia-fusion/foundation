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

import type {
  AnyAttribute,
  Blob,
  Class,
  Doc,
  Mixin,
  PropertyType,
  Ref,
  Status,
  StatusCategory,
  Type,
  WorkspaceUuid
} from '@hcengineering/core'
import type { Asset, IntlString } from '@hcengineering/platform'
import type { ProjectType, TaskType, TaskTypeDescriptor } from '../index'

/**
 * @public
 */
export const TaskTypeConfigVersion = 1

/**
 * @public
 */
export interface TaskTypeStatusConfig {
  id: Ref<Status>
  name: string
  color: Status['color']
  category?: Ref<StatusCategory>
}

/**
 * @public
 */
export interface TaskTypeAttributeConfig {
  id: Ref<AnyAttribute>
  name: string
  label: IntlString
  type: Type<PropertyType>
  required?: boolean
  defaultValue?: any
  enumName?: string
  enumValues?: string[]
  icon?: Asset
  color?: number | number[] | Ref<Blob>
}

/**
 * @public
 */
export interface TaskTypeMixinConfig {
  id: Ref<Mixin<Doc>>
  label: IntlString
  icon?: Asset
  color?: number | number[] | Ref<Blob>
  attributes?: TaskTypeAttributeConfig[]
}

/**
 * @public
 */
export interface TaskTypeConfigEntry {
  id: Ref<TaskType>
  name: string
  icon?: Asset
  color?: number | number[] | Ref<Blob>
  isRootTaskType?: boolean
  allowAnyParent?: boolean
  /** IDs of parent task types */
  allowedAsChildOf?: Array<Ref<TaskType>>
  showParentTasks?: boolean
  descriptor: Ref<TaskTypeDescriptor>
  ofClass: Ref<Class<Doc>>
  statusCategories: Array<Ref<StatusCategory>>
  statuses: TaskTypeStatusConfig[]
  attributes?: TaskTypeAttributeConfig[]
  mixins?: TaskTypeMixinConfig[]
}

/**
 * @public
 */
export interface TaskTypeExportConfig {
  version: number
  exportDate: string
  mode: 'single' | 'hierarchy'
  taskTypeName: string
  taskTypeId: Ref<TaskType>
  workspace: WorkspaceUuid
  projectTypeId: Ref<ProjectType>
  taskTypes: TaskTypeConfigEntry[]
}

/**
 * @public
 */
export interface IncompatibleAttributeItem {
  taskTypeName: string
  attributeName: string
  targetClass: Ref<Class<Doc>>
}

/**
 * @public
 */
export interface TaskTypeDependencyReason {
  role: 'parent' | 'child'
  id: Ref<TaskType>
  name?: string
  universal?: boolean
}

/**
 * @public
 */
export interface TaskTypeDependencyItem {
  taskType: TaskType
  role: 'target' | 'parent' | 'child'
  sourceName?: string
  depth: number
  reasons: TaskTypeDependencyReason[]
}

/**
 * @public
 */
export interface TaskTypeExportOptions {
  mode: 'single' | 'hierarchy'
  taskTypeName: string
  taskTypeId: Ref<TaskType>
  workspace: WorkspaceUuid
  projectTypeId?: Ref<ProjectType>
}

/**
 * @public
 */
export interface TaskTypeImportOptions {
  selectedTypeNames?: string[]
  renameDuplicates?: boolean
}

/**
 * @public
 */
export interface TaskTypeImportResult {
  importedTaskTypes: TaskType[]
  createdCount: number
}

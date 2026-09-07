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
  Enum,
  Mixin,
  PropertyType,
  Ref,
  Status,
  StatusCategory,
  Type,
  WorkspaceUuid
} from '@hcengineering/core'
import type { Asset, IntlString } from '@hcengineering/platform'
import type { Project, ProjectType, TaskType } from '@hcengineering/task'
import type {
  Screen,
  Workflow,
  WorkflowPostFunction,
  WorkflowRequest,
  WorkflowRule,
  WorkflowTransition,
  WorkflowValidator
} from '../schema'

/**
 * Workflow configuration in a portable form: every workspace-specific reference (status, task type,
 * screen) is written by name, so a config exported from one workspace can be imported into another.
 */
export const WorkflowConfigVersion = 1

export interface WorkflowExportOptions {
  workspace: WorkspaceUuid
  projectTypeId: Ref<ProjectType>
}

export interface StatusConfig {
  id: Ref<Status>
  name: string
  color: Status['color']
  category?: Ref<StatusCategory>
}

export interface AttributeConfig {
  id: Ref<AnyAttribute>
  name: string
  label: IntlString
  type: Type<PropertyType>
  isCustom?: boolean
  mixin?: Ref<Mixin<Doc>>
  attributeOf?: Ref<Class<Doc>>
  enumName?: string
  enumValues?: string[]
}

export interface WorkflowMixinConfig {
  id: Ref<Mixin<Doc>>
  label: IntlString
  icon?: Asset
  color?: number | number[] | Ref<Blob>
  attributes?: AttributeConfig[]
}

export interface WorkflowEnumConfig {
  id: Ref<Enum>
  name: string
  enumValues: string[]
}

export interface WorkflowConfig {
  version: number
  exportDate: string
  workspace: WorkspaceUuid
  projectTypeId: Ref<ProjectType>
  screens?: ScreenConfig[]
  statuses?: StatusConfig[]
  attributes?: AttributeConfig[]
  mixins?: WorkflowMixinConfig[]
  enums?: WorkflowEnumConfig[]
  workflows: WorkflowConfigEntry[]
  projects?: ProjectWorkflowsConfig[]
}

export interface WorkflowConfigEntry {
  id: Ref<Workflow>
  name: string
  /** Task type name inside the project type. */
  taskTypeName: string
  taskTypeId: Ref<TaskType>
  /** Initial statuses; empty or absent means any. */
  initialStatuses?: Ref<Status>[]
  transitions?: TransitionConfig[]
}

export interface TransitionConfig {
  id: Ref<WorkflowTransition>
  name: string
  /** Status references; `null` means "any status". */
  from: Ref<Status>[] | null
  /** Target status reference. */
  to: Ref<Status>
  requests?: RequestConfig[]
  validators?: ValidatorConfig[]
  postFunctions?: PostFunctionConfig[]
}

export interface RuleConfig<
  TRule extends WorkflowRule = WorkflowRule,
  TProps extends Record<string, any> = Record<string, any>
> {
  id: string
  rule: Ref<TRule>
  ruleClass: Ref<Class<TRule>>
  props: TProps
}

export type RequestConfig = RuleConfig<WorkflowRequest>
export type ValidatorConfig = RuleConfig<WorkflowValidator>
export type PostFunctionConfig = RuleConfig<WorkflowPostFunction>

export interface ScreenConfig {
  id: Ref<Screen>
  name: string
  description?: string
  /** Class id of the target task, e.g. `tracker:class:Issue`. */
  targetClass: Ref<Class<Doc>>
  tabs?: ScreenTabConfig[]
}

export interface ScreenTabConfig {
  name: string
  fields?: ScreenFieldConfig[]
}

export interface ScreenFieldConfig {
  attribute: Ref<AnyAttribute>
  fieldKey: string
  mixin?: Ref<Mixin<Doc>>
  required: boolean
}

export interface ProjectWorkflowsConfig {
  project: Ref<Project>
  /** Project identifier, e.g. `PRJ`. */
  identifier: string
  /** Task type name to workflow name. */
  workflows: Record<string, string>
}

export interface ImportResult {
  screens: Record<Ref<Screen>, Ref<Screen>>
  workflows: Record<Ref<Workflow>, Ref<Workflow>>
  transitions: Record<Ref<WorkflowTransition>, Ref<WorkflowTransition>>
}

export interface StatusCompatibilityItem {
  sourceStatusId: Ref<Status>
  sourceName: string
  sourceColor: Status['color']
  sourceCategory?: Ref<StatusCategory>
  isMatched: boolean
  targetStatusId?: Ref<Status>
}

export type AttributeUsageSource = Ref<WorkflowRule> | 'ScreenField'

export interface AttributeCompatibilityItem {
  fieldKey: string
  sourceAttributeId: Ref<AnyAttribute>
  label: IntlString
  sourceType?: Type<PropertyType>
  ruleTypes: AttributeUsageSource[]
  isMatched: boolean
  targetAttributeId?: Ref<AnyAttribute>
  unresolvable?: boolean
  unresolvableReason?: IntlString
}

export interface TransitionCompatibilityItem {
  id: Ref<WorkflowTransition>
  name: string
  from: Ref<Status>[] | null
  to: Ref<Status>
}

export interface TransitionResolutionConfig {
  action: 'import' | 'skip' | 'redirect'
  targetToStatusId?: Ref<Status>
}

export type ScreenResolutionAction = 'copy' | 'skip'

export interface ScreenResolutionConfig {
  action: ScreenResolutionAction
  targetScreenId?: Ref<Screen>
}

export interface ScreenCompatibilityItem {
  sourceScreenId: Ref<Screen>
  name: string
  targetClass: Ref<Class<Doc>>
  description?: string
  tabsCount: number
  fieldsCount: number
  isExisting: boolean
  existingScreenId?: Ref<Screen>
  isExactMatch?: boolean
  matchingScreenId?: Ref<Screen>
  matchingScreenName?: string
}

export interface WorkflowCompatibilityReport {
  statuses: StatusCompatibilityItem[]
  attributes: AttributeCompatibilityItem[]
  transitions: TransitionCompatibilityItem[]
  screens?: ScreenCompatibilityItem[]
  hasScreens: boolean
}

export interface AttributeResolutionConfig {
  action: 'create' | 'map' | 'skip'
  targetAttributeId?: Ref<AnyAttribute>
  label?: IntlString
  type?: Type<PropertyType>
}

export interface WorkflowImportResolution {
  /** Target task type ID for the workflow */
  targetTaskTypeId?: Ref<TaskType>
  /** Mapping of source task type ID to target task type ID */
  taskTypeMap?: Record<Ref<TaskType>, Ref<TaskType>>
  /** Status mapping: source Status Ref -> target Status Ref */
  statusMap?: Record<Ref<Status>, Ref<Status> | undefined>
  /** Transition resolutions by transition Ref */
  transitionResolutions?: Record<Ref<WorkflowTransition>, TransitionResolutionConfig>
  /** Attribute resolutions by fieldKey */
  attributeResolutions?: Record<string, AttributeResolutionConfig>
  /** Screen resolutions by screen ID or name */
  screenResolutions?: Record<Ref<Screen> | string, ScreenResolutionConfig>
  /** Whether to copy missing screens (default: true) */
  copyScreens?: boolean
  /** Whether to create missing statuses in the target task type (default: false) */
  createMissingStatuses?: boolean
  /** Workflow name override */
  name?: string
}

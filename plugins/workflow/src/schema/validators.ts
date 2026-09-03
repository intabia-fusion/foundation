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

import { Client, Ref, Status, Tx } from '@hcengineering/core'
import type { Task, TaskType } from '@hcengineering/task'
import type { IntlString, Resource } from '@hcengineering/platform'

import type { WorkflowTransition } from './core'
import { WorkflowRule, WorkflowRuleConfig } from './rules'
import { FieldListProps } from './values'

export interface ValidationSuccess {
  ok: true
}

export interface ValidationError {
  ok: false
  reason: string
  reasonIntl: IntlString
  intlParams: Record<string, any>
  intlParamsNotLocalized?: Record<string, IntlString>
}

export type ValidationResult = ValidationSuccess | ValidationError

export type ValidatorClient = Pick<Client, 'findAll' | 'findOne' | 'getHierarchy' | 'getModel'>

export interface ValidatorContext {
  txes: Tx[]
}

export type ValidatorFunc = (
  client: ValidatorClient,
  task: Task,
  transition: WorkflowTransition,
  props: Record<string, any>,
  context?: ValidatorContext
) => Promise<ValidationResult>

export interface ValidatorImpl extends WorkflowValidator {
  executor: Resource<ValidatorFunc>
}

export interface WorkflowValidator extends WorkflowRule {}
export type WorkflowValidatorConfig<TProps extends Record<string, any> = Record<string, any>> = WorkflowRuleConfig<
WorkflowValidator,
TProps
>

export interface FieldRequiredProps extends FieldListProps {}
export interface SubtaskStatusesProps {
  statuses: Record<Ref<TaskType>, Ref<Status>[] | null>
}

export interface ParentStatusesProps {
  statuses: Record<Ref<TaskType>, Ref<Status>[] | null>
}

export type FieldRequiredValidatorConfig = WorkflowValidatorConfig<FieldRequiredProps>
export type SubtaskStatusesValidatorConfig = WorkflowValidatorConfig<SubtaskStatusesProps>
export type ParentStatusesValidatorConfig = WorkflowValidatorConfig<ParentStatusesProps>

export type AnyValidatorConfig =
  | FieldRequiredValidatorConfig
  | SubtaskStatusesValidatorConfig
  | ParentStatusesValidatorConfig

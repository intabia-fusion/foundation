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

import type { Tx } from '@hcengineering/core'
import type { IntlString } from '@hcengineering/platform'

import { WorkflowRule, WorkflowRuleConfig } from './rules'
import { FieldListProps, UpdateFieldValueConfig } from './values'

export interface PostFunctionSuccess {
  ok: true
  txes: Tx[]
}

export interface PostFunctionError {
  ok: false
  error: string
  errorIntl?: IntlString
  intlParams?: Record<string, any>
}

export type PostFunctionResult = PostFunctionSuccess | PostFunctionError

export interface WorkflowPostFunction extends WorkflowRule {}
export type WorkflowPostFunctionConfig<TProps extends Record<string, any> = Record<string, any>> = WorkflowRuleConfig<
WorkflowPostFunction,
TProps
>

export interface UpdateFieldValueProps extends FieldListProps<UpdateFieldValueConfig> {}

export interface ClearFieldValueProps extends FieldListProps {}

export type UpdateFieldValuePostFnConfig = WorkflowPostFunctionConfig<UpdateFieldValueProps>
export type ClearFieldValuePostFnConfig = WorkflowPostFunctionConfig<ClearFieldValueProps>

export type AnyPostFnConfig = UpdateFieldValuePostFnConfig | ClearFieldValuePostFnConfig

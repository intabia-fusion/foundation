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

import type { Ref } from '@hcengineering/core'

import { Screen } from './screens'
import { WorkflowRule, WorkflowRuleConfig } from './rules'

export interface WorkflowRequest extends WorkflowRule {}
export type WorkflowRequestConfig<TProps extends Record<string, any> = Record<string, any>> = WorkflowRuleConfig<
WorkflowRequest,
TProps
>

export interface ScreenProps {
  screen: Ref<Screen>
}

export type ScreenRequestConfig = WorkflowRequestConfig<ScreenProps>

export type AnyRequestConfig = ScreenRequestConfig

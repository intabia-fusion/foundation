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

import type { Class, Doc, Ref } from '@hcengineering/core'
import type { Asset, IntlString } from '@hcengineering/platform'
import type { AnyComponent } from '@hcengineering/ui'

import { AnyValidatorConfig } from './validators'
import { AnyPostFnConfig } from './post-functions'
import { AnyRequestConfig } from './request'

export interface WorkflowRule extends Doc {
  label: IntlString
  description: IntlString
  icon: Asset
  group?: string
  order: number

  editor: AnyComponent
  presenter: AnyComponent
}

/**
 * Strongly-typed rule configuration interface
 */
export interface WorkflowRuleConfig<
  TRule extends WorkflowRule = WorkflowRule,
  TProps extends Record<string, any> = Record<string, any>
> {
  id: string
  ruleClass: Ref<Class<TRule>>
  rule: Ref<TRule>
  props: TProps
}

export type AnyRuleConfig = AnyValidatorConfig | AnyPostFnConfig | AnyRequestConfig

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

import { type IntlString } from '@hcengineering/platform'
import { type Class, type Doc, type DocumentUpdate, type Ref, type TxCUD } from '@hcengineering/core'
import { type WorkflowRule } from '@hcengineering/workflow'
import { type AnySvelteComponent } from '@hcengineering/ui'

import plugin from './plugin'
import RuleEditor from './components/rules/RuleEditor.svelte'

export interface ScreenModalResult<T extends Doc = Doc> {
  update?: DocumentUpdate<T>
  txes?: Array<TxCUD<Doc>>
}

export interface RuleDisplay {
  _class: Ref<Class<WorkflowRule>>
  label: IntlString
  icon?: string
  presenter?: AnySvelteComponent
  editor?: AnySvelteComponent
}

export const rulesDisplay: Record<Ref<Class<WorkflowRule>>, RuleDisplay> = {
  [plugin.class.WorkflowRule]: {
    _class: plugin.class.WorkflowRule,
    label: plugin.string.AllRules
  },
  [plugin.class.WorkflowRequest]: {
    _class: plugin.class.WorkflowRequest,
    icon: '📑',
    label: plugin.string.Requests,
    editor: RuleEditor
  },
  [plugin.class.WorkflowValidator]: {
    _class: plugin.class.WorkflowValidator,
    icon: '✓',
    label: plugin.string.ValidateDetails,
    editor: RuleEditor
  },
  [plugin.class.WorkflowPostFunction]: {
    _class: plugin.class.WorkflowPostFunction,
    icon: '➔',
    label: plugin.string.PerformActions,
    editor: RuleEditor
  }
}

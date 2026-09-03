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

import core from '@hcengineering/core'
import { type Builder } from '@hcengineering/model'

import workflow from './plugin'

export function definePostFunctions (builder: Builder): void {
  builder.createDoc(
    workflow.class.WorkflowPostFunction,
    core.space.Model,
    {
      label: workflow.string.UpdateFieldValuePostFunction,
      description: workflow.string.UpdateFieldValueDescription,
      icon: workflow.icon.Action,
      group: 'fields',
      order: 10,
      editor: workflow.postFunctionEditor.UpdateFieldValue,
      presenter: workflow.postFunctionPresenter.UpdateFieldValue
    },
    workflow.postFunction.UpdateFieldValue
  )

  builder.createDoc(
    workflow.class.WorkflowPostFunction,
    core.space.Model,
    {
      label: workflow.string.ClearFieldValuePostFunction,
      description: workflow.string.ClearFieldValueDescription,
      icon: workflow.icon.Action,
      group: 'fields',
      order: 20,
      editor: workflow.postFunctionEditor.ClearFieldValue,
      presenter: workflow.postFunctionPresenter.ClearFieldValue
    },
    workflow.postFunction.ClearFieldValue
  )
}

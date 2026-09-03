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
import tracker from '@hcengineering/tracker'

import workflow from './plugin'

export function defineValidators (builder: Builder): void {
  builder.createDoc(
    workflow.class.WorkflowValidator,
    core.space.Model,
    {
      label: workflow.string.FieldRequiredValidator,
      description: workflow.string.FieldRequiredDescription,
      icon: workflow.icon.Check,
      group: 'fields',
      order: 10,
      editor: workflow.validatorEditor.FieldRequired,
      presenter: workflow.validatorPresenter.FieldRequired
    },
    workflow.validator.FieldRequired
  )

  builder.mixin(workflow.validator.FieldRequired, workflow.class.WorkflowValidator, workflow.mixin.ValidatorImpl, {
    executor: workflow.validatorExecutor.FieldRequired
  })

  builder.createDoc(
    workflow.class.WorkflowValidator,
    core.space.Model,
    {
      label: workflow.string.SubtaskStatusValidator,
      description: workflow.string.SubtaskStatusDescription,
      icon: tracker.icon.Subissue,
      order: 20,
      editor: workflow.validatorEditor.SubtaskStatus,
      presenter: workflow.validatorPresenter.SubtaskStatus
    },
    workflow.validator.SubtaskStatus
  )

  builder.mixin(workflow.validator.SubtaskStatus, workflow.class.WorkflowValidator, workflow.mixin.ValidatorImpl, {
    executor: workflow.validatorExecutor.SubtaskStatus
  })

  builder.createDoc(
    workflow.class.WorkflowValidator,
    core.space.Model,
    {
      label: workflow.string.ParentStatusValidator,
      description: workflow.string.ParentStatusDescription,
      icon: tracker.icon.Parent,
      order: 30,
      editor: workflow.validatorEditor.ParentStatus,
      presenter: workflow.validatorPresenter.ParentStatus
    },
    workflow.validator.ParentStatus
  )

  builder.mixin(workflow.validator.ParentStatus, workflow.class.WorkflowValidator, workflow.mixin.ValidatorImpl, {
    executor: workflow.validatorExecutor.ParentStatus
  })
}

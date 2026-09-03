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
import task from '@hcengineering/task'
import serverCore from '@hcengineering/server-core'
import workflow, { TWorkflowValidator, TWorkflowPostFunction } from '@hcengineering/model-workflow'
import { Mixin } from '@hcengineering/model'
import type { Resource } from '@hcengineering/platform'
import { type ValidatorImpl, type PostFunctionImpl, type PostFunctionFunc } from '@hcengineering/server-workflow'
import { type ValidatorFunc } from '@hcengineering/workflow'
import serverWorkflow from '@hcengineering/server-workflow'

export { serverWorkflowId } from '@hcengineering/server-workflow'

@Mixin(serverWorkflow.mixin.ValidatorImpl, workflow.class.WorkflowValidator)
export class TValidatorImpl extends TWorkflowValidator implements ValidatorImpl {
  serverExecutor!: Resource<ValidatorFunc>
}

@Mixin(serverWorkflow.mixin.PostFunctionImpl, workflow.class.WorkflowPostFunction)
export class TPostFunctionImpl extends TWorkflowPostFunction implements PostFunctionImpl {
  serverExecutor!: Resource<PostFunctionFunc>
}

export function createModel (builder: Builder): void {
  builder.createModel(TValidatorImpl, TPostFunctionImpl)

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverWorkflow.trigger.PostFunctionsTrigger,
    isAsync: true,
    txMatch: {
      objectClass: task.class.Task
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverWorkflow.trigger.OnWorkflowDelete,
    isAsync: false,
    txMatch: {
      _class: core.class.TxRemoveDoc,
      objectClass: workflow.class.Workflow
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverWorkflow.trigger.OnTaskTypeDelete,
    isAsync: false,
    txMatch: {
      _class: core.class.TxRemoveDoc,
      objectClass: task.class.TaskType
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverWorkflow.trigger.OnStatusDelete,
    isAsync: false,
    txMatch: {
      _class: core.class.TxRemoveDoc,
      objectClass: core.class.Status
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverWorkflow.trigger.OnTaskTypeUpdate,
    isAsync: false,
    txMatch: {
      _class: core.class.TxUpdateDoc,
      objectClass: task.class.TaskType
    }
  })

  builder.mixin(
    workflow.validator.FieldRequired,
    workflow.class.WorkflowValidator,
    serverWorkflow.mixin.ValidatorImpl,
    {
      serverExecutor: serverWorkflow.validatorExecutor.FieldRequired
    }
  )

  builder.mixin(
    workflow.validator.SubtaskStatus,
    workflow.class.WorkflowValidator,
    serverWorkflow.mixin.ValidatorImpl,
    {
      serverExecutor: serverWorkflow.validatorExecutor.SubtaskStatus
    }
  )

  builder.mixin(workflow.validator.ParentStatus, workflow.class.WorkflowValidator, serverWorkflow.mixin.ValidatorImpl, {
    serverExecutor: serverWorkflow.validatorExecutor.ParentStatus
  })

  builder.mixin(
    workflow.postFunction.UpdateFieldValue,
    workflow.class.WorkflowPostFunction,
    serverWorkflow.mixin.PostFunctionImpl,
    {
      serverExecutor: serverWorkflow.postFunctionExecutor.UpdateFieldValue
    }
  )

  builder.mixin(
    workflow.postFunction.ClearFieldValue,
    workflow.class.WorkflowPostFunction,
    serverWorkflow.mixin.PostFunctionImpl,
    {
      serverExecutor: serverWorkflow.postFunctionExecutor.ClearFieldValue
    }
  )
}

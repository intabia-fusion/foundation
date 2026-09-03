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

import core, { AccountRole } from '@hcengineering/core'
import { type Builder } from '@hcengineering/model'
import presentation from '@hcengineering/model-presentation'

import workflow from './plugin'
import {
  TWorkflow,
  TWorkflowTransition,
  TProjectWorkflow,
  TWorkflowValidator,
  TValidatorImpl,
  TWorkflowRule,
  TWorkflowRequest,
  TWorkflowPostFunction,
  TWorkflowValueFunction,
  TScreenField,
  TScreenTab,
  TScreen
} from './types'
import { defineValidators } from './validators'
import { defineRequests } from './requests'
import { definePostFunctions } from './postFunctions'
import { defineValueFunctions } from './functions'

export function createModel (builder: Builder): void {
  builder.createModel(
    TWorkflow,
    TWorkflowTransition,
    TProjectWorkflow,
    TWorkflowRule,
    TWorkflowValidator,
    TValidatorImpl,
    TWorkflowRequest,
    TWorkflowPostFunction,
    TWorkflowValueFunction,
    TScreenField,
    TScreenTab,
    TScreen
  )
  defineValidators(builder)
  defineRequests(builder)
  definePostFunctions(builder)
  defineValueFunctions(builder)

  builder.mixin(workflow.class.Workflow, core.class.Class, core.mixin.TxAccessLevel, {
    createAccessLevel: AccountRole.Maintainer,
    updateAccessLevel: AccountRole.Maintainer,
    removeAccessLevel: AccountRole.Maintainer
  })

  builder.mixin(workflow.class.WorkflowTransition, core.class.Class, core.mixin.TxAccessLevel, {
    createAccessLevel: AccountRole.Maintainer,
    updateAccessLevel: AccountRole.Maintainer,
    removeAccessLevel: AccountRole.Maintainer
  })

  builder.createDoc(
    presentation.class.PresentationMiddlewareFactory,
    core.space.Model,
    {
      createPresentationMiddleware: workflow.function.CreateMiddleware
    },
    workflow.pipeline.WorkflowMiddleware
  )
}

export * from './types'
export { workflowId } from '@hcengineering/workflow'
export default workflow

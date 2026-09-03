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

import type { Plugin, Resource } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'
import type { TriggerControl, TriggerFunc } from '@hcengineering/server-core'
import type { Mixin, Ref, Tx } from '@hcengineering/core'
import type { Task } from '@hcengineering/task'
import type {
  WorkflowValidator,
  ValidatorFunc,
  WorkflowPostFunction,
  WorkflowTransition
} from '@hcengineering/workflow'

export const serverWorkflowId = 'server-workflow' as Plugin
export { WorkflowMiddleware } from './middleware'

export interface ValidatorImpl extends WorkflowValidator {
  serverExecutor: Resource<ValidatorFunc>
}

export type PostFunctionFunc = (
  control: TriggerControl,
  task: Task,
  transition: WorkflowTransition,
  props: Record<string, any>,
  txes: Tx[]
) => Promise<Tx[]>

export interface PostFunctionImpl extends WorkflowPostFunction {
  serverExecutor: Resource<PostFunctionFunc>
}

export default plugin(serverWorkflowId, {
  trigger: {
    PostFunctionsTrigger: '' as Resource<TriggerFunc>,
    OnWorkflowDelete: '' as Resource<TriggerFunc>,
    OnTaskTypeDelete: '' as Resource<TriggerFunc>,
    OnStatusDelete: '' as Resource<TriggerFunc>,
    OnTaskTypeUpdate: '' as Resource<TriggerFunc>
  },
  mixin: {
    ValidatorImpl: '' as Ref<Mixin<ValidatorImpl>>,
    PostFunctionImpl: '' as Ref<Mixin<PostFunctionImpl>>
  },
  validatorExecutor: {
    FieldRequired: '' as Resource<ValidatorFunc>,
    SubtaskStatus: '' as Resource<ValidatorFunc>,
    ParentStatus: '' as Resource<ValidatorFunc>
  },
  postFunctionExecutor: {
    UpdateFieldValue: '' as Resource<PostFunctionFunc>,
    ClearFieldValue: '' as Resource<PostFunctionFunc>
  }
})

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

import { PostFunctionsTrigger, FieldRequired, SubtaskStatus, ParentStatus } from './PostFunctions'
import { UpdateFieldValue, ClearFieldValue } from './post-functions'
import { OnWorkflowDelete, OnTaskTypeDelete, OnStatusDelete, OnTaskTypeUpdate } from './WorkflowTrigger'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    PostFunctionsTrigger,
    OnWorkflowDelete,
    OnTaskTypeDelete,
    OnStatusDelete,
    OnTaskTypeUpdate
  },
  validatorExecutor: {
    FieldRequired,
    SubtaskStatus,
    ParentStatus
  },
  postFunctionExecutor: {
    UpdateFieldValue,
    ClearFieldValue
  }
})

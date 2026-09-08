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

import { type Ref } from '@hcengineering/core'
import { type TaskType } from '@hcengineering/task'

export interface TaskTypeRelation {
  id: Ref<TaskType>
  name: string
}

export interface TaskTypeSelectItem {
  id: string
  name: string
  /** Enough of a TaskType for TaskTypeIcon to render. */
  icon: Pick<TaskType, 'icon' | 'color' | 'name'>
  /** Types this one can be a parent for. */
  parentOf: TaskTypeRelation[]
  /** Types this one can be a child of. */
  childOf: TaskTypeRelation[]
  /** The type can be a subtask of any parent. */
  universalChild?: boolean
  /** Import only: a type with this name already exists in the target project type. */
  exists?: boolean
}

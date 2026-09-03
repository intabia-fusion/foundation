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

import type { AttachedDoc, Class, Doc, Ref } from '@hcengineering/core'
import type { ProjectType, Rank, Task } from '@hcengineering/task'

import type { Field } from './values'

export interface ScreenField extends AttachedDoc<ScreenTab, 'fields'>, Field {
  required: boolean
  rank: Rank
}

export interface ScreenTab extends AttachedDoc<Screen, 'tabs'> {
  name: string
  rank: Rank
  fields?: number
}

export interface Screen extends Doc {
  name: string
  description?: string
  projectType: Ref<ProjectType>
  targetClass: Ref<Class<Task>>
  tabs?: number
}

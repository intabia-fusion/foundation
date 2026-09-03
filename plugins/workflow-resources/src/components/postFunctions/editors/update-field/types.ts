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
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { type AnyAttribute, type Class, type Doc, type Mixin, type Ref } from '@hcengineering/core'
import { type IntlString } from '@hcengineering/platform'
import { type AnyComponent, type AnySvelteComponent } from '@hcengineering/ui'
import { type CollectionOperation, type WorkflowFieldValue, type WorkflowValueFunction } from '@hcengineering/workflow'

export interface FieldRow {
  id: string
  fieldKey: string
  mixin?: Ref<Class<Mixin<Doc>>>
  value: WorkflowFieldValue
  operation?: CollectionOperation

  attribute?: AnyAttribute
  editor?: AnySvelteComponent
}

export interface ContextOption {
  id: string
  value?: WorkflowFieldValue
  label: IntlString
  category?: { label: IntlString }
  children?: ContextOption[]
  separatorBefore?: boolean
  isParent?: boolean
}

export interface TransformOption extends ContextOption {
  funcRef: Ref<WorkflowValueFunction>
  editor?: AnyComponent
}

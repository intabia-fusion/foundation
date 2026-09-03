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

import type { AnyAttribute, Class, Doc, Mixin, Ref } from '@hcengineering/core'
import type { IntlString, Resource } from '@hcengineering/platform'
import type { AnyComponent } from '@hcengineering/ui'

/**
 * Base field reference descriptor
 */
export interface Field {
  attribute: Ref<AnyAttribute>
  fieldKey: string
  mixin?: Ref<Class<Mixin<Doc>>>
}

export type WorkflowValuePreset = '$currentUser' | '$now'

export interface WorkflowValueFunction extends Doc {
  of: Ref<Class<Doc>>
  to?: Ref<Class<Doc>>
  category: string
  label: IntlString
  type: 'convert' | 'transform'
  editor?: AnyComponent
  propsLabelPresenter?: Resource<(props: Record<string, any>) => IntlString>
}

export interface WorkflowTransformCall {
  func: Ref<WorkflowValueFunction>
  props?: Record<string, any>
}

export type WorkflowValueType = 'preset' | 'this' | 'parent' | 'const'

export interface BaseWorkflowValue<T extends WorkflowValueType = WorkflowValueType> {
  type: T
  functions?: WorkflowTransformCall[]
}

export interface WorkflowPresetValue extends BaseWorkflowValue<'preset'> {
  preset: WorkflowValuePreset
}

export interface WorkflowThisValue extends Field, BaseWorkflowValue<'this'> {}

export interface WorkflowParentValue extends Field, BaseWorkflowValue<'parent'> {}

export interface WorkflowConstValue extends BaseWorkflowValue<'const'> {
  value: any
}

export type WorkflowFieldValue = WorkflowPresetValue | WorkflowThisValue | WorkflowParentValue | WorkflowConstValue

export type CollectionOperation = 'set' | 'add' | 'remove'

export interface UpdateFieldValueConfig extends Field {
  value: WorkflowFieldValue
  operation?: CollectionOperation
}

export interface FieldListProps<TField extends Field = Field> {
  fields?: TField[]
}

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

import core, {
  type Ref,
  type Status,
  type Domain,
  type Class,
  DOMAIN_MODEL,
  type AnyAttribute,
  type Doc,
  type Mixin
} from '@hcengineering/core'
import {
  Model,
  Prop,
  TypeString,
  TypeRef,
  TypeAny,
  Mixin as TypeMixin,
  TypeRecord,
  Collection,
  ArrOf,
  TypeBoolean
} from '@hcengineering/model'
import { TDoc, TAttachedDoc } from '@hcengineering/model-core'
import task, { type TaskType, type ProjectType, type Rank, type Task } from '@hcengineering/task'
import {
  type Workflow,
  type WorkflowTransition,
  type ProjectWorkflow,
  type WorkflowValidator,
  type WorkflowValidatorConfig,
  type ValidatorFunc,
  type ValidatorImpl,
  type WorkflowRule,
  type WorkflowRequest,
  type WorkflowRequestConfig,
  type WorkflowPostFunction,
  type WorkflowPostFunctionConfig,
  type WorkflowValueFunction,
  type Screen,
  type ScreenTab,
  type ScreenField
} from '@hcengineering/workflow'
import { TProject } from '@hcengineering/model-task'
import { type Asset, type IntlString, type Resource } from '@hcengineering/platform'
import type { AnyComponent } from '@hcengineering/ui'

import workflow from './plugin'

export const DOMAIN_WORKFLOW = 'workflow' as Domain

@Model(workflow.class.WorkflowRule, core.class.Doc, DOMAIN_MODEL)
export class TWorkflowRule extends TDoc implements WorkflowRule {
  label!: IntlString
  description!: IntlString
  icon!: Asset
  group?: string
  order!: number

  editor!: AnyComponent
  presenter!: AnyComponent
}

@Model(workflow.class.WorkflowValidator, workflow.class.WorkflowRule)
export class TWorkflowValidator extends TWorkflowRule implements WorkflowValidator {}

@TypeMixin(workflow.mixin.ValidatorImpl, workflow.class.WorkflowValidator)
export class TValidatorImpl extends TWorkflowValidator implements ValidatorImpl {
  executor!: Resource<ValidatorFunc>
}

@Model(workflow.class.WorkflowRequest, workflow.class.WorkflowRule)
export class TWorkflowRequest extends TWorkflowRule implements WorkflowRequest {}

@Model(workflow.class.WorkflowPostFunction, workflow.class.WorkflowRule)
export class TWorkflowPostFunction extends TWorkflowRule implements WorkflowPostFunction {}

@Model(workflow.class.ScreenField, core.class.AttachedDoc, DOMAIN_WORKFLOW)
export class TScreenField extends TAttachedDoc implements ScreenField {
  declare attachedTo: Ref<ScreenTab>
  declare attachedToClass: Ref<Class<ScreenTab>>
  declare collection: 'fields'

  @Prop(TypeRef(core.class.Mixin), core.string.Class)
    mixin?: Ref<Class<Mixin<Doc>>>

  @Prop(TypeRef(core.class.Attribute), workflow.string.Attribute)
    attribute!: Ref<AnyAttribute>

  @Prop(TypeString(), workflow.string.FieldKey)
    fieldKey!: string

  @Prop(TypeBoolean(), workflow.string.Required)
    required!: boolean

  @Prop(TypeString(), task.string.Rank)
    rank!: Rank
}

@Model(workflow.class.ScreenTab, core.class.AttachedDoc, DOMAIN_WORKFLOW)
export class TScreenTab extends TAttachedDoc implements ScreenTab {
  declare attachedTo: Ref<Screen>
  declare attachedToClass: Ref<Class<Screen>>
  declare collection: 'tabs'

  @Prop(TypeString(), workflow.string.Name)
    name!: string

  @Prop(TypeString(), task.string.Rank)
    rank!: Rank

  @Prop(Collection(workflow.class.ScreenField), workflow.string.ScreenField)
    fields?: number
}

@Model(workflow.class.Screen, core.class.Doc, DOMAIN_WORKFLOW)
export class TScreen extends TDoc implements Screen {
  @Prop(TypeString(), workflow.string.Name)
    name!: string

  @Prop(TypeString(), workflow.string.Description)
    description?: string

  @Prop(TypeRef(task.class.ProjectType), task.string.ProjectType)
    projectType!: Ref<ProjectType>

  @Prop(TypeRef(core.class.Class), core.string.Class)
    targetClass!: Ref<Class<Task>>

  @Prop(Collection(workflow.class.ScreenTab), workflow.string.ScreenTab)
    tabs?: number
}

@Model(workflow.class.Workflow, core.class.Doc, DOMAIN_WORKFLOW)
export class TWorkflow extends TDoc implements Workflow {
  @Prop(TypeRef(task.class.ProjectType), task.string.ProjectType)
    projectType!: Ref<ProjectType>

  @Prop(TypeRef(task.class.TaskType), task.string.TaskType)
    taskType!: Ref<TaskType>

  @Prop(TypeString(), workflow.string.Name)
    name!: string

  @Prop(Collection(workflow.class.WorkflowTransition), workflow.string.WorkflowTransition)
    transitions?: number

  @Prop(ArrOf(TypeRef(core.class.Status)), workflow.string.InitialStatuses)
    initialStatuses?: Ref<Status>[]
}

@Model(workflow.class.WorkflowTransition, core.class.AttachedDoc, DOMAIN_WORKFLOW)
export class TWorkflowTransition extends TAttachedDoc implements WorkflowTransition {
  declare attachedTo: Ref<Workflow>
  declare attachedToClass: Ref<Class<Workflow>>
  declare collection: 'transitions'

  @Prop(TypeString(), workflow.string.Name)
    name!: string

  @Prop(ArrOf(TypeRef(core.class.Status)), workflow.string.From)
    from!: Ref<Status>[] | null

  @Prop(TypeRef(core.class.Status), workflow.string.To)
    to!: Ref<Status>

  @Prop(TypeString(), task.string.Rank)
    rank!: Rank

  @Prop(ArrOf(TypeRecord()), workflow.string.Validators)
    validators?: WorkflowValidatorConfig[]

  @Prop(ArrOf(TypeRecord()), workflow.string.Requests)
    requests?: WorkflowRequestConfig[]

  @Prop(ArrOf(TypeRecord()), workflow.string.PostFunctions)
    postFunctions?: WorkflowPostFunctionConfig[]
}

@TypeMixin(workflow.mixin.ProjectWorkflow, task.class.Project)
export class TProjectWorkflow extends TProject implements ProjectWorkflow {
  @Prop(TypeRecord(), workflow.string.WorkflowMapping)
    workflows?: Record<Ref<TaskType>, Ref<Workflow>>
}

@Model(workflow.class.WorkflowValueFunction, core.class.Doc, DOMAIN_WORKFLOW)
export class TWorkflowValueFunction extends TDoc implements WorkflowValueFunction {
  @Prop(TypeRef(core.class.Class), core.string.Class)
    of!: Ref<Class<Doc>>

  @Prop(TypeRef(core.class.Class), core.string.Class)
    to?: Ref<Class<Doc>>

  @Prop(TypeString(), workflow.string.Category)
    category!: string

  @Prop(TypeRecord(), core.string.Object)
    label!: IntlString

  @Prop(TypeString(), workflow.string.Type)
    type!: 'convert' | 'transform'

  @Prop(TypeAny('', workflow.string.Editor), workflow.string.Editor)
    editor?: AnyComponent

  @Prop(TypeAny('', workflow.string.PropsLabelPresenter), workflow.string.PropsLabelPresenter)
    propsLabelPresenter?: Resource<(props: Record<string, any>) => IntlString>
}

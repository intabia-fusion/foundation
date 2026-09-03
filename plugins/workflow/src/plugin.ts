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

import { Class, Mixin, Ref } from '@hcengineering/core'
import { Asset, IntlString, plugin, Plugin, Resource, StatusCode } from '@hcengineering/platform'
import { AnyComponent } from '@hcengineering/ui'
import {
  ProjectWorkflow,
  Workflow,
  WorkflowTransition,
  WorkflowValidator,
  ValidatorImpl,
  ValidatorFunc,
  WorkflowRule,
  WorkflowRequest,
  WorkflowPostFunction,
  WorkflowValueFunction,
  Screen,
  ScreenTab,
  ScreenField
} from './schema'

export const workflowId = 'workflow' as Plugin

export default plugin(workflowId, {
  class: {
    Workflow: '' as Ref<Class<Workflow>>,
    WorkflowTransition: '' as Ref<Class<WorkflowTransition>>,
    WorkflowRule: '' as Ref<Class<WorkflowRule>>,
    WorkflowValidator: '' as Ref<Class<WorkflowValidator>>,
    WorkflowRequest: '' as Ref<Class<WorkflowRequest>>,
    WorkflowPostFunction: '' as Ref<Class<WorkflowPostFunction>>,
    WorkflowValueFunction: '' as Ref<Class<WorkflowValueFunction>>,
    Screen: '' as Ref<Class<Screen>>,
    ScreenTab: '' as Ref<Class<ScreenTab>>,
    ScreenField: '' as Ref<Class<ScreenField>>
  },
  function: {
    ToString: '' as Ref<WorkflowValueFunction>,
    TextFromNumber: '' as Ref<WorkflowValueFunction>,
    TextFromDate: '' as Ref<WorkflowValueFunction>,
    TextFromCheckbox: '' as Ref<WorkflowValueFunction>,
    NumberFromText: '' as Ref<WorkflowValueFunction>,
    DateFromText: '' as Ref<WorkflowValueFunction>,
    YearFromDate: '' as Ref<WorkflowValueFunction>,
    MonthFromDate: '' as Ref<WorkflowValueFunction>,
    DayFromDate: '' as Ref<WorkflowValueFunction>,
    NumberFromDate: '' as Ref<WorkflowValueFunction>,
    DateFromNumber: '' as Ref<WorkflowValueFunction>,
    UpperCase: '' as Ref<WorkflowValueFunction>,
    LowerCase: '' as Ref<WorkflowValueFunction>,
    Trim: '' as Ref<WorkflowValueFunction>,
    Round: '' as Ref<WorkflowValueFunction>,
    Absolute: '' as Ref<WorkflowValueFunction>,
    Ceil: '' as Ref<WorkflowValueFunction>,
    Floor: '' as Ref<WorkflowValueFunction>,
    Sqrt: '' as Ref<WorkflowValueFunction>,
    FirstValue: '' as Ref<WorkflowValueFunction>,
    LastValue: '' as Ref<WorkflowValueFunction>,
    Random: '' as Ref<WorkflowValueFunction>,
    Prepend: '' as Ref<WorkflowValueFunction>,
    Append: '' as Ref<WorkflowValueFunction>,
    Replace: '' as Ref<WorkflowValueFunction>,
    ReplaceAll: '' as Ref<WorkflowValueFunction>,
    Split: '' as Ref<WorkflowValueFunction>,
    Cut: '' as Ref<WorkflowValueFunction>,
    Add: '' as Ref<WorkflowValueFunction>,
    Subtract: '' as Ref<WorkflowValueFunction>,
    Multiply: '' as Ref<WorkflowValueFunction>,
    Divide: '' as Ref<WorkflowValueFunction>,
    Modulo: '' as Ref<WorkflowValueFunction>,
    Power: '' as Ref<WorkflowValueFunction>,
    Min: '' as Ref<WorkflowValueFunction>,
    Max: '' as Ref<WorkflowValueFunction>,
    Offset: '' as Ref<WorkflowValueFunction>,
    DateDifference: '' as Ref<WorkflowValueFunction>
  },
  transformEditor: {
    AppendEditor: '' as AnyComponent,
    ReplaceEditor: '' as AnyComponent,
    SplitEditor: '' as AnyComponent,
    CutEditor: '' as AnyComponent,
    NumberEditor: '' as AnyComponent,
    DateOffsetEditor: '' as AnyComponent,
    DateDifferenceEditor: '' as AnyComponent
  },
  propsLabelPresenter: {
    AppendPresenter: '' as Resource<(props: Record<string, any>) => IntlString>,
    ReplacePresenter: '' as Resource<(props: Record<string, any>) => IntlString>,
    SplitPresenter: '' as Resource<(props: Record<string, any>) => IntlString>,
    CutPresenter: '' as Resource<(props: Record<string, any>) => IntlString>,
    NumberPresenter: '' as Resource<(props: Record<string, any>) => IntlString>,
    DateOffsetPresenter: '' as Resource<(props: Record<string, any>) => IntlString>,
    DateDifferencePresenter: '' as Resource<(props: Record<string, any>) => IntlString>
  },
  validator: {
    FieldRequired: '' as Ref<WorkflowValidator>,
    SubtaskStatus: '' as Ref<WorkflowValidator>,
    ParentStatus: '' as Ref<WorkflowValidator>
  },
  validatorExecutor: {
    FieldRequired: '' as Resource<ValidatorFunc>,
    SubtaskStatus: '' as Resource<ValidatorFunc>,
    ParentStatus: '' as Resource<ValidatorFunc>
  },
  validatorEditor: {
    FieldRequired: '' as AnyComponent,
    SubtaskStatus: '' as AnyComponent,
    ParentStatus: '' as AnyComponent
  },
  validatorPresenter: {
    FieldRequired: '' as AnyComponent,
    SubtaskStatus: '' as AnyComponent,
    ParentStatus: '' as AnyComponent
  },
  request: {
    ScreenRequest: '' as Ref<WorkflowRequest>
  },
  requestEditor: {
    ScreenRequest: '' as AnyComponent
  },
  requestPresenter: {
    ScreenRequest: '' as AnyComponent
  },
  postFunction: {
    UpdateFieldValue: '' as Ref<WorkflowPostFunction>,
    ClearFieldValue: '' as Ref<WorkflowPostFunction>
  },
  postFunctionEditor: {
    UpdateFieldValue: '' as AnyComponent,
    ClearFieldValue: '' as AnyComponent
  },
  postFunctionPresenter: {
    UpdateFieldValue: '' as AnyComponent,
    ClearFieldValue: '' as AnyComponent
  },
  mixin: {
    ProjectWorkflow: '' as Ref<Mixin<ProjectWorkflow>>,
    ValidatorImpl: '' as Ref<Mixin<ValidatorImpl>>
  },
  component: {
    ProjectTypeWorkflowsSectionEditor: '' as AnyComponent,
    WorkflowEditor: '' as AnyComponent,
    WorkflowDiagramPopup: '' as AnyComponent,
    ProjectTypeScreensSectionEditor: '' as AnyComponent,
    ScreenEditor: '' as AnyComponent
  },
  icon: {
    Workflows: '' as Asset,
    Workflow: '' as Asset,
    Transition: '' as Asset,
    Check: '' as Asset,
    Screens: '' as Asset,
    Screen: '' as Asset,
    ScreenTab: '' as Asset,
    Action: '' as Asset,
    Editor: '' as Asset,
    Chart: '' as Asset
  },
  string: {
    Search: '' as IntlString,
    Replacement: '' as IntlString,
    Separator: '' as IntlString,
    Start: '' as IntlString,
    End: '' as IntlString,
    Workflow: '' as IntlString,
    WorkflowScheme: '' as IntlString,
    WorkflowSettings: '' as IntlString,
    WorkflowTransition: '' as IntlString,
    WorkflowMapping: '' as IntlString,
    InitialStatuses: '' as IntlString,
    Name: '' as IntlString,
    From: '' as IntlString,
    To: '' as IntlString,
    TaskType: '' as IntlString,
    DefaultWorkflow: '' as IntlString,
    Untitled: '' as IntlString,
    AnyStatus: '' as IntlString,
    AnyTaskType: '' as IntlString,
    Workflows: '' as IntlString,
    Screens: '' as IntlString,
    DeleteWorkflow: '' as IntlString,
    DeleteWorkflowConfirm: '' as IntlString,
    DeleteWorkflowTransition: '' as IntlString,
    DeleteWorkflowTransitionConfirm: '' as IntlString,
    Export: '' as IntlString,
    Transitions: '' as IntlString,
    AddTransition: '' as IntlString,
    CreateTransition: '' as IntlString,
    TransitionNamed: '' as IntlString,
    TaskTypeRequired: '' as IntlString,
    UnknownTaskType: '' as IntlString,
    WorkflowName: '' as IntlString,
    NameRequired: '' as IntlString,
    StatusToRequired: '' as IntlString,
    Validators: '' as IntlString,
    FieldRequiredValidator: '' as IntlString,
    FieldRequiredDescription: '' as IntlString,
    FieldRequiredError: '' as IntlString,
    FieldRequiredSingleError: '' as IntlString,
    FieldRequiredMultipleError: '' as IntlString,
    SubtaskStatusValidator: '' as IntlString,
    SubtaskStatusDescription: '' as IntlString,
    SubtaskStatusError: '' as IntlString,
    SubtaskStatusRequired: '' as IntlString,
    NoSubtaskTypes: '' as IntlString,
    NoSubtaskTypesDescription: '' as IntlString,
    ParentStatusValidator: '' as IntlString,
    ParentStatusDescription: '' as IntlString,
    ParentStatusError: '' as IntlString,
    ParentStatusRequired: '' as IntlString,
    NoParentTaskTypes: '' as IntlString,
    NoParentTaskTypesDescription: '' as IntlString,
    ConfigureTaskType: '' as IntlString,
    ConfigureTaskTypes: '' as IntlString,
    TransitionConflictError: '' as IntlString,
    SelfTransitionError: '' as IntlString,
    AddValidator: '' as IntlString,
    Validator: '' as IntlString,
    AddRule: '' as IntlString,
    AllRules: '' as IntlString,
    TransitionRulesConfigured: '' as IntlString,
    RuleTypes: '' as IntlString,
    RestrictTransition: '' as IntlString,
    RequestInput: '' as IntlString,
    ValidateDetails: '' as IntlString,
    PerformActions: '' as IntlString,
    SearchRules: '' as IntlString,
    Transition: '' as IntlString,
    Screen: '' as IntlString,
    ScreenTab: '' as IntlString,
    ScreenField: '' as IntlString,
    Attribute: '' as IntlString,
    Category: '' as IntlString,
    Type: '' as IntlString,
    Editor: '' as IntlString,
    PropsLabelPresenter: '' as IntlString,
    Fields: '' as IntlString,
    Function: '' as IntlString,
    Transform: '' as IntlString,
    Field: '' as IntlString,
    FieldKey: '' as IntlString,
    Label: '' as IntlString,
    Required: '' as IntlString,
    Description: '' as IntlString,
    Requests: '' as IntlString,
    WorkflowRequest: '' as IntlString,
    ScreenRequest: '' as IntlString,
    ScreenRequestDescription: '' as IntlString,
    TabNumbered: '' as IntlString,
    DeleteScreen: '' as IntlString,
    DeleteScreenConfirm: '' as IntlString,
    DeleteScreenTab: '' as IntlString,
    DeleteScreenTabConfirm: '' as IntlString,
    AddTab: '' as IntlString,
    AddField: '' as IntlString,
    TabName: '' as IntlString,
    ConfigureScreen: '' as IntlString,
    ScreenRequestPresenter: '' as IntlString,
    ScreenNotSelected: '' as IntlString,
    UsedInWorkflows: '' as IntlString,
    ScreenClassDisabledUsedInWorkflows: '' as IntlString,
    UsedInProjects: '' as IntlString,
    WorkflowsWillBeDeleted: '' as IntlString,
    General: '' as IntlString,
    NoAvailableFields: '' as IntlString,
    PostFunctions: '' as IntlString,
    WorkflowPostFunction: '' as IntlString,
    AddPostFunction: '' as IntlString,
    PostFunction: '' as IntlString,
    UpdateFieldValuePostFunction: '' as IntlString,
    UpdateFieldValueDescription: '' as IntlString,
    ClearFieldValuePostFunction: '' as IntlString,
    ClearFieldValueDescription: '' as IntlString,
    Value: '' as IntlString,
    ClearFields: '' as IntlString,
    SelectFieldToClear: '' as IntlString,
    CurrentUser: '' as IntlString,
    ParentAssignee: '' as IntlString,
    DefaultAssignee: '' as IntlString,
    Now: '' as IntlString,
    ThisTaskField: '' as IntlString,
    ParentTaskField: '' as IntlString,
    Parent: '' as IntlString,
    SelectFieldFirst: '' as IntlString,
    NoTransformationsForAttribute: '' as IntlString,
    SetValueFirst: '' as IntlString,
    FailedToRenderDiagram: '' as IntlString,
    DiagramErrorHint: '' as IntlString,
    ShowDetails: '' as IntlString,
    HideDetails: '' as IntlString,
    Set: '' as IntlString,
    Action: '' as IntlString
  },
  status: {
    InitialStatusNotAllowed: '' as StatusCode,
    ForbiddenTransition: '' as StatusCode<{ from: string, to: string }>,
    SelfTransitionNotAllowed: '' as StatusCode<{ status: string }>,
    TransitionConflict: '' as StatusCode<{ from: string, to: string, name?: string }>,
    ValidationFailed: '' as StatusCode<{ reason: string }>,
    WorkflowNotFound: '' as StatusCode
  }
})

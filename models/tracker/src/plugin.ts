//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021 Hardcore Engineering Inc.
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
import { type Doc, type DocManager, type Ref, type StatusCategory } from '@hcengineering/core'
import { type MessageNotificationType, type NotificationGroup } from '@hcengineering/notification'
import { mergeIds, type IntlString, type Resource } from '@hcengineering/platform'
import { type ProjectType } from '@hcengineering/task'
import { trackerId } from '@hcengineering/tracker'
import tracker from '@hcengineering/tracker-resources/src/plugin'
import type { AnyComponent } from '@hcengineering/ui/src/types'
import { type Action, type ViewAction, type Viewlet, type ViewletViewAction } from '@hcengineering/view'
import { type Application } from '@hcengineering/workbench'
import { type DocUpdateMessage } from '@hcengineering/activity'

export default mergeIds(trackerId, tracker, {
  string: {
    Projects: '' as IntlString,
    GotoIssues: '' as IntlString,
    GotoActive: '' as IntlString,
    GotoBacklog: '' as IntlString,
    GotoComponents: '' as IntlString,
    GotoTrackerApplication: '' as IntlString,
    GotoMyIssues: '' as IntlString,
    SearchIssue: '' as IntlString,
    CreatedDate: '' as IntlString,
    ChangeStatus: '' as IntlString,
    ConfigDescription: '' as IntlString,
    AllProjects: '' as IntlString,
    MapRelatedIssues: '' as IntlString,
    Extensions: '' as IntlString
  },
  component: {
    MilestoneSelector: '' as AnyComponent,
    IssueStatistics: '' as AnyComponent,
    TimeSpendReportPopup: '' as AnyComponent,
    NotificationIssuePresenter: '' as AnyComponent,
    MilestoneFilter: '' as AnyComponent,
    EditRelatedTargets: '' as AnyComponent,
    EditRelatedTargetsPopup: '' as AnyComponent,
    SettingsRelatedTargets: '' as AnyComponent,
    IssueSearchIcon: '' as AnyComponent,
    MembersArrayEditor: '' as AnyComponent,
    IssueExtra: '' as AnyComponent
  },
  app: {
    Tracker: '' as Ref<Application>
  },
  specialViewAction: {
    IssueList: '' as Ref<ViewletViewAction>
  },
  viewlet: {
    IssueList: '' as Ref<Viewlet>,
    IssueTemplateList: '' as Ref<Viewlet>,
    IssueKanban: '' as Ref<Viewlet>,
    MilestoneList: '' as Ref<Viewlet>,
    ComponentList: '' as Ref<Viewlet>,
    ProjectList: '' as Ref<Viewlet>,
    ProjectListGrouped: '' as Ref<Viewlet>
  },
  ids: {
    TrackerNotificationGroup: '' as Ref<NotificationGroup>,
    AssigneeNotification: '' as Ref<MessageNotificationType<DocUpdateMessage>>,
    BaseProjectType: '' as Ref<ProjectType>,
    DefaultProjectType: '' as Ref<ProjectType>,
    KanbanSwimLaneActions: '' as Ref<Doc>,
    KanbanSwimLaneActionsExtension: '' as Ref<Doc>
  },
  actionImpl: {
    Move: '' as ViewAction,
    CopyToClipboard: '' as ViewAction,
    EditWorkflowStatuses: '' as ViewAction,
    EditProject: '' as ViewAction,
    DeleteProject: '' as ViewAction,
    DeleteIssue: '' as ViewAction,
    DeleteMilestone: '' as ViewAction
  },
  action: {
    NewRelatedIssue: '' as Ref<Action<Doc, any>>,
    DeleteMilestone: '' as Ref<Action<Doc, Record<string, any>>>,
    DeleteProject: '' as Ref<Action<Doc, Record<string, any>>>,
    DeleteProjectClean: '' as Ref<Action<Doc, Record<string, any>>>,
    DeleteIssue: '' as Ref<Action<Doc, Record<string, any>>>
  },

  // For migration only
  issueStatusCategory: {
    Backlog: '' as Ref<StatusCategory>,
    Unstarted: '' as Ref<StatusCategory>,
    Started: '' as Ref<StatusCategory>,
    Completed: '' as Ref<StatusCategory>,
    Canceled: '' as Ref<StatusCategory>
  },

  function: {
    SetComponentStore: '' as Resource<(manager: DocManager<any>) => void>,
    ComponentFilterFunction: '' as Resource<(doc: Doc, target: Doc) => boolean>
  }
})

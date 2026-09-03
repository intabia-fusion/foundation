//
// Copyright © 2022-2023 Hardcore Engineering Inc.
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

import { Employee, Person } from '@hcengineering/contact'
import {
  AttachedDoc,
  Attribute,
  Class,
  MarkupBlobRef,
  CollectionSize,
  Data,
  Doc,
  Markup,
  type TxOperations,
  Mixin,
  Ref,
  RelatedDocument,
  Space,
  Status,
  Timestamp,
  Type,
  type Permission
} from '@hcengineering/core'
import { Asset, IntlString, Plugin, Resource, plugin } from '@hcengineering/platform'
import { Preference } from '@hcengineering/preference'
import { TagCategory, TagElement, TagReference } from '@hcengineering/tags'
import { ToDo } from '@hcengineering/time'
import {
  ProjectType,
  ProjectTypeDescriptor,
  Task,
  Project as TaskProject,
  TaskStatusFactory,
  TaskType,
  TaskTypeDescriptor
} from '@hcengineering/task'
import { AnyComponent, ComponentExtensionId, Location, ResolvedLocation } from '@hcengineering/ui'
import { Action, ActionCategory, IconProps } from '@hcengineering/view'

export * from './analytics'
export * from './duration'

/**
 * @public
 */
export interface IssueStatus extends Status {}

/**
 * @public
 */
export interface Project extends TaskProject, IconProps {
  identifier: string // Project identifier
  sequence: number
  defaultIssueStatus?: Ref<IssueStatus>
  defaultAssignee?: Ref<Employee>
  defaultTimeReportDay: TimeReportDayType
}

/**
 * @public
 */
export interface ProjectTargetPreference extends Preference {
  attachedTo: Ref<Project> // tracker.ids.ProjectPreferences

  usedOn: Timestamp

  props?: { key: string, value: any }[]
}

export type RelatedIssueKind = 'classRule' | 'spaceRule'

export interface RelatedClassRule {
  kind: 'classRule'
  ofClass: Ref<Class<Doc>>
}

export interface RelatedSpaceRule {
  kind: 'spaceRule'
  space: Ref<Space>
}

/**
 * @public
 *
 * If defined, will be used to set a default project for this kind of document's related issues.
 */
export interface RelatedIssueTarget extends Doc {
  // Attached to project.
  target?: Ref<Project> | null
  rule: RelatedClassRule | RelatedSpaceRule
}

/**
 * @public
 */
export enum TimeReportDayType {
  CurrentWorkDay = 'CurrentWorkDay',
  PreviousWorkDay = 'PreviousWorkDay'
}

/**
 * @public
 */
export enum IssuePriority {
  NoPriority,
  Urgent,
  High,
  Medium,
  Low
}

/**
 * @public
 */
export enum IssuesGrouping {
  Status = 'status',
  Assignee = 'assignee',
  Priority = 'priority',
  Component = 'component',
  Milestone = 'milestone',
  NoGrouping = '#no_category'
}

/**
 * @public
 */
export enum IssuesOrdering {
  Status = 'status',
  Priority = 'priority',
  LastUpdated = 'modifiedOn',
  DueDate = 'dueDate',
  Manual = 'rank'
}

/**
 * @public
 */
export enum IssuesDateModificationPeriod {
  All = 'all',
  PastWeek = 'pastWeek',
  PastMonth = 'pastMonth'
}

/**
 * @public
 */
export enum MilestoneStatus {
  Planned,
  InProgress,
  Completed,
  Canceled
}

/**
 * @public
 */
export interface Milestone extends Doc {
  label: string
  description?: Markup

  status: MilestoneStatus

  space: Ref<Project>

  comments: number
  attachments?: number

  targetDate: Timestamp
}

/**
 * @public
 */
export interface Issue extends Task {
  attachedTo: Ref<Issue>
  title: string
  description: MarkupBlobRef | null
  status: Ref<IssueStatus>
  priority: IssuePriority

  component: Ref<Component> | null

  // For subtasks
  subIssues: CollectionSize<Issue>
  blockedBy?: RelatedDocument[]
  relations?: RelatedDocument[]
  parents: IssueParentInfo[]

  space: Ref<Project>

  milestone?: Ref<Milestone> | null

  // Estimation in man hours
  estimation: number

  // Remaining time in man hours
  remainingTime: number

  // ReportedTime time, auto updated using trigger.
  reportedTime: number
  // Collection of reportedTime entries, for proper time estimations per person.
  reports: CollectionSize<TimeSpendReport>

  childInfo: IssueChildInfo[]

  template?: {
    // A template issue is based on
    template: Ref<IssueTemplate>
    // Child id in template
    childId?: string
  }

  todos?: CollectionSize<ToDo>
}

/**
 * @public
 */
export interface IssueDraft {
  kind: Ref<TaskType>
  _id: Ref<Issue>
  title: string
  description: Markup
  status?: Ref<IssueStatus>
  priority: IssuePriority
  assignee: Ref<Person> | null
  component: Ref<Component> | null
  space: Ref<Project>
  dueDate: Timestamp | null
  milestone?: Ref<Milestone> | null

  // Estimation in man days
  estimation: number
  parentIssue?: Ref<Issue>
  attachments?: number
  labels: TagReference[]
  subIssues: IssueDraft[]
  template?: {
    // A template issue is based on
    template: Ref<IssueTemplate>
    // Child id in template
    childId?: string
  }
  // Root message of the AI assistant conversation about this draft. Kept in the draft so coming
  // back to an unfinished issue restores the discussion with it, not just the fields.
  assistConversation?: Ref<Doc>
}

/**
 * @public
 */
export interface IssueTemplateData {
  title: string
  description: Markup
  priority: IssuePriority

  assignee: Ref<Person> | null
  component: Ref<Component> | null

  milestone?: Ref<Milestone> | null

  // Estimation in man days
  estimation: number

  labels?: Ref<TagElement>[]

  kind?: Ref<TaskType>
}

/**
 * @public
 */
export interface IssueTemplateChild extends IssueTemplateData {
  id: Ref<Issue>
}

/**
 * @public
 */
export interface IssueTemplate extends Doc, IssueTemplateData {
  space: Ref<Project>

  children: IssueTemplateChild[]

  // Discussion stuff
  comments: number
  attachments?: number

  relations?: RelatedDocument[]
}

/**
 * @public
 *
 * Declares time spend entry
 */
export interface TimeSpendReport extends AttachedDoc {
  attachedTo: Ref<Issue>

  employee: Ref<Employee> | null

  date: Timestamp | null
  // Value in man hours
  value: number

  description: string
}

/**
 * @public
 */
export interface IssueParentInfo {
  parentId: Ref<Issue>
  identifier: string
  parentTitle: string
  space: Ref<Space>
}

/**
 * @public
 */
export interface IssueChildInfo {
  childId: Ref<Issue>
  estimation: number
  reportedTime: number
  parentId?: Ref<Issue>
}

/**
 * Result of tree-based aggregation of child info.
 * @public
 */
export interface ChildInfoTreeResult {
  totalEstimation: number
  totalReportedTime: number
}

/**
 * Aggregates estimation and reported time from a hierarchical childInfo array.
 *
 * - If childInfo is empty, returns own values.
 * - If any element lacks parentId (legacy data), falls back to flat summation.
 * - Otherwise builds a tree and aggregates bottom-up:
 *   effectiveEst(node) = max(node.estimation, sum(children.effectiveEst))
 *   effectiveReported(node) = node.reportedTime + sum(children.effectiveReported)
 *
 * @public
 */
export function reduceChildInfoTree (
  childInfo: IssueChildInfo[],
  ownEstimation: number,
  ownReportedTime: number
): ChildInfoTreeResult {
  if (childInfo.length === 0) {
    return { totalEstimation: ownEstimation, totalReportedTime: ownReportedTime }
  }

  // Legacy fallback: if any entry lacks parentId, use flat summation
  if (childInfo.some((it) => it.parentId === undefined)) {
    const childEst = childInfo.reduce((a, b) => a + b.estimation, 0)
    const childRep = childInfo.reduce((a, b) => a + b.reportedTime, 0)
    return {
      totalEstimation: ownEstimation + childEst,
      totalReportedTime: ownReportedTime + childRep
    }
  }

  // Build tree: parentId -> children
  const childrenMap = new Map<string, IssueChildInfo[]>()
  const nodeMap = new Map<string, IssueChildInfo>()

  for (const info of childInfo) {
    nodeMap.set(info.childId, info)
    const pid = info.parentId as string
    const arr = childrenMap.get(pid)
    if (arr !== undefined) {
      arr.push(info)
    } else {
      childrenMap.set(pid, [info])
    }
  }

  // Memoized bottom-up aggregation
  const estCache = new Map<string, number>()
  const repCache = new Map<string, number>()

  function effectiveEst (nodeId: string): number {
    const cached = estCache.get(nodeId)
    if (cached !== undefined) return cached
    const node = nodeMap.get(nodeId)
    const ownEst = node?.estimation ?? 0
    const children = childrenMap.get(nodeId) ?? []
    const childSum = children.reduce((acc, c) => acc + effectiveEst(c.childId), 0)
    const result = Math.max(ownEst, childSum)
    estCache.set(nodeId, result)
    return result
  }

  function effectiveRep (nodeId: string): number {
    const cached = repCache.get(nodeId)
    if (cached !== undefined) return cached
    const node = nodeMap.get(nodeId)
    const ownRep = node?.reportedTime ?? 0
    const children = childrenMap.get(nodeId) ?? []
    const childSum = children.reduce((acc, c) => acc + effectiveRep(c.childId), 0)
    const result = ownRep + childSum
    repCache.set(nodeId, result)
    return result
  }

  // Root children are those whose parentId is not in the childInfo set (i.e., they are direct children of the owner issue)
  const allChildIds = new Set(childInfo.map((it) => it.childId as string))
  const rootChildren = childInfo.filter((it) => !allChildIds.has(it.parentId as string))

  const rootChildEstSum = rootChildren.reduce((acc, c) => acc + effectiveEst(c.childId), 0)
  const rootChildRepSum = rootChildren.reduce((acc, c) => acc + effectiveRep(c.childId), 0)

  return {
    totalEstimation: Math.max(ownEstimation, rootChildEstSum),
    totalReportedTime: ownReportedTime + rootChildRepSum
  }
}

/**
 * @public
 */
export interface Document extends Doc {
  title: string
  icon: string | null
  color: number
  content?: Markup

  space: Ref<Project>
}

/**
 * @public
 */
export interface Component extends Doc {
  label: string
  description?: Markup
  lead: Ref<Employee> | null
  space: Ref<Project>
  comments: number
  attachments?: number
}

/**
 * @public
 */
export const trackerId = 'tracker' as Plugin
export * from './analytics'

/** Input of the shared issue-creation helper (tracker.function.CreateIssue). */
export interface NewIssue {
  title: string
  description?: Markup
  priority?: IssuePriority
  // Effort in hours, as the estimation editor shows it.
  estimation?: number
  assignee?: Ref<Person> | null
  parent?: Issue
}

/** What the helper returns: enough to link to the created issue. */
export interface CreatedIssue {
  _id: Ref<Issue>
  _class: Ref<Class<Issue>>
  identifier: string
}

const pluginState = plugin(trackerId, {
  class: {
    Project: '' as Ref<Class<Project>>,
    Issue: '' as Ref<Class<Issue>>,
    IssueTemplate: '' as Ref<Class<IssueTemplate>>,
    Component: '' as Ref<Class<Component>>,
    IssueStatus: '' as Ref<Class<IssueStatus>>,
    TypeIssuePriority: '' as Ref<Class<Type<IssuePriority>>>,
    Milestone: '' as Ref<Class<Milestone>>,
    TypeMilestoneStatus: '' as Ref<Class<Type<MilestoneStatus>>>,
    TimeSpendReport: '' as Ref<Class<TimeSpendReport>>,
    TypeReportedTime: '' as Ref<Class<Type<number>>>,
    TypeEstimation: '' as Ref<Class<Type<number>>>,
    TypeRemainingTime: '' as Ref<Class<Type<number>>>,
    RelatedIssueTarget: '' as Ref<Class<RelatedIssueTarget>>,
    ProjectTargetPreference: '' as Ref<Class<ProjectTargetPreference>>,
    IssueTaskType: '' as Ref<Class<Issue>>
  },
  mixin: {
    ClassicProjectTypeData: '' as Ref<Mixin<Project>>
  },
  ids: {
    NoParent: '' as Ref<Issue>,
    IssueDraft: '',
    IssueDraftChild: '',
    ClassingProjectType: '' as Ref<ProjectType>
  },
  status: {
    Backlog: '' as Ref<Status>,
    Todo: '' as Ref<Status>,
    InProgress: '' as Ref<Status>,
    Coding: '' as Ref<Status>,
    UnderReview: '' as Ref<Status>,
    Done: '' as Ref<Status>,
    Canceled: '' as Ref<Status>
  },
  component: {
    SubtaskSection: '' as AnyComponent,
    Tracker: '' as AnyComponent,
    TrackerApp: '' as AnyComponent,
    RelatedIssues: '' as AnyComponent,
    RelatedIssuesSection: '' as AnyComponent,
    RelatedIssueSelector: '' as AnyComponent,
    RelatedIssueTemplates: '' as AnyComponent,
    EditIssue: '' as AnyComponent,
    CreateIssue: '' as AnyComponent,
    ProjectPresenter: '' as AnyComponent,
    CreateIssueTemplate: '' as AnyComponent,
    CreateProject: '' as AnyComponent,
    IssueStatusPresenter: '' as AnyComponent,
    LabelsView: '' as AnyComponent
  },
  attribute: {
    IssueStatus: '' as Ref<Attribute<Status>>
  },
  icon: {
    TrackerApplication: '' as Asset,
    Component: '' as Asset,
    Issue: '' as Asset,
    Subissue: '' as Asset,
    Project: '' as Asset,
    Relations: '' as Asset,
    Inbox: '' as Asset,
    MyIssues: '' as Asset,
    Views: '' as Asset,
    Issues: '' as Asset,
    Components: '' as Asset,
    NewIssue: '' as Asset,
    Magnifier: '' as Asset,
    Labels: '' as Asset,
    DueDate: '' as Asset,
    Parent: '' as Asset,
    UnsetParent: '' as Asset,
    Milestone: '' as Asset,
    IssueTemplates: '' as Asset,
    Start: '' as Asset,
    Stop: '' as Asset,

    CategoryBacklog: '' as Asset,
    CategoryUnstarted: '' as Asset,
    CategoryStarted: '' as Asset,
    CategoryCompleted: '' as Asset,
    CategoryCanceled: '' as Asset,

    PriorityNoPriority: '' as Asset,
    PriorityUrgent: '' as Asset,
    PriorityHigh: '' as Asset,
    PriorityMedium: '' as Asset,
    PriorityLow: '' as Asset,

    ComponentsList: '' as Asset,

    MilestoneStatusPlanned: '' as Asset,
    MilestoneStatusInProgress: '' as Asset,
    MilestoneStatusPaused: '' as Asset,
    MilestoneStatusCompleted: '' as Asset,
    MilestoneStatusCanceled: '' as Asset,

    CopyBranch: '' as Asset,
    Duplicate: '' as Asset,

    TimeReport: '' as Asset,
    Estimation: '' as Asset,

    // Project icons
    Home: '' as Asset,
    RedCircle: '' as Asset,

    Priority: '' as Asset,
    Export: '' as Asset,
    More: '' as Asset
  },
  category: {
    Other: '' as Ref<TagCategory>,
    Tracker: '' as Ref<ActionCategory>
  },
  descriptors: {
    ProjectType: '' as Ref<ProjectTypeDescriptor>,
    Issue: '' as Ref<TaskTypeDescriptor>
  },
  action: {
    CopyAsMarkdownTable: '' as Ref<Action<Doc, any>>,
    SetDueDate: '' as Ref<Action<Doc, any>>,
    SetParent: '' as Ref<Action<Doc, any>>,
    SetStatus: '' as Ref<Action>,
    SetPriority: '' as Ref<Action<Doc, any>>,
    SetAssignee: '' as Ref<Action<Doc, any>>,
    SetComponent: '' as Ref<Action<Doc, any>>,
    CopyIssueId: '' as Ref<Action<Doc, any>>,
    CopyIssueTitle: '' as Ref<Action<Doc, any>>,
    CopyIssueLink: '' as Ref<Action<Doc, any>>,
    MoveToProject: '' as Ref<Action>,
    Duplicate: '' as Ref<Action<Doc, any>>,
    Relations: '' as Ref<Action<Doc, any>>,
    NewIssue: '' as Ref<Action<Doc, any>>,
    NewIssueGlobal: '' as Ref<Action<Doc, any>>,
    NewSubIssue: '' as Ref<Action<Doc, any>>,
    EditWorkflowStatuses: '' as Ref<Action>,
    EditProject: '' as Ref<Action>,
    SetMilestone: '' as Ref<Action<Doc, any>>,
    SetLabels: '' as Ref<Action<Doc, any>>,
    EditRelatedTargets: '' as Ref<Action<Doc, any>>,
    UnsetParent: '' as Ref<Action<Doc, any>>
  },
  project: {
    DefaultProject: '' as Ref<Project>
  },
  resolver: {
    Location: '' as Resource<(loc: Location) => Promise<ResolvedLocation | undefined>>
  },
  function: {
    // Shared issue creation, so other plugins do not depend on tracker-resources (import cycle).
    CreateIssue: '' as Resource<(client: TxOperations, project: Project, data: NewIssue) => Promise<CreatedIssue>>
  },
  string: {
    TrackerApplication: '' as IntlString,
    ConfigLabel: '' as IntlString,
    NewRelatedIssue: '' as IntlString,
    IssueNotificationTitle: '' as IntlString,
    IssueNotificationBody: '' as IntlString,
    IssueNotificationChanged: '' as IntlString,
    IssueNotificationChangedProperty: '' as IntlString,
    IssueNotificationMessage: '' as IntlString,
    IssueAssignedToYou: '' as IntlString,
    Project: '' as IntlString,
    RelatedIssues: '' as IntlString,
    Issue: '' as IntlString,
    NewProject: '' as IntlString,
    UnsetParentIssue: '' as IntlString,
    ForbidCreateProjectPermission: '' as IntlString,
    ForbidCreateProjectPermissionDescription: '' as IntlString,
    AdditionalProperties: '' as IntlString,
    Priority: '' as IntlString,
    NoPriority: '' as IntlString,
    Urgent: '' as IntlString,
    High: '' as IntlString,
    Medium: '' as IntlString,
    Low: '' as IntlString,
    TimeSpendHours: '' as IntlString,
    StatusChangedTo: '' as IntlString,
    PriorityChangedTo: '' as IntlString,
    AssigneeChangedTo: '' as IntlString,
    AssigneeUnset: '' as IntlString,
    ComponentChangedTo: '' as IntlString,
    ComponentUnset: '' as IntlString,
    ParentChangedTo: '' as IntlString,
    ParentUnset: '' as IntlString,
    TitleChangedTo: '' as IntlString,
    DescriptionChangedTo: '' as IntlString,
    AddedLabel: '' as IntlString,
    RemovedLabel: '' as IntlString,
    Label: '' as IntlString,
    MilestoneChangedTo: '' as IntlString,
    MilestoneUnset: '' as IntlString,
    EstimationChangedTo: '' as IntlString,
    EstimationUnset: '' as IntlString,
    TimeSpentAdded: '' as IntlString,
    TimeSpentRemoved: '' as IntlString,
    SubIssueAdded: '' as IntlString,
    SubIssueRemoved: '' as IntlString,
    AddedBlocker: '' as IntlString,
    RemovedBlocker: '' as IntlString,
    AddedRelation: '' as IntlString,
    RemovedRelation: '' as IntlString
  },
  emailTemplate: {
    AssigneeNotificationText: '' as IntlString,
    AssigneeNotificationHtml: '' as IntlString,
    AssigneeNotificationSubject: '' as IntlString
  },
  extensions: {
    IssueListHeader: '' as ComponentExtensionId,
    EditIssueHeader: '' as ComponentExtensionId,
    EditIssueTitle: '' as ComponentExtensionId,
    // Create-issue dialog: the AI assistant. The toggle sits in the header's right corner,
    // the panel itself slides out beside the dialog.
    CreateIssueAssist: '' as ComponentExtensionId,
    CreateIssueHeaderActions: '' as ComponentExtensionId
  },
  taskTypes: {
    Issue: '' as Ref<TaskType>,
    SubIssue: '' as Ref<TaskType>
  },
  permission: {
    ForbidCreateProject: '' as Ref<Permission>
  }
})
export default pluginState

/**
 * @public
 */
export function createStatesData (data: TaskStatusFactory[]): Omit<Data<Status>, 'rank'>[] {
  const states: Omit<Data<Status>, 'rank'>[] = []

  for (const category of data) {
    for (const sName of category.statuses) {
      states.push({
        ofAttribute: pluginState.attribute.IssueStatus,
        name: Array.isArray(sName) ? sName[0] : sName,
        color: Array.isArray(sName) ? sName[1] : undefined,
        category: category.category
      })
    }
  }
  return states
}

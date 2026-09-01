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

import chunter, { type ChatMessage } from '@hcengineering/chunter'
import { type Employee, type Person } from '@hcengineering/contact'
import core, {
  type Blob,
  type Class,
  type CollaborativeDoc,
  type DocData,
  type DocumentUpdate,
  generateId,
  makeCollabId,
  type Markup,
  type Ref,
  type Timestamp,
  type TxOperations
} from '@hcengineering/core'
import { isEmptyMarkup } from '@hcengineering/text-core'
import task, { type TaskType } from '@hcengineering/task'
import tracker, {
  type CreatedIssue,
  type Issue,
  type IssueStatus,
  IssuePriority,
  type NewIssue,
  type Project,
  type TimeSpendReport
} from '.'

/** Uploads markup and returns the resulting blob ref, e.g. `presentation.createMarkup` on the UI. */
export type UploadMarkup = (collabId: CollaborativeDoc, markup: Markup) => Promise<Ref<Blob>>

/** Create an issue (or sub-issue) in `project`, same as the CreateIssue dialog. */
export async function createIssue (
  client: TxOperations,
  project: Project,
  data: NewIssue,
  uploadMarkup?: UploadMarkup
): Promise<CreatedIssue> {
  const taskType = await resolveTaskType(client, project)
  const issueClass: Ref<Class<Issue>> = client.getHierarchy().hasClass(taskType.targetClass)
    ? (taskType.targetClass as Ref<Class<Issue>>)
    : tracker.class.Issue

  // defaultIssueStatus is optional on a project; fall back to the task type's first allowed status,
  // which is what the create dialog's status selector starts on.
  const status = project.defaultIssueStatus ?? (taskType.statuses?.[0] as Ref<IssueStatus> | undefined)
  if (status === undefined) {
    throw new Error(`Project ${project.identifier} has no issue status to start from`)
  }

  // `true` = retrieve: without it the result carries no object and the new sequence is lost.
  const incResult = await client.updateDoc(
    tracker.class.Project,
    core.space.Space,
    project._id,
    { $inc: { sequence: 1 } },
    true
  )
  const number = (incResult as any).object.sequence
  const _id = generateId<Issue>()
  const parent = data.parent

  const value: DocData<Issue> = {
    title: data.title,
    description: null,
    assignee: data.assignee ?? null,
    component: null,
    milestone: null,
    number,
    status,
    priority: data.priority ?? IssuePriority.NoPriority,
    rank: '',
    comments: 0,
    subIssues: 0,
    dueDate: null,
    parents:
      parent != null
        ? [
            { parentId: parent._id, parentTitle: parent.title, space: parent.space, identifier: parent.identifier },
            ...parent.parents
          ]
        : [],
    reportedTime: 0,
    remainingTime: 0,
    estimation: data.estimation ?? 0,
    reports: 0,
    relations: [],
    childInfo: [],
    kind: taskType._id,
    identifier: `${project.identifier}-${number}`
  }

  if (data.descriptionRef !== undefined) {
    value.description = data.descriptionRef
  } else if (data.description !== undefined && !isEmptyMarkup(data.description)) {
    if (uploadMarkup === undefined) {
      throw new Error('uploadMarkup is required to create an issue with a description')
    }
    value.description = await uploadMarkup(makeCollabId(issueClass, _id, 'description'), data.description)
  }

  await client.addCollection(
    issueClass,
    project._id,
    parent?._id ?? tracker.ids.NoParent,
    parent?._class ?? tracker.class.Issue,
    'subIssues',
    value,
    _id
  )
  return { _id, _class: issueClass, identifier: value.identifier }
}

// Same rule as the create dialog's TaskKindSelector: task types of the project's type, root
// ones preferred, first match wins. Query by `parent`, not `_id` - LookupMiddleware strips a
// field from the result when the query matched it by exact value, `_id` included.
async function resolveTaskType (client: TxOperations, project: Project): Promise<TaskType> {
  const taskTypes = await client.findAll(task.class.TaskType, { parent: project.type })
  const taskType = taskTypes.find((t) => t.isRootTaskType !== false) ?? taskTypes[0]
  if (taskType === undefined) {
    throw new Error(`Project "${project.identifier}" has no task type configured for issues`)
  }
  return taskType
}

/** Input of the shared issue-update helper. */
export interface IssueUpdate {
  title?: string
  description?: Markup
  /** Already-uploaded description; when set, `updateIssue` skips `uploadMarkup`. */
  descriptionRef?: Ref<Blob>
  priority?: IssuePriority
  assignee?: Ref<Person> | null
  status?: Ref<IssueStatus>
}

/** Update an issue's status/assignee/priority/title/description, same fields as the issue editors. */
export async function updateIssue (
  client: TxOperations,
  issue: Issue,
  data: IssueUpdate,
  uploadMarkup?: UploadMarkup
): Promise<void> {
  const update: DocumentUpdate<Issue> = {}
  if (data.title !== undefined) update.title = data.title
  if (data.status !== undefined) update.status = data.status
  if (data.assignee !== undefined) update.assignee = data.assignee
  if (data.priority !== undefined) update.priority = data.priority
  if (data.descriptionRef !== undefined) {
    update.description = data.descriptionRef
  } else if (data.description !== undefined) {
    if (uploadMarkup === undefined) {
      throw new Error('uploadMarkup is required to update an issue description')
    }
    update.description = await uploadMarkup(makeCollabId(issue._class, issue._id, 'description'), data.description)
  }
  if (Object.keys(update).length === 0) return
  await client.update(issue, update)
}

/** Post a chat message (comment) on an issue, same as the issue discussion panel. */
export async function commentIssue (client: TxOperations, issue: Issue, message: Markup): Promise<Ref<ChatMessage>> {
  return await client.addCollection(chunter.class.ChatMessage, issue.space, issue._id, issue._class, 'comments', {
    message
  })
}

/** Log time spent on an issue, same as the time-report popup. `reportedTime`/`remainingTime` on the
 * issue are rolled up by a server trigger (server-plugins/tracker-resources), not done here. */
export async function reportTime (
  client: TxOperations,
  issue: Issue,
  employee: Ref<Employee> | null,
  date: Timestamp,
  hours: number,
  description?: string
): Promise<Ref<TimeSpendReport>> {
  return await client.addCollection(tracker.class.TimeSpendReport, issue.space, issue._id, issue._class, 'reports', {
    employee,
    date,
    value: hours,
    description: description ?? ''
  })
}

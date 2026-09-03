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
  type Class,
  type DocData,
  generateId,
  makeCollabId,
  type Ref,
  type TxOperations
} from '@hcengineering/core'
import { isEmptyMarkup } from '@hcengineering/text'
import { createMarkup } from '@hcengineering/presentation'
import task, { type TaskType } from '@hcengineering/task'
import tracker, {
  type CreatedIssue,
  type Issue,
  type IssueStatus,
  IssuePriority,
  type NewIssue,
  type Project
} from '@hcengineering/tracker'

/** Create an issue (or sub-issue) in `project`, same as the CreateIssue dialog. */
export async function createIssue (client: TxOperations, project: Project, data: NewIssue): Promise<CreatedIssue> {
  const taskType = await resolveTaskType(client, project)
  const issueClass: Ref<Class<Issue>> =
    taskType?.targetClass != null && client.getHierarchy().hasClass(taskType.targetClass)
      ? (taskType.targetClass as Ref<Class<Issue>>)
      : tracker.class.Issue

  // defaultIssueStatus is optional on a project; fall back to the task type's first allowed status,
  // which is what the create dialog's status selector starts on.
  const status = project.defaultIssueStatus ?? (taskType?.statuses?.[0] as Ref<IssueStatus> | undefined)
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
    kind: taskType?._id ?? ('' as Ref<TaskType>),
    identifier: `${project.identifier}-${number}`
  }

  if (data.description !== undefined && !isEmptyMarkup(data.description)) {
    value.description = await createMarkup(makeCollabId(issueClass, _id, 'description'), data.description)
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

// First task type of the project's type. The dialog takes it from a store; here we read it
// directly so the helper works outside a component.
async function resolveTaskType (client: TxOperations, project: Project): Promise<TaskType | undefined> {
  const projectType = await client.findOne(task.class.ProjectType, { _id: project.type })
  const taskTypeId = projectType?.tasks?.[0]
  if (taskTypeId === undefined) return undefined
  return await client.findOne(task.class.TaskType, { _id: taskTypeId })
}
